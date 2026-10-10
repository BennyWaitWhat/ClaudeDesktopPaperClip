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
// Each run works in a real folder, so Claude Code loads its CLAUDE.md, .claude/ and memory: the card's project
// folder when the project has one, else the agent's own folder (cwd), else the org's folder from the Claude
// Desktop plugin (plugin/), never the hidden folders Paperclip falls back to.
//
// Each run is a native Claude Code turn (native-turn.mjs): the agent is a Claude Code agent (--agent), each card
// is one conversation that continues every run, the message is what the person wrote on the card, and
// Paperclip's details for the turn arrive as hook context beside it.
//
// Claude Desktop sees the agents' sessions: each session is named "<card> · <agent>", and a run that starts a
// new conversation hands it to Claude Desktop (claude --desktop --resume), which lists it in the sidebar under
// that folder. A conversation has one writer at a time: a run waits while you are mid-turn in it anywhere, and
// closes Claude Desktop's idle loaded copy first, so Desktop loads it again from disk, run turn included.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Same cache-busting query as this file, so Paperclip's adapter reload also reloads the shared helpers.
const sibling = (file) => import(new URL(`./${file}${new URL(import.meta.url).search}`, import.meta.url).href);
const desktop = await sibling('desktop.mjs');
export const { closeDesktopCopies, conversationCopies, desktopClaudeCode, isIdleDesktopCopy, liveSessions, openInDesktop, windowsUserEnv } = desktop;
const { prepareNativeTurn } = await sibling('native-turn.mjs');

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

/** Claude Desktop's title for an agent's session: "<card> · <agent>", or the agent alone without a card. */
export function sessionTitle(ctx) {
  const card = ctx.context?.paperclipWake?.issue?.identifier ?? ctx.context?.issueIdentifier;
  const name = ctx.agent?.name ?? 'Agent';
  return String(card ? `${card} · ${name}` : name).replace(/[\r\n]+/g, ' ').slice(0, 120);
}

// What Paperclip's managed AI connection puts in a run's environment (its throwaway home and token).
export const THROWAWAY_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * The run config Paperclip's Claude adapter gets: the same, minus everything that makes it non-native, plus the
 * native turn's own arguments (`args`) and settings (`overrides`).
 */
export function nativeConfig(config = {}, { agentId, command, mcpConfigPath, title, args = [], overrides = {} } = {}) {
  const { managedAiConnection: _managed, ...rest } = config ?? {};
  const env = { ...(rest.env && typeof rest.env === 'object' ? rest.env : {}) };
  for (const key of THROWAWAY_ENV) delete env[key];
  const id = agentId ? String(agentId).replace(/[\r\n]/g, '').trim().slice(0, 256) : '';
  if (id && !/(^|\n)\s*X-Anthropic-Agent-Id\s*:/i.test(env.ANTHROPIC_CUSTOM_HEADERS ?? '')) {
    env.ANTHROPIC_CUSTOM_HEADERS = [env.ANTHROPIC_CUSTOM_HEADERS, `X-Anthropic-Agent-Id: ${id}`].filter(Boolean).join('\n');
  }
  const extraArgs = [...(strings(rest.extraArgs).length ? strings(rest.extraArgs) : strings(rest.args)), ...strings(args)];
  if (title) extraArgs.push('--name', title);
  if (mcpConfigPath) extraArgs.push('--mcp-config', mcpConfigPath); // last: --mcp-config takes a list
  return { ...rest, ...overrides, env, engine: 'cli', command: command ?? rest.command ?? 'claude', extraArgs };
}

// Each run's own scratch folder (Paperclip's run tools, the agent for a git repo, the turn's hook), removed after.
export const RUN_BASE = path.join(os.tmpdir(), 'paperclip-claude-native');
const runDirFor = (runId, baseDir = RUN_BASE) => path.join(baseDir, String(runId).replace(/[^\w-]/g, '_'));

