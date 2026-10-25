import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeExecution, readExecutionFile } from '../scripts/execution.mjs';
import { fakeExecution, nextTenPmUtc } from '../local/fake.mjs';
import { parseOutputs, redact, mask, tailBytes, firstLine, buildReport } from '../scripts/lib.mjs';
import { ROOT, mkdtempSync, resultMessages } from './helpers.mjs';

test('a real Claude Code 2.1.310 stream (invalid OAuth token) gives authentication_failed / 401', () => {
  const messages = readExecutionFile(join(ROOT, 'tests', 'fixtures', 'login-failed.cli-2.1.310.jsonl'));
  assert.equal(messages.length, 5);
  const analysis = analyzeExecution(messages);
  assert.equal(analysis.ok, false);
  assert.equal(analysis.errorType, 'authentication_failed');
  assert.equal(analysis.apiErrorStatus, 401);
  assert.equal(analysis.resetsAt, null);
  assert.equal(analysis.sessionId, '9ea89349-e33b-441b-b14b-889e7aabfd6b');
  assert.match(analysis.outputTail, /API retry 2\/10: 401 authentication_failed\nFailed to authenticate\. API Error: 401 OAuth access token is invalid\.$/);
  assert.deepEqual(analysis.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    duration_ms: 2178,
    num_turns: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('execution files: a JSON array (claude-code-action) or JSON lines (raw stream-json), torn lines skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trama-exec-'));
  const messages = resultMessages({ result: 'Hello' });
  writeFileSync(join(dir, 'array.json'), JSON.stringify(messages, null, 2));
  writeFileSync(join(dir, 'lines.jsonl'), `${messages.map((message) => JSON.stringify(message)).join('\n')}\n{"type":"assis`);
  assert.deepEqual(readExecutionFile(join(dir, 'array.json')), messages);
  assert.deepEqual(readExecutionFile(join(dir, 'lines.jsonl')), messages);
  assert.equal(readExecutionFile(join(dir, 'missing.json')), null);
  const analysis = analyzeExecution(messages);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.resultText, 'Hello');
  assert.equal(analysis.errorType, null);
});

test('fake outcomes carry what the classifier reads: plan limit with resets_at, rate limit, login', () => {
  const now = new Date('2026-10-24T23:30:00Z');
  const plan = analyzeExecution(fakeExecution('plan_limit', { cwd: '/x', mode: 'check', now }).messages);
  assert.deepEqual([plan.errorType, plan.apiErrorStatus, plan.resetsAt], ['usage_limit_reached', 429, '2026-10-25T22:00:00.000Z']);
  assert.match(plan.outputTail, /You've hit your session limit · resets 10pm \(UTC\)$/);

  const rate = analyzeExecution(fakeExecution('rate_limited', { cwd: '/x', mode: 'check' }).messages);
  assert.deepEqual([rate.errorType, rate.apiErrorStatus, rate.resetsAt], ['rate_limit', 429, null]);
  assert.match(rate.outputTail, /API Error: 429 rate_limit_error$/);

  const login = analyzeExecution(fakeExecution('login_failed', { cwd: '/x', mode: 'check' }).messages);
  assert.deepEqual([login.errorType, login.apiErrorStatus], ['authentication_failed', 401]);

  const ok = analyzeExecution(fakeExecution('success', { cwd: '/x', mode: 'check' }).messages);
  assert.equal(ok.ok, true);
  assert.equal(ok.resultText, 'OK');
  assert.equal(nextTenPmUtc(new Date('2026-10-24T10:00:00Z')).toISOString(), '2026-10-24T22:00:00.000Z');
});

test('max turns and crashes: error subtype as error_type; usage added up from messages when there is no result', () => {
  const maxTurns = analyzeExecution(resultMessages({ result: '', subtype: 'error_max_turns', isError: true }));
  assert.equal(maxTurns.errorType, 'error_max_turns');
  assert.match(maxTurns.outputTail, /Claude stopped: error_max_turns/);

  const crashed = analyzeExecution([
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Working' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 7 } } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Edit' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 7 } } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Still working' }], usage: { input_tokens: 1, output_tokens: 5 } } },
  ]);
  assert.equal(crashed.hasResult, false);
  assert.equal(crashed.usage.input_tokens, 104);
  assert.equal(crashed.usage.output_tokens, 12);
  assert.equal(crashed.usage.cost_usd, null);
  assert.equal(crashed.outputTail, 'Working\nStill working');
  assert.equal(crashed.sessionId, 's');
});

test('error_text keeps the last 8 KB on a character boundary', () => {
  const long = `${'é'.repeat(6000)}END`;
  const tail = tailBytes(long, 8192);
  assert.ok(Buffer.byteLength(tail) <= 8192);
  assert.ok(tail.endsWith('END'));
  assert.ok(!tail.includes('�'));
  const analysis = analyzeExecution(resultMessages({ result: 'x'.repeat(20_000), isError: true }));
  assert.ok(Buffer.byteLength(analysis.outputTail) <= 8192);
});

test('helpers: outputs round-trip, redaction, commit subject, report shape', () => {
  assert.deepEqual(parseOutputs('a<<D1\nline 1\nline 2\nD1\nb=plain\nc<<D2\n\nD2\n'), { a: 'line 1\nline 2', b: 'plain', c: '' });
  const original = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (chunk) => ((printed += chunk), true);
  try {
    mask('lxt_at_secret_value');
  } finally {
    process.stdout.write = original;
  }
  assert.equal(printed, '::add-mask::lxt_at_secret_value\n');
  assert.equal(redact('token lxt_at_secret_value and https://x-access-token:ghs_abc@github.com/a/b.git'), 'token *** and https://***@github.com/a/b.git');
  assert.equal(firstLine('## Summary\n\nAdded the **webhook** controller.'), 'Added the webhook controller.');
  assert.equal(firstLine('## Done'), 'Done');
  const long = firstLine('\n\n- Added the webhook controller and its tests for every provider we support today');
  assert.ok(long.length <= 72 && long.endsWith('…') && long.startsWith('Added the webhook controller'), long);
  assert.deepEqual(Object.keys(buildReport()), [
    'outcome',
    'result_text',
    'error_text',
    'error_type',
    'api_error_status',
    'resets_at',
    'usage',
    'session_id',
    'wip_pushed',
    'no_changes',
    'pull_request_url',
    'branch_pushed',
    'pull_request',
  ]);
});
