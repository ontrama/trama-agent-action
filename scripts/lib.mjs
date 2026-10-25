// Shared by start.mjs, finish.mjs and local/run.mjs. Node 20+, no dependencies.
//
// The GitHub runner protocol used here: `::add-mask::`, `::warning::`, `::error::` workflow commands on stdout and
// step outputs appended to the $GITHUB_OUTPUT file (heredoc syntax, so values may span lines).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SECRET_NAME = /^TRAMA_[A-Z0-9_]+$/;
export const SECRET_NAME_MAX = 100;
export const ERROR_TEXT_MAX_BYTES = 8 * 1024;
export const RESULT_TEXT_MAX = 60_000;
export const GIT_USER = { name: 'trama-agent[bot]', email: 'trama-agent[bot]@users.noreply.github.com' };
export const CHECK_PROMPT = 'This is a connection check from Trama. Reply with the single word OK.';
export const EXECUTION_FILENAME = 'claude-execution-output.json';
export const USER_AGENT = 'trama-agent-action/1';

// Tools Claude may use in a run: edit files, read-only and committing git commands, and Trama's MCP server (whose
// run token only reaches the run's task). Pushing and opening the pull request are left to the finish step.
export const GIT_TOOLS = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git rm:*)',
  'Bash(git mv:*)',
  'Bash(git restore:*)',
  'Bash(ls:*)',
  'Bash(pwd)',
];
export const FILE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite'];
export const MCP_SERVER_NAME = 'trama';

// Logging and masking ----------------------------------------------------------------------------------------------

const secrets = new Set();

/** Registers a value to hide: the runner masks it in the job log, and redact() removes it from what we print. */
export function mask(value) {
  if (typeof value !== 'string' || value.length < 4 || secrets.has(value)) return;
  secrets.add(value);
  for (const line of value.split(/\r?\n/)) {
    if (line.trim().length >= 4) process.stdout.write(`::add-mask::${line}\n`);
  }
}

/** Known secrets and URL credentials (https://user:token@host) replaced by ***. */
export function redact(text) {
  let out = String(text ?? '');
  for (const secret of secrets) out = out.split(secret).join('***');
  return out.replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@');
}

export function log(message) {
  process.stdout.write(`${redact(message)}\n`);
}

