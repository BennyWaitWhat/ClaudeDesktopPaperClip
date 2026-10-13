// An org in Claude Desktop, kept in step with Paperclip by the plugin (grill Q2, Q6, Q7, Q14, Q20). The moment an
// org switched to Claude Desktop has a Claude agent, its folder gets:
//   - .claude/agents/<agent>.md for each of its Claude agents, and .claude/skills (agent-files.mjs);
//   - .claude/settings.json with the org's hooks (org-folder.mjs) and the Chief of Staff as the folder's default
//     agent, so a new chat in the folder is the Chief of Staff;
//   - .claude/paperclip-team.md: the team and each member's Desktop conversation, for hand-offs;
// and each agent gets its one conversation: a hello turn as that agent (one turn, no tools: setup, never work;
// its first reply is also what keeps the conversation its own agent rather than the folder's default), which the
// plugin then hands to Claude Desktop's sidebar at a pause in your typing. Desktop takes the conversation's model and
// permission mode from that hello (never bypass: it makes that "accept edits"), so the hello runs in the mode the
// agent's Paperclip "Skip permissions" switch asks for; the org folder's PreToolUse hook does the rest.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readInstructions, removeOtherAgentFiles, skipsPermissions, syncSkills, writeAgentFile } from './agent-files.mjs';
import { windowsUserEnv } from './desktop.mjs';
import { readOrg, updateOrg } from './desktop-orgs.mjs';
import { HELLO_ENV } from './desktop-turn.mjs';
import { ensureOrgSettings } from './org-folder.mjs';
import { paperclipCall } from './paperclip-access.mjs';
import { addToInbox } from './paperclip-wakes.mjs';

export const TEAM_FILE = path.join('.claude', 'paperclip-team.md');
const RETRY_MS = 5 * 60_000;

/** Paperclip's instance folder, found the way Paperclip finds it (its plugin workers start without its settings). */
export function paperclipInstance(env = process.env) {
  const raw = env.PAPERCLIP_HOME?.trim();
  const home = !raw ? path.join(os.homedir(), '.paperclip') : path.resolve(raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
  return path.join(home, 'instances', env.PAPERCLIP_INSTANCE_ID?.trim() || 'default');
}

/** The running Paperclip's address, from its own record of where it listens. */
export function paperclipApi(instance) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(instance, 'runtime-info.json'), 'utf8'));
    if (info.dashboardUrl) return String(info.dashboardUrl).replace(/\/+$/, '');
    if (info.port) return `http://${info.host && info.host !== '0.0.0.0' ? info.host : '127.0.0.1'}:${info.port}`;
  } catch { /* not running, or an older Paperclip */ }
  return 'http://127.0.0.1:3100';
}

export const helloPrompt = ({ name, org }) =>
  `(Setup from Paperclip, not work.) This is your own conversation in Claude Desktop, ${name}: the board and your teammates in ${org} will talk to you here. Reply with one short line of hello, and nothing else.`;

/**
 * Make an agent's conversation with its hello turn, in the org folder: one turn, no tools, no MCP servers, and only
 * the folder's own settings (its hooks; your user settings, such as a chime at the end of each turn, stay out of
 * setup). Desktop keeps the hello's permission mode: "accept edits" when Paperclip's Skip permissions is on, else the
 * usual mode. Resolves { ok, sessionId, reply, model, error }.
 */
export function createConversation({ claude, folder, slug, name, org, skipPermissions = true, sessionId = crypto.randomUUID(), timeoutMs = 180_000 }) {
  const args = [
    '-p', helloPrompt({ name, org }), '--agent', slug, '--session-id', sessionId, '--name', name,
    '--output-format', 'json', '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--effort', 'low',
    '--permission-mode', skipPermissions ? 'acceptEdits' : 'default',
  ];
  return new Promise((resolve) => {
    const child = execFile(claude, args, { cwd: folder, env: { ...windowsUserEnv(), [HELLO_ENV]: '1' }, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* no answer */ }
      const ok = Boolean(!err && out && !out.is_error && out.session_id === sessionId);
      resolve({
        ok, sessionId, reply: typeof out?.result === 'string' ? out.result : null, model: Object.keys(out?.modelUsage ?? {})[0] ?? null,
        error: ok ? null : String(out?.result || stderr || err?.message || 'Claude Code gave no answer').slice(0, 500),
      });
    });
    child.stdin?.end(); // nothing to read: Claude Code would otherwise wait for it
  });
}

/** The org's Claude agents (oldest first) and its Chief of Staff: the one who reports to no one. */
export function claudeTeam(agents) {
  const team = agents
    .filter((a) => a?.adapterType === 'claude_local' && !['terminated', 'pending_approval'].includes(a.status))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { team, chief: team.find((a) => !a.reportsTo) ?? null };
}

const cell = (v) => String(v ?? '').replace(/[|\r\n]+/g, ' ').trim();

/** .claude/paperclip-team.md: who is on the team, and each one's Desktop conversation. */
export function teamRoster({ org, team, slugs, conversations }) {
  const byId = new Map(team.map((a) => [a.id, a]));
  const rows = team.map((a) => {
    const sessionId = conversations[a.id]?.ready ? conversations[a.id].sessionId : null;
    const boss = a.reportsTo ? byId.get(a.reportsTo)?.name ?? '(outside the Claude team)' : 'the board';
    return `| ${cell(a.name)} | ${cell(a.title || a.role)} | ${cell(boss)} | ${slugs.get(a.id)} | ${sessionId ? `local_${sessionId}` : '(being set up)'} |`;
  });
  return [
    `# ${cell(org)}: the team`,
    '',
    'Kept by ClaudeDesktopPaperClip from Paperclip; changes here are replaced. Each agent has one conversation in Claude Desktop.',
    '',
    '| Agent | Title | Reports to | Claude Code agent | Desktop conversation |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'To hand work to one of them: create the card in backlog, assigned to them, then send their Desktop conversation a message that names the card (SendMessage, to the conversation above).',
    '',
  ].join('\n');
}

