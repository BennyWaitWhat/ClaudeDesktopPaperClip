// ClaudeDesktopPaperClip: Paperclip's Claude agent type for a team that lives in Claude Desktop.
//
// Paperclip loads this folder as a local adapter package (Settings > Adapters, or POST /api/adapters/install with
// isLocalPath). Its type is claude_local, so it stands in for Paperclip's built-in Claude type for every Claude agent
// in every org. Pausing the override in Settings > Adapters restores Paperclip's own.
//
// Paperclip never starts work for a Claude agent here (grill Q4). The agents live in Claude Desktop, one
// conversation each, and every turn they take there is a Paperclip run:
//   - a run woken as a Desktop turn (the org folder's hook wakes the agent when its turn starts) records that turn:
//     its log, its tokens, its end (desktop-turn.mjs);
//   - any other wake (a card given to the agent, a comment, a recovery) waits for the agent's next Desktop turn,
//     which sees it first (paperclip-wakes.mjs). Claude is never started from Paperclip.
// Paperclip's setup wizard still checks the Claude sign-in through testEnvironment before it hires the first agent;
// that check runs Paperclip's own probe with Claude Desktop's Claude Code and your own setup.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Same cache-busting query as this file, so Paperclip's adapter reload also reloads these.
const sibling = (file) => import(new URL(`./${file}${new URL(import.meta.url).search}`, import.meta.url).href);
const desktop = await sibling('desktop.mjs');
export const { desktopClaudeCode, findPaperclipPackage, windowsUserEnv } = desktop;
const { DESKTOP_TURN_REASON, recordDesktopTurn, turnsDir } = await sibling('desktop-turn.mjs');
const { absorbPaperclipWake } = await sibling('paperclip-wakes.mjs');
const { isDesktopOrg } = await sibling('desktop-orgs.mjs');

// What Paperclip's managed AI connection puts in a run's environment (its throwaway home and token).
export const THROWAWAY_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

/** The config Paperclip's Claude probe gets: the same, minus the managed connection's throwaway home and token. */
export function nativeConfig(config = {}, { command } = {}) {
  const { managedAiConnection: _managed, ...rest } = config ?? {};
  const env = { ...(rest.env && typeof rest.env === 'object' ? rest.env : {}) };
  for (const key of THROWAWAY_ENV) delete env[key];
  return { ...rest, env, engine: 'cli', command: command ?? rest.command ?? 'claude' };
}

const claudePkg = findPaperclipPackage('adapter-claude-local');
if (!claudePkg) throw new Error('claude-desktop: cannot find @paperclipai/adapter-claude-local next to the running Paperclip.');
const builtin = await import(pathToFileURL(path.join(claudePkg, 'dist', 'server', 'index.js')).href);
const info = await import(pathToFileURL(path.join(claudePkg, 'dist', 'index.js')).href);
const paperclipUtils = await import(pathToFileURL(path.join(findPaperclipPackage('adapter-utils'), 'dist', 'server-utils.js')).href);
const paperclipPaths = await import(pathToFileURL(path.join(findPaperclipPackage('shared'), 'dist', 'home-paths.js')).href);

const instanceRoot = () => paperclipPaths.resolvePaperclipInstanceRoot();
const apiUrl = (ctx) => String(paperclipUtils.buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL).replace(/\/+$/, '');

// An org that has not moved to Claude Desktop yet (desktop-orgs.mjs): its agents' cards are left as they are.
const NOT_MOVED = {
  exitCode: 1, signal: null, timedOut: false,
  errorMessage: "This org's Claude agents work from Claude Desktop, and the org has not moved there yet: switch it over (ClaudeDesktopPaperClip), or pause the claude_local override in Settings > Adapters to use Paperclip's own Claude type.",
};

/** A run, with what it can do passed in (tests swap them). */
export function createExecute({
  recordTurn = (ctx) => recordDesktopTurn(ctx, { dir: turnsDir(instanceRoot()) }),
  absorbWake = (ctx) => absorbPaperclipWake(ctx, { instance: instanceRoot(), api: apiUrl(ctx) }),
  movedToDesktop = (ctx) => isDesktopOrg(instanceRoot(), ctx.agent?.companyId),
} = {}) {
  return async function execute(ctx) {
    if (ctx.context?.wakeReason === DESKTOP_TURN_REASON) return recordTurn(ctx);
    if (!movedToDesktop(ctx)) {
      await ctx.onLog('stderr', `[desktop] ${NOT_MOVED.errorMessage}\n`);
      return NOT_MOVED;
    }
    return absorbWake(ctx);
  };
}

const execute = createExecute();

async function testEnvironment(ctx) {
  const result = await builtin.testEnvironment({ ...ctx, config: nativeConfig(ctx.config, { command: desktopClaudeCode()?.file }) });
  const code = desktopClaudeCode();
  const check = code
    ? { code: 'claude_desktop_code', level: 'info', message: `Claude Desktop's Claude Code ${code.version} is here; the agents work in Claude Desktop.`, detail: code.file }
    : { code: 'claude_desktop_no_code', level: 'warn', message: "Claude Desktop's Claude Code was not found; this check used `claude` from PATH.", hint: 'Install Claude Desktop.' };
  return { ...result, checks: [check, ...(result.checks ?? [])] };
}

export const DESKTOP_NOTE = `## Claude Desktop team (ClaudeDesktopPaperClip)

This Paperclip's Claude agents live in Claude Desktop, one conversation each in their org's folder, and Paperclip
never starts their work. Every turn an agent takes in Desktop is recorded here as a run (its log and tokens, as
subscription use). A card you give an agent here, or a comment you write here, waits for that agent's next turn in
Desktop: the card goes to backlog with a note and the agent sees it first thing. Model and effort set here apply
to the agent's Desktop conversation. Pause the override in Settings > Adapters to go back to Paperclip's own
Claude type.`;

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
    agentConfigurationDoc: `${info.agentConfigurationDoc}\n\n${DESKTOP_NOTE}\n`,
    getConfigSchema: builtin.getConfigSchema,
    getQuotaWindows: builtin.getQuotaWindows,
  };
}
