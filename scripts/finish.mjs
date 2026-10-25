#!/usr/bin/env node
// trama-agent-action/finish: always runs last and reports the attempt to Trama, once.
//
// - succeeded with changes: commits what's left (`<KEY>: <first line of Claude's summary>`), pushes the run branch,
//   opens the pull request (title from Trama, body = Claude's summary + Trama's footer), reports the PR URL;
// - succeeded without commits ahead of the base: reports `no_changes: true`;
// - failed / cancelled / timed out: commits and pushes the work in progress (`WIP <KEY>: attempt <n> stopped`) when
//   there is any, and reports the end of Claude's output with error_type / api_error_status / resets_at;
// - check mode: only reports.
//
// Reads: TRAMA_EXECUTION_FILE (default $RUNNER_TEMP/claude-execution-output.json), TRAMA_CLAUDE_OUTCOME (the claude
// step's outcome), TRAMA_JOB_STATUS (job.status), TRAMA_TIMEOUT_MINUTES (60), TRAMA_TIMED_OUT, GITHUB_TOKEN,
// GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_STEP_SUMMARY, RUNNER_TEMP, and the state start wrote.
// Runs in the repository checkout (cwd).

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeExecution, readExecutionFile } from './execution.mjs';
import {
  EXECUTION_FILENAME,
  GitError,
  HttpError,
  RESULT_TEXT_MAX,
  apiBase,
  buildReport,
  commitAll,
  commitsAhead,
  env,
  fail,
  firstLine,
  git,
  isMainModule,
  log,
  mask,
  readState,
  redact,
  request,
  runnerTemp,
  sendReport,
  truncate,
  warn,
  writeState,
} from './lib.mjs';

const TIMEOUT_SLACK_SECONDS = 180;

export function decideOutcome({ claudeOutcome, jobStatus, analysis, timedOut }) {
  if (timedOut) return 'timeout';
  if (jobStatus === 'cancelled' || claudeOutcome === 'cancelled') return 'cancelled';
  if (claudeOutcome === 'success') return analysis && analysis.hasResult && !analysis.ok ? 'failed' : 'succeeded';
  if (!claudeOutcome && jobStatus !== 'failure' && analysis?.ok) return 'succeeded';
  return 'failed';
}

function hitTimeLimit(state, jobStatus, claudeOutcome) {
  if (env('TRAMA_TIMED_OUT').toLowerCase() === 'true') return true;
  if (jobStatus !== 'cancelled' && claudeOutcome !== 'cancelled') return false;
  const minutes = Number(env('TRAMA_TIMEOUT_MINUTES', '60')) || 60;
  const started = Date.parse(state.started_at || '');
  if (Number.isNaN(started)) return false;
  return (Date.now() - started) / 1000 >= minutes * 60 - TIMEOUT_SLACK_SECONDS;
}

/** Why the attempt stopped, when Claude's output doesn't say (cancelled, timed out, Claude never ran). */
function stopReason(outcome, claudeOutcome) {
  if (outcome === 'timeout') return `The job hit its time limit (timeout-minutes: ${env('TRAMA_TIMEOUT_MINUTES', '60') || 60}) and GitHub cancelled it.`;
  if (outcome === 'cancelled') return 'The run was cancelled.';
  if (claudeOutcome === 'skipped' || !claudeOutcome) {
    return 'The Claude step did not run (it was skipped: check the provider and mode inputs of the workflow).';
  }
  return 'The Claude step failed before Claude wrote any output (see the GitHub Actions log): for example Claude Code could not be installed, or claude-code-action refused the workflow actor (allowed_bots).';
}

function push(state) {
  const refspec = `HEAD:refs/heads/${state.branch}`;
  const first = git(['push', '--quiet', 'origin', refspec], { allowFail: true });
  if (first.code === 0) return;
  // origin may have no credential left (persist-credentials: false): try once with the job's token.
  const token = env('GITHUB_TOKEN');
  const repository = env('GITHUB_REPOSITORY');
  const server = env('GITHUB_SERVER_URL', 'https://github.com');
  if (token && repository && server.startsWith('https://')) {
    mask(token);
    const url = new URL(server);
    url.username = 'x-access-token';
    url.password = token;
    url.pathname = `/${repository}.git`;
    const second = git(['push', '--quiet', url.toString(), refspec], { allowFail: true });
    if (second.code === 0) return;
  }
  throw new GitError(`git push of ${state.branch} failed: ${redact(first.stderr || first.stdout || `exit ${first.code}`)}`);
}

