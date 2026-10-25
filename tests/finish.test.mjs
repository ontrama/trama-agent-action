import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeExecution } from '../local/fake.mjs';
import { decideOutcome } from '../scripts/finish.mjs';
import {
  BRANCH,
  GITHUB_TOKEN,
  RUN_TOKEN,
  git,
  jobEnv,
  makeRepos,
  onlyMasked,
  readJson,
  remoteFile,
  remoteLog,
  resultMessages,
  runScript,
  startResponse,
  stubServer,
} from './helpers.mjs';

/** Runs start, lets `claude` change the checkout, writes the execution file and runs finish. */
async function attempt(t, { startOverrides = {}, claude = () => {}, messages, claudeOutcome = 'success', jobStatus, env = {}, pulls } = {}) {
  const server = await stubServer({
    start: () => ({ status: 200, body: startResponse(server.base, startOverrides) }),
    pulls,
  });
  t.after(() => server.close());
  const repos = makeRepos();
  const baseEnv = jobEnv(repos, server, env);
  const start = await runScript('scripts/start.mjs', { cwd: repos.work, env: baseEnv });
  assert.equal(start.code, 0, start.stdout + start.stderr);
  claude(repos);
  const executionFile = join(repos.runnerTemp, 'claude-execution-output.json');
  if (messages) writeFileSync(executionFile, JSON.stringify(messages, null, 2));
  const finish = await runScript('scripts/finish.mjs', {
    cwd: repos.work,
    env: {
      ...baseEnv,
      TRAMA_EXECUTION_FILE: messages ? executionFile : '',
      TRAMA_CLAUDE_OUTCOME: claudeOutcome,
      TRAMA_JOB_STATUS: jobStatus ?? (claudeOutcome === 'success' ? 'success' : 'failure'),
    },
  });
  const reports = server.to('POST', /^\/agent_attempts\/30\/report$/);
  return { server, repos, start, finish, reports, report: reports[0]?.body, baseEnv };
}

const commitFile = (repos, file, message) => {
  writeFileSync(join(repos.work, file), `${file}\n`);
  git(['add', file], repos.work);
  git(['commit', '-q', '-m', message], repos.work);
};

test('finish: success with changes commits leftovers, pushes, opens the PR and reports its URL', async (t) => {
  const summary = 'Added the payments webhook controller.\n\nIt verifies the signature and enqueues a job. Tests: `rspec spec/requests/webhooks`.';
  const { server, repos, finish, reports, report, start, baseEnv } = await attempt(t, {
    claude: (repos) => {
      commitFile(repos, 'controller.rb', 'Add the webhook controller');
      writeFileSync(join(repos.work, 'leftover.rb'), 'not committed by Claude\n');
    },
    messages: resultMessages({ result: summary, sessionId: 'sess-42' }),
  });
  assert.equal(finish.code, 0, finish.stdout + finish.stderr);

  assert.deepEqual(remoteLog(repos, BRANCH), ['BOARDP-1713: Added the payments webhook controller.', 'Add the webhook controller', 'Initial commit']);
  assert.equal(remoteFile(repos, BRANCH, 'leftover.rb'), 'not committed by Claude\n');
  assert.equal(git(['log', '-1', '--format=%an <%ae>'], repos.work), 'trama-agent[bot] <trama-agent[bot]@users.noreply.github.com>');

  const [pr] = server.to('POST', /^\/repos\/acme\/web\/pulls$/);
  assert.equal(pr.headers.authorization, `Bearer ${GITHUB_TOKEN}`);
  assert.equal(pr.headers['x-github-api-version'], '2022-11-28');
  assert.deepEqual(pr.body, {
    title: 'BOARDP-1713 Implement webhooks',
    head: BRANCH,
    base: 'main',
    body: `${summary}\n\n---\n\nTrama: https://ontrama.com/tasks/7871 · run #12`,
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].headers.authorization, `Bearer ${RUN_TOKEN}`);
  assert.deepEqual(report, {
    outcome: 'succeeded',
    result_text: summary,
    error_text: null,
    error_type: null,
    api_error_status: null,
    resets_at: null,
    usage: {
      input_tokens: 10 + 2560 + 18432,
      output_tokens: 300,
      cost_usd: 0.0123,
      duration_ms: 4210,
      num_turns: 3,
      cache_read_input_tokens: 18432,
      cache_creation_input_tokens: 2560,
    },
    session_id: 'sess-42',
    wip_pushed: false,
    no_changes: false,
    pull_request_url: 'https://github.com/acme/web/pull/40',
    branch_pushed: false,
    pull_request: null,
  });

  const again = await runScript('scripts/finish.mjs', { cwd: repos.work, env: { ...baseEnv, TRAMA_CLAUDE_OUTCOME: 'success', TRAMA_JOB_STATUS: 'success' } });
  assert.equal(again.code, 0);
  assert.equal(server.to('POST', /\/report$/).length, 1, 'reported once');

  for (const output of [start.stdout, finish.stdout]) {
    assert.ok(onlyMasked(output, RUN_TOKEN), 'run token never printed');
    assert.ok(onlyMasked(output, GITHUB_TOKEN), 'GitHub token never printed');
  }
  assert.ok(!finish.stderr.includes(RUN_TOKEN));
});

