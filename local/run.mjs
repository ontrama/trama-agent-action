#!/usr/bin/env node
// Local executor (development only): plays .github/workflows/trama-agent.yml on this machine. The API spawns it in
// local mode (AGENT_RUNS_DISPATCH=local) as `node local/run.mjs` with:
//
//   TRAMA_LOCAL_INPUTS        JSON of the workflow inputs (attempt_id, issue_key, provider, kind, secret_name,
//                             base_branch, branch, mode, api_url)
//   TRAMA_LOCAL_OIDC_TOKEN    the HS256 token the API signed in place of GitHub's OIDC token
//   TRAMA_LOCAL_REPOSITORY    owner/name
//   TRAMA_LOCAL_LOG           optional: file the log is appended to (secrets removed)
//   AGENT_RUNS_LOCAL_SECRETS  JSON object, secret name → value: "local" (this machine's Claude login),
//                             "fake:success" | "fake:plan_limit" | "fake:rate_limited" | "fake:login_failed"
//                             (simulated, Claude not called), anything else = CLAUDE_CODE_OAUTH_TOKEN
//
// Optional: TRAMA_LOCAL_CLONE_FROM (a path or URL to `git clone` instead of `gh repo clone`, for tests),
// TRAMA_LOCAL_GITHUB_TOKEN (instead of `gh auth token`), TRAMA_LOCAL_GITHUB_API_URL (default https://api.github.com),
// TRAMA_LOCAL_CLAUDE_BIN (default claude), TRAMA_LOCAL_TIMEOUT_MINUTES (60), TRAMA_LOCAL_KEEP=1 (keep the temp dir).
//
// Same steps as the workflow, with the same scripts: clone → scripts/start.mjs → Claude → scripts/finish.mjs (always).
// SIGTERM/SIGINT cancel Claude and still let finish report `cancelled`. Exits 0 only when the attempt succeeded.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeExecution } from '../scripts/execution.mjs';
import { EXECUTION_FILENAME, GIT_TOOLS, MCP_SERVER_NAME, isMainModule, parseOutputs } from '../scripts/lib.mjs';
import { FAKE_OUTCOMES, fakeExecution } from './fake.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Environment passed to Claude: enough to run and find its login, nothing of the API's own environment.
const CLAUDE_ENV_KEYS = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|TMP|TEMP|LC_\w+|XDG_\w+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|CLAUDE_CONFIG_DIR|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL)$/;
// Never handed to the start/finish scripts.
const PRIVATE_KEYS = ['AGENT_RUNS_LOCAL_SECRETS', 'TRAMA_LOCAL_INPUTS', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN'];

export class Logger {
  constructor(file) {
    this.file = file || '';
    this.secrets = new Set();
  }

  secret(value) {
    if (typeof value === 'string' && value.length >= 4) this.secrets.add(value);
  }

  redact(text) {
    let out = String(text ?? '');
    for (const secret of this.secrets) out = out.split(secret).join('***');
    return out.replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@');
  }

  line(text) {
    const out = this.redact(text);
    process.stdout.write(`${out}\n`);
    if (this.file) {
      try {
        appendFileSync(this.file, `${out}\n`);
      } catch {
        // The log is best effort.
      }
    }
  }

  info(message) {
    this.line(`[trama-local ${new Date().toISOString().slice(11, 19)}] ${message}`);
  }

  /** A line from a child script: `::add-mask::` lines teach the logger a secret and are not logged. */
  childLine(prefix, line) {
    const maskLine = line.match(/^::add-mask::(.*)$/);
    if (maskLine) {
      this.secret(maskLine[1]);
      return;
    }
    this.line(`${prefix}${line}`);
  }
}

function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    },
    end() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

function runNode(logger, script, { cwd, env, prefix }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = lineSplitter((line) => logger.childLine(prefix, line));
    const err = lineSplitter((line) => logger.childLine(prefix, line));
    child.stdout.setEncoding('utf8').on('data', (chunk) => out.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      logger.info(`${script} could not start: ${error.message}`);
      resolvePromise(1);
    });
    child.on('close', (code) => {
      out.end();
      err.end();
      resolvePromise(code ?? 1);
    });
  });
}

