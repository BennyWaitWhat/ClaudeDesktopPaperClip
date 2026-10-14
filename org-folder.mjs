// An org folder as Claude Code sees it, through its own .claude settings:
// - SessionStart (hooks/desktop-session.mjs): every conversation there that runs as one of the org's agents gets
//   that agent's Paperclip access, and a plain new conversation is the org's Chief of Staff;
// - UserPromptSubmit and Stop (hooks/desktop-turn.mjs): each turn such a conversation takes is a Paperclip run;
// - PreToolUse for Bash (hooks/paperclip-allow.mjs): its calls to Paperclip go ahead without asking.
// Claude Desktop loads project settings, so this is what talking to the org in Desktop means.
//
// The folder's default agent is the Chief of Staff (grill Q14), so a new chat there is the Chief of Staff. Claude
// Code prefers a folder default over the agent a conversation started with until that conversation's first reply,
// so every agent's conversation is made with one hello reply (org-sync.mjs).
//
// An org folder can be a git repo: a project's own copy, such as Career Catchers' clone of Career Ops (grill Q23).
// There the hooks and the default agent go in .claude/settings.local.json, which stays on this computer, and the
// files the plugin writes are kept out of git through .git/info/exclude, so the repo's own settings and history
// never carry them.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_HOOK = fileURLToPath(new URL('./hooks/desktop-session.mjs', import.meta.url));
export const TURN_HOOK = fileURLToPath(new URL('./hooks/desktop-turn.mjs', import.meta.url));
// Every tool call in an org folder: lets an agent whose Paperclip "Skip permissions" is on go ahead without asking, and
// approves the others' Paperclip calls only (hooks/paperclip-allow.mjs).
export const ALLOW_HOOK = fileURLToPath(new URL('./hooks/paperclip-allow.mjs', import.meta.url));
const OURS = [
  { event: 'SessionStart', script: SESSION_HOOK },
  { event: 'UserPromptSubmit', script: TURN_HOOK },
  { event: 'Stop', script: TURN_HOOK },
  { event: 'PreToolUse', script: ALLOW_HOOK, matcher: '*' },
];
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
const isOurHook = (h) => typeof h?.command === 'string' && /desktop-(session|turn)\.mjs|paperclip-allow\.mjs/.test(h.command);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A hook's command line: the script, the Paperclip it talks to, the instance folder it keeps keys in, the Chief of Staff. */
export function hookCommand(script, { node = process.execPath, apiUrl, instanceRoot, chiefId = null }) {
  return [q(node), q(script), '--api', q(apiUrl), '--instance', q(instanceRoot), ...(chiefId ? ['--chief', chiefId] : [])].join(' ');
}
export const sessionHookCommand = (options) => hookCommand(SESSION_HOOK, options);

/** True when the folder is a git repo's top (a .git folder, or the .git file of a worktree). */
export const isGitRepo = (folder) => fs.existsSync(path.join(folder, '.git'));

/** The settings file our hooks go in: settings.local.json in a git repo, settings.json elsewhere. */
export const orgSettingsFile = (folder) => path.join(folder, '.claude', isGitRepo(folder) ? 'settings.local.json' : 'settings.json');

