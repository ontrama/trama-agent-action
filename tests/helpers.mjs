// Test helpers: a stub of Trama's API and GitHub's REST API, temp git repositories with a local bare "origin", and
// async runners for the scripts (async, so the stub server in this process keeps answering).

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync as makeTempDir, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Temp dirs made by the tests go away when the test file's process exits.
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export function mkdtempSync(prefix) {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}
export const RUN_TOKEN = 'lxt_at_runtoken_0123456789abcdef';
export const OIDC_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.oidc-claims.signature0123';
export const REQUEST_TOKEN = 'actions-id-token-request-0123';
export const GITHUB_TOKEN = 'ghs_jobtoken0123456789';
export const BRANCH = 'boardp-1713-agent-12';

export function startResponse(base, overrides = {}) {
  return {
    attempt_id: 30,
    run_id: 12,
    mode: 'run',
    task: { id: 7871, issue_key: 'BOARDP-1713', name: 'Implement webhooks', url: 'https://ontrama.com/tasks/7871', board_id: 1 },
    brief: '# BOARDP-1713 Implement webhooks\n\nAdd a webhook endpoint for payments.',
    base_branch: 'main',
    branch: BRANCH,
    continue_from_branch: false,
    pull_request: { title: 'BOARDP-1713 Implement webhooks', body_footer: 'Trama: https://ontrama.com/tasks/7871 · run #12' },
    run_token: RUN_TOKEN,
    run_token_expires_at: '2026-10-24T23:00:00Z',
    api_url: base,
    mcp_url: 'https://mcp.example.test/mcp',
    ...overrides,
  };
}

/**
 * The stub: GET /oidc (GitHub's token endpoint), POST /agent_attempts/:id/start and /report (Trama), POST and GET
 * /repos/:owner/:repo/pulls (GitHub). `handlers.start(request, attemptId)` and `handlers.pulls(request)` may return
 * { status, body } to change the answers.
 */
export async function stubServer(handlers = {}) {
  const requests = [];
  let base = '';
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://stub');
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(entry);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    let match;
    if (req.method === 'GET' && url.pathname === '/oidc') return send(200, { value: OIDC_TOKEN, count: 1 });
    if (req.method === 'POST' && (match = url.pathname.match(/^\/agent_attempts\/(\d+)\/start$/))) {
      const answer = handlers.start?.(entry, match[1]) ?? { status: 200, body: startResponse(base) };
      return send(answer.status, answer.body);
    }
    if (req.method === 'POST' && (match = url.pathname.match(/^\/agent_attempts\/(\d+)\/report$/))) {
      const answer = handlers.report?.(entry, match[1]) ?? {
        status: 200,
        body: { status: entry.body.outcome === 'succeeded' ? 'succeeded' : 'failed', next: 'done' },
      };
      return send(answer.status, answer.body);
    }
    if (req.method === 'POST' && (match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
      const answer = handlers.pulls?.(entry) ?? { status: 201, body: { html_url: `https://github.com/${match[1]}/${match[2]}/pull/40`, number: 40 } };
      return send(answer.status, answer.body);
    }
    if (req.method === 'GET' && (match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
      return send(200, [{ html_url: `https://github.com/${match[1]}/${match[2]}/pull/39`, number: 39 }]);
    }
    return send(404, { error: 'not found' });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => new Promise((done) => server.close(done)),
    to: (method, pattern) => requests.filter((request) => request.method === method && pattern.test(request.path)),
  };
}

const gitConfig = join(mkdtempSync(join(tmpdir(), 'trama-gitconfig-')), 'gitconfig');
writeFileSync(gitConfig, '[init]\n\tdefaultBranch = main\n');

export const GIT_ENV = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

export function git(args, cwd) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare origin with one commit on main, and a checkout of it (what actions/checkout leaves). */
export function makeRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'trama-action-test-'));
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  const work = join(dir, 'work');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(runnerTemp);
  git(['init', '-q', '--bare', '-b', 'main', remote], dir);
  git(['init', '-q', '-b', 'main', seed], dir);
  writeFileSync(join(seed, 'README.md'), '# acme/web\n');
  git(['add', '.'], seed);
  git(['commit', '-q', '-m', 'Initial commit'], seed);
  git(['push', '-q', remote, 'main'], seed);
  git(['clone', '-q', remote, work], dir);
  const outputFile = join(dir, 'github_output');
  writeFileSync(outputFile, '');
  return { dir, remote, seed, work, runnerTemp, outputFile };
}

/** Pushes a branch with one commit to origin, as an earlier attempt would have. */
export function pushBranch(repos, branch, file = 'WIP.md') {
  git(['checkout', '-q', '-b', branch], repos.seed);
  writeFileSync(join(repos.seed, file), 'work in progress\n');
  git(['add', '.'], repos.seed);
  git(['commit', '-q', '-m', 'WIP BOARDP-1713: attempt 1 stopped'], repos.seed);
  git(['push', '-q', repos.remote, branch], repos.seed);
  git(['checkout', '-q', 'main'], repos.seed);
}

export function remoteLog(repos, branch) {
  const result = spawnSync('git', ['log', '--format=%s', `refs/heads/${branch}`], { cwd: repos.remote, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return result.status === 0 ? result.stdout.trim().split('\n') : null;
}

export function remoteFile(repos, branch, path) {
  const result = spawnSync('git', ['show', `refs/heads/${branch}:${path}`], { cwd: repos.remote, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return result.status === 0 ? result.stdout : null;
}

/** The environment of a GitHub-hosted job for the scripts, without anything of this process's GitHub/Trama vars. */
export function jobEnv(repos, server, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(GITHUB_|ACTIONS_|RUNNER_|TRAMA_|AGENT_RUNS_)/.test(key)) env[key] = value;
  }
  return {
    ...env,
    ...GIT_ENV,
    RUNNER_TEMP: repos.runnerTemp,
    GITHUB_OUTPUT: repos.outputFile,
    GITHUB_REPOSITORY: 'acme/web',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: server.base,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${server.base}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    TRAMA_ATTEMPT_ID: '30',
    TRAMA_API_URL: server.base,
    TRAMA_SECRET_NAME: 'TRAMA_CLAUDE_MAX_JP',
    TRAMA_SECRET_PRESENT: 'true',
    TRAMA_MODE: 'run',
    TRAMA_ISSUE_KEY: 'BOARDP-1713',
    TRAMA_BASE_BRANCH: 'main',
    TRAMA_BRANCH: BRANCH,
    ...extra,
  };
}

/** Runs a script with node (async). Resolves { code, stdout, stderr }. */
export function runScript(script, { cwd, env, input } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, script)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(input ?? '');
    child.on('close', (code) => done({ code, stdout, stderr, child }));
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Claude's result messages, as claude-code-action's execution file holds them. */
export function resultMessages({ result = 'Done.', isError = false, subtype = 'success', sessionId = 'session-1', extra = [] } = {}) {
  return [
    { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-4-5', permissionMode: 'acceptEdits', mcp_servers: [] },
    ...extra,
    { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: result }], usage: { input_tokens: 5, output_tokens: 50 } }, session_id: sessionId },
    {
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: 4210,
      num_turns: 3,
      result,
      session_id: sessionId,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, cache_creation_input_tokens: 2560, cache_read_input_tokens: 18432, output_tokens: 300 },
      permission_denials: [],
    },
  ];
}

/** Every line of `text` that holds `secret` is an ::add-mask:: command (which the runner swallows). */
export function onlyMasked(text, secret) {
  return String(text)
    .split('\n')
    .filter((line) => line.includes(secret))
    .every((line) => line.startsWith('::add-mask::'));
}
