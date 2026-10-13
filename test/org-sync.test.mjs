import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopOrgs, isDesktopOrg, readOrg, switchOrg } from '../desktop-orgs.mjs';
import { claudeTeam, markHandedOff, noteNewCard, paperclipApi, syncOrg, TEAM_FILE } from '../org-sync.mjs';
import { takeInbox } from '../paperclip-wakes.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const ORG = 'org-1';

function team(instructionsDir) {
  const instructions = (name, text) => { const f = path.join(instructionsDir, `${name}.md`); fs.writeFileSync(f, text); return f; };
  const agent = (id, name, extra = {}) => ({
    id, companyId: ORG, name, role: 'general', status: 'idle', adapterType: 'claude_local', reportsTo: 'cos', createdAt: `2026-10-10T00:00:0${id.length % 10}Z`,
    adapterConfig: { model: 'claude-haiku-5-5', instructionsFilePath: instructions(id, `You are ${name}.`), paperclipSkillSync: { desiredSkills: ['paperclipai/paperclip/paperclip'] } },
    ...extra,
  });
  return [
    agent('cashier', 'Cashier', { createdAt: '2026-10-10T00:00:05Z' }),
    agent('cos', 'Chief of Staff', { reportsTo: null, title: 'CEO', createdAt: '2026-10-10T00:00:01Z', adapterConfig: { instructionsFilePath: instructions('cos', 'You run the stand.'), paperclipSkillSync: { desiredSkills: ['paperclipai/paperclip/paperclip-board'] } } }),
    agent('verifier', 'Verifier', { adapterType: 'codex_local' }),
    agent('gone', 'Old Hand', { status: 'terminated' }),
    agent('waiting', 'New Hire', { status: 'pending_approval' }),
  ];
}

