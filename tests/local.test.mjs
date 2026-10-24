import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANCH, GIT_ENV, ROOT, RUN_TOKEN, makeRepos, remoteFile, remoteLog, runScript, startResponse, stubServer } from './helpers.mjs';

const OIDC = 'local-hs256-oidc-token-123';
const GH_TOKEN = 'ghs_local_machine_token_123';
const FAKE_CLAUDE = join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs');

/** A stub API (start answers per attempt id), a bare origin to clone from, and run.mjs's environment. */
async function setup(t, { startFor = () => ({}) } = {}) {
  const server = await stubServer({
    start: (_request, attemptId) => ({ status: 200, body: startResponse(server.base, { attempt_id: Number(attemptId), ...startFor(attemptId) }) }),
  });
  t.after(() => server.close());
  const repos = makeRepos();
  const tmp = mkdtempSync(join(tmpdir(), 'trama-local-test-'));
  const log = join(tmp, 'run.log');
  const envFor = ({ secrets = {}, inputs = {}, env = {} } = {}) => {
    const base = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(GITHUB_|ACTIONS_|RUNNER_|TRAMA_|AGENT_RUNS_)/.test(key)) base[key] = value;
    }
    return {
      ...base,
      ...GIT_ENV,
      TMPDIR: tmp,
      TRAMA_LOCAL_INPUTS: JSON.stringify({
        attempt_id: '30',
        issue_key: 'BOARDP-1713',
        provider: 'claude',
        kind: 'oauth_token',
        secret_name: 'TRAMA_CLAUDE_MAX_JP',
        base_branch: 'main',
        branch: BRANCH,
        mode: 'run',
        api_url: server.base,
        ...inputs,
      }),
      TRAMA_LOCAL_OIDC_TOKEN: OIDC,
      TRAMA_LOCAL_REPOSITORY: 'acme/web',
      TRAMA_LOCAL_LOG: log,
      AGENT_RUNS_LOCAL_SECRETS: JSON.stringify(secrets),
      TRAMA_LOCAL_CLONE_FROM: repos.remote,
      TRAMA_LOCAL_GITHUB_TOKEN: GH_TOKEN,
      TRAMA_LOCAL_GITHUB_API_URL: server.base,
      ...env,
    };
  };
  const run = (options) => runScript('local/run.mjs', { cwd: tmp, env: envFor(options) });
  const reports = (attemptId = '30') => server.to('POST', new RegExp(`^/agent_attempts/${attemptId}/report$`));
  return { server, repos, tmp, log, run, envFor, reports };
}