/**
 * Bring an org's folder and Desktop conversations in step with Paperclip. Safe to run again and again. Returns
 * what it did: { skipped } or { org, wrote, made, handOff: [{ agentId, name, sessionId }] } (conversations ready
 * for Claude Desktop that it has not been handed yet).
 */
export async function syncOrg({ api, instance, companyId, node = process.execPath, claude, hello = createConversation, now = () => Date.now() }) {
  const state = readOrg(instance, companyId);
  if (state?.desktop !== true) return { skipped: 'not switched to Claude Desktop' };
  const folder = state.folder;
  if (!folder || !fs.existsSync(folder)) return { skipped: 'its folder is missing' };
  const company = await paperclipCall(api, `/api/companies/${companyId}`);
  if (company.status !== 200 || !company.json) return { skipped: `Paperclip answered ${company.status}` };
  if (company.json.status === 'archived') return { skipped: 'archived' };
  const listed = await paperclipCall(api, `/api/companies/${companyId}/agents`);
  if (listed.status !== 200 || !Array.isArray(listed.json)) return { skipped: `Paperclip answered ${listed.status}` };
  const { team, chief } = claudeTeam(listed.json);
  if (!chief) return { skipped: 'no Chief of Staff yet' };
  const org = company.json.name;

  const wrote = [];
  const slugs = new Map();
  for (const agent of team) {
    const file = await writeAgentFile({ folder, agent, org, instructions: await readInstructions(agent) });
    slugs.set(agent.id, file.slug);
    if (file.changed) wrote.push(path.relative(folder, file.file));
  }
  wrote.push(...(await removeOtherAgentFiles(folder, team.map((a) => a.id))).map((f) => `-${path.relative(folder, f)}`));
  const skills = await syncSkills(folder, team.flatMap((a) => a.adapterConfig?.paperclipSkillSync?.desiredSkills ?? []));
  wrote.push(...skills.copied.map((s) => path.join('.claude', 'skills', s)));
  const settings = await ensureOrgSettings(folder, { node, apiUrl: api, instanceRoot: instance, chiefId: chief.id, defaultAgent: slugs.get(chief.id) });
  if (settings.changed) wrote.push(path.relative(folder, settings.file));

  // Each agent's conversation, the Chief of Staff's first. A failed hello is tried again after a few minutes.
  const made = [];
  for (const agent of team) {
    const known = readOrg(instance, companyId)?.conversations?.[agent.id];
    if (known?.ready || (known?.failedAt && now() - Date.parse(known.failedAt) < RETRY_MS)) continue;
    const result = await hello({ claude, folder, slug: slugs.get(agent.id), name: agent.name, org, skipPermissions: skipsPermissions(agent) });
    made.push({ agentId: agent.id, name: agent.name, ...result });
    updateOrg(instance, companyId, (o) => ({
      ...o,
      conversations: {
        ...o.conversations,
        [agent.id]: result.ok
          ? { sessionId: result.sessionId, name: agent.name, ready: new Date(now()).toISOString(), handedOff: null }
          : { failedAt: new Date(now()).toISOString(), error: result.error },
      },
    }));
  }

  const conversations = readOrg(instance, companyId)?.conversations ?? {};
  const roster = teamRoster({ org, team, slugs, conversations });
  const rosterFile = path.join(folder, TEAM_FILE);
  if ((await fsp.readFile(rosterFile, 'utf8').catch(() => null)) !== roster) {
    await fsp.mkdir(path.dirname(rosterFile), { recursive: true });
    await fsp.writeFile(rosterFile, roster);
    wrote.push(TEAM_FILE);
  }
  updateOrg(instance, companyId, (o) => ({ ...o, syncedAt: new Date(now()).toISOString() }));

  const handOff = team
    .filter((a) => conversations[a.id]?.ready && !conversations[a.id].handedOff)
    .map((a) => ({ agentId: a.id, name: a.name, sessionId: conversations[a.id].sessionId }));
  return { org, folder, chief: chief.id, wrote, skippedSkills: skills.skipped, made, handOff };
}

/** Note that an agent's conversation is in Claude Desktop's sidebar. */
export const markHandedOff = (instance, companyId, agentId) => updateOrg(instance, companyId, (o) => ({
  ...o,
  conversations: { ...o.conversations, [agentId]: { ...o.conversations?.[agentId], handedOff: new Date().toISOString() } },
}));

/**
 * A card made in Paperclip by the board for one of the org's Claude agents (the setup wizard's first card, or one
 * you make there) waits in that agent's Desktop inbox. Cards agents make come with a message to the receiver.
 */
export async function noteNewCard({ api, instance, issueId }) {
  const found = await paperclipCall(api, `/api/issues/${issueId}`);
  const card = found.json;
  if (found.status !== 200 || !card?.assigneeAgentId || card.createdByAgentId) return null;
  const agent = await paperclipCall(api, `/api/agents/${card.assigneeAgentId}`);
  if (agent.json?.adapterType !== 'claude_local') return null;
  const item = { at: new Date().toISOString(), reason: 'issue_created', card: { id: card.id, identifier: card.identifier ?? null, title: card.title ?? null }, parked: false, comments: [] };
  addToInbox(instance, card.assigneeAgentId, item);
  return { agentId: card.assigneeAgentId, ...item };
}
