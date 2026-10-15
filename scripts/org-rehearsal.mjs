#!/usr/bin/env node
// Live rehearsal of an org on Claude Desktop, against the running Paperclip (with this folder's adapter loaded), on
// Haiku: a throwaway org with a Chief of Staff and a Cashier is brought into a scratch folder the way the plugin
// does it (org-sync.mjs), but nothing is handed to Claude Desktop. It checks:
//   1. the agent files, skills, settings and team file;
//   2. one hello conversation per agent, as that agent, on Paperclip's model, recorded as a Paperclip run;
//   3. a card the board gives the Cashier in Paperclip waits: it goes to backlog and into the Cashier's inbox;
//   4. the Cashier's next turn (its conversation, resumed) opens with that, and takes the card to done through the
//      Paperclip API with its own key and the turn's run id, all of it recorded as one run on the card;
//   5. work asked for in Desktop (no card named) becomes a card the Cashier makes itself, recorded as a run on it,
//      never parked; 6. chat makes no card;
//   7. a routine fired the way a Claude Desktop scheduled task fires it (scripts/run-routine.mjs, the routine
//      paused in Paperclip): its card waits in the Cashier's inbox, the message names it to the Cashier's
//      conversation and starts the turn that takes it to done; a second firing the same day sends nothing.
// The Cashier has a tool list in Paperclip (Read, Grep, Glob), so its agent file carries a tools line. With --repo,
// the org folder is a clone of that git repo (a project's own copy, grill Q23): the hooks go in settings.local.json,
// the plugin's files stay out of git, and the Cashier's first real turn reports what one call costs there.
// Then it removes everything it made (the org is archived, its agents terminated). A few Haiku turns.
//   node scripts/org-rehearsal.mjs [--keep] [--repo <path>]   (--keep leaves it all for a look; then:)
//   node scripts/org-rehearsal.mjs --clean <org id>
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopClaudeCode, windowsUserEnv } from '../desktop.mjs';
import { orgFile, readOrg, switchOrg } from '../desktop-orgs.mjs';
import { seenFile, turnsDir } from '../desktop-turn.mjs';
import { orgSettingsFile } from '../org-folder.mjs';
import { paperclipApi, paperclipInstance, syncOrg, TEAM_FILE } from '../org-sync.mjs';
import { keyFile } from '../paperclip-access.mjs';
import { inboxFile } from '../paperclip-wakes.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const KEEP = process.argv.includes('--keep');
const REPO = arg('repo');
const INSTANCE = paperclipInstance();
const API = paperclipApi(INSTANCE);
const CLAUDE = desktopClaudeCode(windowsUserEnv())?.file ?? 'claude';
const MODEL = 'claude-haiku-5-5';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const list = (x) => (Array.isArray(x) ? x : x?.items ?? x?.runs ?? x?.data ?? []);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`); };
async function until(fn, ms = 30_000) { for (const end = Date.now() + ms; ; await sleep(500)) { const v = await fn(); if (v || Date.now() > end) return v; } }
const projectsDir = path.join(os.homedir(), '.claude', 'projects');
function transcriptOf(sessionId) {
  for (const dir of fs.readdirSync(projectsDir)) {
    const file = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
const entries = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const lastAgent = (file) => entries(file).filter((e) => e.type === 'agent-setting').map((e) => e.agentSetting).pop() ?? null;
const claudeTurn = (args, cwd) => new Promise((resolve) => execFile(CLAUDE, args, { cwd, env: windowsUserEnv(), windowsHide: true, timeout: 6 * 60_000, maxBuffer: 16 * 1024 * 1024 },
  (err, stdout, stderr) => { let out = null; try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* none */ } resolve({ err, out, stderr: String(stderr) }); }));

/** Remove a rehearsal org and everything it made: its agents, their keys and files, its conversations, its folders. */
async function cleanUp(orgId) {
  const record = readOrg(INSTANCE, orgId);
  const company = (await call(`/api/companies/${orgId}`)).json;
  if (!/^cdpc rehearsal /.test(company?.name ?? '')) { console.log(`Not a rehearsal org: ${orgId} (${company?.name}); left alone.`); return; }
  const agents = list((await call(`/api/companies/${orgId}/agents`)).json);
  for (const a of agents) {
    await call(`/api/agents/${a.id}/terminate`, { method: 'POST', body: {} });
    fs.rmSync(keyFile(INSTANCE, a.id), { force: true });
    fs.rmSync(inboxFile(INSTANCE, a.id), { force: true });
  }
  const pluginFolder = (await call(`/api/plugins/claude-desktop-paperclip/companies/${orgId}/local-folders`)).json;
  await call(`/api/companies/${orgId}/archive`, { method: 'POST', body: {} });
  // The org folder the plugin made when the org was created, if nothing is in it.
  for (const f of list(pluginFolder?.folders)) {
    try { if (f?.path && fs.readdirSync(f.path).length === 0) fs.rmdirSync(f.path); } catch { /* gone or not empty */ }
  }
  const sessions = Object.values(record?.conversations ?? {}).map((c) => c?.sessionId).filter(Boolean);
  const dir = turnsDir(INSTANCE);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, f);
    try { if (sessions.some((s) => f.startsWith(`session-${s}.`) || (f.endsWith('.json') && fs.readFileSync(file, 'utf8').includes(s)))) fs.rmSync(file, { force: true }); } catch { /* gone */ }
  }
  for (const s of sessions) {
    const t = transcriptOf(s);
    // The scratch folder's own project in ~/.claude/projects, and nothing else.
    if (t && /cdpc-rehearsal/.test(path.basename(path.dirname(t)))) fs.rmSync(path.dirname(t), { recursive: true, force: true });
  }
  fs.rmSync(orgFile(INSTANCE, orgId), { force: true });
  const scratch = record?.folder ? path.dirname(record.folder) : null;
  let held = null;
  try {
    if (scratch && /cdpc-rehearsal-/.test(path.basename(scratch))) fs.rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    held = `${scratch} is still in use (${error.code}); a Claude Desktop session there holds it until it is archived.`;
  }
  console.log(`Cleaned up ${company.name}: org archived, ${agents.length} agents terminated, files removed.${held ? ` ${held}` : ''}`);
}

if (arg('clean')) {
  await cleanUp(arg('clean'));
  process.exit(0);
}

const tag = crypto.randomUUID().slice(0, 6);
const name = `cdpc rehearsal ${tag}`;
const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdpc-rehearsal-')), name);
if (REPO) execFileSync('git', ['clone', '--quiet', '--depth', '1', '-c', 'core.longpaths=true', path.resolve(REPO), folder], { stdio: 'inherit' });
else fs.mkdirSync(folder);
let orgId = null;

try {
  const org = (await call('/api/companies', { method: 'POST', body: { name } })).json;
  orgId = org?.id ?? null;
  check('throwaway org made', org?.id, org?.issuePrefix ?? org?.error);
  const agent = (body) => call(`/api/companies/${org.id}/agents`, {
    method: 'POST',
    body: { adapterType: 'claude_local', adapterConfig: { model: MODEL, effort: 'medium' }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, ...body },
  }).then((r) => r.json);
  const chief = await agent({ name: 'Chief of Staff', role: 'ceo', title: 'Chief of Staff' });
  const cashier = await agent({ name: 'Cashier', role: 'general', title: 'Runs the till', reportsTo: chief?.id, adapterConfig: { model: MODEL, effort: 'medium', desktopTools: ['Read', 'Grep', 'Glob'] } });
  check('Chief of Staff and Cashier hired', chief?.id && cashier?.id, [chief?.status ?? chief?.error, cashier?.status ?? cashier?.error]);

  // 1 + 2. Brought into the folder, as the plugin does once the org is on Claude Desktop. The plugin leaves a
  // rehearsal org alone (desktop-orgs.mjs, REHEARSAL_ORG and plugin: false): nothing goes to Claude Desktop.
  switchOrg(INSTANCE, org.id, { on: true, folder, plugin: false });
  const pluginFolder = (await call(`/api/plugins/claude-desktop-paperclip/companies/${org.id}/local-folders`)).json;
  check('the plugin left the rehearsal org alone', !list(pluginFolder?.folders).some((f) => f?.configured), list(pluginFolder?.folders).map((f) => f?.path ?? null));
  const sync = await syncOrg({ api: API, instance: INSTANCE, companyId: org.id, claude: CLAUDE });
  const agentsDir = path.join(folder, '.claude', 'agents');
  check('agent files', ['cashier.md', 'chief-of-staff.md'].every((f) => fs.existsSync(path.join(agentsDir, f))), fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : sync.skipped);
  check("the Cashier's file lists its tools from Paperclip", /^tools: Bash, SendMessage, mcp__ccd_session_mgmt__send_message, Read, Grep, Glob$/m.test(fs.readFileSync(path.join(agentsDir, 'cashier.md'), 'utf8')));
  check(REPO ? 'in a repo, the hooks are in settings.local.json' : 'the hooks are in settings.json', path.basename(orgSettingsFile(folder)) === (REPO ? 'settings.local.json' : 'settings.json'));
  if (REPO) {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: folder, encoding: 'utf8' }).trim();
    check("git sees none of the plugin's files", status === '', status.split(/\r?\n/).slice(0, 8));
  }
  const settings = JSON.parse(fs.readFileSync(orgSettingsFile(folder), 'utf8'));
  check("the folder has the org's hooks and no default agent (it would give resumed conversations its tools)", !('agent' in settings) && settings.hooks?.UserPromptSubmit && settings.hooks?.SessionStart && settings.hooks?.Stop);
  check("Paperclip's skills copied", fs.existsSync(path.join(folder, '.claude', 'skills', 'paperclip', 'SKILL.md')), fs.readdirSync(path.join(folder, '.claude', 'skills')).join(', '));
  const helloes = sync.made ?? [];
  check('one hello conversation per agent', helloes.length === 2 && helloes.every((h) => h.ok), helloes.map(({ name: n, ok, reply, error }) => ({ n, ok, reply, error })));
  check(`the hellos ran on Paperclip's model (${MODEL})`, helloes.every((h) => h.model === MODEL), helloes.map((h) => h.model));
  check('the team file lists both conversations', helloes.every((h) => fs.readFileSync(path.join(folder, TEAM_FILE), 'utf8').includes(`local_${h.sessionId}`)));
  for (const h of helloes) {
    const t = transcriptOf(h.sessionId);
    const slug = h.name === 'Cashier' ? 'cashier' : 'chief-of-staff';
    check(`${h.name}'s conversation keeps its own agent`, t && lastAgent(t) === slug, { agent: t && lastAgent(t) });
    check(`${h.name}'s conversation ran the org folder's hooks`, fs.existsSync(seenFile(turnsDir(INSTANCE), h.sessionId)));
  }
  const runsOf = async (agentId) => list((await call(`/api/companies/${org.id}/heartbeat-runs?agentId=${agentId}`)).json).filter((r) => r.agentId === agentId);
  const helloRuns = await until(async () => { const r = await runsOf(cashier.id); return r.some((x) => x.status === 'succeeded') ? r : null; }, 20_000);
  check("the Cashier's hello is a Paperclip run", helloRuns?.some((r) => r.status === 'succeeded' && r.contextSnapshot?.wakeReason === 'desktop_turn'), helloRuns?.map((r) => [r.status, r.contextSnapshot?.wakeReason]));

  // 3. The board gives the Cashier a card in Paperclip: it waits for the Cashier's next Desktop turn.
  const card = (await call(`/api/companies/${org.id}/issues`, { method: 'POST', body: { title: 'Count the till', description: 'How many lemonades sold so far?', status: 'todo', assigneeAgentId: cashier.id } })).json;
  const parked = await until(async () => { const c = (await call(`/api/issues/${card.id}`)).json; return c?.status === 'backlog' ? c : null; });
  check('the card goes to backlog, waiting for Desktop', parked, parked?.status ?? (await call(`/api/issues/${card.id}`)).json?.status);
  check("and into the Cashier's inbox", await until(() => fs.existsSync(inboxFile(INSTANCE, cashier.id)), 10_000));

  // 4. The Cashier's next turn, in "accept edits" mode as Claude Desktop runs it: its Paperclip calls go through
  // without asking (hooks/paperclip-allow.mjs).
  const cashierSession = helloes.find((h) => h.name === 'Cashier')?.sessionId;
  const turn = await claudeTurn(['-p', `Please take ${card.identifier}: check it out, add the comment "Till counted: 3 lemonades sold.", then mark it done.`,
    '--resume', cashierSession, '--output-format', 'json', '--max-turns', '25', '--permission-mode', 'acceptEdits'], folder);
  check('no step was refused for lack of approval', !(turn.out?.permission_denials?.length), turn.out?.permission_denials?.map((d) => d.tool_input?.command ?? d.tool_name));
  check("the Cashier's turn finished", turn.out && !turn.out.is_error, turn.out?.result?.slice?.(0, 300) ?? turn.stderr.slice(0, 300));
  const t = transcriptOf(cashierSession);
  check('it opened with what happened in Paperclip', t && fs.readFileSync(t, 'utf8').includes('Since your last turn, in Paperclip'));
  // What one model call costs in this folder: the context of the turn's first call (prompt, tools, files that always load).
  const callTokens = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  const turnCalls = t ? entries(t).filter((e) => e.type === 'assistant' && e.message?.usage).map((e) => callTokens(e.message.usage)) : [];
  check("tokens per call in this folder (the turn's calls, in order)", turnCalls.length > 0, turnCalls.slice(-12));
  // Every tool loaded is about 63,000 tokens a call; the Cashier's five keep its first call well under 50,000.
  check("the turn ran with the Cashier's own tool list", turnCalls.length > 1 && turnCalls[1] < 50_000, turnCalls[1]);
  check('it is still the Cashier', t && lastAgent(t) === 'cashier', lastAgent(t));
  const done = (await call(`/api/issues/${card.id}`)).json;
  check('the card is done', done?.status === 'done', done?.status);
  const comments = list((await call(`/api/issues/${card.id}/comments`)).json);
  check('the Cashier commented on it', comments.some((c) => c.authorAgentId === cashier.id && /Till counted/.test(c.body)), comments.map((c) => [c.authorAgentId === cashier.id ? 'cashier' : c.authorAgentId ?? c.authorUserId, String(c.body).slice(0, 60)]));
  check('the card was parked once, not again during the turn', comments.filter((c) => /Waiting for my next turn/.test(c.body)).length === 1);
  await sleep(2000);
  const cashierRuns = await runsOf(cashier.id);
  const turnRuns = cashierRuns.filter((r) => r.contextSnapshot?.issueId === card.id && r.contextSnapshot?.wakeReason === 'desktop_turn');
  check('the turn is one Paperclip run on the card', turnRuns.length === 1 && turnRuns[0].status === 'succeeded', cashierRuns.map((r) => [r.contextSnapshot?.wakeReason, r.status]));
  check('the inbox was handed over, and nothing new waits', !fs.existsSync(inboxFile(INSTANCE, cashier.id)));

  // 5. Work asked for in Desktop goes on a card the agent makes itself (paperclip-card.mjs --new), recorded on it.
  const before = new Set(list((await call(`/api/companies/${org.id}/issues`)).json).map((c) => c.id));
  const ask = await claudeTurn(['-p', 'I spent $20.40 at Taco Maco on lemons for the stand.',
    '--resume', cashierSession, '--output-format', 'json', '--max-turns', '25', '--permission-mode', 'acceptEdits'], folder);
  check('no step of the request was refused for lack of approval', !(ask.out?.permission_denials?.length), ask.out?.permission_denials?.map((d) => d.tool_input?.command ?? d.tool_name));
  check('the request turn finished', ask.out && !ask.out.is_error, ask.out?.result?.slice?.(0, 300) ?? ask.stderr.slice(0, 300));
  await sleep(3000);
  const made = list((await call(`/api/companies/${org.id}/issues`)).json).filter((c) => !before.has(c.id));
  const own = made.find((c) => c.assigneeAgentId === cashier.id && c.createdByAgentId === cashier.id);
  check('the request became a card the Cashier made, assigned to itself', own, made.map((c) => [c.identifier, c.title, c.status, c.createdByAgentId === cashier.id ? 'by cashier' : c.createdByUserId ?? c.createdByAgentId]));
  check('the card is left done, in review, or blocked on the board', own && ['done', 'in_review', 'blocked'].includes(own.status), own?.status);
  const ownComments = own ? list((await call(`/api/issues/${own.id}/comments`)).json) : [];
  check('and never parked as waiting for Desktop', own && !ownComments.some((c) => /Waiting for my next turn/.test(c.body)), ownComments.map((c) => String(c.body).slice(0, 60)));
  const askRuns = own ? (await runsOf(cashier.id)).filter((r) => r.contextSnapshot?.issueId === own.id) : [];
  check('the work is a Paperclip run on that card', askRuns.some((r) => r.contextSnapshot?.wakeReason === 'desktop_turn' && r.status === 'succeeded'), askRuns.map((r) => [r.contextSnapshot?.wakeReason, r.status]));
  check('Paperclip woke no one for it', !fs.existsSync(inboxFile(INSTANCE, cashier.id)) && askRuns.every((r) => r.contextSnapshot?.wakeReason === 'desktop_turn'));

  // 6. Chat needs no card: the end-of-turn check lets it end as it is.
  const cardsBefore = list((await call(`/api/companies/${org.id}/issues`)).json).length;
  const chat = await claudeTurn(['-p', 'Thanks, that is all for now.',
    '--resume', cashierSession, '--output-format', 'json', '--max-turns', '10', '--permission-mode', 'acceptEdits'], folder);
  check('the chat turn finished', chat.out && !chat.out.is_error, chat.out?.result?.slice?.(0, 300) ?? chat.stderr.slice(0, 300));
  check('and made no card', list((await call(`/api/companies/${org.id}/issues`)).json).length === cardsBefore, chat.out?.result?.slice?.(0, 200));

  // 7. A routine, fired as a Claude Desktop scheduled task fires it: the task runs scripts/run-routine.mjs and sends
  // each line's message to its conversation (here a resumed turn stands in for Desktop's send_message).
  const routine = (await call(`/api/companies/${org.id}/routines`, { method: 'POST', body: {
    title: 'Close the till', assigneeAgentId: cashier.id, status: 'paused', concurrencyPolicy: 'skip_if_active',
    description: 'Add the comment "Till closed." to this card, then mark it done.',
  } })).json;
  const fire = () => new Promise((resolve) => execFile(process.execPath, [fileURLToPath(new URL('./run-routine.mjs', import.meta.url)), routine.id],
    { env: process.env, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch { resolve({ error: String(stderr || stdout || err?.message).slice(0, 300) }); }
    }));
  const fired = await fire();
  check("the routine's run names its card to the Cashier's conversation", fired.send === true && fired.card && fired.conversation === `local_${cashierSession}` && fired.message?.includes(fired.card), fired);
  const routineCard = list((await call(`/api/companies/${org.id}/issues`)).json).find((c) => c.identifier === fired.card);
  const waits = await until(async () => (await call(`/api/issues/${routineCard?.id}`)).json?.status === 'backlog');
  check("the card waits for Desktop, in the Cashier's inbox", waits && await until(() => fs.existsSync(inboxFile(INSTANCE, cashier.id)), 10_000), (await call(`/api/issues/${routineCard?.id}`)).json?.status);
  const routineTurn = await claudeTurn(['-p', fired.message ?? '', '--resume', cashierSession, '--output-format', 'json', '--max-turns', '25', '--permission-mode', 'acceptEdits'], folder);
  check("the Cashier's turn on that message finished", routineTurn.out && !routineTurn.out.is_error, routineTurn.out?.result?.slice?.(0, 300) ?? routineTurn.stderr.slice(0, 300));
  check("and took the routine's card to done", (await call(`/api/issues/${routineCard?.id}`)).json?.status === 'done', (await call(`/api/issues/${routineCard?.id}`)).json?.status);
  const refired = await fire();
  check('a second firing the same day sends nothing', refired.send === false && refired.card === fired.card, refired);
} catch (error) {
  check('rehearsal finished', false, error.stack ?? error.message);
} finally {
  if (KEEP) console.log(`\nKept: org ${orgId}, folder ${folder}. Remove it with: node scripts/org-rehearsal.mjs --clean ${orgId}`);
  else if (orgId) await cleanUp(orgId);
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `${failed.length} of ${checks.length} checks failed` : `All ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