test('finish: success without commits reports no_changes and opens nothing', async (t) => {
  const { server, repos, finish, report } = await attempt(t, { messages: resultMessages({ result: 'The webhook already exists; nothing to change.' }) });
  assert.equal(finish.code, 0, finish.stdout);
  assert.equal(report.outcome, 'succeeded');
  assert.equal(report.no_changes, true);
  assert.equal(report.pull_request_url, null);
  assert.equal(report.result_text, 'The webhook already exists; nothing to change.');
  assert.equal(server.to('POST', /pulls$/).length, 0);
  assert.equal(remoteLog(repos, BRANCH), null, 'nothing pushed');
});

test('finish: a plan limit pushes the work in progress and reports the structured error', async (t) => {
  const messages = fakeExecution('plan_limit', { cwd: '/tmp', mode: 'check', now: new Date('2026-10-24T17:00:00Z') }).messages;
  const { server, repos, finish, report } = await attempt(t, {
    startOverrides: { attempt_number: 2 },
    claude: (repos) => {
      commitFile(repos, 'half.rb', 'Start the controller');
      writeFileSync(join(repos.work, 'unsaved.rb'), 'in progress\n');
    },
    messages,
    claudeOutcome: 'failure',
  });
  assert.equal(finish.code, 1);
  assert.deepEqual(remoteLog(repos, BRANCH), ['WIP BOARDP-1713: attempt 2 stopped', 'Start the controller', 'Initial commit']);
  assert.equal(server.to('POST', /pulls$/).length, 0);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.wip_pushed, true);
  assert.equal(report.error_type, 'usage_limit_reached');
  assert.equal(report.api_error_status, 429);
  assert.equal(report.resets_at, '2026-10-24T22:00:00.000Z');
  assert.match(report.error_text, /You've hit your session limit · resets 10pm \(UTC\)/);
  assert.equal(report.usage.num_turns, 12);
  assert.equal(report.pull_request_url, null);
});

test('finish: a failure with nothing to push reports wip_pushed false; no execution file explains itself', async (t) => {
  const login = await attempt(t, {
    messages: fakeExecution('login_failed', { cwd: '/tmp', mode: 'check' }).messages,
    claudeOutcome: 'failure',
  });
  assert.equal(login.report.outcome, 'failed');
  assert.equal(login.report.wip_pushed, false);
  assert.equal(login.report.error_type, 'authentication_failed');
  assert.equal(login.report.api_error_status, 401);
  assert.match(login.report.error_text, /API retry 1\/10: 401 authentication_failed[\s\S]*API Error: 401 Invalid API key · Please run \/login/);
  assert.equal(remoteLog(login.repos, BRANCH), null);

  const crashed = await attempt(t, { claudeOutcome: 'failure' });
  assert.equal(crashed.report.outcome, 'failed');
  assert.match(crashed.report.error_text, /The Claude step failed before Claude wrote any output/);
  assert.equal(crashed.report.error_type, null);
});

test('finish: cancelled and timed out runs push WIP and say so', async (t) => {
  const cancelled = await attempt(t, {
    claude: (repos) => writeFileSync(join(repos.work, 'partial.rb'), 'partial\n'),
    claudeOutcome: 'cancelled',
    jobStatus: 'cancelled',
  });
  assert.equal(cancelled.report.outcome, 'cancelled');
  assert.equal(cancelled.report.wip_pushed, true);
  assert.match(cancelled.report.error_text, /The run was cancelled/);
  assert.deepEqual(remoteLog(cancelled.repos, BRANCH), ['WIP BOARDP-1713: attempt 30 stopped', 'Initial commit']);

  const timedOut = await attempt(t, { claudeOutcome: 'cancelled', jobStatus: 'cancelled', env: { TRAMA_TIMED_OUT: 'true' } });
  assert.equal(timedOut.report.outcome, 'timeout');
  assert.match(timedOut.report.error_text, /time limit \(timeout-minutes: 60\)/);
});