/** Paperclip's run tools as an MCP config file (same shape Paperclip writes), loaded without --strict. */
export async function writeRunMcpConfig(runId, servers, baseDir = RUN_BASE) {
  if (!servers?.length) return null;
  const dir = runDirFor(runId, baseDir);
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
const paperclipUtils = await import(pathToFileURL(path.join(findPaperclipPackage('adapter-utils'), 'dist', 'server-utils.js')).href);
const paperclipPaths = await import(pathToFileURL(path.join(findPaperclipPackage('shared'), 'dist', 'home-paths.js')).href);

// The Claude Desktop plugin (plugin/ next to this file) keeps each org's folder.
export const ORG_FOLDER_PLUGIN = 'claude-desktop-paperclip';
const FALLBACK_SOURCES = new Set(['agent_home', 'project_primary', 'task_session']);
const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * True when Paperclip had no folder for this run and picked one of its own inside its data folder: the agent's
 * home, or the stand-in it makes for a project with no folder. A project folder you set is never one of them.
 */
export function isFallbackFolder(workspace, paperclipRoot = paperclipPaths.resolvePaperclipInstanceRoot()) {
  const ws = workspace ?? {};
  if (!ws.cwd || ws.workspaceId || ws.worktreePath || !FALLBACK_SOURCES.has(ws.source)) return false;
  return inside(ws.cwd, paperclipRoot);
}

/** The agent's org folder, asked of the Claude Desktop plugin with the run's own token; null when it has none. */
export async function fetchOrgFolder(ctx, { fetchImpl = fetch, apiUrl } = {}) {
  if (!ctx.authToken) return null;
  const base = String(apiUrl ?? paperclipUtils.buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL).replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/api/plugins/${ORG_FOLDER_PLUGIN}/api/org-folder`, {
      headers: { Authorization: `Bearer ${ctx.authToken}`, 'x-paperclip-run-id': String(ctx.runId ?? '') },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const dir = (await res.json())?.path;
    return typeof dir === 'string' && path.isAbsolute(dir) && fs.existsSync(dir) ? dir : null;
  } catch {
    return null; // plugin off or not answering: Paperclip's own choice stands
  }
}

/** Where a run works when Paperclip had no folder for it: the agent's own folder, else its org's folder. */
export async function runFolder(ctx, options = {}) {
  if (!isFallbackFolder(ctx.context?.paperclipWorkspace, options.paperclipRoot)) return null;
  const own = typeof ctx.config?.cwd === 'string' ? ctx.config.cwd.trim() : '';
  if (own && path.isAbsolute(own) && fs.existsSync(own)) return { cwd: own, from: "the agent's own folder" };
  const org = await fetchOrgFolder(ctx, options);
  return org ? { cwd: org, from: 'the org folder' } : null;
}

const native = (ctx, extra = {}) => nativeConfig(ctx.config, { agentId: ctx.agent?.id, command: desktopClaudeCode()?.file, ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const priorSessionId = (ctx) => ctx.runtime?.sessionParams?.sessionId ?? ctx.runtime?.sessionId ?? null;

const CLOSED_NOTE = "Closed Claude Desktop's loaded copy of this conversation; Desktop shows this turn when it loads the conversation again.";

/** A run, with the pieces it calls passed in (tests and smoke runs swap them). */
export function createExecute({
  runBuiltin = (ctx) => builtin.execute(ctx), open = openInDesktop, copiesOf = conversationCopies, close = closeDesktopCopies,
  folderFor = runFolder, runBase = RUN_BASE, claudeConfig, pollMs = 5000,
} = {}) {
  return async function execute(ctx) {
    const log = (line, stream = 'stdout') => ctx.onLog(stream, `[native] ${line}\n`);
    // One writer per conversation. Wait while a turn is in progress in it anywhere (or it is open in a terminal);
    // Claude Desktop's idle copy is closed instead, and Desktop loads the conversation again from disk. A copy
    // Desktop loads again at once (it is on screen) is closed after the run, when the turn is on disk.
    const prior = priorSessionId(ctx);
    let waited = false;
    let closed = false;
    for (;;) {
      const copies = prior ? await copiesOf(prior) : [];
      if (copies.length === 0 || (closed && copies.every(isIdleDesktopCopy))) break;
      if (!closed && copies.every(isIdleDesktopCopy)) {
        closed = true;
        if ((await close(copies)).length > 0) { await log(CLOSED_NOTE); continue; }
      }
      if (!waited) { waited = true; await log('This conversation is in use (a turn in progress, or open in a terminal); the run starts when it is free.'); }
      if (ctx.signal?.aborted) return { exitCode: null, signal: 'SIGTERM', timedOut: false, errorMessage: 'Cancelled in Paperclip' };
      await sleep(pollMs);
    }

    // No folder from Paperclip for this run: work in the org's folder, not a hidden Paperclip one.
    const folder = await folderFor(ctx);
    const context = folder ? { ...ctx.context, paperclipWorkspace: { ...ctx.context.paperclipWorkspace, cwd: folder.cwd } } : ctx.context;
    if (folder) await log(`Working in ${folder.from}: ${folder.cwd}`);

    const title = sessionTitle(ctx);
    const runDir = runDirFor(ctx.runId, runBase);
    let result;
    let turn;
    try {
      const mcp = await writeRunMcpConfig(ctx.runId, ctx.runtimeMcp?.getServers?.() ?? [], runBase);
      turn = await prepareNativeTurn({ ...ctx, context }, { utils: paperclipUtils, runDir, claudeConfig });
      if (turn.warning) await log(turn.warning, 'stderr');
      await log(turn.resume ? `Continuing this card's conversation (${turn.resume}).` : 'Starting a new conversation for this card.');
      await log(`Agent "${turn.placed.slug}": ${turn.placed.file}`);
      result = await runBuiltin({
        ...ctx,
        context: turn.context,
        runtime: turn.runtime,
        config: native(ctx, { mcpConfigPath: mcp?.file, title, args: turn.args, overrides: turn.overrides }),
        runtimeMcp: undefined,
      });
    } finally {
      await fsp.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }

    // A copy Claude Desktop loaded during the run lacks the run's turn: close it too, now that the turn is on disk.
    const session = result?.sessionId ?? result?.sessionParams?.sessionId;
    if (session && session === prior && (await close(await copiesOf(session))).length > 0) await log(CLOSED_NOTE);

    // A new conversation goes to Claude Desktop's sidebar, under the folder it ran in.
    const cwd = result?.sessionParams?.cwd ?? turn?.cwd;
    if (session && session !== prior && cwd) {
      const opened = await open(session, cwd);
      await log(opened.ok ? `Opened in Claude Desktop as "${title}".` : `Could not open it in Claude Desktop (${opened.reason}).`);
    }
    return result;
  };
}

const execute = createExecute();

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
supported. Pause the override in Settings > Adapters to go back to Paperclip's own Claude type.

Each run is a native Claude Code turn: the agent's instructions (instructionsFilePath) and a prompt template
that names only the agent become a Claude Code agent used with --agent; each card is one conversation that
continues every run; the message is what people wrote on the card; Paperclip's turn details, a
bootstrapPromptTemplate and any other promptTemplate arrive as hook context beside the message.`;

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
