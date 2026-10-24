#!/usr/bin/env node
// trama-agent-action/start: asks Trama to start the attempt and prepares the run.
//
// 1. Checks the secret name (TRAMA_ + [A-Z0-9_]) before anything else.
// 2. Gets a GitHub OIDC token for the API (audience = api_url), or TRAMA_LOCAL_OIDC_TOKEN in local mode.
// 3. POST {api_url}/agent_attempts/{attempt_id}/start → brief, branches, run token (masked at once).
// 4. No secret with that name → reports `failed` / `secret_missing` and stops (finish sees it was reported).
// 5. Run mode: configures git, creates the run branch from the base (or checks out the pushed branch to continue).
// 6. Writes $RUNNER_TEMP/trama/brief.md, mcp.json and state.json (0600) and the step outputs.
//
// Reads: TRAMA_ATTEMPT_ID, TRAMA_API_URL, TRAMA_SECRET_NAME, TRAMA_SECRET_PRESENT, TRAMA_MODE, TRAMA_ISSUE_KEY,
// TRAMA_BASE_BRANCH, TRAMA_BRANCH, TRAMA_OIDC_AUDIENCE, TRAMA_LOCAL_OIDC_TOKEN, ACTIONS_ID_TOKEN_REQUEST_URL,
// ACTIONS_ID_TOKEN_REQUEST_TOKEN, RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// GITHUB_SERVER_URL. Runs in the repository checkout (cwd).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_PROMPT,
  FILE_TOOLS,
  GIT_TOOLS,
  GIT_USER,
  HttpError,
  MCP_SERVER_NAME,
  SECRET_NAME,
  SECRET_NAME_MAX,
  apiBase,
  buildReport,
  env,
  fail,
  git,
  isMainModule,
  log,
  mask,
  request,
  sendReport,
  setOutput,
  shellQuote,
  tramaDir,
  validBranch,
  warn,
  writePrivateFile,
  writeState,
} from './lib.mjs';

async function oidcToken(audience) {
  const local = env('TRAMA_LOCAL_OIDC_TOKEN');
  if (local) return local;
  const requestUrl = env('ACTIONS_ID_TOKEN_REQUEST_URL');
  const requestToken = env('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  if (!requestUrl || !requestToken) {
    throw new Error('GitHub gave this job no OIDC token: the workflow needs `permissions: id-token: write`.');
  }
  mask(requestToken);
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);
  const { data } = await request('GET', url.toString(), {
    token: requestToken,
    headers: { Accept: 'application/json; api-version=2.0' },
  });
  if (!data || typeof data.value !== 'string' || !data.value) throw new Error('GitHub answered the OIDC request without a token.');
  return data.value;
}

function startHint(error) {
  if (!(error instanceof HttpError)) return '';
  switch (error.status) {
    case 401:
      return ' The API did not accept the GitHub OIDC token (issuer, audience or signature).';
    case 403:
      return ' This repository or workflow is not the one Trama dispatched the attempt to (the repository must be enabled in the workspace and the workflow file named trama-agent.yml).';
    case 409:
      return ' The attempt already started in another GitHub run or has ended (re-running an old workflow run does not restart it; retry the run in Trama).';
    default:
      return '';
  }
}

export function mcpConfig(mcpUrl, runToken) {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${runToken}` } } } };
}

/** The allowed tools for claude-code-action: file tools, the git commands of GIT_TOOLS and Trama's MCP server. */
export function allowedTools() {
  return [...FILE_TOOLS, ...GIT_TOOLS, `mcp__${MCP_SERVER_NAME}`];
}

export function claudeArgs(state) {
  if (state.mode === 'check') return '--max-turns 1';
  const lines = [];
  if (state.mcp_url) lines.push(`--mcp-config ${shellQuote(JSON.stringify(mcpConfig(state.mcp_url, state.run_token)))}`);
  lines.push('--permission-mode acceptEdits');
  lines.push(`--allowedTools ${shellQuote(allowedTools().join(','))}`);
  return lines.join('\n');
}

/** The brief from Trama plus what only the action knows: the branch, and that finish pushes and opens the PR. */
export function buildPrompt(state, brief) {
  if (state.mode === 'check') return CHECK_PROMPT;
  const repository = env('GITHUB_REPOSITORY');
  const where = state.continue_from_branch
    ? `on the branch \`${state.branch}\`, which already has the commits of an earlier attempt (\`git log origin/${state.base_branch}..HEAD\` shows them)`
    : `on the branch \`${state.branch}\`, created from \`${state.base_branch}\``;
  return [
    String(brief || `# ${state.task?.issue_key || ''} ${state.task?.name || ''}`.trim()).trimEnd(),
    '',
    '---',
    '',
    '## How this run works',
    '',
    `You are working in a clone of ${repository ? `\`${repository}\`` : 'the repository'} ${where}.`,
    '',
    "- Commit your work with git as you go (`git add`, `git commit` with clear messages). Don't push, switch branches or open a pull request: when you stop, Trama commits anything left, pushes the branch and opens the pull request.",
    "- Your last message becomes the pull request description, so write it for the reviewer: what you changed and why, how you checked it, and anything left to do. Don't mention pushing, the pull request or these instructions.",
    `- Trama's MCP tools (\`mcp__${MCP_SERVER_NAME}__…\`) reach this task: post a one-line note with \`report_progress\` at each milestone, and read the task, its comments and linked documents when you need more context.`,
    '',
  ].join('\n');
}

