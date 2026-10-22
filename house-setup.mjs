// A new org sets itself up the house way, with nobody asked to do it (Benny, 2026-10-21: "I can't just start an org
// and everything get set up for me automatically on Claude Desktop."). The house way is a template folder,
// <instance>/claude-desktop/org-template, copied from this repo's templates/org the first time it is needed:
//   - the new org's folder gets CLAUDE.md (the house rules) and FACTS.md, once, with the org's name filled in;
//   - its Chief of Staff (the agent who reports to no one) gets the house job file, the house model and effort, every
//     tool, and the check of the board's steps, whatever Paperclip's setup wizard gave it;
//   - every later hire gets the house model and effort, and the org folder, where Paperclip left them unset.
// An org that was on Claude Desktop before this existed is adopted as it is: its agents are left alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrg, updateOrg } from './desktop-orgs.mjs';
import { paperclipCall } from './paperclip-access.mjs';

const REPO_TEMPLATE = fileURLToPath(new URL('./templates/org/', import.meta.url));
const FILES = ['CLAUDE.md', 'FACTS.md', 'chief-of-staff.md', 'defaults.json'];
// Paperclip takes about 6 seconds to save an agent, and re-tests its AI connection when it has one.
const SAVE_MS = 60_000;

export const templateDir = (instance) => path.join(instance, 'claude-desktop', 'org-template');

/** The house template, { dir, claude, facts, chief, defaults }; a file missing there is copied from this repo first. */
export function orgTemplate(instance, { from = REPO_TEMPLATE } = {}) {
  const dir = templateDir(instance);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) if (!fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(from, f), path.join(dir, f));
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { dir, claude: read('CLAUDE.md'), facts: read('FACTS.md'), chief: read('chief-of-staff.md'), defaults: JSON.parse(read('defaults.json')) };
}

/** A template with {{org}}, {{folder}}, {{folder_json}} (the folder as it goes inside a JSON string) and {{date}}. */
export function fill(text, { org, folder, date = new Date().toISOString().slice(0, 10) }) {
  const vars = { org, folder, folder_json: JSON.stringify(String(folder)).slice(1, -1), date };
  return String(text).replace(/\{\{(\w+)\}\}/g, (all, name) => (name in vars ? vars[name] : all));
}

/** The house CLAUDE.md and FACTS.md in a new org's folder, never over a file already there. Returns the names written. */
export function seedOrgFolder({ folder, org, template, date }) {
  const wrote = [];
  for (const [name, text] of [['CLAUDE.md', template.claude], ['FACTS.md', template.facts]]) {
    const file = path.join(folder, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, fill(text, { org, folder, date }));
    wrote.push(name);
  }
  return wrote;
}

/** A new org: every agent it gets is set up the house way. Written before the org's first sync. */
export const markNewOrg = (instance, companyId) => updateOrg(instance, companyId, (o) => ({ ...o, house: o.house ?? { agents: {} } }));

/**
 * What the house way changes in an agent's adapterConfig, or null. A new org's Chief of Staff (`fresh`) takes the
 * house model, effort and every tool whatever was set; anyone else gets them only where nothing was set.
 */
export function houseConfig(config = {}, { defaults = {}, folder, chief = false, fresh = false }) {
  const out = {};
  for (const key of ['model', 'effort']) {
    if (defaults[key] && (fresh ? config[key] !== defaults[key] : !config[key])) out[key] = defaults[key];
  }
  if (fresh && Array.isArray(config.desktopTools) && config.desktopTools.length) out.desktopTools = [];
  if (!config.cwd && folder) out.cwd = folder;
  if (config.dangerouslySkipPermissions === undefined) out.dangerouslySkipPermissions = true;
  if (chief && config.checksBoardSteps === undefined) out.checksBoardSteps = true;
  return Object.keys(out).length ? out : null;
}

async function writeInstructions(api, agentId, content) {
  const current = await paperclipCall(api, `/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`, { timeoutMs: SAVE_MS });
  if (current.json?.content === content) return true;
  const saved = await paperclipCall(api, `/api/agents/${agentId}/instructions-bundle/file`, {
    method: 'PUT', body: { path: 'AGENTS.md', content, baseRevisionId: current.json?.revision?.id ?? null }, timeoutMs: SAVE_MS,
  });
  return saved.status >= 200 && saved.status < 300;
}

/**
 * Set up, once each, the org's Claude agents not seen before. Returns { changed: [names], pending: [agent ids] }: a
 * pending agent (Paperclip did not take the change) is tried again at the next sync, and gets no conversation yet,
 * since Claude Desktop keeps the model a conversation was made with.
 */
export async function houseSetUp({ api, instance, companyId, org, folder, team, chief, template, now = () => new Date() }) {
  const house = readOrg(instance, companyId)?.house;
  if (!house) {
    updateOrg(instance, companyId, (o) => ({ ...o, house: { adopted: now().toISOString(), agents: Object.fromEntries(team.map((a) => [a.id, 'adopted'])) } }));
    return { changed: [], pending: [] };
  }
  const changed = [];
  const pending = [];
  for (const agent of team) {
    if (house.agents?.[agent.id]) continue;
    template ??= orgTemplate(instance);
    const isChief = agent.id === chief?.id;
    const fresh = isChief && !house.adopted;
    const patch = houseConfig(agent.adapterConfig, { defaults: template.defaults, folder, chief: isChief, fresh });
    let ok = true;
    if (patch) {
      const saved = await paperclipCall(api, `/api/agents/${agent.id}`, { method: 'PATCH', body: { adapterConfig: patch }, timeoutMs: SAVE_MS });
      ok = saved.status >= 200 && saved.status < 300;
    }
    if (ok && fresh) ok = await writeInstructions(api, agent.id, fill(template.chief, { org, folder }));
    if (!ok) { pending.push(agent.id); continue; }
    updateOrg(instance, companyId, (o) => ({ ...o, house: { ...o.house, agents: { ...o.house?.agents, [agent.id]: now().toISOString() } } }));
    changed.push(agent.name);
  }
  return { changed, pending };
}
