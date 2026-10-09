#!/usr/bin/env node
// One real Claude run through this add-on, outside Paperclip: a cheap model and a one-line prompt, but set up
// like a run on Paperclip's managed AI connection (throwaway home, a bogus token, the "user settings only"
// switch). It passes only if the run uses Claude Desktop's Claude Code with your own login and setup.
// Costs one short model call.  node scripts/live-smoke.mjs [--model haiku] [--cwd <folder>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerAdapter, desktopClaudeCode } from '../index.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const scratch = !arg('cwd');
const cwd = path.resolve(arg('cwd', '') || fs.mkdtempSync(path.join(os.tmpdir(), 'native-smoke-')));
const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-ai-smoke-'));
const runId = crypto.randomUUID();
const logs = [];
let meta = null;

const result = await createServerAdapter().execute({
  runId,
  agent: { id: 'native-smoke', companyId: 'native-smoke', name: 'Native smoke test', adapterType: 'claude_local', adapterConfig: {} },
  runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
  config: {
    cwd,
    model: arg('model', 'haiku'),
    maxTurnsPerRun: 1,
    promptTemplate: 'Reply with exactly this and nothing else: native-ok',
    managedAiConnection: { identity: 'smoke' },
    env: { HOME: throwaway, CLAUDE_CONFIG_DIR: path.join(throwaway, 'provider'), CLAUDE_CODE_OAUTH_TOKEN: 'bogus-token' },
  },
  context: {},
  authToken: 'smoke-run-key',
  runtimeMcp: { getServers: () => [{ name: 'paperclip', url: 'http://127.0.0.1:9/mcp', token: 'smoke', connectionId: 'smoke-conn' }] },
  onLog: async (_stream, chunk) => { logs.push(chunk); },
  onMeta: async (m) => { meta = m; },
});

const args = meta?.commandArgs ?? [];
const transcript = result.sessionId ? path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${result.sessionId}.jsonl`) : null;
const checks = [
  ["Claude Desktop's Claude Code", !desktopClaudeCode() || meta?.command === desktopClaudeCode().file, meta?.command],
  ['no "user settings only" switch', !args.includes('--setting-sources'), ''],
  ['Paperclip tools load next to yours (no --strict-mcp-config)', args.includes('--mcp-config') && !args.includes('--strict-mcp-config'), ''],
  ['no throwaway config folder', !meta?.env?.CLAUDE_CONFIG_DIR, meta?.env?.CLAUDE_CONFIG_DIR ?? ''],
  ['run succeeded on your own login', result.exitCode === 0 && /native-ok/.test(JSON.stringify(result.resultJson ?? result.summary ?? '')), result.errorMessage ?? ''],
  ['conversation saved in your own Claude folder', Boolean(transcript && fs.existsSync(transcript)), transcript ?? ''],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);
fs.rmSync(throwaway, { recursive: true, force: true });
if (scratch) { // the scratch folder and its one test conversation go too
  fs.rmSync(cwd, { recursive: true, force: true });
  if (transcript) fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
}
if (checks.some(([, ok]) => !ok)) { console.log(logs.join('').slice(-1500)); process.exit(1); }
