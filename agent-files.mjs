// An org's Claude agents as Claude Code sees them in the org folder (the Desktop-native team, PAPERCLIP-WORKFLOWS.md):
// - .claude/agents/<agent>.md for each one: a short note on working from Claude Desktop, then its Paperclip
//   instructions, as the agent's system prompt (loaded once per conversation, not resent every turn), with the model
//   and effort Paperclip sets for it;
// - .claude/skills/<skill>: the Paperclip skills the org's agents are set to have.
// A file of an agent's name that belongs to someone else (yours, or another agent's) is never overwritten.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPaperclipPackage } from './desktop.mjs';

export const CARD_TOOL = fileURLToPath(new URL('./hooks/paperclip-card.mjs', import.meta.url));
const forward = (p) => String(p).replace(/\\/g, '/');

/** A Claude Code agent name from a Paperclip agent name ("Chief of Staff" -> "chief-of-staff"). */
export function agentSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agent';
}

/** How an agent works from Claude Desktop: the first part of every agent's system prompt. */
export function desktopNotes({ name, org, cardTool = CARD_TOOL }) {
  return `## Working from Claude Desktop

You are ${name}, an agent in the Paperclip org ${org}. You live in one Claude Desktop conversation, where the board (Benny) and the other agents talk to you. Paperclip keeps the team's cards and records; it never starts your work.
- Every turn you take is recorded as a Paperclip run, and $PAPERCLIP_RUN_ID always holds the current one. Make Paperclip API calls from the Bash tool (it has your Paperclip environment; PowerShell does not), with "Authorization: Bearer $PAPERCLIP_API_KEY" and "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" (double quotes, so the shell fills them in). You don't run in Paperclip heartbeats: skip what your skills say about heartbeats and inbox polling.
- A run can comment on and update its own card freely, and up to 20 other cards. A turn whose message names a card already runs on that card. To work on a different card, first leave the current one done, in_review, blocked, or in backlog, then run: node "${forward(cardTool)}" <CARD> (it ends the run so far and opens one on that card).
- Your team, and each member's Desktop conversation, are in .claude/paperclip-team.md. Handing work to one of them: create the card for them in backlog, assigned to them, then send their Desktop conversation a message that names the card (Claude Desktop's send_message). Never leave a card waiting in todo: Paperclip treats todo as work it should start.
- End every turn with each card you touched done, in_review (with a reviewer), blocked (with a blocker or a question for the board), or back in backlog; never todo or in_progress.
- A turn may open with what changed in Paperclip since your last one (cards given to you, comments, answers): handle those first.
- Your agent folder is $AGENT_HOME: relative file references in your instructions resolve there.`;
}

const yaml = (value) => JSON.stringify(String(value));

/** The agent file's text: frontmatter (name, description, model, effort, Paperclip id), then the system prompt. */
export function agentMarkdown({ agent, slug, org, instructions }) {
  const name = String(agent?.name ?? 'Agent').replace(/[\r\n]+/g, ' ').trim() || 'Agent';
  const role = [agent?.title, agent?.role && agent.role !== 'general' ? agent.role : null].filter(Boolean)[0];
  const config = agent?.adapterConfig ?? {};
  const front = [
    `name: ${slug}`,
    `description: ${yaml(`Paperclip agent: ${name}${role ? `, ${role}` : ''}.`)}`,
    typeof config.model === 'string' && config.model.trim() ? `model: ${config.model.trim()}` : null,
    typeof config.effort === 'string' && config.effort.trim() ? `effort: ${config.effort.trim()}` : null,
    `paperclip-agent-id: ${agent.id}`,
  ].filter(Boolean);
  const prompt = [desktopNotes({ name, org }), String(instructions ?? '').trim()].filter(Boolean).join('\n\n');
  return `---\n${front.join('\n')}\n---\n\n${prompt}\n`;
}

/** The agent's Paperclip instructions (its bundle's entry file), or '' when it has none. */
export async function readInstructions(agent) {
  const file = agent?.adapterConfig?.instructionsFilePath;
  if (typeof file !== 'string' || !file.trim()) return '';
  return fsp.readFile(file, 'utf8').catch(() => '');
}

const owner = (text) => text.match(/^paperclip-agent-id:\s*(\S+)\s*$/m)?.[1] ?? null;

/**
 * Write the agent's file in `folder`/.claude/agents, under its own name unless that file is someone else's (then
 * <name>-<id>). A renamed agent's old file goes. Returns { slug, file, hash, changed }.
 */
export async function writeAgentFile({ folder, agent, org, instructions }) {
  const dir = path.join(folder, '.claude', 'agents');
  const base = agentSlug(agent.name);
  let slug = base;
  for (const candidate of [base, `${base}-${String(agent.id).slice(0, 4)}`]) {
    slug = candidate;
    const existing = await fsp.readFile(path.join(dir, `${candidate}.md`), 'utf8').catch(() => null);
    if (existing === null || owner(existing) === agent.id) break;
  }
  const file = path.join(dir, `${slug}.md`);
  const markdown = agentMarkdown({ agent, slug, org, instructions });
  const changed = (await fsp.readFile(file, 'utf8').catch(() => null)) !== markdown;
  if (changed) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, markdown);
  }
  for (const other of await fsp.readdir(dir).catch(() => [])) {
    if (!other.endsWith('.md') || other === `${slug}.md`) continue;
    if (owner(await fsp.readFile(path.join(dir, other), 'utf8').catch(() => '')) === agent.id) await fsp.rm(path.join(dir, other), { force: true });
  }
  return { slug, file, hash: crypto.createHash('sha256').update(markdown).digest('hex'), changed };
}

/** Remove the agent files of Paperclip agents no longer on the team (terminated, or moved away). Returns their paths. */
export async function removeOtherAgentFiles(folder, keepIds) {
  const dir = path.join(folder, '.claude', 'agents');
  const keep = new Set(keepIds);
  const removed = [];
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.md')) continue;
    const id = owner(await fsp.readFile(path.join(dir, f), 'utf8').catch(() => ''));
    if (id && !keep.has(id)) {
      await fsp.rm(path.join(dir, f), { force: true });
      removed.push(path.join(dir, f));
    }
  }
  return removed;
}

/** Where the installed Paperclip keeps a bundled skill ("paperclipai/paperclip/<name>"), or null. */
export function bundledSkillDir(key, server = findPaperclipPackage('server')) {
  const name = /^paperclipai\/paperclip\/([\w-]+)$/.exec(String(key))?.[1];
  if (!name || !server) return null;
  for (const dir of [path.join(server, 'skills', name), path.join(server, 'dist', 'onboarding-assets', name, 'skills', name)]) {
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/**
 * Copy the skills the org's agents are set to have into `folder`/.claude/skills (Paperclip's bundled ones; others
 * are reported, not guessed). Returns { copied: [names], skipped: [keys] }.
 */
export async function syncSkills(folder, keys, { resolve = bundledSkillDir } = {}) {
  const copied = [];
  const skipped = [];
  for (const key of [...new Set(keys)]) {
    const from = resolve(key);
    if (!from) { skipped.push(key); continue; }
    const to = path.join(folder, '.claude', 'skills', path.basename(from));
    const same = await Promise.all([from, to].map((d) => fsp.readFile(path.join(d, 'SKILL.md'), 'utf8').catch(() => null)));
    if (same[1] !== null && same[0] === same[1]) continue; // already there, unchanged
    await fsp.rm(to, { recursive: true, force: true });
    await fsp.cp(from, to, { recursive: true });
    copied.push(path.basename(from));
  }
  return { copied, skipped };
}
