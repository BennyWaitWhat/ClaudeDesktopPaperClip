// Offline checks for the Claude Desktop plugin: folder naming, and the worker in the SDK's test harness (no
// Paperclip server, no Claude Desktop, no model calls: the org sync and the hand-off are stand-ins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import { readOrg, updateOrg } from '../../desktop-orgs.mjs';
import { paperclipInstance } from '../../org-sync.mjs';
import manifest from '../manifest.js';
import plugin, { FOLDER_KEY, options } from '../worker.js';
import { desktopFolder, ensureFolder, ensureOrgFolder, orgFolderName } from '../folders.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const settle = () => new Promise((r) => setTimeout(r, 50));

test('org names become folder names Windows accepts', () => {
  assert.equal(orgFolderName('Test Org'), 'Test Org');
  assert.equal(orgFolderName('Acme: R&D / West'), 'Acme R&D West');
  assert.equal(orgFolderName('  Trailing dots...  '), 'Trailing dots');
  assert.equal(orgFolderName('CON'), 'CON org');
  assert.equal(orgFolderName(''), 'Org');
  assert.ok(orgFolderName('x'.repeat(300)).length <= 80);
});

test('finds the real Desktop', () => {
  const dir = desktopFolder();
  assert.ok(path.isAbsolute(dir) && fs.existsSync(dir), dir);
});

test("finds Paperclip's instance folder the way Paperclip does", () => {
  assert.equal(paperclipInstance({}), path.join(os.homedir(), '.paperclip', 'instances', 'default'));
  assert.equal(paperclipInstance({ PAPERCLIP_HOME: 'D:/pc', PAPERCLIP_INSTANCE_ID: 'second' }), path.join(path.resolve('D:/pc'), 'instances', 'second'));
});

test('makes an org folder, and reuses one that is already there', () => {
  const parent = tmp('org-parent');
  const first = ensureOrgFolder(parent, 'Test Org');
  fs.writeFileSync(path.join(first, 'keep.txt'), 'x');
  assert.equal(ensureOrgFolder(parent, 'Test Org'), first);
  assert.ok(fs.existsSync(path.join(first, 'keep.txt')), 'nothing in it is touched');
  assert.throws(() => ensureOrgFolder('relative/path', 'X'));
  assert.throws(() => ensureFolder('Desktop'), /full path/);
  fs.rmSync(parent, { recursive: true, force: true });
});

async function harness() {
  const synced = [];
  const noted = [];
  Object.assign(options, {
    instance: tmp('instance'), api: 'http://127.0.0.1:9', watch: false,
    sync: async ({ companyId }) => { synced.push(companyId); return { skipped: 'stand-in' }; },
    noteCard: async ({ issueId }) => { noted.push(issueId); return null; },
  });
  const h = createTestHarness({ manifest });
  h.seed({ companies: [{ id: 'c1', name: 'Test Org' }, { id: 'c2', name: 'Older Org' }, { id: 'c3', name: 'cdpc rehearsal abc123' }] });
  await plugin.definition.setup(h.ctx);
  return { h, synced, noted };
}

