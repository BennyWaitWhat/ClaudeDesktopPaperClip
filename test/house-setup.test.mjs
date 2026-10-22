import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { readOrg, switchOrg } from '../desktop-orgs.mjs';
import { fill, houseConfig, houseSetUp, markNewOrg, orgTemplate, seedOrgFolder, templateDir } from '../house-setup.mjs';
import { syncOrg } from '../org-sync.mjs';

const made = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still held: left */ } } });
const tmp = (name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); made.push(dir); return dir; };
const ORG = 'org-h';
const FOLDER = 'C:\\Users\\Benny\\Desktop\\PaperClip\\Lemon Co';

test('the house template is copied from the repo once, then read from its own folder', () => {
  const instance = tmp('instance');
  const first = orgTemplate(instance);
  assert.equal(first.dir, templateDir(instance));
  assert.deepEqual(first.defaults, { model: 'claude-opus-5-5', effort: 'max' });
  assert.match(first.claude, /# \{\{org\}\}/);
  assert.match(first.chief, /Every employee gets every tool: leave `desktopTools` out/);
  fs.writeFileSync(path.join(first.dir, 'defaults.json'), JSON.stringify({ model: 'claude-sonnet-5-5', effort: 'high' }));
  assert.deepEqual(orgTemplate(instance).defaults, { model: 'claude-sonnet-5-5', effort: 'high' }, 'an edit to the house template is kept');
});

test("a template gets the org's name, its folder (also as it goes inside JSON) and the date", () => {
  const text = fill('{{org}} at {{folder}}; "cwd": "{{folder_json}}"; {{date}}; {{unknown}}', { org: 'Lemon Co', folder: FOLDER, date: '2026-10-21' });
  assert.equal(text, 'Lemon Co at C:\\Users\\Benny\\Desktop\\PaperClip\\Lemon Co; "cwd": "C:\\\\Users\\\\Benny\\\\Desktop\\\\PaperClip\\\\Lemon Co"; 2026-10-21; {{unknown}}');
  assert.equal(JSON.parse(`{"cwd": "${fill('{{folder_json}}', { org: 'x', folder: FOLDER })}"}`).cwd, FOLDER);
});

test("a new org's folder gets the house rules and facts once, never over its own", () => {
  const instance = tmp('instance');
  const folder = tmp('org');
  const template = orgTemplate(instance);
  assert.deepEqual(seedOrgFolder({ folder, org: 'Lemon Co', template, date: '2026-10-21' }), ['CLAUDE.md', 'FACTS.md']);
  assert.match(fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8'), /^# Lemon Co\n/);
  assert.match(fs.readFileSync(path.join(folder, 'FACTS.md'), 'utf8'), /- Name: Lemon Co\. \(Paperclip, 2026-10-21\)/);
  fs.writeFileSync(path.join(folder, 'CLAUDE.md'), 'Our own rules.');
  assert.deepEqual(seedOrgFolder({ folder, org: 'Lemon Co', template }), []);
  assert.equal(fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8'), 'Our own rules.');
});

test("the house way: a new org's Chief of Staff takes the house model, effort and every tool; others only fill gaps", () => {
  const defaults = { model: 'claude-opus-5-5', effort: 'max' };
  assert.deepEqual(houseConfig({ model: 'claude-sonnet-5-5', desktopTools: ['Read'] }, { defaults, folder: FOLDER, chief: true, fresh: true }), {
    model: 'claude-opus-5-5', effort: 'max', desktopTools: [], cwd: FOLDER, dangerouslySkipPermissions: true, checksBoardSteps: true,
  });
  assert.deepEqual(houseConfig({ model: 'claude-sonnet-5-5', cwd: 'D:\\x', dangerouslySkipPermissions: false }, { defaults, folder: FOLDER }), { effort: 'max' }, "a hire's own choices stay");
  assert.equal(houseConfig({ model: 'claude-opus-5-5', effort: 'max', cwd: FOLDER, dangerouslySkipPermissions: true }, { defaults, folder: FOLDER }), null);
  assert.deepEqual(houseConfig({ model: 'claude-opus-5-5', effort: 'max', cwd: FOLDER, dangerouslySkipPermissions: true }, { defaults, folder: FOLDER, chief: true }), { checksBoardSteps: true });
});

/** A stand-in Paperclip that records saves; `failFor` agents refuse them. */
async function fakePaperclip({ agents, failFor = [] }) {
  const saves = [];
  const instructions = new Map(agents.map((a) => [a.id, { content: 'You are the CEO.', revision: { id: `rev-${a.id}` } }]));
  const server = http.createServer(async (req, res) => {
    const send = (code, json) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    if (req.url === `/api/companies/${ORG}`) return send(200, { id: ORG, name: 'Lemon Co', status: 'active' });
    if (req.url === `/api/companies/${ORG}/agents`) return send(200, agents);
    const file = req.url.match(/^\/api\/agents\/([\w-]+)\/instructions-bundle\/file/)?.[1];
    if (file && req.method === 'GET') return send(200, instructions.get(file));
    if (file && req.method === 'PUT') {
      if (json.baseRevisionId !== instructions.get(file).revision.id) return send(409, { error: 'stale' });
      instructions.set(file, { content: json.content, revision: { id: `rev-${file}-2` } });
      saves.push({ id: file, instructions: json.content });
      return send(200, {});
    }
    const id = req.url.match(/^\/api\/agents\/([\w-]+)$/)?.[1];
    if (id && req.method === 'PATCH') {
      if (failFor.includes(id)) return send(500, { error: 'busy' });
      const agent = agents.find((a) => a.id === id);
      agent.adapterConfig = { ...agent.adapterConfig, ...json.adapterConfig };
      saves.push({ id, adapterConfig: json.adapterConfig });
      return send(200, agent);
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, saves, instructions, close: () => server.close() };
}

const agent = (id, name, extra = {}) => ({ id, companyId: ORG, name, role: 'general', status: 'idle', adapterType: 'claude_local', reportsTo: 'cos', adapterConfig: {}, createdAt: '2026-10-21T00:00:02Z', ...extra });

test("an org on Claude Desktop before the house way is adopted as it is; a new org's agents are set up once each", async () => {
  const chief = agent('cos', 'Chief of Staff', { reportsTo: null, createdAt: '2026-10-21T00:00:01Z', adapterConfig: { model: 'claude-haiku-5-5' } });
  const paperclip = await fakePaperclip({ agents: [chief] });
  try {
    const old = tmp('instance');
    const adopted = await houseSetUp({ api: paperclip.api, instance: old, companyId: ORG, org: 'Lemon Co', folder: FOLDER, team: [chief], chief });
    assert.deepEqual(adopted, { changed: [], pending: [] });
    assert.equal(paperclip.saves.length, 0, 'nothing changes in an adopted org');
    assert.ok(readOrg(old, ORG).house.adopted);

    const instance = tmp('instance');
    markNewOrg(instance, ORG);
    const first = await houseSetUp({ api: paperclip.api, instance, companyId: ORG, org: 'Lemon Co', folder: FOLDER, team: [chief], chief });
    assert.deepEqual(first, { changed: ['Chief of Staff'], pending: [] });
    assert.deepEqual(paperclip.saves[0], { id: 'cos', adapterConfig: { model: 'claude-opus-5-5', effort: 'max', cwd: FOLDER, dangerouslySkipPermissions: true, checksBoardSteps: true } });
    const job = paperclip.instructions.get('cos').content;
    assert.match(job, /^You are the Chief of Staff at Lemon Co's team\./);
    assert.match(job, /"cwd": "C:\\\\Users\\\\Benny\\\\Desktop\\\\PaperClip\\\\Lemon Co"/);
    assert.ok(!job.includes('{{'), 'every placeholder filled');

    const again = await houseSetUp({ api: paperclip.api, instance, companyId: ORG, org: 'Lemon Co', folder: FOLDER, team: [chief], chief });
    assert.deepEqual(again, { changed: [], pending: [] }, 'once each: a later change of the Chief is left alone');
  } finally {
    paperclip.close();
  }
});

test("a hire Paperclip refuses to save waits for the next sync, and gets no conversation until then", async () => {
  const instance = tmp('instance');
  const folder = tmp('org');
  const chief = agent('cos', 'Chief of Staff', { reportsTo: null, createdAt: '2026-10-21T00:00:01Z', adapterConfig: { model: 'claude-opus-5-5', effort: 'max', cwd: folder, dangerouslySkipPermissions: true, checksBoardSteps: true } });
  const hire = agent('roofer', 'Estimator', { adapterConfig: {} });
  const paperclip = await fakePaperclip({ agents: [chief, hire], failFor: ['roofer'] });
  try {
    switchOrg(instance, ORG, { on: true, folder });
    markNewOrg(instance, ORG);
    const hellos = [];
    const hello = async ({ name }) => { hellos.push(name); return { ok: true, sessionId: `s-${name}` }; };
    const first = await syncOrg({ api: paperclip.api, instance, companyId: ORG, claude: 'claude', hello });
    assert.deepEqual(first.house, ['Chief of Staff']);
    assert.deepEqual(hellos, ['Chief of Staff'], 'the refused hire has no conversation yet');
    assert.equal(readOrg(instance, ORG).house.agents.roofer, undefined);

    paperclip.saves.length = 0;
    const fixedPaperclip = await fakePaperclip({ agents: [chief, hire] });
    try {
      const second = await syncOrg({ api: fixedPaperclip.api, instance, companyId: ORG, claude: 'claude', hello });
      assert.deepEqual(second.house, ['Estimator']);
      assert.deepEqual(fixedPaperclip.saves[0], { id: 'roofer', adapterConfig: { model: 'claude-opus-5-5', effort: 'max', cwd: folder, dangerouslySkipPermissions: true } });
      assert.deepEqual(hellos, ['Chief of Staff', 'Estimator']);
      assert.match(fs.readFileSync(path.join(folder, '.claude', 'agents', 'estimator.md'), 'utf8'), /model: claude-opus-5-5/, 'its file is written with the house model');
    } finally {
      fixedPaperclip.close();
    }
  } finally {
    paperclip.close();
  }
});
