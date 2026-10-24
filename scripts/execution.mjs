// Reads Claude's execution file: what anthropics/claude-code-action writes to $RUNNER_TEMP/claude-execution-output.json
// (a JSON array of the Agent SDK messages, the same objects `claude -p --output-format stream-json --verbose` prints
// one per line). local/run.mjs writes the same file; JSON Lines are accepted too.
//
// The messages read here:
//   { type: "system", subtype: "init", session_id, model, … }
//   { type: "system", subtype: "api_retry", attempt, max_retries, error_status, error }
//   { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: <unix s>, rateLimitType } }
//   { type: "assistant", message: { content: [{ type: "text", text }] }, error?, is_api_error_message?,
//     api_error_status?, api_error?, api_error_params?: { rate_limit_info } }
//   { type: "result", subtype: "success" | "error_max_turns" | "error_during_execution", is_error, result,
//     usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }, total_cost_usd,
//     duration_ms, num_turns, session_id, api_error_status?, api_error?, errors? }

import { existsSync, readFileSync } from 'node:fs';
import { ERROR_TEXT_MAX_BYTES, tailBytes } from './lib.mjs';

/** The messages of an execution file, or null when there is none (or it can't be read). */
export function readExecutionFile(path) {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // JSON Lines (raw stream-json).
  }
  const messages = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // A torn last line when the process was killed.
    }
  }
  return messages;
}

function textOf(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toIso(resetsAt) {
  if (resetsAt === undefined || resetsAt === null || resetsAt === '') return null;
  if (typeof resetsAt === 'string' && !/^\d+(\.\d+)?$/.test(resetsAt)) {
    const parsed = Date.parse(resetsAt);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const number = Number(resetsAt);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number > 1e12 ? number : number * 1000).toISOString();
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Prompt tokens of a usage object: plain input plus cache writes and reads (Claude Code reads most from cache). */
function inputTokens(usage) {
  return num(usage?.input_tokens) + num(usage?.cache_creation_input_tokens) + num(usage?.cache_read_input_tokens);
}

/**
 * What the report needs from the messages: the final result, usage, session, and on errors the structured fields
 * (error_type, api_error_status, resets_at) plus the end of Claude's output (≤ 8 KB).
 */
export function analyzeExecution(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const result = [...list].reverse().find((message) => message?.type === 'result') || null;
  const init = list.find((message) => message?.type === 'system' && message.subtype === 'init') || null;
  const apiErrors = list.filter((message) => message?.type === 'assistant' && (message.is_api_error_message || message.error));
  const lastApiError = apiErrors[apiErrors.length - 1] || null;
  const retries = list.filter((message) => message?.type === 'system' && message.subtype === 'api_retry');
  const lastRetry = retries[retries.length - 1] || null;
  const rejected = [...list]
    .reverse()
    .find((message) => message?.type === 'rate_limit_event' && message.rate_limit_info?.status === 'rejected');

  const ok = !!result && result.subtype === 'success' && !result.is_error;

  let usage;
  if (result) {
    usage = {
      input_tokens: inputTokens(result.usage),
      output_tokens: num(result.usage?.output_tokens),
      cost_usd: num(result.total_cost_usd),
      duration_ms: num(result.duration_ms),
      num_turns: num(result.num_turns),
      cache_read_input_tokens: num(result.usage?.cache_read_input_tokens),
      cache_creation_input_tokens: num(result.usage?.cache_creation_input_tokens),
    };
  } else {
    // No result (killed or crashed): add up the API calls seen (one usage per message id).
    const seen = new Map();
    for (const message of list) {
      if (message?.type === 'assistant' && message.message?.usage && message.message.id) seen.set(message.message.id, message.message.usage);
    }
    const usages = [...seen.values()];
    usage = {
      input_tokens: usages.reduce((sum, item) => sum + inputTokens(item), 0),
      output_tokens: usages.reduce((sum, item) => sum + num(item.output_tokens), 0),
      cost_usd: null,
      duration_ms: null,
      num_turns: list.filter((message) => message?.type === 'assistant' && !message.is_api_error_message).length || null,
      cache_read_input_tokens: usages.reduce((sum, item) => sum + num(item.cache_read_input_tokens), 0),
      cache_creation_input_tokens: usages.reduce((sum, item) => sum + num(item.cache_creation_input_tokens), 0),
    };
  }

  const errorType = ok
    ? null
    : result?.api_error ||
      lastApiError?.api_error ||
      lastApiError?.error ||
      (result && typeof result.subtype === 'string' && result.subtype.startsWith('error') ? result.subtype : null) ||
      lastRetry?.error ||
      null;

  const status = ok
    ? null
    : result?.api_error_status ?? lastApiError?.api_error_status ?? (lastRetry ? lastRetry.error_status : null) ?? null;

  const resetsAt = ok
    ? null
    : toIso(lastApiError?.api_error_params?.rate_limit_info?.resetsAt) || toIso(rejected?.rate_limit_info?.resetsAt);

  // The end of Claude's output: what it said, API retries and errors, and the final result.
  const lines = [];
  for (const message of list) {
    if (message?.type === 'assistant') {
      const text = textOf(message).trim();
      if (text) lines.push(text);
    } else if (message?.type === 'system' && message.subtype === 'api_retry') {
      lines.push(`API retry ${message.attempt ?? '?'}/${message.max_retries ?? '?'}: ${message.error_status ?? ''} ${message.error ?? ''}`.trim());
    } else if (message?.type === 'result') {
      if (typeof message.result === 'string' && message.result.trim() && message.result.trim() !== lines[lines.length - 1]) {
        lines.push(message.result.trim());
      }
      if (Array.isArray(message.errors) && message.errors.length > 0) lines.push(message.errors.join('\n'));
      if (message.subtype && message.subtype !== 'success') lines.push(`Claude stopped: ${message.subtype}`);
    }
  }

  return {
    hasResult: !!result,
    ok,
    resultText: typeof result?.result === 'string' ? result.result : '',
    sessionId: result?.session_id || init?.session_id || list.find((message) => message?.session_id)?.session_id || null,
    usage,
    errorType: errorType || null,
    apiErrorStatus: typeof status === 'number' ? status : status ? Number(status) || null : null,
    resetsAt,
    outputTail: tailBytes(lines.join('\n'), ERROR_TEXT_MAX_BYTES),
    permissionDenials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0,
  };
}
