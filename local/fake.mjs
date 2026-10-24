// Fake Claude outcomes for local mode (`fake:success`, `fake:plan_limit`, `fake:rate_limited`, `fake:login_failed`):
// the messages a real `claude -p --output-format stream-json --verbose` prints for that outcome (shapes taken from
// Claude Code 2.1.x), so finish.mjs and Trama's classifier see what they would in production. Claude is not called.
//
// fake:success commits a line to TRAMA_AGENT_LOG.md (so the push and pull request path runs); fake:plan_limit leaves
// an uncommitted line, as a run stopped mid-way would (so the WIP push and the next attempt's continue path run).

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_USER, git, identityArgs } from '../scripts/lib.mjs';

export const FAKE_OUTCOMES = ['success', 'plan_limit', 'rate_limited', 'login_failed'];

export const MESSAGES = {
  plan_limit: "You've hit your session limit · resets 10pm (UTC)",
  login_failed: 'API Error: 401 Invalid API key · Please run /login',
  rate_limited: 'API Error: 429 rate_limit_error',
};

const MODEL = 'claude-sonnet-4-5';
const CLAUDE_CODE_VERSION = '2.1.310';

function usage(input, cacheWrite, cacheRead, output) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cacheWrite },
  };
}

/** The next 10pm UTC: when "resets 10pm (UTC)" happens. */
export function nextTenPmUtc(now = new Date()) {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0));
  if (reset <= now) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

function appendLog(cwd, line) {
  const file = join(cwd, 'TRAMA_AGENT_LOG.md');
  if (!existsSync(file)) appendFileSync(file, '# Trama agent log\n\nLines written by fake local agent runs.\n\n');
  appendFileSync(file, `${line}\n`);
}

/**
 * Plays a fake outcome in `cwd` (the run branch checkout) and returns the messages and the claude step's outcome.
 */
export function fakeExecution(kind, { cwd, issueKey = 'TASK', attemptId = '0', mcp = true, mode = 'run', now = new Date() } = {}) {
  if (!FAKE_OUTCOMES.includes(kind)) throw new Error(`Unknown fake outcome: ${kind}`);
  const sessionId = randomUUID();
  const base = { session_id: sessionId };
  const messages = [
    {
      type: 'system',
      subtype: 'init',
      cwd,
      session_id: sessionId,
      tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite', ...(mcp ? ['mcp__trama__report_progress', 'mcp__trama__get_task_detail', 'mcp__trama__add_comment'] : [])],
      mcp_servers: mcp ? [{ name: 'trama', status: 'connected' }] : [],
      model: MODEL,
      permissionMode: mode === 'run' ? 'acceptEdits' : 'default',
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: CLAUDE_CODE_VERSION,
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: [],
      uuid: randomUUID(),
    },
  ];
  const stamp = now.toISOString();

  if (kind === 'success') {
    let summary = 'OK';
    if (mode === 'run') {
      appendLog(cwd, `- ${stamp} · ${issueKey} · attempt ${attemptId}: fake success`);
      git(['add', 'TRAMA_AGENT_LOG.md'], { cwd });
      git([...identityArgs(GIT_USER), 'commit', '--no-verify', '-q', '-m', `${issueKey}: add a line to TRAMA_AGENT_LOG.md`], { cwd });
      summary = [
        `Added a line to \`TRAMA_AGENT_LOG.md\` for ${issueKey} (attempt ${attemptId}).`,
        '',
        'This was a fake local run (`fake:success`): Claude was not called.',
      ].join('\n');
    }
    const toolId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    messages.push(
      {
        type: 'assistant',
        message: {
          id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [
            { type: 'text', text: "I'll add a line to TRAMA_AGENT_LOG.md and commit it." },
            { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'git commit -m "add a line"', description: 'Commit the change' } },
          ],
          stop_reason: 'tool_use',
          usage: usage(4, 2048, 8192, 120),
        },
        parent_tool_use_id: null,
        ...base,
        uuid: randomUUID(),
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: '[branch 1a2b3c4] add a line', is_error: false }] },
        parent_tool_use_id: null,
        ...base,
        uuid: randomUUID(),
      },
      {
        type: 'assistant',
        message: {
          id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: summary }],
          stop_reason: 'end_turn',
          usage: usage(6, 512, 10240, 180),
        },
        parent_tool_use_id: null,
        ...base,
        uuid: randomUUID(),
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 4210,
        duration_api_ms: 3920,
        num_turns: 3,
        result: summary,
        stop_reason: 'end_turn',
        session_id: sessionId,
        total_cost_usd: 0.0123,
        usage: usage(10, 2560, 18432, 300),
        modelUsage: {},
        permission_denials: [],
        terminal_reason: 'completed',
        uuid: randomUUID(),
      }
    );
    return { messages, outcome: 'success' };
  }

  // Failures: the API refusal as Claude Code reports it (a synthetic assistant message, then an error result).
  let error;
  let status;
  let apiError;
  let apiErrorParams;
  if (kind === 'plan_limit') {
    if (mode === 'run') appendLog(cwd, `- ${stamp} · ${issueKey} · attempt ${attemptId}: stopped by a plan limit (uncommitted)`);
    const resetsAt = Math.floor(nextTenPmUtc(now).getTime() / 1000);
    const info = { status: 'rejected', resetsAt, rateLimitType: 'five_hour', utilization: 1 };
    messages.push({ type: 'rate_limit_event', rate_limit_info: info, uuid: randomUUID(), ...base });
    error = 'rate_limit';
    status = 429;
    apiError = 'usage_limit_reached';
    apiErrorParams = { rate_limit_info: info };
  } else if (kind === 'rate_limited') {
    error = 'rate_limit';
    status = 429;
  } else {
    error = 'authentication_failed';
    status = 401;
  }
  if (kind !== 'plan_limit') {
    for (const attempt of [1, 2]) {
      messages.push({
        type: 'system',
        subtype: 'api_retry',
        attempt,
        max_retries: 10,
        retry_delay_ms: 550 * attempt,
        error_status: status,
        error,
        uuid: randomUUID(),
        ...base,
      });
    }
  }
  const text = MESSAGES[kind];
  messages.push(
    {
      type: 'assistant',
      message: {
        id: randomUUID(),
        container: null,
        model: '<synthetic>',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        type: 'message',
        usage: usage(0, 0, 0, 0),
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      ...base,
      uuid: randomUUID(),
      timestamp: stamp,
      error,
      is_api_error_message: true,
      api_error_status: status,
      ...(apiError ? { api_error: apiError, api_error_params: apiErrorParams } : {}),
      api_error_origin: 'first_party',
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      duration_ms: kind === 'plan_limit' ? 61200 : 2180,
      duration_api_ms: kind === 'plan_limit' ? 58000 : 0,
      num_turns: kind === 'plan_limit' ? 12 : 1,
      result: text,
      stop_reason: 'stop_sequence',
      session_id: sessionId,
      total_cost_usd: kind === 'plan_limit' ? 0.42 : 0,
      usage: kind === 'plan_limit' ? usage(40, 6000, 52000, 2400) : usage(0, 0, 0, 0),
      modelUsage: {},
      permission_denials: [],
      terminal_reason: 'api_error',
      api_error_status: status,
      ...(apiError ? { api_error: apiError } : {}),
      api_error_origin: 'first_party',
      uuid: randomUUID(),
    }
  );
  return { messages, outcome: 'failure' };
}
