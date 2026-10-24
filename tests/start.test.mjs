import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseOutputs } from '../scripts/lib.mjs';
import { BRANCH, OIDC_TOKEN, REQUEST_TOKEN, RUN_TOKEN, git, jobEnv, makeRepos, onlyMasked, pushBranch, readJson, runScript, startResponse, stubServer } from './helpers.mjs';

const mode = (path) => statSync(path).mode & 0o777;

test('start: OIDC token for the API, start request, run branch, private state and the outputs for Claude', async (t) => {
  const server = await stubServer();
  t.after(() => server.close());
  const repos = makeRepos();
  const { code, stdout, stderr } = await runScript('scripts/start.mjs', { cwd: repos.work, env: jobEnv(repos, server) });
  assert.equal(code, 0, stdout + stderr);

  const [oidc] = server.to('GET', /^\/oidc$/);
  assert.equal(oidc.headers.authorization, `Bearer ${REQUEST_TOKEN}`);
  assert.equal(oidc.query.audience, server.base);
  assert.equal(oidc.query['api-version'], '2.0');

  const [start] = server.to('POST', /^\/agent_attempts\/30\/start$/);
  assert.equal(start.headers.authorization, `Bearer ${OIDC_TOKEN}`);
  assert.deepEqual(start.body, {
    github_run_id: '123',
    github_run_attempt: '1',
    github_repository: 'acme/web',
    github_run_url: 'https://github.com/acme/web/actions/runs/123',
  });

  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repos.work), BRANCH);
  assert.equal(git(['config', '--local', 'user.name'], repos.work), 'trama-agent[bot]');

  const statePath = join(repos.runnerTemp, 'trama', 'state.json');
  assert.equal(mode(statePath), 0o600);
  const state = readJson(statePath);
  assert.equal(state.run_token, RUN_TOKEN);
  assert.equal(state.attempt_id, 30);
  assert.equal(state.branch, BRANCH);
  assert.equal(state.base_sha, git(['rev-parse', 'origin/main'], repos.work));
  assert.equal(state.pull_request.title, 'BOARDP-1713 Implement webhooks');
  assert.equal(state.reported, false);

  const outputs = parseOutputs(readFileSync(repos.outputFile, 'utf8'));
  assert.equal(outputs.mode, 'run');
  assert.equal(outputs.branch, BRANCH);
  assert.equal(outputs.attempt_id, '30');
  assert.equal(outputs.run_id, '12');
  assert.match(outputs.prompt, /^# BOARDP-1713 Implement webhooks\n\nAdd a webhook endpoint for payments\./);
  assert.match(outputs.prompt, /## How this run works/);
  assert.match(outputs.prompt, /on the branch `boardp-1713-agent-12`, created from `main`/);
  assert.equal(readFileSync(outputs.prompt_file, 'utf8'), outputs.prompt);
  assert.equal(outputs.prompt_file, join(repos.runnerTemp, 'trama', 'brief.md'));

  const args = outputs.claude_args;
  const mcp = JSON.parse(args.match(/--mcp-config '([^']+)'/)[1]);
  assert.deepEqual(mcp, {
    mcpServers: { trama: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: `Bearer ${RUN_TOKEN}` } } },
  });
  assert.match(args, /--permission-mode acceptEdits/);
  const tools = args.match(/--allowedTools '([^']+)'/)[1].split(',');
  for (const tool of ['Edit', 'Write', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'mcp__trama']) assert.ok(tools.includes(tool), tool);
  assert.ok(!tools.some((tool) => /push|^Bash$/.test(tool)), 'no push and no unrestricted Bash');
  assert.equal(mode(outputs.mcp_config_file), 0o600);
  assert.deepEqual(readJson(outputs.mcp_config_file), mcp);

  assert.ok(onlyMasked(stdout, RUN_TOKEN), 'the run token only appears in ::add-mask::');
  assert.ok(onlyMasked(stdout, OIDC_TOKEN), 'the OIDC token only appears in ::add-mask::');
  assert.ok(!stderr.includes(RUN_TOKEN));
});

test('start: refuses a secret name outside TRAMA_* before calling anyone', async (t) => {
  const server = await stubServer();
  t.after(() => server.close());
  const repos = makeRepos();
  for (const name of ['GITHUB_TOKEN', 'TRAMA_', 'trama_lower', 'TRAMA_X-Y']) {
    const { code, stdout } = await runScript('scripts/start.mjs', { cwd: repos.work, env: jobEnv(repos, server, { TRAMA_SECRET_NAME: name }) });
    assert.equal(code, 1, name);
    assert.match(stdout, /::error::secret_name must match/);
  }
  assert.equal(server.requests.length, 0);
  assert.ok(!existsSync(join(repos.runnerTemp, 'trama', 'state.json')));
});

