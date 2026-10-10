// An org folder as Claude Code sees it, through its own .claude/settings.json: a SessionStart hook
// (hooks/desktop-session.mjs) gives every conversation there that runs as one of the org's agents that agent's
// Paperclip access, and makes a plain new conversation the org's Chief of Staff. Claude Desktop loads project
// settings, so this is what talking to the org in Desktop means.
//
// The folder sets no default agent on purpose: Claude Code prefers a folder default over the agent a conversation
// started with until that conversation has its first reply, and a card's conversation opens in Claude Desktop
// before its first reply.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_HOOK = fileURLToPath(new URL('./hooks/desktop-session.mjs', import.meta.url));
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
const isOurHook = (h) => typeof h?.command === 'string' && h.command.includes('desktop-session.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The hook's command line: the Paperclip it asks for keys, the instance folder it keeps them in, the Chief of Staff. */
export function sessionHookCommand({ node = process.execPath, apiUrl, instanceRoot, chiefId = null }) {
  return [q(node), q(SESSION_HOOK), '--api', q(apiUrl), '--instance', q(instanceRoot), ...(chiefId ? ['--chief', chiefId] : [])].join(' ');
}

async function readSettings(folder) {
  const file = path.join(folder, '.claude', 'settings.json');
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (raw === null || !raw.trim()) return { file, settings: {} };
  try { return { file, settings: JSON.parse(raw) }; } catch { return { file, settings: null }; }
}

const ourCommands = (settings) => (settings?.hooks?.SessionStart ?? []).flatMap((g) => g?.hooks ?? []).filter(isOurHook).map((h) => h.command);

/** The org's Chief of Staff as the folder's hook names it, or null. */
export async function chiefOf(folder) {
  const { settings } = await readSettings(folder);
  for (const command of ourCommands(settings)) {
    const id = command.match(/--chief\s+(\S+)/)?.[1];
    if (UUID.test(id ?? '')) return id;
  }
  return null;
}

/** True when the folder's settings run the session hook, so Claude Desktop's copies there get Paperclip access. */
export async function hasSessionHook(folder) {
  return ourCommands((await readSettings(folder)).settings).length > 0;
}

/**
 * Give a plain folder the session hook, replacing an older copy of it and keeping the Chief of Staff it names unless
 * `chiefId` gives one. The rest of the file stays as it is; a git repo, or a settings file that is not valid JSON,
 * is left alone. Returns { file, changed, reason? }.
 */
export async function ensureOrgSettings(folder, { node, apiUrl, instanceRoot, chiefId = null }) {
  const file = path.join(folder, '.claude', 'settings.json');
  if (fs.existsSync(path.join(folder, '.git'))) return { file, changed: false, reason: 'a git repo' };
  const { settings } = await readSettings(folder);
  if (!settings) return { file, changed: false, reason: 'its settings.json is not valid JSON' };
  const before = JSON.stringify(settings);
  const command = sessionHookCommand({ node, apiUrl, instanceRoot, chiefId: chiefId ?? (await chiefOf(folder)) });
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const others = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurHook(h)) })).filter((g) => g.hooks.length > 0);
  settings.hooks = { ...hooks, SessionStart: [...others, { hooks: [{ type: 'command', command }] }] };
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