/** One line per notable Claude message, for the log. */
function describeMessage(message) {
  if (message.type === 'system' && message.subtype === 'init') {
    const servers = (message.mcp_servers || []).map((server) => `${server.name}:${server.status}`).join(', ');
    return `session ${message.session_id} · ${message.model} · ${message.permissionMode}${servers ? ` · mcp ${servers}` : ''}`;
  }
  if (message.type === 'system' && message.subtype === 'api_retry') return `API retry ${message.attempt}: ${message.error_status} ${message.error}`;
  if (message.type === 'rate_limit_event') return `rate limit ${message.rate_limit_info?.status} (${message.rate_limit_info?.rateLimitType ?? '?'})`;
  if (message.type === 'assistant') {
    return (message.message?.content || [])
      .map((block) => {
        if (block.type === 'text') return block.text.length > 400 ? `${block.text.slice(0, 400)}…` : block.text;
        if (block.type === 'tool_use') {
          const input = block.input?.command || block.input?.file_path || block.input?.pattern || '';
          return `→ ${block.name}${input ? ` ${String(input).slice(0, 200)}` : ''}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (message.type === 'result') {
    return `result: ${message.subtype}${message.is_error ? ' (error)' : ''} · ${message.num_turns} turns · $${message.total_cost_usd ?? 0} · ${message.duration_ms} ms`;
  }
  return '';
}

function claudeEnv(secretValue) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CLAUDE_ENV_KEYS.test(key) && value !== undefined) env[key] = value;
  }
  if (secretValue && secretValue !== 'local') env.CLAUDE_CODE_OAUTH_TOKEN = secretValue;
  return env;
}

// `extraTools`: TRAMA_LOCAL_EXTRA_TOOLS, comma-separated permission rules this machine's owner opts into, e.g.
// "Bash(npm test:*),Bash(node --test:*)" so Claude can run the project's checks. They run the repository's own scripts
// on this machine, so none are allowed by default.
export function claudeArgs(mode, mcpConfigFile, extraTools = '') {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--setting-sources', 'project'];
  if (mode === 'check') return [...args, '--max-turns', '1'];
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);
  // File edits are auto-accepted inside the clone (acceptEdits keeps them to the working directory); shell access is
  // limited to the git commands of GIT_TOOLS (plus the opted-in extras). No --dangerously-skip-permissions.
  const extras = String(extraTools || '').split(',').map((rule) => rule.trim()).filter(Boolean);
  args.push('--permission-mode', 'acceptEdits', '--allowedTools', [...GIT_TOOLS, ...extras, `mcp__${MCP_SERVER_NAME}`].join(','));
  return args;
}

function runClaude(logger, { bin, args, prompt, cwd, env, timeoutMs, control }) {
  return new Promise((resolvePromise) => {
    const messages = [];
    let timedOut = false;
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    control.child = child;
    const timer = setTimeout(() => {
      timedOut = true;
      logger.info(`Claude ran past the time limit (${Math.round(timeoutMs / 60000)} min); stopping it.`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    timer.unref();
    const out = lineSplitter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const message = JSON.parse(trimmed);
        messages.push(message);
        const text = describeMessage(message);
        if (text) for (const part of text.split('\n')) logger.line(`[claude] ${part}`);
      } catch {
        logger.line(`[claude] ${trimmed}`);
      }
    });
    const err = lineSplitter((line) => logger.line(`[claude stderr] ${line}`));
    child.stdout.setEncoding('utf8').on('data', (chunk) => out.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('error', (error) => {
      clearTimeout(timer);
      logger.info(`Claude could not start (${bin}): ${error.message}`);
      resolvePromise({ messages, code: 127, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out.end();
      err.end();
      control.child = null;
      resolvePromise({ messages, code: code ?? (signal ? 128 : 1), timedOut });
    });
  });
}

function clone(logger, { repository, cloneFrom, dir }) {
  const command = cloneFrom ? ['git', ['clone', '--quiet', cloneFrom, dir]] : ['gh', ['repo', 'clone', repository, dir, '--', '--quiet']];
  logger.info(`Cloning ${cloneFrom || repository} into ${dir}`);
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) {
    throw new Error(`${command[0]} clone failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
}

function githubToken(logger) {
  if (process.env.TRAMA_LOCAL_GITHUB_TOKEN) return process.env.TRAMA_LOCAL_GITHUB_TOKEN;
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  logger.info('No GitHub token (gh auth token failed): finish will not be able to open the pull request.');
  return '';
}

function parseJson(name, text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

export async function main() {
  const logger = new Logger(process.env.TRAMA_LOCAL_LOG);
  const control = { cancelled: false, child: null };
  const onSignal = (signal) => {
    if (control.cancelled) return;
    control.cancelled = true;
    logger.info(`${signal}: cancelling; finish will report the attempt as cancelled.`);
    control.child?.kill('SIGTERM');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  let inputs;
  let secrets;
  try {
    inputs = parseJson('TRAMA_LOCAL_INPUTS', process.env.TRAMA_LOCAL_INPUTS, null);
    secrets = parseJson('AGENT_RUNS_LOCAL_SECRETS', process.env.AGENT_RUNS_LOCAL_SECRETS, {});
  } catch (error) {
    logger.info(error.message);
    return 1;
  }
  const repository = process.env.TRAMA_LOCAL_REPOSITORY || '';
  const oidc = process.env.TRAMA_LOCAL_OIDC_TOKEN || '';
  if (!inputs || !inputs.attempt_id || !inputs.api_url || !inputs.secret_name || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !oidc) {
    logger.info('TRAMA_LOCAL_INPUTS (attempt_id, api_url, secret_name, …), TRAMA_LOCAL_REPOSITORY (owner/name) and TRAMA_LOCAL_OIDC_TOKEN are required.');
    return 1;
  }

  const secretName = String(inputs.secret_name);
  const secretValue = typeof secrets?.[secretName] === 'string' ? secrets[secretName] : '';
  const fake = secretValue.startsWith('fake:') ? secretValue.slice(5) : null;
  logger.secret(oidc);
  if (secretValue && secretValue !== 'local' && !fake) logger.secret(secretValue);
  const token = githubToken(logger);
  logger.secret(token);

  const root = mkdtempSync(join(tmpdir(), `trama-agent-${String(inputs.attempt_id).replace(/\W/g, '')}-`));
  const runnerTemp = join(root, 'runner');
  const repoDir = join(root, 'repo');
  const outputFile = join(root, 'github_output');
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(outputFile, '');
  const executionFile = join(runnerTemp, EXECUTION_FILENAME);
  logger.info(
    `Attempt ${inputs.attempt_id} · ${inputs.issue_key || ''} · ${repository} · ${inputs.mode || 'run'} · secret ${secretName}: ${
      !secretValue ? 'missing' : fake ? `fake ${fake}` : secretValue === 'local' ? "this machine's Claude login" : 'token'
    } · ${root}`
  );

  const baseEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PRIVATE_KEYS.includes(key) || /^(GITHUB_|ACTIONS_|RUNNER_|TRAMA_)/.test(key)) continue;
    baseEnv[key] = value;
  }
  Object.assign(baseEnv, {
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKSPACE: repoDir,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: process.env.TRAMA_LOCAL_GITHUB_API_URL || 'https://api.github.com',
  });

  let startCode = 1;
  let claudeOutcome = 'skipped';
  let timedOut = false;
  let cloned = false;
  try {
    clone(logger, { repository, cloneFrom: process.env.TRAMA_LOCAL_CLONE_FROM, dir: repoDir });
    cloned = true;
  } catch (error) {
    logger.info(`${error.message}. Nothing was started; the attempt stays dispatched until Trama marks it lost.`);
  }

  if (cloned) {
    startCode = await runNode(logger, join(ROOT, 'scripts', 'start.mjs'), {
      cwd: repoDir,
      prefix: '[start] ',
      env: {
        ...baseEnv,
        TRAMA_ATTEMPT_ID: String(inputs.attempt_id),
        TRAMA_API_URL: String(inputs.api_url),
        TRAMA_SECRET_NAME: secretName,
        TRAMA_SECRET_PRESENT: secretValue ? 'true' : 'false',
        TRAMA_MODE: String(inputs.mode || 'run'),
        TRAMA_ISSUE_KEY: String(inputs.issue_key || ''),
        TRAMA_BASE_BRANCH: String(inputs.base_branch || ''),
        TRAMA_BRANCH: String(inputs.branch || ''),
        TRAMA_LOCAL_OIDC_TOKEN: oidc,
      },
    });
  }

  if (startCode === 0 && !control.cancelled) {
    const outputs = parseOutputs(readFileSync(outputFile, 'utf8'));
    const mode = outputs.mode || 'run';
    if (inputs.provider && inputs.provider !== 'claude') {
      logger.info(`Provider ${inputs.provider} is not supported; skipping the agent.`);
    } else if (fake) {
      if (!FAKE_OUTCOMES.includes(fake)) {
        logger.info(`Unknown fake outcome "${fake}" (known: ${FAKE_OUTCOMES.join(', ')}); treating it as a failure.`);
        claudeOutcome = 'failure';
      } else {
        logger.info(`Simulating Claude: fake:${fake}`);
        const { messages, outcome } = fakeExecution(fake, {
          cwd: repoDir,
          issueKey: outputs.issue_key || inputs.issue_key,
          attemptId: outputs.attempt_id || inputs.attempt_id,
          mcp: !!outputs.mcp_config_file,
          mode,
        });
        for (const message of messages) {
          const text = describeMessage(message);
          if (text) for (const part of text.split('\n')) logger.line(`[claude] ${part}`);
        }
        writeFileSync(executionFile, JSON.stringify(messages, null, 2));
        claudeOutcome = outcome;
      }
    } else {
      const bin = process.env.TRAMA_LOCAL_CLAUDE_BIN || 'claude';
      const args = claudeArgs(mode, outputs.mcp_config_file, process.env.TRAMA_LOCAL_EXTRA_TOOLS);
      logger.info(`Running ${bin} ${args.join(' ')} (prompt on stdin, ${outputs.prompt?.length ?? 0} characters)`);
      const timeoutMs = (Number(process.env.TRAMA_LOCAL_TIMEOUT_MINUTES) || 60) * 60_000;
      const result = await runClaude(logger, {
        bin,
        args,
        prompt: outputs.prompt || '',
        cwd: repoDir,
        env: claudeEnv(secretValue),
        timeoutMs,
        control,
      });
      writeFileSync(executionFile, JSON.stringify(result.messages, null, 2));
      timedOut = result.timedOut;
      const analysis = analyzeExecution(result.messages);
      claudeOutcome = control.cancelled ? 'cancelled' : result.code === 0 && analysis.ok ? 'success' : 'failure';
      logger.info(`Claude exited with ${result.code}: ${claudeOutcome}`);
    }
  }

  const jobStatus = control.cancelled || timedOut ? 'cancelled' : startCode !== 0 || claudeOutcome === 'failure' ? 'failure' : 'success';
  let finishCode = 1;
  if (cloned) {
    finishCode = await runNode(logger, join(ROOT, 'scripts', 'finish.mjs'), {
      cwd: repoDir,
      prefix: '[finish] ',
      env: {
        ...baseEnv,
        TRAMA_EXECUTION_FILE: executionFile,
        TRAMA_CLAUDE_OUTCOME: claudeOutcome,
        TRAMA_JOB_STATUS: jobStatus,
        TRAMA_TIMEOUT_MINUTES: String(Number(process.env.TRAMA_LOCAL_TIMEOUT_MINUTES) || 60),
        TRAMA_TIMED_OUT: timedOut ? 'true' : 'false',
        GITHUB_TOKEN: token,
      },
    });
  }

  if (process.env.TRAMA_LOCAL_KEEP === '1') {
    logger.info(`Kept ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
  const code = startCode === 0 && finishCode === 0 ? 0 : 1;
  logger.info(`Done (exit ${code}).`);
  return code;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`trama local executor failed: ${error?.stack || error}\n`);
      process.exit(1);
    }
  );
}
