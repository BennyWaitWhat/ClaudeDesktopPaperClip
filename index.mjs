// ClaudeDesktopPaperClip: Paperclip's Claude agent type, run natively on Claude Desktop's own Claude Code.
//
// Paperclip loads this folder as a local adapter package (Settings > Adapters, or POST /api/adapters/install
// with isLocalPath). Its type is claude_local, so it stands in for Paperclip's built-in Claude type for every
// Claude agent in every org: existing ones, ones created by hand, and ones another agent hires. Pausing the
// override in Settings > Adapters restores Paperclip's own.
//
// Each run is Paperclip's own Claude adapter, unchanged, with four things removed:
//   1. The throwaway home. Paperclip's managed AI connection starts Claude Code with a temp HOME and
//      CLAUDE_CONFIG_DIR and its own token, so agents never see your login, plugins, skills, memory or
//      connectors. Those variables are dropped and Claude Code uses your own setup.
//   2. The "user settings only" switch (--setting-sources user) that comes with the managed connection, so
//      the org folder's own .claude settings, agents and skills load like in any Claude Code session.
//   3. The bundled engine. Runs use the CLI engine with the Claude Code that Claude Desktop runs
//      (%APPDATA%\Claude\claude-code\<newest>\...\claude.exe), never ACP, which carries an older bundled
//      Claude Code and rewrites .claude/settings.local.json on every run.
//   4. Paperclip-only tools. Paperclip passes its run tools as the only MCP servers (--strict-mcp-config);
//      here they load next to your own MCP servers and claude.ai connectors.
// The org folder is the folder Paperclip already runs the agent in (the project's workspace, or the
// agent's cwd), so Claude Code loads that folder's CLAUDE.md, .claude/ and memory.
//
// Claude Desktop sees the agents' sessions: each session is named "<card> · <agent>", and a run that starts a
// new conversation hands it to Claude Desktop (claude --desktop --resume), which lists it in the sidebar under
// that folder. A run waits while you are mid-turn in the agent's session in Claude Desktop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Folder of a @paperclipai package next to the running Paperclip (realpath, so the server's own copy). */
export function findPaperclipPackage(name, starts = [
  process.argv[1],
  path.join(path.dirname(process.execPath), 'node_modules', 'paperclipai', 'dist', 'index.js'),
]) {
  for (const start of starts) {
    if (!start) continue;
    let dir = path.dirname(path.resolve(start));
    for (;;) {
      const pkg = path.join(dir, 'node_modules', '@paperclipai', name);
      if (fs.existsSync(path.join(pkg, 'package.json'))) return fs.realpathSync(pkg);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const compareVersions = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

// Claude Desktop is a packaged Windows app: its %APPDATA%\Claude is only visible under that name to programs
// it starts. Everything else finds the same folder under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming.
function desktopCodeRoots(env) {
  const roots = [path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code')];
  const packages = path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  for (const pkg of list(packages)) if (/^Claude_/i.test(pkg)) roots.push(path.join(packages, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
  return roots;
}

/** The newest Claude Code that Claude Desktop installed (Windows), or null. */
export function desktopClaudeCode(env = process.env) {
  if (process.platform !== 'win32') return null;
  let best = null;
  for (const root of desktopCodeRoots(env)) {
    for (const version of list(root)) {
      if (!/^\d+\.\d+/.test(version)) continue;
      for (const build of list(path.join(root, version))) {
        const file = path.join(root, version, build, 'claude.exe');
        if (!fs.existsSync(file)) continue;
        const mtime = fs.statSync(file).mtimeMs;
        const order = best ? compareVersions(version, best.version) : 1;
        if (order > 0 || (order === 0 && mtime > best.mtime)) best = { version, file, mtime };
      }
    }
  }
  return best ? { version: best.version, file: best.file } : null;
}

/** Claude Desktop's title for an agent's session: "<card> · <agent>", or the agent alone without a card. */
export function sessionTitle(ctx) {
  const card = ctx.context?.paperclipWake?.issue?.identifier ?? ctx.context?.issueIdentifier;
  const name = ctx.agent?.name ?? 'Agent';
  return String(card ? `${card} · ${name}` : name).replace(/[\r\n]+/g, ' ').slice(0, 120);
}

/** Live Claude Code sessions on this PC, from Claude Code's own registry (~/.claude/sessions/<pid>.json). */
export function liveSessions(dir = path.join(os.homedir(), '.claude', 'sessions')) {
  const out = [];
  for (const f of list(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      process.kill(s.pid, 0); // throws when the process is gone
      out.push({ pid: s.pid, sessionId: s.sessionId, status: s.status, kind: s.kind, hostSessionId: s.hostSessionId });
    } catch { /* stale or unreadable */ }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hand a Claude Code conversation to Claude Desktop (claude --desktop --resume), which lists it in the sidebar. */
export function openInDesktop(sessionId, cwd, claude = desktopClaudeCode()?.file ?? 'claude') {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: 'only on Windows so far' });
  if (!UUID.test(String(sessionId))) return Promise.resolve({ ok: false, reason: 'not a session id' });
  // `claude --desktop` refuses to run without a real console, so it gets a hidden one of its own.
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const command = `Start-Process -FilePath ${q(claude)} -ArgumentList '--desktop','--resume',${q(sessionId)} -WorkingDirectory ${q(cwd)} -WindowStyle Hidden -Wait`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, reason: 'timed out' }); }, 30_000);
    p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code}` }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
  });
}

// What Paperclip's managed AI connection puts in a run's environment (its throwaway home and token).
export const THROWAWAY_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** The run config Paperclip's Claude adapter gets: the same, minus everything that makes it non-native. */
export function nativeConfig(config = {}, { agentId, command, mcpConfigPath, title } = {}) {
  const { managedAiConnection: _managed, ...rest } = config ?? {};
  const env = { ...(rest.env && typeof rest.env === 'object' ? rest.env : {}) };
  for (const key of THROWAWAY_ENV) delete env[key];
  const id = agentId ? String(agentId).replace(/[\r\n]/g, '').trim().slice(0, 256) : '';
  if (id && !/(^|\n)\s*X-Anthropic-Agent-Id\s*:/i.test(env.ANTHROPIC_CUSTOM_HEADERS ?? '')) {
    env.ANTHROPIC_CUSTOM_HEADERS = [env.ANTHROPIC_CUSTOM_HEADERS, `X-Anthropic-Agent-Id: ${id}`].filter(Boolean).join('\n');
  }
  const extraArgs = strings(rest.extraArgs).length ? strings(rest.extraArgs) : strings(rest.args);
  if (title) extraArgs.push('--name', title);
  if (mcpConfigPath) extraArgs.push('--mcp-config', mcpConfigPath); // last: --mcp-config takes a list
  return { ...rest, env, engine: 'cli', command: command ?? rest.command ?? 'claude', extraArgs };
}

/** Paperclip's run tools as an MCP config file (same shape Paperclip writes), loaded without --strict. */
export async function writeRunMcpConfig(runId, servers, baseDir = path.join(os.tmpdir(), 'paperclip-claude-native')) {
  if (!servers?.length) return null;
  const dir = path.join(baseDir, String(runId).replace(/[^\w-]/g, '_'));
  const used = new Set();
  const mcpServers = {};
  for (const server of servers) {
    const short = String(server.connectionId ?? '').slice(0, 8);
    let name = server.name;
    if (used.has(name)) name = `${server.name}-${short}`;
    for (let n = 2; used.has(name); n++) name = `${server.name}-${short}-${n}`;
    used.add(name);
    mcpServers[name] = { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } };
  }
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'mcp-config.json');
  await fsp.writeFile(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return { file, dir };
}

const claudePkg = findPaperclipPackage('adapter-claude-local');
if (!claudePkg) throw new Error('claude-native: cannot find @paperclipai/adapter-claude-local next to the running Paperclip.');
const builtin = await import(pathToFileURL(path.join(claudePkg, 'dist', 'server', 'index.js')).href);
const info = await import(pathToFileURL(path.join(claudePkg, 'dist', 'index.js')).href);

const native = (ctx, extra = {}) => nativeConfig(ctx.config, { agentId: ctx.agent?.id, command: desktopClaudeCode()?.file, ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const priorSessionId = (ctx) => ctx.runtime?.sessionParams?.sessionId ?? ctx.runtime?.sessionId ?? null;

async function execute(ctx) {
  const log = (line) => ctx.onLog('stdout', `[native] ${line}\n`);
  // Never run beside you: while you are mid-turn in this agent's session in Claude Desktop, wait.
  const prior = priorSessionId(ctx);
  let waited = false;
  while (prior && liveSessions().some((s) => s.sessionId === prior && s.kind === 'interactive' && s.status === 'busy')) {
    if (!waited) { waited = true; await log("You are working in this agent's session in Claude Desktop; the run starts when that turn ends."); }
    if (ctx.signal?.aborted) return { exitCode: null, signal: 'SIGTERM', timedOut: false, errorMessage: 'Cancelled in Paperclip' };
    await sleep(5000);
  }

  const title = sessionTitle(ctx);
  const mcp = await writeRunMcpConfig(ctx.runId, ctx.runtimeMcp?.getServers?.() ?? []);
  let result;
  try {
    result = await builtin.execute({ ...ctx, config: native(ctx, { mcpConfigPath: mcp?.file, title }), runtimeMcp: undefined });
  } finally {
    if (mcp) await fsp.rm(mcp.dir, { recursive: true, force: true }).catch(() => {});
  }

  // A new conversation goes to Claude Desktop's sidebar, under the folder it ran in.
  const session = result?.sessionId ?? result?.sessionParams?.sessionId;
  const cwd = result?.sessionParams?.cwd ?? ctx.config?.cwd;
  if (session && session !== prior && cwd) {
    const opened = await openInDesktop(session, cwd);
    await log(opened.ok ? `Opened in Claude Desktop as "${title}".` : `Could not open it in Claude Desktop (${opened.reason}).`);
  }
  return result;
}

async function testEnvironment(ctx) {
  const result = await builtin.testEnvironment({ ...ctx, config: native(ctx) });
  const code = desktopClaudeCode();
  const check = code
    ? { code: 'claude_native_desktop_code', level: 'info', message: `Runs on Claude Desktop's Claude Code ${code.version} with your own setup.`, detail: code.file }
    : { code: 'claude_native_no_desktop_code', level: 'warn', message: "Claude Desktop's Claude Code was not found; runs use `claude` from PATH with your own setup.", hint: 'Install Claude Desktop, or keep Claude Code on PATH.' };
  return { ...result, checks: [check, ...(result.checks ?? [])] };
}

export const NATIVE_NOTE = `## Native runs (ClaudeDesktopPaperClip)

This Paperclip runs Claude agents on Claude Desktop's own Claude Code with your own setup: your login,
plugins, skills, memory, MCP servers and claude.ai connectors, in the org folder Paperclip runs the agent in.
The managed AI connection's throwaway home, the "user settings only" switch, the ACP engine and the
Paperclip-only MCP switch are not used. "engine" is always cli and "command" is Claude Desktop's Claude Code
(or \`claude\` on PATH when Claude Desktop is not installed). Remote and sandbox execution targets are not
supported. Pause the override in Settings > Adapters to go back to Paperclip's own Claude type.`;

export function createServerAdapter() {
  return {
    type: 'claude_local',
    runtimeToolDelivery: 'native_mcp',
    execute,
    testEnvironment,
    listSkills: builtin.listClaudeSkills,
    syncSkills: builtin.syncClaudeSkills,
    sessionCodec: builtin.sessionCodec,
    models: info.models,
    listModels: builtin.listClaudeModels,
    refreshModels: builtin.refreshClaudeModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: 'instructionsFilePath',
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc: `${info.agentConfigurationDoc}\n\n${NATIVE_NOTE}\n`,
    getConfigSchema: builtin.getConfigSchema,
    getQuotaWindows: builtin.getQuotaWindows,
  };
}