/** Workflow command data: %, CR and LF escaped as the runner expects. */
function commandData(message) {
  return redact(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function warn(message) {
  process.stdout.write(`::warning::${commandData(message)}\n`);
}

export function fail(message) {
  process.stdout.write(`::error::${commandData(message)}\n`);
}

// Environment, outputs and state -----------------------------------------------------------------------------------

export function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

export function runnerTemp() {
  return env('RUNNER_TEMP') || tmpdir();
}

export function tramaDir() {
  const dir = join(runnerTemp(), 'trama');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function statePath() {
  return join(tramaDir(), 'state.json');
}

/** Writes a step output; heredoc syntax with a random delimiter, so any value (multi-line too) is safe. */
export function setOutput(name, value) {
  const file = env('GITHUB_OUTPUT');
  const text = value === undefined || value === null ? '' : String(value);
  if (!file) {
    warn(`GITHUB_OUTPUT is not set; output ${name} is lost.`);
    return;
  }
  let delimiter = `ghadelimiter_${randomUUID()}`;
  while (text.includes(delimiter)) delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

/** Reads a $GITHUB_OUTPUT file back (heredoc and name=value lines). */
export function parseOutputs(text) {
  const outputs = {};
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heredoc = line.match(/^([^=<\s]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const value = [];
      i += 1;
      while (i < lines.length && lines[i] !== delimiter) value.push(lines[i++]);
      outputs[name] = value.join('\n');
      continue;
    }
    const pair = line.match(/^([^=\s]+)=(.*)$/);
    if (pair) outputs[pair[1]] = pair[2];
  }
  return outputs;
}

export function writeState(state) {
  const path = statePath();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readState() {
  const path = statePath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writePrivateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// HTTP -------------------------------------------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JSON request with retries on network errors and 5xx (3 tries, 2 s then 4 s apart). Throws HttpError on 4xx/5xx
 * with the parsed body; `token` goes in `Authorization: Bearer`.
 */
export async function request(method, url, { token, body, headers = {}, tries = 3, timeoutMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text.slice(0, 500) };
        }
      }
      if (response.ok) return { status: response.status, data };
      const message = describeError(data) || response.statusText || 'request failed';
      const error = new HttpError(`${method} ${new URL(url).pathname} → ${response.status}: ${message}`, response.status, data);
      if (response.status < 500 || attempt === tries) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof HttpError && (error.status < 500 || attempt === tries)) throw error;
      lastError = error;
      if (attempt === tries) break;
    }
    await sleep(2000 * attempt);
  }
  throw lastError instanceof HttpError ? lastError : new HttpError(`${method} ${url} failed: ${lastError?.message ?? lastError}`, 0, null);
}

function describeError(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [data.error, data.message, data.error_description].filter((part) => typeof part === 'string' && part);
  if (Array.isArray(data.errors)) {
    for (const item of data.errors) parts.push(typeof item === 'string' ? item : item?.message || item?.code || '');
  }
  return [...new Set(parts.filter(Boolean))].join(' · ');
}

export function apiBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

/** POST /agent_attempts/:id/report with the run token (the API revokes the token once it has the report). */
export async function sendReport(state, report) {
  const url = `${apiBase(state.api_url)}/agent_attempts/${encodeURIComponent(state.attempt_id)}/report`;
  return request('POST', url, { token: state.run_token, body: report });
}

// Git --------------------------------------------------------------------------------------------------------------

export class GitError extends Error {}

/** Runs git; returns { code, stdout, stderr }. Throws GitError (credentials redacted) unless allowFail. */
export function git(args, { cwd = process.cwd(), allowFail = false, input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = { code: result.status ?? 1, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
  if (result.error) out.stderr = `${out.stderr}\n${result.error.message}`.trim();
  if (out.code !== 0 && !allowFail) {
    throw new GitError(`git ${args[0]} failed: ${redact(out.stderr || out.stdout || `exit ${out.code}`)}`);
  }
  return out;
}

/** A branch name git accepts and that can't be read as an option. */
export function validBranch(name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
  return git(['check-ref-format', '--branch', name], { allowFail: true }).code === 0;
}

export function identityArgs(user = GIT_USER) {
  return ['-c', `user.name=${user.name}`, '-c', `user.email=${user.email}`, '-c', 'commit.gpgsign=false'];
}

/** Commits everything that isn't committed yet (gitignored files excepted). Returns true when it made a commit. */
export function commitAll(message, { cwd, user } = {}) {
  git(['add', '-A'], { cwd });
  if (git(['diff', '--cached', '--quiet'], { cwd, allowFail: true }).code === 0) return false;
  git([...identityArgs(user), 'commit', '--no-verify', '-q', '-m', message], { cwd });
  return true;
}

export function commitsAhead(baseSha, { cwd } = {}) {
  if (!baseSha) return Number(git(['rev-list', '--count', 'HEAD'], { cwd }).stdout) || 0;
  const result = git(['rev-list', '--count', `${baseSha}..HEAD`], { cwd, allowFail: true });
  return result.code === 0 ? Number(result.stdout) || 0 : 0;
}

// Report -----------------------------------------------------------------------------------------------------------

/**
 * The body of POST /agent_attempts/:id/report (trama docs/AGENT_RUNS.md, "Report"), every key present.
 * usage.input_tokens counts all prompt tokens (plain input + cache writes + cache reads); the cache parts are also
 * sent on their own.
 */
export function buildReport(fields = {}) {
  return {
    outcome: fields.outcome || 'failed',
    result_text: fields.result_text ?? null,
    error_text: fields.error_text ?? null,
    error_type: fields.error_type ?? null,
    api_error_status: fields.api_error_status ?? null,
    resets_at: fields.resets_at ?? null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      ...(fields.usage || {}),
    },
    session_id: fields.session_id ?? null,
    wip_pushed: fields.wip_pushed === true,
    no_changes: fields.no_changes === true,
    pull_request_url: fields.pull_request_url ?? null,
    branch_pushed: fields.branch_pushed === true,
    pull_request: fields.pull_request ?? null,
  };
}

// Scripts ----------------------------------------------------------------------------------------------------------

/** True when `metaUrl` (import.meta.url) is the script node was started with. */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Text -------------------------------------------------------------------------------------------------------------

/** The last `maxBytes` bytes of a text, cut on a character boundary. */
export function tailBytes(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/** A commit subject from Claude's summary: its first line that isn't a Markdown heading, list marker and bold removed. */
export function firstLine(text, max = 72) {
  const lines = String(text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
  const pick = lines.find((part) => !/^#{1,6}\s/.test(part)) ?? lines[0] ?? '';
  const line = pick
    .replace(/^(#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '')
    .replace(/\*\*/g, '')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Single-quotes a value for claude_args (claude-code-action parses it with shell-quote). */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
