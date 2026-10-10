// Offline checks: no Paperclip server and no model calls. Needs Paperclip installed next to this Node
// (the add-on loads Paperclip's own Claude adapter from there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerAdapter, desktopClaudeCode, fetchOrgFolder, findPaperclipPackage, isFallbackFolder, liveSessions, nativeConfig, openInDesktop, ORG_FOLDER_PLUGIN, runFolder, sessionTitle, THROWAWAY_ENV, windowsUserEnv, writeRunMcpConfig } from '../index.mjs';

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

test('sessions are titled "<card> · <agent>"', () => {
  assert.equal(sessionTitle({ agent: { name: 'Chief of Staff' }, context: { paperclipWake: { issue: { identifier: 'CAR-15' } } } }), 'CAR-15 · Chief of Staff');
  assert.equal(sessionTitle({ agent: { name: 'Steward' }, context: {} }), 'Steward');
  assert.equal(nativeConfig({}, { title: 'CAR-1 · X', mcpConfigPath: 'm.json' }).extraArgs.join(' '), '--name CAR-1 · X --mcp-config m.json');
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

test('fills in the Windows basics a plugin worker starts without, keeping what is there', { skip: process.platform !== 'win32' }, () => {
  const env = windowsUserEnv({ PATH: 'C:/x', APPDATA: 'D:/mine' });
  assert.equal(env.PATH, 'C:/x');
  assert.equal(env.APPDATA, 'D:/mine');
  assert.equal(env.USERPROFILE, os.homedir());
  assert.ok(env.SystemRoot && env.LOCALAPPDATA && env.TEMP && env.USERNAME, JSON.stringify(env));
});

const ROOT = path.join(os.tmpdir(), 'pc-root');
const ws = (over) => ({ cwd: path.join(ROOT, 'workspaces', 'agent-1'), source: 'agent_home', workspaceId: null, ...over });

test("tells Paperclip's hidden fallback folders from folders someone chose", () => {
  assert.equal(isFallbackFolder(ws(), ROOT), true, 'agent home');
  assert.equal(isFallbackFolder(ws({ source: 'project_primary', cwd: path.join(ROOT, 'projects', 'c', 'p', '_default') }), ROOT), true, 'project with no folder');
  assert.equal(isFallbackFolder(ws({ source: 'task_session' }), ROOT), true, 'old session in the agent home');
  assert.equal(isFallbackFolder(ws({ source: 'project_primary', workspaceId: 'w1', cwd: 'C:/Work/Repo' }), ROOT), false, 'project folder you set');
  assert.equal(isFallbackFolder(ws({ source: 'project_primary', workspaceId: 'w1' }), ROOT), false, 'a set project folder, even inside Paperclip');
  assert.equal(isFallbackFolder(ws({ worktreePath: path.join(ROOT, 'wt') }), ROOT), false, 'isolated worktree');
  assert.equal(isFallbackFolder(ws({ source: 'task_session', cwd: 'C:/Users/me/Desktop/Test Org' }), ROOT), false, 'already in the org folder');
  assert.equal(isFallbackFolder(ws({ source: 'execution_workspace' }), ROOT), false);
  assert.equal(isFallbackFolder(undefined, ROOT), false);
});

test("asks the Claude Desktop plugin for the org folder with the run's own token", async () => {
  const org = fs.mkdtempSync(path.join(os.tmpdir(), 'native-org-'));
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return { ok: true, json: async () => ({ path: org }) }; };
  const ctx = { authToken: 'run-jwt', runId: 'r1', agent: { id: 'a1', companyId: 'c1' }, config: {}, context: { paperclipWorkspace: ws() } };
  assert.equal(await fetchOrgFolder(ctx, { fetchImpl, apiUrl: 'http://127.0.0.1:3100/' }), org);
  assert.deepEqual(calls, [{ url: `http://127.0.0.1:3100/api/plugins/${ORG_FOLDER_PLUGIN}/api/org-folder`, auth: 'Bearer run-jwt' }]);
  assert.equal(await fetchOrgFolder({ ...ctx, authToken: undefined }, { fetchImpl, apiUrl: 'http://x' }), null, 'no token, no ask');
  assert.equal(await fetchOrgFolder(ctx, { fetchImpl: async () => { throw new Error('down'); }, apiUrl: 'http://x' }), null, 'plugin off');
  assert.equal(await fetchOrgFolder(ctx, { fetchImpl: async () => ({ ok: true, json: async () => ({ path: path.join(org, 'gone') }) }), apiUrl: 'http://x' }), null, 'folder missing');

  const opts = { fetchImpl, apiUrl: 'http://x', paperclipRoot: ROOT };
  assert.deepEqual(await runFolder(ctx, opts), { cwd: org, from: 'the org folder' });
  assert.deepEqual(await runFolder({ ...ctx, config: { cwd: os.tmpdir() } }, opts), { cwd: os.tmpdir(), from: "the agent's own folder" });
  const project = { ...ctx, context: { paperclipWorkspace: ws({ source: 'project_primary', workspaceId: 'w1', cwd: 'C:/Work/Repo' }) } };
  assert.equal(await runFolder(project, opts), null, 'a set project folder wins');
  fs.rmSync(org, { recursive: true, force: true });
});

test('a managed run config becomes a native one', () => {
  const managed = {
    managedAiConnection: { identity: 'grant:user:gen' },
    engine: 'acp',
    command: 'claude',
    model: 'claude-opus-5',
    extraArgs: ['--foo'],
    env: {
      HOME: 'C:/Temp/paperclip-ai-x', XDG_CONFIG_HOME: 'x', XDG_DATA_HOME: 'x', CODEX_HOME: 'x', GROK_HOME: 'x',
      CLAUDE_CONFIG_DIR: 'C:/Temp/paperclip-ai-x/provider', CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '', MY_SETTING: 'kept',
    },
  };
  const before = JSON.stringify(managed);
  const out = nativeConfig(managed, { agentId: 'agent-1', command: 'C:/Claude/claude.exe', mcpConfigPath: 'C:/Temp/mcp.json' });
  assert.equal(JSON.stringify(managed), before, 'input left untouched');
  assert.equal(out.managedAiConnection, undefined);
  for (const key of THROWAWAY_ENV) assert.equal(key in out.env, false, key);
  assert.equal(out.env.ANTHROPIC_API_KEY, '', 'a blanked API key stays blank, so a server-level key never bills a run');
  assert.equal(out.env.MY_SETTING, 'kept');
  assert.equal(out.env.ANTHROPIC_CUSTOM_HEADERS, 'X-Anthropic-Agent-Id: agent-1');
  assert.equal(out.engine, 'cli');
  assert.equal(out.command, 'C:/Claude/claude.exe');
  assert.equal(out.model, 'claude-opus-5');
  assert.deepEqual(out.extraArgs, ['--foo', '--mcp-config', 'C:/Temp/mcp.json']);
});

test('falls back to the configured command, then claude on PATH', () => {
  assert.equal(nativeConfig({ command: 'D:/claude.exe' }).command, 'D:/claude.exe');
  assert.equal(nativeConfig({}).command, 'claude');
  assert.deepEqual(nativeConfig({ args: ['--x'] }).extraArgs, ['--x']);
});

test("Paperclip's run tools go in an MCP config next to your own", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-'));
  assert.equal(await writeRunMcpConfig('run-0', [], base), null);
  const out = await writeRunMcpConfig('run-1', [
    { name: 'paperclip', url: 'http://127.0.0.1:3100/mcp', token: 't1', connectionId: 'conn-aaaa1111' },
    { name: 'paperclip', url: 'http://127.0.0.1:3100/mcp2', token: 't2', connectionId: 'conn-bbbb2222' },
  ], base);
  const json = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  assert.deepEqual(Object.keys(json.mcpServers), ['paperclip', 'paperclip-conn-bbb']);
  assert.deepEqual(json.mcpServers.paperclip, { type: 'http', url: 'http://127.0.0.1:3100/mcp', headers: { Authorization: 'Bearer t1' } });
  fs.rmSync(base, { recursive: true, force: true });
});

test('stands in for the built-in Claude type with its own pieces', () => {
  const a = createServerAdapter();
  assert.equal(a.type, 'claude_local');
  assert.equal(a.supportsInstructionsBundle, true);
  assert.equal(a.supportsLocalAgentJwt, true);
  assert.equal(a.runtimeToolDelivery, 'native_mcp');
  for (const fn of ['execute', 'testEnvironment', 'listSkills', 'syncSkills', 'listModels', 'getConfigSchema', 'getQuotaWindows']) assert.equal(typeof a[fn], 'function', fn);
  assert.equal(typeof a.sessionCodec?.deserialize, 'function');
  assert.ok(Array.isArray(a.models) && a.models.length > 0);
  assert.match(a.agentConfigurationDoc, /Native runs/);
});