test('finish: a cancellation after timeout-minutes counts as a timeout', async (t) => {
  const { report } = await attempt(t, {
    claude: (repos) => {
      const path = join(repos.runnerTemp, 'trama', 'state.json');
      const state = readJson(path);
      state.started_at = new Date(Date.now() - 59 * 60_000).toISOString();
      writeFileSync(path, JSON.stringify(state));
    },
    claudeOutcome: 'cancelled',
    jobStatus: 'cancelled',
  });
  assert.equal(report.outcome, 'timeout');
});

test('finish: check mode only reports', async (t) => {
  const { server, repos, finish, report } = await attempt(t, {
    startOverrides: { mode: 'check', branch: null },
    env: { TRAMA_MODE: 'check', TRAMA_BRANCH: '' },
    messages: resultMessages({ result: 'OK' }),
  });
  assert.equal(finish.code, 0, finish.stdout);
  assert.equal(report.outcome, 'succeeded');
  assert.equal(report.result_text, 'OK');
  assert.equal(report.no_changes, false);
  assert.equal(server.to('POST', /pulls$/).length, 0);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repos.work), 'main');
});

test('finish: an open PR for the branch is reused; a refused PR is reported with the setting to change', async (t) => {
  const exists = await attempt(t, {
    claude: (repos) => commitFile(repos, 'a.rb', 'Change'),
    messages: resultMessages({ result: 'Done again.' }),
    pulls: () => ({ status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:boardp-1713-agent-12.' }] } }),
  });
  assert.equal(exists.report.outcome, 'succeeded');
  assert.equal(exists.report.pull_request_url, 'https://github.com/acme/web/pull/39');
  const [lookup] = exists.server.to('GET', /pulls$/);
  assert.equal(lookup.query.head, `acme:${BRANCH}`);

  const refused = await attempt(t, {
    claude: (repos) => commitFile(repos, 'a.rb', 'Change'),
    messages: resultMessages({ result: 'Done.' }),
    pulls: () => ({ status: 403, body: { message: 'GitHub Actions is not permitted to create or approve pull requests.' } }),
  });
  assert.equal(refused.finish.code, 1);
  assert.equal(refused.report.outcome, 'failed');
  assert.equal(refused.report.error_type, 'pull_request_failed');
  assert.equal(refused.report.wip_pushed, true);
  assert.match(refused.report.error_text, /Allow GitHub Actions to create and approve pull requests/);
  assert.deepEqual(remoteLog(refused.repos, BRANCH), ['Change', 'Initial commit']);
});

test('finish: Claude reporting an error result fails even when the step passed', () => {
  const analysis = { hasResult: true, ok: false };
  assert.equal(decideOutcome({ claudeOutcome: 'success', jobStatus: 'success', analysis, timedOut: false }), 'failed');
  assert.equal(decideOutcome({ claudeOutcome: 'success', jobStatus: 'success', analysis: null, timedOut: false }), 'succeeded');
  assert.equal(decideOutcome({ claudeOutcome: 'skipped', jobStatus: 'success', analysis: null, timedOut: false }), 'failed');
  assert.equal(decideOutcome({ claudeOutcome: 'failure', jobStatus: 'cancelled', analysis: null, timedOut: false }), 'cancelled');
  assert.equal(decideOutcome({ claudeOutcome: '', jobStatus: 'success', analysis: { hasResult: true, ok: true }, timedOut: false }), 'succeeded');
});

test('finish: without state (start never got a token) there is nothing to report', async (t) => {
  const server = await stubServer();
  t.after(() => server.close());
  const repos = makeRepos();
  const { code, stdout } = await runScript('scripts/finish.mjs', { cwd: repos.work, env: jobEnv(repos, server) });
  assert.equal(code, 0);
  assert.match(stdout, /nothing to report/);
  assert.equal(server.requests.length, 0);
});

test('finish: with open_pull_request false it pushes and leaves the PR to Trama', async (t) => {
  const summary = 'Added the webhook controller.';
  const { server, repos, finish, report } = await attempt(t, {
    env: { TRAMA_OPEN_PULL_REQUEST: 'false' },
    claude: (repos) => commitFile(repos, 'controller.rb', 'Add the webhook controller'),
    messages: resultMessages({ result: summary }),
  });
  assert.equal(finish.code, 0, finish.stdout + finish.stderr);
  assert.deepEqual(remoteLog(repos, BRANCH), ['Add the webhook controller', 'Initial commit']);
  assert.equal(server.to('POST', /\/pulls$/).length, 0, 'no PR opened by the workflow');
  assert.equal(report.outcome, 'succeeded');
  assert.equal(report.pull_request_url, null);
  assert.equal(report.branch_pushed, true);
  assert.deepEqual(report.pull_request, {
    title: 'BOARDP-1713 Implement webhooks',
    body: `${summary}\n\n---\n\nTrama: https://ontrama.com/tasks/7871 · run #12`,
  });
});
