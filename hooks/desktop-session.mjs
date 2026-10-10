// SessionStart hook in an org folder (org-folder.mjs puts it in .claude/settings.json). Outside a Paperclip run (in
// Claude Desktop, or a terminal):
// - a conversation that runs as one of the org's Paperclip agents (a card's conversation) gets that agent's own
//   Paperclip access, the way Paperclip gives it to a run: the API address, the agent's own lasting key, its ids
//   and its folder, as environment for the conversation's commands;
// - a plain new conversation is the org's Chief of Staff (--chief): it gets the Chief of Staff's definition as
//   context, and its access.
// A Paperclip run brings its own access and is left alone.
//   node desktop-session.mjs --api <Paperclip URL> --instance <Paperclip instance folder> [--chief <agent id>]
import fs from 'node:fs';
import path from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const api = String(arg('api') ?? 'http://localhost:3100').replace(/\/+$/, '');
const instance = arg('instance');
const chiefId = arg('chief');

if (process.env.PAPERCLIP_API_KEY) process.exit(0);

let input = {};
try {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  input = JSON.parse(s);
} catch {
  process.exit(0);
}
const cwd = input.cwd || process.cwd();
const agentsDir = path.join(cwd, '.claude', 'agents');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const agentIdOf = (definition) => definition.match(/^paperclip-agent-id:\s*(\S+)\s*$/m)?.[1] ?? null;

/** The agent the conversation started with (Claude Code records it), else the one it was started as now. */
function slugOf({ transcript_path: transcript, agent_type: agentType }) {
  let slug = null;
  for (const line of read(transcript).split('\n')) {
    if (!line.includes('"agent-setting"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'agent-setting' && e.agentSetting) slug = e.agentSetting;
    } catch { /* a torn line */ }
  }
  return slug ?? agentType ?? null;
}

const slug = slugOf(input);
let agentId = null;
let definition = '';
if (slug) {
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) process.exit(0);
  definition = read(path.join(agentsDir, `${slug}.md`));
  agentId = agentIdOf(definition);
  if (!agentId) process.exit(0); // an agent that is not one of the org's Paperclip agents
} else if (chiefId) {
  agentId = chiefId; // a plain conversation in the org folder: the Chief of Staff's
  for (const f of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
    const text = f.endsWith('.md') ? read(path.join(agentsDir, f)) : '';
    if (agentIdOf(text) === chiefId) { definition = text; break; }
  }
} else {
  process.exit(0);
}

async function call(pathname, { method = 'GET', token, body } = {}) {
  try {
    const res = await fetch(`${api}${pathname}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null }; // Paperclip is not running
  }
}

/** The agent's lasting key, kept beside Paperclip's data; made once (Paperclip answers this machine as the board). */
async function agentKey() {
  const file = instance ? path.join(instance, 'claude-desktop', 'keys', `${agentId}.json`) : null;
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (saved?.token) {
    const me = await call('/api/agents/me', { token: saved.token });
    if (me.status === 200 && me.json?.id === agentId) return { token: saved.token, agent: me.json };
    if (me.status !== 401 && me.status !== 403) return null; // Paperclip is down: keep the key, try next time
  }
  if (!file) return null;
  const made = await call(`/api/agents/${agentId}/keys`, { method: 'POST', body: { name: 'Claude Desktop' } });
  if (made.status !== 201 || !made.json?.token) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ keyId: made.json.id, token: made.json.token, createdAt: made.json.createdAt }), { mode: 0o600 });
  const me = await call('/api/agents/me', { token: made.json.token });
  return { token: made.json.token, agent: me.json ?? { id: agentId } };
}

const say = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
const key = await agentKey();
if (!key) {
  say(`Paperclip did not answer at ${api}, so this conversation has no Paperclip access. Once Paperclip is running again (paperclipai run), open the conversation again to get it.`);
  process.exit(0);
}

const name = key.agent?.name ?? slug ?? 'the agent';
const companyId = key.agent?.companyId ?? '';
const home = instance && companyId ? path.join(instance, 'companies', companyId, 'agents', agentId, 'instructions') : '';
const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const exports = [
  ['PAPERCLIP_API_URL', api], ['PAPERCLIP_API_KEY', key.token], ['PAPERCLIP_AGENT_ID', agentId], ['PAPERCLIP_COMPANY_ID', companyId],
  ['AGENT_HOME', home && fs.existsSync(home) ? home.replace(/\\/g, '/') : ''],
].filter(([, v]) => v).map(([k, v]) => `export ${k}=${sh(v)}`);
if (process.env.CLAUDE_ENV_FILE) fs.writeFileSync(process.env.CLAUDE_ENV_FILE, `${exports.join('\n')}\n`, { mode: 0o600 });

const access = `Your own Paperclip access is in the environment: $PAPERCLIP_API_URL, $PAPERCLIP_API_KEY (your agent key), $PAPERCLIP_AGENT_ID, $PAPERCLIP_COMPANY_ID${home ? ', and $AGENT_HOME for your agent folder' : ''}. No run is in progress here, so leave out X-Paperclip-Run-Id unless a message from Paperclip gives you a run id.`;
const body = definition.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
if (slug) {
  say(`Paperclip: this conversation runs as ${name}, outside a Paperclip run (in Claude Desktop or a terminal). ${access}`);
} else if (input.source === 'resume') {
  say(`Paperclip: you are ${name}, this org's Chief of Staff, in this conversation with the board. ${access}`);
} else {
  say([
    `Paperclip: in this conversation you are ${name}, this org's Chief of Staff, talking with the board in Claude Desktop. The board's requests become work for the team through Paperclip: cards, assignments and follow-ups, as your definition below says. ${access}`,
    body ? `Your definition as a Paperclip agent:\n\n${body}` : '',
  ].filter(Boolean).join('\n\n'));
}