function prepareBranch(state) {
  if (!validBranch(state.branch)) throw new Error(`Trama sent an invalid branch name: ${JSON.stringify(state.branch)}.`);
  if (!validBranch(state.base_branch)) throw new Error(`Invalid base branch: ${JSON.stringify(state.base_branch)}.`);
  git(['config', 'user.name', state.git_user.name]);
  git(['config', 'user.email', state.git_user.email]);

  const base = state.base_branch;
  const fetchedBase = git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { allowFail: true });
  if (fetchedBase.code !== 0) throw new Error(`The base branch ${base} could not be fetched from origin: ${fetchedBase.stderr || 'unknown error'}`);
  state.base_sha = git(['rev-parse', `refs/remotes/origin/${base}`]).stdout;

  const remoteBranch = git(['ls-remote', '--exit-code', '--heads', 'origin', state.branch], { allowFail: true }).code === 0;
  if (remoteBranch) {
    if (!state.continue_from_branch) warn(`origin already has ${state.branch}; continuing from it instead of starting over.`);
    git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${state.branch}:refs/remotes/origin/${state.branch}`]);
    git(['checkout', '-q', '--no-track', '-B', state.branch, `refs/remotes/origin/${state.branch}`]);
    state.continue_from_branch = true;
    log(`Continuing on ${state.branch} (${git(['rev-list', '--count', `${state.base_sha}..HEAD`]).stdout} commit(s) ahead of ${base}).`);
  } else {
    if (state.continue_from_branch) warn(`Trama asked to continue from ${state.branch}, but origin has no such branch; starting it from ${base}.`);
    git(['checkout', '-q', '--no-track', '-B', state.branch, `refs/remotes/origin/${base}`]);
    state.continue_from_branch = false;
    log(`Created ${state.branch} from ${base} (${state.base_sha.slice(0, 12)}).`);
  }
}

async function reportAndStop(state, fields, message) {
  fail(message);
  try {
    const { data } = await sendReport(state, buildReport(fields));
    state.reported = true;
    state.reported_outcome = fields.outcome;
    writeState(state);
    log(`Reported ${fields.outcome} (${fields.error_type}) to Trama: attempt ${data?.status ?? '?'}, next: ${data?.next ?? '?'}.`);
  } catch (error) {
    fail(`Could not report the failure to Trama: ${error.message}`);
  }
  return 1;
}

export async function main() {
  const attemptId = env('TRAMA_ATTEMPT_ID');
  const apiUrl = apiBase(env('TRAMA_API_URL'));
  const secretName = env('TRAMA_SECRET_NAME');
  const secretPresent = env('TRAMA_SECRET_PRESENT', 'true').toLowerCase() !== 'false';
  const inputMode = env('TRAMA_MODE', 'run') || 'run';

  if (!SECRET_NAME.test(secretName) || secretName.length > SECRET_NAME_MAX) {
    fail(`secret_name must match ^TRAMA_[A-Z0-9_]+$ (at most ${SECRET_NAME_MAX} characters); got ${JSON.stringify(secretName)}. Nothing was started.`);
    return 1;
  }
  if (!/^\d+$/.test(attemptId)) {
    fail(`attempt_id must be a number; got ${JSON.stringify(attemptId)}.`);
    return 1;
  }
  if (!/^https?:\/\/[^/]/.test(apiUrl)) {
    fail(`api_url must be an http(s) URL; got ${JSON.stringify(apiUrl)}.`);
    return 1;
  }
  if (!['run', 'check'].includes(inputMode)) {
    fail(`mode must be run or check; got ${JSON.stringify(inputMode)}.`);
    return 1;
  }

  let oidc;
  try {
    oidc = await oidcToken(env('TRAMA_OIDC_AUDIENCE') || apiUrl);
  } catch (error) {
    fail(error.message);
    return 1;
  }
  mask(oidc);

  const runId = env('GITHUB_RUN_ID');
  const repository = env('GITHUB_REPOSITORY');
  const server = env('GITHUB_SERVER_URL', 'https://github.com');
  let start;
  try {
    ({ data: start } = await request('POST', `${apiUrl}/agent_attempts/${attemptId}/start`, {
      token: oidc,
      body: {
        github_run_id: runId || null,
        github_run_attempt: env('GITHUB_RUN_ATTEMPT') || null,
        github_repository: repository || null,
        github_run_url: runId && repository ? `${server}/${repository}/actions/runs/${runId}` : null,
      },
    }));
  } catch (error) {
    fail(`Trama did not start attempt ${attemptId}: ${error.message}.${startHint(error)}`);
    return 1;
  }
  if (!start || typeof start.run_token !== 'string' || !start.run_token) {
    fail('Trama answered the start request without a run token.');
    return 1;
  }
  mask(start.run_token);

  const mode = start.mode === 'check' || start.mode === 'run' ? start.mode : inputMode;
  if (mode !== inputMode) warn(`The workflow was dispatched with mode ${inputMode}, but Trama says ${mode}; using ${mode}.`);
  const task = start.task || {};
  const state = {
    version: 1,
    attempt_id: start.attempt_id ?? Number(attemptId),
    attempt_number: start.attempt_number ?? null,
    run_id: start.run_id ?? null,
    mode,
    task: {
      id: task.id ?? null,
      issue_key: task.issue_key || env('TRAMA_ISSUE_KEY') || null,
      name: task.name ?? null,
      url: task.url ?? null,
      board_id: task.board_id ?? null,
    },
    api_url: apiBase(start.api_url || apiUrl),
    mcp_url: start.mcp_url || null,
    run_token: start.run_token,
    run_token_expires_at: start.run_token_expires_at ?? null,
    base_branch: start.base_branch || env('TRAMA_BASE_BRANCH') || null,
    base_sha: null,
    branch: start.branch || env('TRAMA_BRANCH') || null,
    continue_from_branch: start.continue_from_branch === true,
    pull_request: {
      title: start.pull_request?.title || `${task.issue_key || ''} ${task.name || ''}`.trim(),
      body_footer: start.pull_request?.body_footer || (task.url ? `Trama: ${task.url}` : ''),
    },
    git_user: GIT_USER,
    secret_name: secretName,
    started_at: new Date().toISOString(),
    reported: false,
  };
  writeState(state);
  log(`Trama started attempt ${state.attempt_id} (run ${state.run_id ?? '?'}, ${mode}) for ${state.task.issue_key || `task ${state.task.id}`}.`);

  if (!secretPresent) {
    return reportAndStop(
      state,
      {
        outcome: 'failed',
        error_type: 'secret_missing',
        error_text: `No GitHub secret named ${secretName} is available to this workflow. Add it under Settings → Secrets and variables → Actions (on the repository or its organization) with the token from \`claude setup-token\`.`,
      },
      `The secret ${secretName} is missing or empty.`
    );
  }

  try {
    if (mode === 'run') {
      if (!state.branch || !state.base_branch) throw new Error('Trama sent no branch or base branch for this run.');
      prepareBranch(state);
      if (!state.mcp_url) warn("Trama sent no mcp_url, so Claude won't have Trama's MCP tools in this run.");
    }
    writeState(state);

    const dir = tramaDir();
    const promptFile = join(dir, 'brief.md');
    const prompt = buildPrompt(state, start.brief);
    writeFileSync(promptFile, prompt);
    let mcpFile = '';
    if (mode === 'run' && state.mcp_url) {
      mcpFile = writePrivateFile(join(dir, 'mcp.json'), `${JSON.stringify(mcpConfig(state.mcp_url, state.run_token), null, 2)}\n`);
    }

    setOutput('prompt', prompt);
    setOutput('prompt_file', promptFile);
    setOutput('claude_args', claudeArgs(state));
    setOutput('mcp_config_file', mcpFile);
    setOutput('mode', mode);
    setOutput('branch', mode === 'run' ? state.branch : '');
    setOutput('base_branch', state.base_branch || '');
    setOutput('continue_from_branch', String(state.continue_from_branch));
    setOutput('attempt_id', String(state.attempt_id));
    setOutput('run_id', state.run_id === null ? '' : String(state.run_id));
    setOutput('issue_key', state.task.issue_key || '');
    return 0;
  } catch (error) {
    return reportAndStop(
      state,
      { outcome: 'failed', error_type: 'setup_failed', error_text: `The Trama start step failed: ${error.message}` },
      error.message
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      fail(`Unexpected error in Trama start: ${error?.stack || error}`);
      process.exit(1);
    }
  );
}