async function readSettings(file) {
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (raw === null || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const ourCommands = (settings) => [...new Set(OURS.map((o) => o.event))].flatMap((event) => (settings?.hooks?.[event] ?? []).flatMap((g) => g?.hooks ?? []).filter(isOurHook).map((h) => h.command));
// Both settings files: a folder may have had our hooks in settings.json before it became a repo.
const allOurCommands = async (folder) => (await Promise.all(['settings.local.json', 'settings.json']
  .map((name) => readSettings(path.join(folder, '.claude', name))))).flatMap(ourCommands);

/** The org's Chief of Staff as the folder's hooks name it, or null. */
export async function chiefOf(folder) {
  for (const command of await allOurCommands(folder)) {
    const id = command.match(/--chief\s+(\S+)/)?.[1];
    if (UUID.test(id ?? '')) return id;
  }
  return null;
}

/** True when the folder's settings run our hooks, so Claude Desktop's conversations there are the org's agents. */
export async function hasSessionHook(folder) {
  return (await allOurCommands(folder)).length > 0;
}

/**
 * Give an org folder our hooks (SessionStart, UserPromptSubmit, Stop, PreToolUse), replacing older copies of them
 * and keeping the Chief of Staff they name unless `chiefId` gives one. A folder default agent naming one of the
 * org's agents (`teamAgents`, as older syncs set the Chief of Staff) is removed: Claude Code gives a conversation it
 * resumes the folder default agent's tools, though the conversation keeps its own prompt, so each agent's tool list
 * only holds without one (seen 2026-10-14 in Claude Code 2.1.295). A plain new chat in the folder is the Chief of
 * Staff through the SessionStart hook instead. The rest of the file stays as it is; a settings file that is not valid
 * JSON is left alone. In a git repo this is settings.local.json (orgSettingsFile). Returns { file, changed, reason? }.
 */
export async function ensureOrgSettings(folder, { node, apiUrl, instanceRoot, chiefId = null, teamAgents = [] }) {
  const file = orgSettingsFile(folder);
  const settings = await readSettings(file);
  if (!settings) return { file, changed: false, reason: `its ${path.basename(file)} is not valid JSON` };
  const before = JSON.stringify(settings);
  const chief = chiefId ?? (await chiefOf(folder));
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...settings.hooks } : {};
  for (const event of new Set(OURS.map((o) => o.event))) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const others = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurHook(h)) })).filter((g) => g.hooks.length > 0);
    const ours = OURS.filter((o) => o.event === event).map(({ script, matcher }) => ({
      ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCommand(script, { node, apiUrl, instanceRoot, chiefId: chief }) }],
    }));
    hooks[event] = [...others, ...ours];
  }
  settings.hooks = hooks;
  if (typeof settings.agent === 'string' && teamAgents.includes(settings.agent)) delete settings.agent;
  if (JSON.stringify(settings) === before) return { file, changed: false };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, changed: true };
}

const EXCLUDE_START = '# ClaudeDesktopPaperClip: files the plugin keeps in this org folder (rewritten on each sync)';
const EXCLUDE_END = '# end ClaudeDesktopPaperClip';

/**
 * In a git repo, keep the plugin's files out of git: one marked block in .git/info/exclude listing them (folder-relative
 * paths), rewritten when the list changes; the rest of the file stays as it is. Returns { file, changed } or null
 * outside a repo (or in a worktree, whose .git is a file).
 */
export async function ensureGitExclude(folder, paths) {
  const gitDir = path.join(folder, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return null;
  const file = path.join(gitDir, 'info', 'exclude');
  const raw = await fsp.readFile(file, 'utf8').catch(() => '');
  const lines = raw.split(/\r?\n/);
  const start = lines.indexOf(EXCLUDE_START);
  const end = lines.indexOf(EXCLUDE_END, start);
  const rest = start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  while (rest.length && rest.at(-1) === '') rest.pop();
  const entries = [...new Set(paths.map((p) => `/${String(p).replace(/\\/g, '/').replace(/^\/+/, '')}`))].sort();
  const next = `${[...rest, ...(rest.length ? [''] : []), EXCLUDE_START, ...entries, EXCLUDE_END].join('\n')}\n`;
  if (next === raw) return { file, changed: false };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, next);
  return { file, changed: true };
}

/** True when the agent heads its org (reports to no one), asked of Paperclip with the run's own token. */
export async function isTopAgent(ctx, apiUrl, { fetchImpl = fetch } = {}) {
  if (!ctx.authToken || !ctx.agent?.id) return false;
  try {
    const res = await fetchImpl(`${String(apiUrl).replace(/\/+$/, '')}/api/agents/${ctx.agent.id}`, {
      headers: { Authorization: `Bearer ${ctx.authToken}`, 'x-paperclip-run-id': String(ctx.runId ?? '') },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const agent = await res.json();
    return agent?.id === ctx.agent.id && !agent.reportsTo;
  } catch {
    return false;
  }
}