function githubHeaders() {
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

/** Opens the pull request with GITHUB_TOKEN; one that is already open for the branch is reused. */
export async function openPullRequest({ title, head, base, body }) {
  const token = env('GITHUB_TOKEN');
  const repository = env('GITHUB_REPOSITORY');
  if (!token) throw new Error('GITHUB_TOKEN is not set, so the pull request could not be opened.');
  if (!repository) throw new Error('GITHUB_REPOSITORY is not set, so the pull request could not be opened.');
  mask(token);
  const apiUrl = apiBase(env('GITHUB_API_URL', 'https://api.github.com'));
  try {
    const { data } = await request('POST', `${apiUrl}/repos/${repository}/pulls`, {
      token,
      headers: githubHeaders(),
      body: { title, head, base, body },
    });
    return { url: data.html_url, number: data.number, existing: false };
  } catch (error) {
    if (error instanceof HttpError && error.status === 422 && /already exists/i.test(JSON.stringify(error.data ?? ''))) {
      const owner = repository.split('/')[0];
      const query = `head=${encodeURIComponent(`${owner}:${head}`)}&state=open`;
      const { data } = await request('GET', `${apiUrl}/repos/${repository}/pulls?${query}`, { token, headers: githubHeaders() });
      if (Array.isArray(data) && data[0]?.html_url) return { url: data[0].html_url, number: data[0].number, existing: true };
    }
    throw error;
  }
}

function pullRequestHint(error) {
  const text = JSON.stringify(error?.data ?? error?.message ?? '');
  if (/not permitted to create or approve pull requests/i.test(text)) {
    return ' Turn on "Allow GitHub Actions to create and approve pull requests" in the repository (or organization) settings → Actions → General.';
  }
  return '';
}

/** Commits, pushes and opens the PR (run mode); fills the report's git fields. */
async function finishBranch(state, report, analysis) {
  const key = state.task?.issue_key || `Attempt ${state.attempt_id}`;
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).stdout;
  if (head && head !== state.branch) warn(`The checkout is on ${head}, not ${state.branch}; pushing what HEAD has to ${state.branch}.`);

  if (report.outcome === 'succeeded') {
    const summary = firstLine(analysis?.resultText) || 'changes from Claude';
    if (commitAll(`${key}: ${summary}`, { user: state.git_user })) log('Committed the changes Claude left uncommitted.');
    const ahead = commitsAhead(state.base_sha);
    if (ahead === 0) {
      report.no_changes = true;
      log(`Claude made no changes (nothing ahead of ${state.base_branch}); no pull request.`);
      return;
    }
    push(state);
    log(`Pushed ${state.branch} (${ahead} commit(s) ahead of ${state.base_branch}).`);
    const footer = state.pull_request?.body_footer || (state.task?.url ? `Trama: ${state.task.url}` : '');
    const body = `${truncate(analysis?.resultText?.trim() || 'Claude finished without a summary.', RESULT_TEXT_MAX)}${footer ? `\n\n---\n\n${footer}` : ''}`;
    // open_pull_request: false (the template's default) leaves the PR to Trama, which opens it with its GitHub App: no
    // repository setting needed, and the PR starts the repository's CI.
    if (env('TRAMA_OPEN_PULL_REQUEST', 'true') === 'false') {
      report.branch_pushed = true;
      report.pull_request = { title: state.pull_request?.title || key, body };
      log('Trama opens the pull request.');
      return;
    }
    try {
      const pr = await openPullRequest({ title: state.pull_request?.title || key, head: state.branch, base: state.base_branch, body });
      report.pull_request_url = pr.url;
      log(`${pr.existing ? 'Pull request already open' : 'Opened pull request'}: ${pr.url}`);
    } catch (error) {
      report.outcome = 'failed';
      report.error_type = 'pull_request_failed';
      report.wip_pushed = true;
      report.error_text = `Claude finished and ${state.branch} was pushed, but the pull request could not be opened: ${error.message}.${pullRequestHint(error)}`;
      fail(report.error_text);
    }
    return;
  }

  const number = state.attempt_number ?? state.attempt_id;
  if (commitAll(`WIP ${key}: attempt ${number} stopped`, { user: state.git_user })) log('Committed the work in progress.');
  const ahead = commitsAhead(state.base_sha);
  if (ahead === 0) {
    log('No work in progress to push.');
    return;
  }
  try {
    push(state);
    report.wip_pushed = true;
    log(`Pushed the work in progress to ${state.branch} (${ahead} commit(s) ahead of ${state.base_branch}).`);
  } catch (error) {
    warn(error.message);
    report.error_text = `${report.error_text ? `${report.error_text}\n` : ''}The work in progress could not be pushed: ${error.message}`;
  }
}

