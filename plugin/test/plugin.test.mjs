// Offline checks for the Claude Desktop plugin: folder naming, and the worker in the SDK's test harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../manifest.js';
import plugin, { FOLDER_KEY } from '../worker.js';
import { desktopFolder, ensureFolder, ensureOrgFolder, orgFolderName } from '../folders.mjs';

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

test('makes an org folder, and reuses one that is already there', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'org-parent-'));
  const first = ensureOrgFolder(parent, 'Test Org');
  fs.writeFileSync(path.join(first, 'keep.txt'), 'x');
  assert.equal(ensureOrgFolder(parent, 'Test Org'), first);
  assert.ok(fs.existsSync(path.join(first, 'keep.txt')), 'nothing in it is touched');
  assert.throws(() => ensureOrgFolder('relative/path', 'X'));
  assert.throws(() => ensureFolder('Desktop'), /full path/);
  fs.rmSync(parent, { recursive: true, force: true });
});

async function harness() {
  const h = createTestHarness({ manifest });
  h.seed({ companies: [{ id: 'c1', name: 'Test Org' }] });
  await plugin.definition.setup(h.ctx);
  return h;
}

test('creating an org makes its folder, where you chose, and records it as the org folder', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'org-parent-'));
  const h = await harness();
  await h.performAction('set-new-org-parent', { path: parent });
  await h.emit('company.created', {}, { companyId: 'c1', entityId: 'c1', entityType: 'company' });
  const folder = await h.ctx.localFolders.status('c1', FOLDER_KEY);
  assert.equal(folder.path, path.join(parent, 'Test Org'));
  assert.ok(fs.existsSync(folder.path));

  // The adapter's question, asked as the org's agent.
  const answer = await plugin.definition.onApiRequest({ routeKey: 'org-folder', companyId: 'c1' });
  assert.deepEqual(answer, { body: { path: folder.path } });
  assert.equal((await plugin.definition.onApiRequest({ routeKey: 'nope', companyId: 'c1' })).status, 404);

  // An org that already has a folder keeps it.
  await h.emit('company.created', {}, { companyId: 'c1', entityId: 'c1', entityType: 'company' });
  assert.equal((await h.ctx.localFolders.status('c1', FOLDER_KEY)).path, folder.path);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('settings page data, and moving an org to another folder', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'org-parent-'));
  const h = await harness();
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

test('the card button refuses anything but a real session id', async () => {
  const h = await harness();
  const result = await h.performAction('open-in-desktop', { sessionId: 'nope', cwd: os.tmpdir() });
  assert.equal(result.ok, false);
});

test('manifest declares what the worker uses', () => {
  for (const cap of ['events.subscribe', 'companies.read', 'local.folders', 'plugin.state.read', 'plugin.state.write', 'api.routes.register', 'instance.settings.register', 'ui.action.register']) {
    assert.ok(manifest.capabilities.includes(cap), cap);
  }
  assert.deepEqual(manifest.localFolders.map((f) => f.folderKey), [FOLDER_KEY]);
  assert.equal(manifest.apiRoutes[0].auth, 'agent');
});
