import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentMarkdown, agentSlug, bundledSkillDir, readInstructions, syncSkills, writeAgentFile } from '../agent-files.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const cashier = { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Cashier', title: 'Runs the till', adapterConfig: { model: 'claude-haiku-5-5', effort: 'medium' } };

test('an agent name becomes a Claude Code agent name', () => {
  assert.equal(agentSlug('Chief of Staff'), 'chief-of-staff');
  assert.equal(agentSlug('  R&D: Lead!  '), 'r-d-lead');
  assert.equal(agentSlug(''), 'agent');
});

test("an agent file: its Paperclip model, effort, Skip permissions and id up top, the Desktop notes, then its Paperclip instructions", () => {
  const md = agentMarkdown({ agent: cashier, slug: 'cashier', org: 'Lemonade Stand', instructions: 'You run the till.' });
  const [, front, body] = md.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.deepEqual(front.split('\n'), [
    'name: cashier', 'description: "Paperclip agent: Cashier, Runs the till."', 'model: claude-haiku-5-5', 'effort: medium', 'paperclip-skip-permissions: true', `paperclip-agent-id: ${cashier.id}`,
  ]);
  assert.match(body, /^## Working from Claude Desktop\n\nYou are Cashier, an agent in the Paperclip org Lemonade Stand\./);
  assert.match(body, /\$PAPERCLIP_RUN_ID/);
  assert.match(body, /paperclip-card\.mjs" <CARD>/);
  assert.match(body, /Work goes on cards/);
  assert.match(body, /paperclip-card\.mjs" --new "<short title>"/);
  assert.match(body, /You run the till\.\n$/);
  assert.doesNotMatch(agentMarkdown({ agent: { ...cashier, adapterConfig: {} }, slug: 'cashier', org: 'X', instructions: '' }), /^(model|effort):/m, 'nothing Paperclip does not set');
  assert.match(agentMarkdown({ agent: { ...cashier, adapterConfig: { dangerouslySkipPermissions: false } }, slug: 'cashier', org: 'X', instructions: '' }), /^paperclip-skip-permissions: false$/m, 'Skip permissions turned off in Paperclip');
  assert.doesNotMatch(md, /^tools:/m, 'no tool list in Paperclip: every tool');
});

test("an agent's tool list from Paperclip goes into its file, always with Bash, SendMessage and Desktop's messaging tool, and nothing but tool names", () => {
  const withTools = (desktopTools) => agentMarkdown({ agent: { ...cashier, adapterConfig: { ...cashier.adapterConfig, desktopTools } }, slug: 'cashier', org: 'X', instructions: '' });
  assert.match(withTools(['Read', 'Grep', 'mcp__Claude_Browser']), /^tools: Bash, SendMessage, mcp__ccd_session_mgmt__send_message, Read, Grep, mcp__Claude_Browser$/m);
  assert.match(withTools('Read, Write\nBash'), /^tools: Bash, SendMessage, mcp__ccd_session_mgmt__send_message, Read, Write$/m, 'a comma or line separated list, each tool once');
  assert.match(withTools(['Read', 'evil: yes\nmodel: x', '  ', 'Write']), /^tools: Bash, SendMessage, mcp__ccd_session_mgmt__send_message, Read, Write$/m, 'anything that is not a tool name is dropped');
  assert.doesNotMatch(withTools([]), /^tools:/m);
  assert.doesNotMatch(withTools(['not a tool!']), /^tools:/m, 'nothing usable listed: every tool');
});

test('agent files are written once per change, never over someone else\'s file, and follow a rename', async () => {
  const folder = tmp('org');
  const agents = path.join(folder, '.claude', 'agents');
  const first = await writeAgentFile({ folder, agent: cashier, org: 'Lemonade Stand', instructions: 'You run the till.' });
  assert.equal(first.slug, 'cashier');
  assert.equal(first.changed, true);
  assert.equal((await writeAgentFile({ folder, agent: cashier, org: 'Lemonade Stand', instructions: 'You run the till.' })).changed, false);
  const edited = await writeAgentFile({ folder, agent: cashier, org: 'Lemonade Stand', instructions: 'Cash only.' });
  assert.equal(edited.changed, true);
  assert.notEqual(edited.hash, first.hash);

  fs.writeFileSync(path.join(agents, 'maker.md'), '---\nname: maker\n---\nMine, not Paperclip\'s.\n');
  const maker = { id: 'ffff0000-0000-4000-8000-000000000002', name: 'Maker' };
  assert.equal((await writeAgentFile({ folder, agent: maker, org: 'Lemonade Stand', instructions: '' })).slug, 'maker-ffff');
  assert.match(fs.readFileSync(path.join(agents, 'maker.md'), 'utf8'), /Mine, not Paperclip's/);

  const renamed = await writeAgentFile({ folder, agent: { ...cashier, name: 'Head Cashier' }, org: 'Lemonade Stand', instructions: 'Cash only.' });
  assert.equal(renamed.slug, 'head-cashier');
  assert.deepEqual(fs.readdirSync(agents).sort(), ['head-cashier.md', 'maker-ffff.md', 'maker.md']);
});

test("an agent's Paperclip instructions come from its instructions file", async () => {
  const file = path.join(tmp('bundle'), 'AGENTS.md');
  fs.writeFileSync(file, 'You run the till.');
  assert.equal(await readInstructions({ adapterConfig: { instructionsFilePath: file } }), 'You run the till.');
  assert.equal(await readInstructions({ adapterConfig: {} }), '');
  assert.equal(await readInstructions({ adapterConfig: { instructionsFilePath: path.join(tmp('none'), 'gone.md') } }), '');
});

test("the org folder gets the skills its agents have, copied once per change; skills that aren't Paperclip's own are reported", async () => {
  const source = tmp('skills');
  fs.mkdirSync(path.join(source, 'paperclip', 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'paperclip', 'SKILL.md'), '---\nname: paperclip\n---\nv1');
  fs.writeFileSync(path.join(source, 'paperclip', 'references', 'api.md'), 'routes');
  const resolve = (key) => (key === 'paperclipai/paperclip/paperclip' ? path.join(source, 'paperclip') : null);
  const folder = tmp('org');

  assert.deepEqual(await syncSkills(folder, ['paperclipai/paperclip/paperclip', 'someone/else/skill', 'paperclipai/paperclip/paperclip'], { resolve }), { copied: ['paperclip'], kept: ['paperclip'], skipped: ['someone/else/skill'] });
  assert.equal(fs.readFileSync(path.join(folder, '.claude', 'skills', 'paperclip', 'references', 'api.md'), 'utf8'), 'routes');
  assert.deepEqual((await syncSkills(folder, ['paperclipai/paperclip/paperclip'], { resolve })).copied, [], 'unchanged: left alone');
  fs.writeFileSync(path.join(source, 'paperclip', 'SKILL.md'), '---\nname: paperclip\n---\nv2');
  assert.deepEqual((await syncSkills(folder, ['paperclipai/paperclip/paperclip'], { resolve })).copied, ['paperclip']);

  // In a git repo, a skill folder of the same name that the plugin did not copy is the repo's own: left alone.
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'paperclip'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'paperclip', 'SKILL.md'), 'the repo\'s own');
  assert.deepEqual(await syncSkills(repo, ['paperclipai/paperclip/paperclip'], { resolve }), { copied: [], kept: [], skipped: ['paperclipai/paperclip/paperclip'] });
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'skills', 'paperclip', 'SKILL.md'), 'utf8'), 'the repo\'s own');
  const clone = tmp('clone');
  fs.mkdirSync(path.join(clone, '.git'));
  assert.deepEqual((await syncSkills(clone, ['paperclipai/paperclip/paperclip'], { resolve })).copied, ['paperclip'], 'none there yet: copied');
  fs.writeFileSync(path.join(source, 'paperclip', 'SKILL.md'), '---\nname: paperclip\n---\nv3');
  assert.deepEqual((await syncSkills(clone, ['paperclipai/paperclip/paperclip'], { resolve })).copied, ['paperclip'], 'its own copy is updated');
});

test("Paperclip's bundled skills are found in the installed Paperclip", () => {
  const dir = bundledSkillDir('paperclipai/paperclip/paperclip');
  assert.ok(dir && fs.existsSync(path.join(dir, 'SKILL.md')), String(dir));
  assert.ok(bundledSkillDir('paperclipai/paperclip/first-task'), 'the onboarding skill too');
  assert.equal(bundledSkillDir('../../etc'), null);
});