test('start: a missing secret is reported once as secret_missing, and finish does not report again', async (t) => {
  const server = await stubServer();
  t.after(() => server.close());
  const repos = makeRepos();
  const env = jobEnv(repos, server, { TRAMA_SECRET_PRESENT: 'false' });
  const start = await runScript('scripts/start.mjs', { cwd: repos.work, env });
  assert.equal(start.code, 1);
  const reports = server.to('POST', /\/report$/);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].headers.authorization, `Bearer ${RUN_TOKEN}`);
  assert.equal(reports[0].body.outcome, 'failed');
  assert.equal(reports[0].body.error_type, 'secret_missing');
  assert.match(reports[0].body.error_text, /No GitHub secret named TRAMA_CLAUDE_MAX_JP/);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repos.work), 'main', 'no branch for a run that cannot start');

  const finish = await runScript('scripts/finish.mjs', { cwd: repos.work, env: { ...env, TRAMA_CLAUDE_OUTCOME: 'skipped', TRAMA_JOB_STATUS: 'failure' } });
  assert.equal(finish.code, 0);
  assert.match(finish.stdout, /already reported/);
  assert.equal(server.to('POST', /\/report$/).length, 1);
});

test('start: continue_from_branch checks out the pushed branch; an existing branch is continued even when not asked', async (t) => {
  for (const continueFlag of [true, false]) {
    const server = await stubServer({ start: (_req) => ({ status: 200, body: startResponse(server.base, { continue_from_branch: continueFlag, attempt_number: 2 }) }) });
    t.after(() => server.close());
    const repos = makeRepos();
    pushBranch(repos, BRANCH);
    const { code, stdout } = await runScript('scripts/start.mjs', { cwd: repos.work, env: jobEnv(repos, server) });
    assert.equal(code, 0, stdout);
    assert.equal(git(['log', '-1', '--format=%s'], repos.work), 'WIP BOARDP-1713: attempt 1 stopped');
    assert.ok(existsSync(join(repos.work, 'WIP.md')));
    const outputs = parseOutputs(readFileSync(repos.outputFile, 'utf8'));
    assert.equal(outputs.continue_from_branch, 'true');
    assert.match(outputs.prompt, /already has the commits of an earlier attempt/);
    if (!continueFlag) assert.match(stdout, /::warning::origin already has boardp-1713-agent-12/);
    assert.equal(readJson(join(repos.runnerTemp, 'trama', 'state.json')).attempt_number, 2);
  }
});

test('start: check mode makes no branch and asks Claude for OK', async (t) => {
  const server = await stubServer({ start: () => ({ status: 200, body: startResponse(server.base, { mode: 'check', branch: null }) }) });
  t.after(() => server.close());
  const repos = makeRepos();
  const { code, stdout } = await runScript('scripts/start.mjs', { cwd: repos.work, env: jobEnv(repos, server, { TRAMA_MODE: 'check', TRAMA_BRANCH: '' }) });
  assert.equal(code, 0, stdout);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repos.work), 'main');
  const outputs = parseOutputs(readFileSync(repos.outputFile, 'utf8'));
  assert.equal(outputs.mode, 'check');
  assert.equal(outputs.branch, '');
  assert.match(outputs.prompt, /Reply with the single word OK/);
  assert.equal(outputs.claude_args, '--max-turns 1');
  assert.equal(outputs.mcp_config_file, '');
});

test('start: an API refusal stops without state (Trama marks the attempt lost)', async (t) => {
  const server = await stubServer({ start: () => ({ status: 409, body: { error: 'attempt is not dispatched' } }) });
  t.after(() => server.close());
  const repos = makeRepos();
  const { code, stdout } = await runScript('scripts/start.mjs', { cwd: repos.work, env: jobEnv(repos, server) });
  assert.equal(code, 1);
  assert.match(stdout, /::error::Trama did not start attempt 30: .*409: attempt is not dispatched.*already started/);
  assert.ok(!existsSync(join(repos.runnerTemp, 'trama', 'state.json')));
  assert.equal(server.to('POST', /\/report$/).length, 0);
});

test('start: a base branch that does not exist is reported as a setup failure', async (t) => {
  const server = await stubServer({ start: () => ({ status: 200, body: startResponse(server.base, { base_branch: 'develop' }) }) });
  t.after(() => server.close());
  const repos = makeRepos();
  const { code } = await runScript('scripts/start.mjs', { cwd: repos.work, env: jobEnv(repos, server) });
  assert.equal(code, 1);
  const [report] = server.to('POST', /\/report$/);
  assert.equal(report.body.error_type, 'setup_failed');
  assert.match(report.body.error_text, /base branch develop could not be fetched/);
});

test('start: TRAMA_LOCAL_OIDC_TOKEN replaces the GitHub OIDC request', async (t) => {
  const server = await stubServer();
  t.after(() => server.close());
  const repos = makeRepos();
  const env = jobEnv(repos, server, { TRAMA_LOCAL_OIDC_TOKEN: 'local-hs256-token' });
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const { code } = await runScript('scripts/start.mjs', { cwd: repos.work, env });
  assert.equal(code, 0);
  assert.equal(server.to('GET', /oidc/).length, 0);
  assert.equal(server.to('POST', /\/start$/)[0].headers.authorization, 'Bearer local-hs256-token');
});