test('creating an org makes its folder where you chose, and moves the org to Claude Desktop at once', async () => {
  const parent = tmp('org-parent');
  const { h, synced } = await harness();
  await h.performAction('set-new-org-parent', { path: parent });
  await h.emit('company.created', {}, { companyId: 'c1', entityId: 'c1', entityType: 'company' });
  await settle();
  const folder = await h.ctx.localFolders.status('c1', FOLDER_KEY);
  assert.equal(folder.path, path.join(parent, 'Test Org'));
  assert.ok(fs.existsSync(folder.path));
  const org = readOrg(options.instance, 'c1');
  assert.equal(org.desktop, true);
  assert.equal(org.folder, folder.path);
  assert.deepEqual(synced, ['c1'], 'its team is brought into Claude Desktop right away');

  // An org that already has a folder keeps it.
  await h.emit('company.created', {}, { companyId: 'c1', entityId: 'c1', entityType: 'company' });
  assert.equal((await h.ctx.localFolders.status('c1', FOLDER_KEY)).path, folder.path);
  assert.equal((await plugin.definition.onApiRequest({ routeKey: 'nope', companyId: 'c1' })).status, 404);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('an older org stays as it is until it is moved to Claude Desktop', async () => {
  const parent = tmp('org-parent');
  const { h, synced, noted } = await harness();
  await h.performAction('set-new-org-parent', { path: parent });
  await h.emit('agent.created', {}, { companyId: 'c2', entityId: 'a1', entityType: 'agent' });
  await h.emit('issue.created', {}, { companyId: 'c2', entityId: 'i1', entityType: 'issue' });
  await settle();
  assert.deepEqual([synced, noted], [[], []], 'not moved: nothing happens');
  assert.equal((await h.getData('org-folder', { companyId: 'c2' })).desktop, false);

  assert.deepEqual(await h.performAction('set-desktop', { companyId: 'c2', on: true }), { desktop: true, folder: path.join(parent, 'Older Org') });
  await settle();
  assert.deepEqual(synced, ['c2']);
  assert.equal((await h.getData('org-folder', { companyId: 'c2' })).desktop, true);
  await h.emit('issue.created', {}, { companyId: 'c2', entityId: 'i2', entityType: 'issue' });
  await h.emit('agent.created', {}, { companyId: 'c2', entityId: 'a2', entityType: 'agent' });
  await settle();
  assert.deepEqual(noted, ['i2'], 'a card made for one of its agents waits in that agent\'s inbox');
  assert.equal(synced.length, 2, 'a new agent is brought in');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a rehearsal org is left to the rehearsal: no folder, no sync, nothing handed to Claude Desktop', async () => {
  const parent = tmp('org-parent');
  const { h, synced } = await harness();
  await h.performAction('set-new-org-parent', { path: parent });
  await h.emit('company.created', {}, { companyId: 'c3', entityId: 'c3', entityType: 'company' });
  await settle();
  assert.equal((await h.ctx.localFolders.status('c3', FOLDER_KEY)).configured, false);
  assert.equal(readOrg(options.instance, 'c3'), null);
  updateOrg(options.instance, 'c3', (o) => ({ ...o, desktop: true, folder: parent, plugin: false }));
  await h.emit('agent.created', {}, { companyId: 'c3', entityId: 'a9', entityType: 'agent' });
  await settle();
  assert.deepEqual(synced, []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('settings page data, and moving an org to another folder', async () => {
  const parent = tmp('org-parent');
  const { h } = await harness();
  await h.performAction('set-new-org-parent', { path: parent });
  let data = await h.getData('org-folder', { companyId: 'c1' });
  assert.equal(data.folder.configured, false);
  assert.equal(data.newOrgParent, parent);
  assert.equal(data.suggested, path.join(parent, 'Test Org'), 'an org without a folder is offered the one a new org would get');

  const moved = path.join(parent, 'Elsewhere', 'Test Org');
  await h.performAction('set-org-folder', { companyId: 'c1', path: moved });
  data = await h.getData('org-folder', { companyId: 'c1' });
  assert.equal(data.folder.path, moved);
  assert.ok(fs.existsSync(moved), 'a folder you type is made when missing');
  await assert.rejects(h.performAction('set-org-folder', { companyId: 'c1', path: 'not/full' }), /full path/);
  fs.rmSync(parent, { recursive: true, force: true });
});

test("the card button finds each agent's Desktop conversation, and refuses anything but a real session id", async () => {
  const { h } = await harness();
  updateOrg(options.instance, 'c1', (o) => ({
    ...o, desktop: true, folder: 'C:/orgs/Test Org',
    conversations: { a1: { sessionId: '11111111-2222-4333-8444-555555555555', name: 'Cashier', ready: 'now' }, a2: { failedAt: 'now' } },
  }));
  assert.deepEqual(await h.getData('agent-conversations', { companyId: 'c1' }), {
    desktop: true, folder: 'C:/orgs/Test Org', conversations: [{ agentId: 'a1', name: 'Cashier', sessionId: '11111111-2222-4333-8444-555555555555' }],
  });
  const result = await h.performAction('open-in-desktop', { sessionId: 'nope', cwd: os.tmpdir() });
  assert.equal(result.ok, false);
});

test('manifest declares what the worker uses, and no more than before (Paperclip refuses an upgrade that adds one)', () => {
  assert.deepEqual([...manifest.capabilities].sort(), [
    'api.routes.register', 'companies.read', 'events.subscribe', 'instance.settings.register', 'local.folders', 'plugin.state.read', 'plugin.state.write', 'ui.action.register',
  ]);
  assert.deepEqual(manifest.localFolders.map((f) => f.folderKey), [FOLDER_KEY]);
  assert.equal(manifest.apiRoutes[0].auth, 'agent');
});
