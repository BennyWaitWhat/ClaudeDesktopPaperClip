// Offline checks: no Paperclip server and no model calls. Needs Paperclip installed next to this Node
// (the add-on loads Paperclip's own Claude adapter from there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerAdapter, desktopClaudeCode, findPaperclipPackage, nativeConfig, THROWAWAY_ENV, writeRunMcpConfig } from '../index.mjs';

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
  assert.equal(desktopClaudeCode({ APPDATA: appdata }).version, '2.1.293');
  fs.rmSync(appdata, { recursive: true, force: true });
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
