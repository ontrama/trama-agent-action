#!/usr/bin/env node
// Stands in for the claude CLI in tests of local/run.mjs: records how it was called (argv, env, cwd, stdin, the MCP
// config file) to $TMPDIR/fake-claude-record.json and prints stream-json like `claude -p --output-format stream-json`.
// $TMPDIR/fake-claude-mode: "success" (default: writes from-claude.txt, uncommitted) or "sleep" (until killed).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.TMPDIR || '/tmp';
const modeFile = join(dir, 'fake-claude-mode');
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'success';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const mcpIndex = argv.indexOf('--mcp-config');
const mcpConfig = mcpIndex >= 0 && existsSync(argv[mcpIndex + 1]) ? JSON.parse(readFileSync(argv[mcpIndex + 1], 'utf8')) : null;
writeFileSync(join(dir, 'fake-claude-record.json'), JSON.stringify({ argv, env: process.env, cwd: process.cwd(), prompt, mcpConfig }));

const sessionId = 'fake-session-1';
const say = (message) => process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`);
say({ type: 'system', subtype: 'init', model: 'fake-model', permissionMode: 'acceptEdits', mcp_servers: mcpConfig ? [{ name: 'trama', status: 'connected' }] : [] });

if (mode === 'sleep') {
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
} else {
  writeFileSync(join(process.cwd(), 'from-claude.txt'), 'hello from claude\n');
  say({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Wrote from-claude.txt.' }], usage: { input_tokens: 3, output_tokens: 20 } } });
  say({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Wrote from-claude.txt with a greeting.',
    duration_ms: 1500,
    num_turns: 2,
    total_cost_usd: 0.002,
    usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 },
    permission_denials: [],
  });
}
