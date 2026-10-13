// Which of an org's Paperclip agents a Claude Code conversation in the org folder is, and that agent's own lasting
// Paperclip key. Shared by the org folder's hooks (hooks/desktop-session.mjs, hooks/desktop-turn.mjs).
import fs from 'node:fs';
import path from 'node:path';

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
export const agentIdOf = (definition) => definition.match(/^paperclip-agent-id:\s*(\S+)\s*$/m)?.[1] ?? null;
/** The agent file's Skip permissions switch (agent-files.mjs writes it from Paperclip). */
export const skipsPermissionsIn = (definition) => /^paperclip-skip-permissions:\s*true\s*$/m.test(definition);

/** The agent the conversation started with (Claude Code records it in the transcript), else the one it runs as now. */
export function conversationSlug({ transcriptPath, agentType }) {
  let slug = null;
  for (const line of read(transcriptPath).split('\n')) {
    if (!line.includes('"agent-setting"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'agent-setting' && e.agentSetting) slug = e.agentSetting;
    } catch { /* a torn line */ }
  }
  return slug ?? agentType ?? null;
}

/**
 * The org agent this conversation runs as: { slug, agentId, definition, chief }, or null for a conversation that
 * is not one of the org's agents. A plain conversation (no agent) is the Chief of Staff when `chiefId` is given.
 */
export function conversationAgent({ cwd, transcriptPath, agentType, chiefId = null }) {
  const agentsDir = path.join(cwd, '.claude', 'agents');
  const slug = conversationSlug({ transcriptPath, agentType });
  if (slug) {
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) return null;
    const definition = read(path.join(agentsDir, `${slug}.md`));
    const agentId = agentIdOf(definition);
    return agentId ? { slug, agentId, definition, chief: false } : null;
  }
  if (!chiefId) return null;
  let definition = '';
  for (const f of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
    const text = f.endsWith('.md') ? read(path.join(agentsDir, f)) : '';
    if (agentIdOf(text) === chiefId) { definition = text; break; }
  }
  return { slug: null, agentId: chiefId, definition, chief: true };
}

/** One Paperclip API call; { status: 0 } when Paperclip is not answering. */
export async function paperclipCall(api, pathname, { method = 'GET', token, body, runId, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${String(api).replace(/\/+$/, '')}${pathname}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(runId ? { 'X-Paperclip-Run-Id': runId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

export const keyFile = (instance, agentId) => path.join(instance, 'claude-desktop', 'keys', `${agentId}.json`);

/**
 * The agent's lasting key, kept beside Paperclip's data and made once (Paperclip answers this machine as the board).
 * Returns { token, agent } or null when Paperclip is down or refuses.
 */
export async function agentKey({ api, instance, agentId }) {
  const file = instance ? keyFile(instance, agentId) : null;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (saved?.token) {
    const me = await paperclipCall(api, '/api/agents/me', { token: saved.token });
    if (me.status === 200 && me.json?.id === agentId) return { token: saved.token, agent: me.json };
    if (me.status !== 401 && me.status !== 403) return null; // Paperclip is down: keep the key, try next time
  }
  if (!file) return null;
  const made = await paperclipCall(api, `/api/agents/${agentId}/keys`, { method: 'POST', body: { name: 'Claude Desktop' } });
  if (made.status !== 201 || !made.json?.token) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ keyId: made.json.id, token: made.json.token, createdAt: made.json.createdAt }), { mode: 0o600 });
  const me = await paperclipCall(api, '/api/agents/me', { token: made.json.token });
  return { token: made.json.token, agent: me.json ?? { id: agentId } };
}

/**
 * True inside a run Paperclip started itself (its own Claude type, with the override paused), which brings its own
 * access. The org folder's conversations carry CLAUDE_DESKTOP_SESSION_ID from their SessionStart hook.
 */
export const insidePaperclipRun = (env = process.env) => Boolean(env.PAPERCLIP_RUN_ID || env.PAPERCLIP_API_KEY) && !env.CLAUDE_DESKTOP_SESSION_ID;

/** A hook's command-line arguments: --api, --instance, --chief. */
export function hookArgs(argv = process.argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
  return { api: String(arg('api') ?? 'http://localhost:3100').replace(/\/+$/, ''), instance: arg('instance'), chiefId: arg('chief') ?? null };
}

/** The hook's input (Claude Code sends it as JSON on stdin), or null. */
export async function hookInput(stdin = process.stdin) {
  try {
    let s = '';
    for await (const chunk of stdin) s += chunk;
    return JSON.parse(s);
  } catch {
    return null;
  }
}
