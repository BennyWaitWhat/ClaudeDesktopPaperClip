// An org folder as Claude Code sees it, through its own .claude/settings.json:
// - SessionStart (hooks/desktop-session.mjs): every conversation there that runs as one of the org's agents gets
//   that agent's Paperclip access, and a plain new conversation is the org's Chief of Staff;
// - UserPromptSubmit and Stop (hooks/desktop-turn.mjs): each turn such a conversation takes is a Paperclip run.
// Claude Desktop loads project settings, so this is what talking to the org in Desktop means.
//
// The folder sets no default agent on purpose: Claude Code prefers a folder default over the agent a conversation
// started with until that conversation has its first reply.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_HOOK = fileURLToPath(new URL('./hooks/desktop-session.mjs', import.meta.url));
export const TURN_HOOK = fileURLToPath(new URL('./hooks/desktop-turn.mjs', import.meta.url));
const OURS = { SessionStart: SESSION_HOOK, UserPromptSubmit: TURN_HOOK, Stop: TURN_HOOK };
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
const isOurHook = (h) => typeof h?.command === 'string' && /desktop-(session|turn)\.mjs/.test(h.command);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A hook's command line: the script, the Paperclip it talks to, the instance folder it keeps keys in, the Chief of Staff. */
export function hookCommand(script, { node = process.execPath, apiUrl, instanceRoot, chiefId = null }) {
  return [q(node), q(script), '--api', q(apiUrl), '--instance', q(instanceRoot), ...(chiefId ? ['--chief', chiefId] : [])].join(' ');
}
export const sessionHookCommand = (options) => hookCommand(SESSION_HOOK, options);

async function readSettings(folder) {
  const file = path.join(folder, '.claude', 'settings.json');
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (raw === null || !raw.trim()) return { file, settings: {} };
  try { return { file, settings: JSON.parse(raw) }; } catch { return { file, settings: null }; }
}

const ourCommands = (settings) => Object.keys(OURS).flatMap((event) => (settings?.hooks?.[event] ?? []).flatMap((g) => g?.hooks ?? []).filter(isOurHook).map((h) => h.command));

/** The org's Chief of Staff as the folder's hooks name it, or null. */
export async function chiefOf(folder) {
  const { settings } = await readSettings(folder);
  for (const command of ourCommands(settings)) {
    const id = command.match(/--chief\s+(\S+)/)?.[1];
    if (UUID.test(id ?? '')) return id;
  }
  return null;
}

/** True when the folder's settings run our hooks, so Claude Desktop's conversations there are the org's agents. */
export async function hasSessionHook(folder) {
  return ourCommands((await readSettings(folder)).settings).length > 0;
}

/**
 * Give a plain folder our hooks (SessionStart, UserPromptSubmit, Stop), replacing older copies of them and keeping the
 * Chief of Staff they name unless `chiefId` gives one. The rest of the file stays as it is; a git repo, or a
 * settings file that is not valid JSON, is left alone. Returns { file, changed, reason? }.
 */
export async function ensureOrgSettings(folder, { node, apiUrl, instanceRoot, chiefId = null }) {
  const file = path.join(folder, '.claude', 'settings.json');
  if (fs.existsSync(path.join(folder, '.git'))) return { file, changed: false, reason: 'a git repo' };
  const { settings } = await readSettings(folder);
  if (!settings) return { file, changed: false, reason: 'its settings.json is not valid JSON' };
  const before = JSON.stringify(settings);
  const chief = chiefId ?? (await chiefOf(folder));
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...settings.hooks } : {};
  for (const [event, script] of Object.entries(OURS)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const others = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurHook(h)) })).filter((g) => g.hooks.length > 0);
    hooks[event] = [...others, { hooks: [{ type: 'command', command: hookCommand(script, { node, apiUrl, instanceRoot, chiefId: chief }) }] }];
  }
  settings.hooks = hooks;
  if (JSON.stringify(settings) === before) return { file, changed: false };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
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
