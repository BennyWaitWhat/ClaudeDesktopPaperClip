// Offline checks: no Paperclip server and no model calls. Needs Paperclip installed next to this Node
// (the add-on loads Paperclip's own Claude adapter from there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecute, createServerAdapter, desktopClaudeCode, findPaperclipPackage, nativeConfig, THROWAWAY_ENV, windowsUserEnv } from '../index.mjs';
import { liveSessions, openInDesktop } from '../desktop.mjs';

test("finds Paperclip's own Claude adapter", () => {
  const dir = findPaperclipPackage('adapter-claude-local');
  assert.ok(dir && fs.existsSync(path.join(dir, 'dist', 'server', 'index.js')), String(dir));
});

test("finds Claude Desktop's Claude Code on Windows", { skip: process.platform !== 'win32' }, () => {
  const code = desktopClaudeCode();
  assert.ok(code, 'Claude Desktop has not installed Claude Code here');
  assert.match(code.file, /[\\/]Claude[\\/]claude-code[\\/][\d.]+[\\/][^\\/]+[\\/]claude\.exe$/);
});

test('picks the newest Claude Code version Claude Desktop installed', { skip: process.platform !== 'win32' }, () => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'native-appdata-'));
  for (const [version, build] of [['2.1.9', 'aaa'], ['2.1.293', 'bbb'], ['2.1.30', 'ccc']]) {
    const dir = path.join(appdata, 'Claude', 'claude-code', version, build);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  }
  assert.equal(desktopClaudeCode({ APPDATA: appdata, LOCALAPPDATA: appdata }).version, '2.1.293');
  fs.rmSync(appdata, { recursive: true, force: true });
});

test("also finds it inside the packaged app's own folder", { skip: process.platform !== 'win32' }, () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'native-local-'));
  const dir = path.join(local, 'Packages', 'Claude_test123', 'LocalCache', 'Roaming', 'Claude', 'claude-code', '9.9.9', 'zzz');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  const found = desktopClaudeCode({ APPDATA: path.join(local, 'none'), LOCALAPPDATA: local });
  assert.equal(found.version, '9.9.9');
  fs.rmSync(local, { recursive: true, force: true });
});

test("reads Claude Code's live-session registry, skipping dead entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reg-'));
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'aaaa', status: 'busy', kind: 'interactive' }));
  fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'bbbb', status: 'idle', kind: 'interactive' }));
  fs.writeFileSync(path.join(dir, `${process.pid}.abc.key`), 'secret');
  assert.deepEqual(liveSessions(dir).map((s) => [s.sessionId, s.status]), [['aaaa', 'busy']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('opens only real session ids, in folders that exist, in Claude Desktop', async () => {
  assert.equal((await openInDesktop("x'; Remove-Item C:\\ -Recurse", 'C:/')).ok, false);
  const gone = await openInDesktop('5bb63481-e691-487d-a5b2-16e23978da0d', path.join(os.tmpdir(), 'no-such-folder-xyz'));
  assert.equal(gone.reason, process.platform === 'win32' ? 'its folder is gone' : 'only on Windows so far');
});

test('a conversation Claude Desktop already has open is reported as open, not handed over again', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reg-'));
  const id = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status: 'idle', kind: 'interactive' }));
  assert.deepEqual(await openInDesktop(id, os.tmpdir(), 'claude-not-run', dir), { ok: true, alreadyOpen: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fills in the Windows basics a plugin worker starts without, keeping what is there', { skip: process.platform !== 'win32' }, () => {
  const env = windowsUserEnv({ PATH: 'C:/x', APPDATA: 'D:/mine' });
  assert.equal(env.PATH, 'C:/x');
  assert.equal(env.APPDATA, 'D:/mine');
  assert.equal(env.USERPROFILE, os.homedir());
  assert.ok(env.SystemRoot && env.LOCALAPPDATA && env.TEMP && env.USERNAME, JSON.stringify(env));
});

test("the wizard's Claude check runs on your own setup, without the managed connection's throwaway home", () => {
  const managed = {
    managedAiConnection: { identity: 'grant:user:gen' }, engine: 'acp', command: 'claude', model: 'claude-opus-5',
    env: { HOME: 'C:/Temp/paperclip-ai-x', CLAUDE_CONFIG_DIR: 'C:/Temp/paperclip-ai-x/provider', CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_API_KEY: '', MY_SETTING: 'kept' },
  };
  const before = JSON.stringify(managed);
  const out = nativeConfig(managed, { command: 'C:/Claude/claude.exe' });
  assert.equal(JSON.stringify(managed), before, 'input left untouched');
  assert.equal(out.managedAiConnection, undefined);
  for (const key of THROWAWAY_ENV) assert.equal(key in out.env, false, key);
  assert.equal(out.env.ANTHROPIC_API_KEY, '', 'a blanked API key stays blank');
  assert.equal(out.env.MY_SETTING, 'kept');
  assert.equal(out.engine, 'cli');
  assert.equal(out.command, 'C:/Claude/claude.exe');
  assert.equal(nativeConfig({}).command, 'claude');
});

test('a Desktop-turn wake is recorded; every other wake waits for Desktop; Claude is never started', async () => {
  const seen = [];
  const execute = createExecute({
    recordTurn: async (ctx) => { seen.push(['record', ctx.runId]); return { exitCode: 0, summary: 'recorded' }; },
    absorbWake: async (ctx) => { seen.push(['absorb', ctx.runId]); return { exitCode: 0, summary: 'waiting' }; },
  });
  const base = { agent: { id: 'a1', name: 'Cashier' }, config: {}, onLog: async () => {} };
  assert.equal((await execute({ ...base, runId: 'r1', context: { wakeReason: 'desktop_turn' } })).summary, 'recorded');
  assert.equal((await execute({ ...base, runId: 'r2', context: { wakeReason: 'issue_assigned' } })).summary, 'waiting');
  assert.equal((await execute({ ...base, runId: 'r3', context: {} })).summary, 'waiting');
  assert.deepEqual(seen, [['record', 'r1'], ['absorb', 'r2'], ['absorb', 'r3']]);
});

test('stands in for the built-in Claude type with its own pieces', () => {
  const a = createServerAdapter();
  assert.equal(a.type, 'claude_local');
  assert.equal(a.supportsInstructionsBundle, true);
  assert.equal(a.supportsLocalAgentJwt, true);
  for (const fn of ['execute', 'testEnvironment', 'listSkills', 'syncSkills', 'listModels', 'getConfigSchema', 'getQuotaWindows']) assert.equal(typeof a[fn], 'function', fn);
  assert.equal(typeof a.sessionCodec?.deserialize, 'function');
  assert.ok(Array.isArray(a.models) && a.models.length > 0);
  assert.match(a.agentConfigurationDoc, /Claude Desktop team/);
});
