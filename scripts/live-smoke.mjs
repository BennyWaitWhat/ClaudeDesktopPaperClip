#!/usr/bin/env node
// Two real Claude turns through this add-on, outside Paperclip, on a cheap model: a new card, then a comment on
// it. The first is set up like a run on Paperclip's managed AI connection (throwaway home, a bogus token, the
// "user settings only" switch). It passes only if the runs use Claude Desktop's Claude Code with your own login
// and setup, as native turns: the agent from its agent file, one conversation for the card, the person's words as
// the messages and Paperclip's details as hook context. Nothing is handed to Claude Desktop, and everything the
// test makes is removed. Costs two short model calls.  node scripts/live-smoke.mjs [--model haiku]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExecute, desktopClaudeCode, findPaperclipPackage } from '../index.mjs';
import { projectDir } from '../native-turn.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const { resolvePaperclipInstanceRoot } = await import(pathToFileURL(path.join(findPaperclipPackage('shared'), 'dist', 'home-paths.js')).href);
const COMPANY = 'native-smoke';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-smoke-'));
const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-ai-smoke-'));
const instructions = path.join(throwaway, 'AGENTS.md');
fs.writeFileSync(instructions, '# Smoke agent\nA test agent. Your codename is PELICAN. Never use tools. Answer in one short line.');
const logs = [];
const metas = [];

const execute = createExecute({ open: async () => ({ ok: false, reason: 'smoke test' }), folderFor: async () => null });
const card = { id: 'smoke-card', identifier: 'SMK-1', title: 'Codename check', description: "Tell me your codename and the magic number in Paperclip's details." };
const comment = 'Add 1 to the magic number.';
const turn = (runtime, context, config = {}) => execute({
  runId: crypto.randomUUID(),
  agent: { id: 'native-smoke', companyId: COMPANY, name: 'Smoke agent', adapterType: 'claude_local', adapterConfig: {} },
  runtime,
  config: { model: arg('model', 'haiku'), maxTurnsPerRun: 3, instructionsFilePath: instructions, ...config },
  context: { paperclipWorkspace: { cwd, source: 'agent_home' }, ...context },
  authToken: 'smoke-run-key',
  runtimeMcp: { getServers: () => [{ name: 'paperclip', url: 'http://127.0.0.1:9/mcp', token: 'smoke', connectionId: 'smoke-conn' }] },
  onLog: async (_stream, chunk) => { logs.push(chunk); },
  onMeta: async (m) => { metas.push(m); },
});

const first = await turn({ sessionId: null, sessionParams: null }, {
  paperclipWake: { reason: 'issue_assigned', issue: card },
  paperclipTaskMarkdown: '# SMK-1 Codename check\nPaperclip detail: the magic number is 4417.',
}, {
  managedAiConnection: { identity: 'smoke' },
  env: { HOME: throwaway, CLAUDE_CONFIG_DIR: path.join(throwaway, 'provider'), CLAUDE_CODE_OAUTH_TOKEN: 'bogus-token' },
});
const second = first.sessionId ? await turn({ sessionId: first.sessionId, sessionParams: first.sessionParams }, {
  paperclipWake: { reason: 'issue_commented', issue: card, comments: [{ id: 'c1', body: comment, author: { type: 'user', id: 'u1' } }] },
  paperclipTaskMarkdown: '# SMK-1 Codename check',
}) : null;

const args = metas[0]?.commandArgs ?? [];
const transcript = first.sessionId ? path.join(projectDir(cwd), `${first.sessionId}.jsonl`) : null;
const entries = transcript && fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const said = entries.filter((e) => e.type === 'user' && typeof e.message?.content === 'string').map((e) => e.message.content);
const hooked = entries.filter((e) => e.attachment?.type === 'hook_additional_context').length;
const text = (r) => JSON.stringify(r?.summary ?? r?.resultJson ?? '');
const checks = [
  ["Claude Desktop's Claude Code", !desktopClaudeCode() || metas[0]?.command === desktopClaudeCode().file, metas[0]?.command],
  ['no "user settings only" switch', !args.includes('--setting-sources'), ''],
  ['Paperclip tools load next to yours (no --strict-mcp-config)', args.includes('--mcp-config') && !args.includes('--strict-mcp-config'), ''],
  ['no throwaway config folder', !metas[0]?.env?.CLAUDE_CONFIG_DIR, metas[0]?.env?.CLAUDE_CONFIG_DIR ?? ''],
  ['the agent from its agent file, on your own login', first.exitCode === 0 && /PELICAN/i.test(text(first)), first.errorMessage ?? text(first)],
  ["Paperclip's details arrive as hook context", /4417/.test(text(first)) && hooked === 2, `${hooked} hook contexts`],
  ['one conversation for the card', second?.sessionId === first.sessionId && args.length > 0 && metas[1]?.commandArgs.includes('--resume'), second?.sessionId ?? ''],
  ["the messages are the card and the person's words", JSON.stringify(said) === JSON.stringify([`${card.title}\n\n${card.description}`, comment]), JSON.stringify(said)],
  ['it remembers the first turn', /4418/.test(text(second)), text(second)],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);

// Everything the test made: its folders, its conversation, and what Paperclip's adapter keeps for the test org.
fs.rmSync(throwaway, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(projectDir(cwd), { recursive: true, force: true });
fs.rmSync(path.join(resolvePaperclipInstanceRoot(), 'companies', COMPANY), { recursive: true, force: true });
if (checks.some(([, ok]) => !ok)) { console.log(logs.join('').slice(-1500)); process.exit(1); }