/** A stand-in Paperclip with one org, its agents and cards. */
async function fakePaperclip({ agents, cards = {}, status = 'active' }) {
  const server = http.createServer((req, res) => {
    const send = (code, json) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url === `/api/companies/${ORG}`) return send(200, { id: ORG, name: 'Lemonade Stand', issuePrefix: 'LEM', status });
    if (req.url === `/api/companies/${ORG}/agents`) return send(200, agents);
    const agent = req.url.match(/^\/api\/agents\/([\w-]+)$/)?.[1];
    if (agent) return send(agents.some((a) => a.id === agent) ? 200 : 404, agents.find((a) => a.id === agent) ?? {});
    const card = req.url.match(/^\/api\/issues\/([\w-]+)$/)?.[1];
    if (card && cards[card]) return send(200, cards[card]);
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('an org moves to Claude Desktop by its own switch, which the adapter reads too', () => {
  const instance = tmp('instance');
  assert.equal(isDesktopOrg(instance, ORG), false);
  switchOrg(instance, ORG, { on: true, folder: 'C:/orgs/Lemonade Stand' });
  assert.equal(isDesktopOrg(instance, ORG), true);
  assert.deepEqual(desktopOrgs(instance).map((o) => [o.companyId, o.folder]), [[ORG, 'C:/orgs/Lemonade Stand']]);
  switchOrg(instance, ORG, { on: false });
  assert.equal(isDesktopOrg(instance, ORG), false);
  assert.equal(readOrg(instance, ORG).folder, 'C:/orgs/Lemonade Stand', 'its folder is remembered');
  assert.equal(isDesktopOrg(instance, undefined), false);
});

test("Paperclip's address comes from its own runtime record", () => {
  const instance = tmp('instance');
  assert.equal(paperclipApi(instance), 'http://127.0.0.1:3100');
  fs.writeFileSync(path.join(instance, 'runtime-info.json'), JSON.stringify({ host: '127.0.0.1', port: 3111, dashboardUrl: 'http://127.0.0.1:3111/' }));
  assert.equal(paperclipApi(instance), 'http://127.0.0.1:3111');
});

test("the team is the org's Claude agents, and its Chief of Staff the one who reports to no one", () => {
  const { team: members, chief } = claudeTeam(team(tmp('instr')));
  assert.deepEqual(members.map((a) => a.id), ['cos', 'cashier']);
  assert.equal(chief.id, 'cos');
});

test("an org's folder and Desktop conversations follow Paperclip: agent files, skills, settings, the team, one hello each", async () => {
  const agents = team(tmp('instr'));
  const paperclip = await fakePaperclip({ agents });
  try {
    const instance = tmp('instance');
    const folder = tmp('Lemonade Stand');
    fs.mkdirSync(path.join(folder, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude', 'agents', 'old-hand.md'), '---\nname: old-hand\npaperclip-agent-id: gone\n---\nGone.\n');
    fs.writeFileSync(path.join(folder, '.claude', 'agents', 'mine.md'), '---\nname: mine\n---\nNot from Paperclip.\n');
    const hellos = [];
    const hello = async ({ folder: cwd, slug, name, org, skipPermissions }) => {
      hellos.push({ cwd, slug, name, org, skipPermissions });
      return { ok: true, sessionId: `${slug}-0000-4000-8000-000000000000`.slice(0, 36), reply: `Hi, I'm ${name}.`, model: 'claude-haiku-5-5' };
    };
    const sync = () => syncOrg({ api: paperclip.api, instance, companyId: ORG, node: 'node', claude: 'claude', hello });

    assert.deepEqual(await sync(), { skipped: 'not switched to Claude Desktop' });
    switchOrg(instance, ORG, { on: true, folder });

    const first = await sync();
    assert.deepEqual(hellos.map((h) => h.slug), ['chief-of-staff', 'cashier'], "the Chief of Staff's conversation first; no conversation for agents that aren't Claude, are gone, or wait for approval");
    assert.equal(hellos[0].cwd, folder);
    assert.equal(hellos[0].org, 'Lemonade Stand');
    assert.equal(hellos[0].skipPermissions, true, "Paperclip's Skip permissions (on unless turned off) reaches the hello, whose mode Desktop keeps");
    assert.deepEqual(fs.readdirSync(path.join(folder, '.claude', 'agents')).sort(), ['cashier.md', 'chief-of-staff.md', 'mine.md'], "a former agent's file goes; yours stays");
    assert.match(fs.readFileSync(path.join(folder, '.claude', 'agents', 'cashier.md'), 'utf8'), /model: claude-haiku-5-5[\s\S]*You are Cashier\./);
    const settings = JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.agent, 'chief-of-staff', 'a new chat in the folder is the Chief of Staff');
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /--chief cos/);
    const roster = fs.readFileSync(path.join(folder, TEAM_FILE), 'utf8');
    assert.match(roster, /\| Chief of Staff \| CEO \| the board \| chief-of-staff \| local_chief-of-staff/);
    assert.match(roster, /\| Cashier \| general \| Chief of Staff \| cashier \| local_cashier/);
    assert.deepEqual(first.handOff.map((x) => x.name), ['Chief of Staff', 'Cashier']);
    assert.ok(first.wrote.includes(TEAM_FILE));
    assert.deepEqual(first.skippedSkills, [], "Paperclip's bundled skills are found");
    assert.ok(fs.existsSync(path.join(folder, '.claude', 'skills', 'paperclip-board', 'SKILL.md')));

    const second = await sync();
    assert.equal(hellos.length, 2, 'one hello per agent, ever');
    assert.deepEqual(second.wrote, [], 'nothing changed, nothing written');
    assert.equal(second.handOff.length, 2, 'still to be handed to Claude Desktop');
    markHandedOff(instance, ORG, 'cos');
    assert.deepEqual((await sync()).handOff.map((x) => x.name), ['Cashier']);

    fs.writeFileSync(agents.find((a) => a.id === 'cashier').adapterConfig.instructionsFilePath, 'You are Cashier. Cash only.');
    assert.deepEqual((await sync()).wrote, [path.join('.claude', 'agents', 'cashier.md')], 'an instruction edit in Paperclip rewrites the agent file');
  } finally {
    paperclip.close();
  }
});

test('a hello that fails is tried again a few minutes later; an archived org is left alone', async () => {
  const agents = team(tmp('instr')).filter((a) => a.id === 'cos');
  const paperclip = await fakePaperclip({ agents });
  try {
    const instance = tmp('instance');
    switchOrg(instance, ORG, { on: true, folder: tmp('org') });
    let clock = Date.parse('2026-10-10T12:00:00Z');
    let calls = 0;
    const hello = async () => { calls += 1; return { ok: false, sessionId: 'x', error: 'session limit' }; };
    const sync = () => syncOrg({ api: paperclip.api, instance, companyId: ORG, node: 'node', claude: 'claude', hello, now: () => clock });
    assert.equal((await sync()).made[0].error, 'session limit');
    await sync();
    assert.equal(calls, 1, 'not again right away');
    clock += 6 * 60_000;
    await sync();
    assert.equal(calls, 2);
    assert.match(fs.readFileSync(path.join(readOrg(instance, ORG).folder, TEAM_FILE), 'utf8'), /\(being set up\)/);
  } finally {
    paperclip.close();
  }
  const archived = await fakePaperclip({ agents: [], status: 'archived' });
  try {
    const instance = tmp('instance');
    switchOrg(instance, ORG, { on: true, folder: tmp('org') });
    assert.deepEqual(await syncOrg({ api: archived.api, instance, companyId: ORG, claude: 'claude' }), { skipped: 'archived' });
  } finally {
    archived.close();
  }
});

test("a card the board makes for a Claude agent waits in that agent's Desktop inbox; agents' own hand-offs don't", async () => {
  const agents = team(tmp('instr'));
  const paperclip = await fakePaperclip({
    agents,
    cards: {
      'card-1': { id: 'card-1', identifier: 'LEM-1', title: 'Say hello', assigneeAgentId: 'cos', createdByUserId: 'local-board', createdByAgentId: null },
      'card-2': { id: 'card-2', identifier: 'LEM-2', title: 'Restock', assigneeAgentId: 'cashier', createdByAgentId: 'cos' },
      'card-3': { id: 'card-3', identifier: 'LEM-3', title: 'Verify', assigneeAgentId: 'verifier', createdByUserId: 'local-board' },
    },
  });
  try {
    const instance = tmp('instance');
    const noted = await noteNewCard({ api: paperclip.api, instance, issueId: 'card-1' });
    assert.equal(noted.agentId, 'cos');
    assert.equal(await noteNewCard({ api: paperclip.api, instance, issueId: 'card-2' }), null);
    assert.equal(await noteNewCard({ api: paperclip.api, instance, issueId: 'card-3' }), null);
    assert.deepEqual(takeInbox(instance, 'cos').map((i) => [i.reason, i.card.identifier]), [['issue_created', 'LEM-1']]);
  } finally {
    paperclip.close();
  }
});