function writeSummary(state, report) {
  const file = env('GITHUB_STEP_SUMMARY');
  if (!file) return;
  const lines = [`### Trama · ${state.task?.issue_key || ''} attempt ${state.attempt_number ?? state.attempt_id}: ${report.outcome}`, ''];
  if (report.pull_request_url) lines.push(`Pull request: ${report.pull_request_url}`);
  if (report.no_changes) lines.push('Claude made no changes.');
  if (report.wip_pushed) lines.push(`Work in progress pushed to \`${state.branch}\`.`);
  if (report.error_type) lines.push(`Error: \`${report.error_type}\`${report.api_error_status ? ` (HTTP ${report.api_error_status})` : ''}`);
  if (state.task?.url) lines.push(`Task: ${state.task.url}`);
  try {
    appendFileSync(file, `${redact(lines.join('\n'))}\n`);
  } catch {
    // The summary is a nicety.
  }
}

export async function main() {
  const state = readState();
  if (!state) {
    log('Trama start did not get as far as a run token, so there is nothing to report (Trama marks the attempt lost).');
    return 0;
  }
  mask(state.run_token);
  if (state.reported) {
    log(`Attempt ${state.attempt_id} was already reported (${state.reported_outcome || 'by start'}).`);
    return 0;
  }

  const claudeOutcome = env('TRAMA_CLAUDE_OUTCOME').toLowerCase();
  const jobStatus = env('TRAMA_JOB_STATUS').toLowerCase();
  const executionFile = env('TRAMA_EXECUTION_FILE') || join(runnerTemp(), EXECUTION_FILENAME);
  const messages = readExecutionFile(executionFile);
  const analysis = messages ? analyzeExecution(messages) : null;
  const outcome = decideOutcome({ claudeOutcome, jobStatus, analysis, timedOut: hitTimeLimit(state, jobStatus, claudeOutcome) });
  log(`Claude step: ${claudeOutcome || 'unknown'}; job: ${jobStatus || 'unknown'}; execution file: ${messages ? `${messages.length} messages` : 'none'} → ${outcome}.`);

  const report = buildReport({
    outcome,
    result_text: analysis?.resultText ? truncate(analysis.resultText, RESULT_TEXT_MAX) : null,
    usage: analysis?.usage,
    session_id: analysis?.sessionId ?? null,
  });
  if (outcome !== 'succeeded') {
    const parts = analysis?.outputTail ? [analysis.outputTail] : [];
    if (parts.length === 0 || outcome === 'timeout' || outcome === 'cancelled') parts.push(stopReason(outcome, claudeOutcome));
    report.error_text = parts.join('\n');
    report.error_type = analysis?.errorType ?? null;
    report.api_error_status = analysis?.apiErrorStatus ?? null;
    report.resets_at = analysis?.resetsAt ?? null;
  }

  if (state.mode === 'run') {
    try {
      await finishBranch(state, report, analysis);
    } catch (error) {
      fail(error.message);
      if (report.outcome === 'succeeded') {
        report.outcome = 'failed';
        report.error_type = error instanceof GitError ? 'push_failed' : 'finish_failed';
      }
      report.error_text = `${report.error_text ? `${report.error_text}\n` : ''}${redact(error.message)}`;
    }
  }

  writeSummary(state, report);
  try {
    const { data } = await sendReport(state, report);
    state.reported = true;
    state.reported_outcome = report.outcome;
    writeState(state);
    log(`Reported ${report.outcome} to Trama: attempt ${data?.status ?? '?'}, next: ${data?.next ?? '?'}.`);
  } catch (error) {
    const hint = error instanceof HttpError && error.status === 401 ? ' (the run token was refused: it expired, or Trama already has a report for this attempt)' : '';
    fail(`Could not report attempt ${state.attempt_id} to Trama: ${error.message}${hint}`);
    return 1;
  }
  return report.outcome === 'succeeded' ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      fail(`Unexpected error in Trama finish: ${error?.stack || error}`);
      process.exit(1);
    }
  );
}