function assertNoSecrets(text, secrets) {
  for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 12)}…`);
}

test('local fake:success clones, starts with the local token, commits, pushes, opens the PR and reports it', async (t) => {
  const { server, repos, tmp, log, run, reports } = await setup(t);
  const result = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: 'fake:success' } });
  assert.equal(result.code, 0, result.stdout + result.stderr);

  assert.equal(server.to('POST', /\/start$/)[0].headers.authorization, `Bearer ${OIDC}`);
  assert.deepEqual(remoteLog(repos, BRANCH), ['BOARDP-1713: add a line to TRAMA_AGENT_LOG.md', 'Initial commit']);
  assert.match(remoteFile(repos, BRANCH, 'TRAMA_AGENT_LOG.md'), /BOARDP-1713 · attempt 30: fake success/);
  const [pr] = server.to('POST', /pulls$/);
  assert.equal(pr.headers.authorization, `Bearer ${GH_TOKEN}`);
  assert.equal(pr.body.title, 'BOARDP-1713 Implement webhooks');
  assert.equal(pr.body.head, BRANCH);
  assert.match(pr.body.body, /fake local run/);
  const [report] = reports();
  assert.equal(report.headers.authorization, `Bearer ${RUN_TOKEN}`);
  assert.equal(report.body.outcome, 'succeeded');
  assert.equal(report.body.pull_request_url, 'https://github.com/acme/web/pull/40');
  assert.equal(report.body.usage.cost_usd, 0.0123);

  const logText = readFileSync(log, 'utf8');
  assert.match(logText, /Simulating Claude: fake:success/);
  assert.match(logText, /\[finish\] Opened pull request: https:\/\/github.com\/acme\/web\/pull\/40/);
  assertNoSecrets(logText + result.stdout + result.stderr, [RUN_TOKEN, OIDC, GH_TOKEN]);
  assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith('trama-agent-')), [], 'temp dir removed');
});

test('local: a plan limit pushes WIP, and the next attempt on another account continues from the branch', async (t) => {
  const { repos, run, reports } = await setup(t, {
    startFor: (attemptId) => (attemptId === '31' ? { continue_from_branch: true, attempt_number: 2 } : { attempt_number: 1 }),
  });
  const first = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: 'fake:plan_limit', TRAMA_CLAUDE_PRO_ANA: 'fake:success' } });
  assert.equal(first.code, 1);
  const [limited] = reports('30');
  assert.equal(limited.body.outcome, 'failed');
  assert.equal(limited.body.error_type, 'usage_limit_reached');
  assert.equal(limited.body.api_error_status, 429);
  assert.match(limited.body.resets_at, /T22:00:00\.000Z$/);
  assert.equal(limited.body.wip_pushed, true);
  assert.deepEqual(remoteLog(repos, BRANCH), ['WIP BOARDP-1713: attempt 1 stopped', 'Initial commit']);

  const second = await run({
    secrets: { TRAMA_CLAUDE_MAX_JP: 'fake:plan_limit', TRAMA_CLAUDE_PRO_ANA: 'fake:success' },
    inputs: { attempt_id: '31', secret_name: 'TRAMA_CLAUDE_PRO_ANA' },
  });
  assert.equal(second.code, 0, second.stdout);
  const [done] = reports('31');
  assert.equal(done.body.outcome, 'succeeded');
  assert.equal(done.body.pull_request_url, 'https://github.com/acme/web/pull/40');
  assert.deepEqual(remoteLog(repos, BRANCH), ['BOARDP-1713: add a line to TRAMA_AGENT_LOG.md', 'WIP BOARDP-1713: attempt 1 stopped', 'Initial commit']);
  const lines = remoteFile(repos, BRANCH, 'TRAMA_AGENT_LOG.md');
  assert.match(lines, /attempt 30: stopped by a plan limit/);
  assert.match(lines, /attempt 31: fake success/);
});

test('local fake:rate_limited and fake:login_failed report the failure without a branch', async (t) => {
  const { repos, run, reports } = await setup(t);
  const rate = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: 'fake:rate_limited' } });
  assert.equal(rate.code, 1);
  assert.deepEqual(
    [reports()[0].body.outcome, reports()[0].body.error_type, reports()[0].body.api_error_status, reports()[0].body.wip_pushed],
    ['failed', 'rate_limit', 429, false]
  );
  assert.match(reports()[0].body.error_text, /API Error: 429 rate_limit_error/);

  const login = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: 'fake:login_failed' }, inputs: { attempt_id: '32' } });
  assert.equal(login.code, 1);
  const [report] = reports('32');
  assert.deepEqual([report.body.error_type, report.body.api_error_status], ['authentication_failed', 401]);
  assert.match(report.body.error_text, /Please run \/login/);
  assert.equal(remoteLog(repos, BRANCH), null);
});

test('local: a secret missing from AGENT_RUNS_LOCAL_SECRETS is reported once as secret_missing', async (t) => {
  const { server, run, reports } = await setup(t);
  const result = await run({ secrets: { TRAMA_OTHER: 'fake:success' } });
  assert.equal(result.code, 1);
  assert.equal(reports().length, 1);
  assert.equal(reports()[0].body.error_type, 'secret_missing');
  assert.equal(server.to('POST', /pulls$/).length, 0);
});

test('local check mode with fake:success reports OK without a branch', async (t) => {
  const { repos, run, reports } = await setup(t, { startFor: () => ({ mode: 'check', branch: null }) });
  const result = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: 'fake:success' }, inputs: { mode: 'check', branch: '' } });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(reports()[0].body.outcome, 'succeeded');
  assert.equal(reports()[0].body.result_text, 'OK');
  assert.equal(remoteLog(repos, BRANCH), null);
});

test('local with a token runs claude -p with stream-json, the MCP config and safe permissions, and the token in its env only', async (t) => {
  const { repos, tmp, log, run, reports } = await setup(t);
  const secret = 'sk-ant-oat01-test-secret-value';
  const result = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: secret }, env: { TRAMA_LOCAL_CLAUDE_BIN: FAKE_CLAUDE } });
  assert.equal(result.code, 0, result.stdout + result.stderr);

  const record = JSON.parse(readFileSync(join(tmp, 'fake-claude-record.json'), 'utf8'));
  for (const flag of ['-p', '--verbose', '--strict-mcp-config']) assert.ok(record.argv.includes(flag), flag);
  const value = (flag) => record.argv[record.argv.indexOf(flag) + 1];
  assert.equal(value('--output-format'), 'stream-json');
  assert.equal(value('--permission-mode'), 'acceptEdits');
  assert.equal(value('--setting-sources'), 'project');
  const tools = value('--allowedTools').split(',');
  assert.ok(tools.includes('Bash(git commit:*)') && tools.includes('mcp__trama'));
  assert.ok(!tools.some((tool) => /^(Edit|Write|Bash)$/.test(tool)), 'file tools stay with acceptEdits (inside the clone); no free Bash');
  assert.ok(!record.argv.includes('--dangerously-skip-permissions'));
  assert.deepEqual(record.mcpConfig.mcpServers.trama.headers, { Authorization: `Bearer ${RUN_TOKEN}` });
  assert.equal(record.env.CLAUDE_CODE_OAUTH_TOKEN, secret);
  for (const key of ['AGENT_RUNS_LOCAL_SECRETS', 'TRAMA_LOCAL_OIDC_TOKEN', 'TRAMA_LOCAL_INPUTS', 'GITHUB_TOKEN', 'TRAMA_LOCAL_GITHUB_TOKEN']) {
    assert.ok(!(key in record.env), `${key} reached Claude`);
  }
  assert.match(record.cwd, /\/repo$/);
  assert.match(record.prompt, /^# BOARDP-1713 Implement webhooks/);

  assert.deepEqual(remoteLog(repos, BRANCH), ['BOARDP-1713: Wrote from-claude.txt with a greeting.', 'Initial commit']);
  assert.equal(reports()[0].body.outcome, 'succeeded');
  assert.equal(reports()[0].body.session_id, 'fake-session-1');
  assertNoSecrets(readFileSync(log, 'utf8') + result.stdout, [secret, RUN_TOKEN, OIDC, GH_TOKEN]);

  const machine = await run({ secrets: { TRAMA_CLAUDE_MAX_JP: 'local' }, inputs: { attempt_id: '33' }, env: { TRAMA_LOCAL_CLAUDE_BIN: FAKE_CLAUDE, CLAUDE_CODE_OAUTH_TOKEN: 'from-the-api-env' } });
  assert.equal(machine.code, 0, machine.stdout);
  const second = JSON.parse(readFileSync(join(tmp, 'fake-claude-record.json'), 'utf8'));
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in second.env), "local uses this machine's login: no token");
});

test('local: Claude past TRAMA_LOCAL_TIMEOUT_MINUTES is stopped and reported as a timeout', async (t) => {
  const { tmp, run, reports } = await setup(t);
  writeFileSync(join(tmp, 'fake-claude-mode'), 'sleep');
  const result = await run({
    secrets: { TRAMA_CLAUDE_MAX_JP: 'sk-ant-oat01-x-secret' },
    env: { TRAMA_LOCAL_CLAUDE_BIN: FAKE_CLAUDE, TRAMA_LOCAL_TIMEOUT_MINUTES: '0.02' },
  });
  assert.equal(result.code, 1);
  assert.equal(reports()[0].body.outcome, 'timeout');
});

test('local: SIGTERM cancels Claude and finish reports cancelled', async (t) => {
  const { tmp, envFor, reports } = await setup(t);
  writeFileSync(join(tmp, 'fake-claude-mode'), 'sleep');
  const child = spawn(process.execPath, [join(ROOT, 'local', 'run.mjs')], {
    cwd: tmp,
    env: envFor({ secrets: { TRAMA_CLAUDE_MAX_JP: 'sk-ant-oat01-y-secret' }, env: { TRAMA_LOCAL_CLAUDE_BIN: FAKE_CLAUDE } }),
  });
  let stdout = '';
  const code = await new Promise((done) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (/\[claude\] session fake-session-1/.test(stdout) && !child.killed) child.kill('SIGTERM');
    });
    child.on('close', done);
  });
  assert.equal(code, 1, stdout);
  assert.equal(reports()[0].body.outcome, 'cancelled');
});
