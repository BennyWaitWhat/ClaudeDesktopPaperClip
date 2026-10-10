// Offline checks for native turns (native-turn.mjs, and execute() with Paperclip's adapter swapped out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExecute, findPaperclipPackage } from '../index.mjs';
import {
  agentDefinition, agentSlug, claudeRunCwd, conversationFor, hasConversation, HOOK_SCRIPT, humanMessage, isAgentOnlyTemplate,
  NATIVE_MESSAGE_TEMPLATE, nativeContext, placeAgent, prepareNativeTurn, projectDir, PROMPT_FIELDS, turnContext, writeTurnHook,
} from '../native-turn.mjs';

const utils = await import(pathToFileURL(path.join(findPaperclipPackage('adapter-utils'), 'dist', 'server-utils.js')).href);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `turn-${name}-`));
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

// A card with one comment from Benny and one from another agent, as Paperclip's server sends it.
const wake = (over = {}) => ({
  reason: 'issue_commented',
  issue: { id: 'i1', identifier: 'CLO-1', title: 'Set up the org', description: 'Make the folders.', status: 'todo' },
  comments: [
    { id: 'c1', body: 'Put them on the Desktop.', author: { type: 'user', id: 'u1' } },
    { id: 'c2', body: 'Agent note.', author: { type: 'agent', id: 'a2' } },
  ],
  ...over,
});

test('the message is what people wrote, word for word', () => {
  assert.equal(humanMessage(wake()), 'Put them on the Desktop.');
  assert.equal(humanMessage(utils.normalizePaperclipWakePayload(wake())), 'Put them on the Desktop.', 'normalized comments too');
  assert.equal(humanMessage(wake(), { newConversation: true }), 'Set up the org\n\nMake the folders.\n\nPut them on the Desktop.', 'a new conversation opens with the card');
  assert.equal(humanMessage(wake({ comments: [{ body: 'gone', author: { type: 'user' }, deletedAt: '2026-10-09' }, { body: 'hidden', authorType: 'user', sourceTrust: { disposition: 'quarantined' } }] })), '(Paperclip: a new comment.)');
  assert.equal(humanMessage({ reason: 'issue_children_completed' }), '(Paperclip: its sub-cards finished.)');
  assert.equal(humanMessage({ reason: 'some_new_reason' }), '(Paperclip: some new reason.)');
  assert.equal(humanMessage(null), '(Paperclip: a wake with no new message.)');
  const answered = { reason: 'x', questionResponse: { summaryMarkdown: 'Q: Folder?\nA: Desktop' }, checkboxSelection: { prompt: 'Which', selectedOptions: [{ label: 'A' }, { label: 'B' }] } };
  assert.equal(humanMessage(answered), 'Q: Folder?\nA: Desktop\n\nWhich: A, B');
});

test("an agent's rules live in its definition only when its template names nothing but the agent", () => {
  assert.equal(isAgentOnlyTemplate(utils.DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE), true);
  assert.equal(isAgentOnlyTemplate('Run {{run.id}} for {{agent.name}}'), false);
  assert.equal(isAgentOnlyTemplate('No variables'), true);
  const def = agentDefinition({ agent: { name: 'Chief of Staff', role: 'ceo' }, instructions: '# AGENTS\nBe brief.', contract: 'Rules.' });
  assert.equal(def.description, 'Paperclip agent: Chief of Staff, ceo.');
  assert.ok(def.prompt.startsWith('# AGENTS\nBe brief.\n\nRules.\n\n## Working through Paperclip'), def.prompt.slice(0, 80));
  assert.equal(agentSlug('Chief of Staff'), 'chief-of-staff');
  assert.equal(agentSlug('***'), 'agent');
});

test('in a plain folder the agent is a .claude/agents file; yours are never overwritten; a renamed agent leaves no old file', async () => {
  const org = tmp('org');
  const run = tmp('run');
  const def = agentDefinition({ agent: { name: 'Chief of Staff' }, instructions: 'Hi.' });
  const placed = await placeAgent({ cwd: org, agentId: 'aaaa1111', definition: def, runtimeDir: run });
  assert.deepEqual(placed.args, ['--agent', 'chief-of-staff']);
  const text = fs.readFileSync(placed.file, 'utf8');
  assert.match(text, /^---\nname: chief-of-staff\ndescription: "Paperclip agent: Chief of Staff\."\npaperclip-agent-id: aaaa1111\n---\n\nHi\./);
  const stamp = fs.statSync(placed.file).mtimeMs;
  await placeAgent({ cwd: org, agentId: 'aaaa1111', definition: def, runtimeDir: run });
  assert.equal(fs.statSync(placed.file).mtimeMs, stamp, 'unchanged agent, file left alone');

  fs.writeFileSync(path.join(org, '.claude', 'agents', 'steward.md'), '---\nname: steward\ndescription: mine\n---\nMine.');
  const other = await placeAgent({ cwd: org, agentId: 'bbbb2222', definition: agentDefinition({ agent: { name: 'Steward' } }), runtimeDir: run });
  assert.equal(other.slug, 'steward-bbbb');
  assert.equal(fs.readFileSync(path.join(org, '.claude', 'agents', 'steward.md'), 'utf8'), '---\nname: steward\ndescription: mine\n---\nMine.');

  const renamed = await placeAgent({ cwd: org, agentId: 'aaaa1111', definition: agentDefinition({ agent: { name: 'Chief' } }), runtimeDir: run });
  assert.equal(renamed.slug, 'chief');
  assert.deepEqual(fs.readdirSync(path.join(org, '.claude', 'agents')).sort(), ['chief.md', 'steward-bbbb.md', 'steward.md']);
  fs.rmSync(org, { recursive: true, force: true });
  fs.rmSync(run, { recursive: true, force: true });
});

test('in a git repo the agent goes in the run folder, never in the repo', async () => {
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const run = tmp('run');
  const placed = await placeAgent({ cwd: repo, agentId: 'aaaa1111', definition: agentDefinition({ agent: { name: 'Steward' }, instructions: 'Keep files.' }), runtimeDir: run });
  assert.deepEqual(placed.args, ['--agents', path.join(run, 'agents.json'), '--agent', 'steward']);
  assert.match(JSON.parse(fs.readFileSync(placed.file, 'utf8')).steward.prompt, /^Keep files\./);
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(run, { recursive: true, force: true });
});

test("the run folder follows Paperclip's own rule", () => {
  assert.equal(claudeRunCwd({ paperclipWorkspace: { cwd: 'C:/Org', source: 'agent_home' } }, {}), 'C:/Org');
  assert.equal(claudeRunCwd({ paperclipWorkspace: { cwd: 'C:/Home', source: 'agent_home' } }, { cwd: 'C:/Mine' }), 'C:/Mine', "the agent's cwd beats its home");
  assert.equal(claudeRunCwd({ paperclipWorkspace: { cwd: 'C:/Repo', source: 'project_primary' } }, { cwd: 'C:/Mine' }), 'C:/Repo', 'a project folder beats it');
  assert.equal(claudeRunCwd({}, {}), process.cwd());
});

test("a card's conversation continues whenever Claude Code has it in this folder", () => {
  const config = tmp('claude');
  const org = tmp('org');
  const saved = { sessionParams: { sessionId: SESSION, cwd: org, promptBundleKey: 'old-bundle', mcpServerIdentity: '[{"name":"x"}]', workspaceId: 'w1' }, taskKey: 'i1' };
  assert.deepEqual(conversationFor(saved, org, config), { resume: null, runtime: { ...saved, sessionId: null, sessionParams: null } }, 'no conversation file yet');

  fs.mkdirSync(projectDir(org, config), { recursive: true });
  fs.writeFileSync(path.join(projectDir(org, config), `${SESSION}.jsonl`), '{}\n');
  assert.equal(hasConversation(org, SESSION, config), true);
  const next = conversationFor(saved, org, config);
  assert.equal(next.resume, SESSION);
  assert.deepEqual(next.runtime.sessionParams, { sessionId: SESSION, cwd: org, workspaceId: 'w1' }, 'fingerprints dropped, the rest kept');
  assert.equal(next.runtime.taskKey, 'i1');
  assert.equal(conversationFor({ sessionId: SESSION }, org, config).resume, SESSION, 'an id saved without its folder');
  assert.equal(conversationFor(saved, os.tmpdir(), config).resume, null, 'another folder starts a new one');
  assert.equal(conversationFor({ sessionId: 'not-a-uuid' }, org, config).resume, null);
  assert.equal(projectDir('C:\\Users\\me\\Desktop\\PaperClip\\ORG1 - Georgia Pardon', 'X'), path.join('X', 'projects', 'C--Users-me-Desktop-PaperClip-ORG1---Georgia-Pardon'));
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(org, { recursive: true, force: true });
});

test("Paperclip's adapter is left with the message alone, and the turn's details go to the hook", () => {
  const context = { paperclipWake: wake(), paperclipTaskMarkdown: '# CLO-1\nMake the folders.', paperclipTaskMarkdownCompact: '# CLO-1', paperclipIssue: { id: 'i1' }, issueId: 'i1', paperclipWorkspace: { cwd: 'C:/Org' } };
  context.paperclipWake.issue.workMode = 'standard';
  const out = nativeContext(context, 'Put them on the Desktop.', utils);
  for (const key of PROMPT_FIELDS) assert.equal(key in out, false, key);
  assert.deepEqual(out.paperclipIssue, { id: 'i1', workMode: 'standard' });
  assert.equal(out.issueId, 'i1');
  assert.equal(out.paperclipNativeMessage, 'Put them on the Desktop.');
  assert.ok(context.paperclipWake, 'input left untouched');

  // What Paperclip's Claude adapter builds from that, step by step (execute.js runAttempt), for both kinds of turn.
  for (const resumedSession of [false, true]) {
    const { taskContextNote, wakePrompt } = utils.selectPaperclipPromptSections(out, { resumedSession });
    const rendered = utils.renderTemplate(NATIVE_MESSAGE_TEMPLATE, { context: out });
    assert.equal(utils.joinPromptSections([wakePrompt, String(out.paperclipSessionHandoffMarkdown ?? ''), taskContextNote, rendered]), 'Put them on the Desktop.');
  }
  assert.equal(utils.renderTemplate(NATIVE_MESSAGE_TEMPLATE, { context: { paperclipNativeMessage: 'Use {{agent.id}} $& as is' } }), 'Use {{agent.id}} $& as is', "people's words are never filled in");

  const templateData = { agent: { id: 'a1', name: 'Chief of Staff' }, context };
  const full = turnContext({ utils, context, config: {}, templateData, resumed: false, rulesInAgent: true });
  assert.match(full, /# CLO-1\nMake the folders\./);
  assert.match(full, /Put them on the Desktop\./, "Paperclip's own account of the wake");
  assert.doesNotMatch(full, /Execution contract/, 'rules live in the agent');
  assert.match(turnContext({ utils, context, config: {}, templateData, resumed: false, rulesInAgent: false }), /You are agent a1 \(Chief of Staff\)/);
});

test('the hook hands Claude the full details in a new conversation and the shorter ones after', async () => {
  const dir = tmp('hook');
  const hook = await writeTurnHook(dir, { full: 'FULL details', delta: 'SHORT details' });
  const settings = JSON.parse(fs.readFileSync(hook.settings, 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /turn-context\.mjs" ".*turn-full\.md" ".*turn-delta\.md"$/);
  const ask = (transcript) => JSON.parse(spawnSync(process.execPath, [HOOK_SCRIPT, hook.fullFile, hook.deltaFile], { input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8' }).stdout);
  const fresh = path.join(dir, 'fresh.jsonl');
  fs.writeFileSync(fresh, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
  const going = path.join(dir, 'going.jsonl');
  fs.writeFileSync(going, `${JSON.stringify({ type: 'user' })}\n${JSON.stringify({ type: 'assistant' })}\n`);
  assert.deepEqual(ask(fresh), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'FULL details' } });
  assert.equal(ask(going).hookSpecificOutput.additionalContext, 'SHORT details');
  assert.equal(ask(path.join(dir, 'missing.jsonl')).hookSpecificOutput.additionalContext, 'FULL details', 'no transcript yet');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a whole turn is prepared from what Paperclip hands the adapter', async () => {
  const org = tmp('org');
  const run = tmp('run');
  const files = tmp('agentfiles');
  const claudeConfig = tmp('claude');
  const instructions = path.join(files, 'AGENTS.md');
  fs.writeFileSync(instructions, '# Chief of Staff\nYou are the one contact.');
  const ctx = {
    runId: 'r1', agent: { id: 'aaaa1111', companyId: 'c1', name: 'Chief of Staff' }, runtime: {},
    config: { instructionsFilePath: instructions, model: 'haiku' },
    context: { paperclipWake: wake(), paperclipTaskMarkdown: '# CLO-1', paperclipWorkspace: { cwd: org, source: 'agent_home' } },
  };
  const turn = await prepareNativeTurn(ctx, { utils, runDir: run, claudeConfig });
  assert.equal(turn.resume, null);
  assert.equal(turn.cwd, org);
  assert.equal(turn.message, 'Set up the org\n\nMake the folders.\n\nPut them on the Desktop.');
  assert.deepEqual(turn.overrides, { instructionsFilePath: '', promptTemplate: NATIVE_MESSAGE_TEMPLATE, bootstrapPromptTemplate: '' });
  assert.deepEqual(turn.args, ['--agent', 'chief-of-staff', '--settings', path.join(run, 'turn-settings.json')]);
  const agentFile = fs.readFileSync(path.join(org, '.claude', 'agents', 'chief-of-staff.md'), 'utf8');
  assert.match(agentFile, /# Chief of Staff\nYou are the one contact\.\n\nYou are agent aaaa1111 \(Chief of Staff\)\. Continue your Paperclip work\./);
  assert.match(fs.readFileSync(path.join(run, 'turn-full.md'), 'utf8'), /# CLO-1/);
  assert.equal(turn.warning, null);
  const missing = await prepareNativeTurn({ ...ctx, config: { instructionsFilePath: path.join(org, 'nope.md') } }, { utils, runDir: run, claudeConfig });
  assert.match(missing.warning, /could not read the agent's instructions file/);
  for (const dir of [org, run, files, claudeConfig]) fs.rmSync(dir, { recursive: true, force: true });
});

test('execute: one conversation per card, the message alone, the rest as hook context', async () => {
  const org = tmp('org');
  const claudeConfig = tmp('claude');
  const runBase = tmp('runs');
  const seen = [];
  const opened = [];
  const execute = createExecute({
    runBase, claudeConfig, folderFor: async () => null, live: () => [],
    open: async (id, cwd) => { opened.push([id, cwd]); return { ok: true }; },
    runBuiltin: async (ctx) => {
      const settings = ctx.config.extraArgs[ctx.config.extraArgs.indexOf('--settings') + 1];
      seen.push({ ctx, hookThere: fs.existsSync(settings) });
      return { exitCode: 0, sessionId: SESSION, sessionParams: { sessionId: SESSION, cwd: org, promptBundleKey: `bundle-${seen.length}` } };
    },
  });
  const logs = [];
  const ctx = {
    runId: 'run-1', agent: { id: 'aaaa1111', companyId: 'c1', name: 'Chief of Staff' }, runtime: {},
    config: { model: 'haiku', extraArgs: ['--x'] }, onLog: async (s, line) => logs.push(line),
    context: { paperclipWake: wake(), paperclipTaskMarkdown: '# CLO-1', paperclipWorkspace: { cwd: org, source: 'agent_home' } },
  };
  const first = await execute(ctx);
  const a = seen[0].ctx;
  assert.equal(a.context.paperclipNativeMessage, 'Set up the org\n\nMake the folders.\n\nPut them on the Desktop.');
  assert.equal('paperclipWake' in a.context, false);
  assert.equal(a.config.promptTemplate, NATIVE_MESSAGE_TEMPLATE);
  assert.equal(a.config.instructionsFilePath, '');
  assert.deepEqual(a.config.extraArgs.slice(0, 3), ['--x', '--agent', 'chief-of-staff']);
  assert.deepEqual(a.config.extraArgs.slice(-2), ['--name', 'CLO-1 · Chief of Staff']);
  assert.equal(a.runtime.sessionId, null);
  assert.equal(seen[0].hookThere, true);
  assert.equal(fs.existsSync(path.join(runBase, 'run-1')), false, 'scratch removed after the run');
  assert.deepEqual(opened, [[SESSION, org]], 'a new conversation goes to Claude Desktop');
  assert.ok(logs.some((l) => /Starting a new conversation/.test(l)));

  // Claude Code saved the conversation; Paperclip hands back the session it stored, fingerprints and all.
  fs.mkdirSync(projectDir(org, claudeConfig), { recursive: true });
  fs.writeFileSync(path.join(projectDir(org, claudeConfig), `${SESSION}.jsonl`), '{}\n');
  await execute({ ...ctx, runId: 'run-2', runtime: { sessionId: SESSION, sessionParams: first.sessionParams } });
  const b = seen[1].ctx;
  assert.equal(b.runtime.sessionParams.sessionId, SESSION);
  assert.equal('promptBundleKey' in b.runtime.sessionParams, false);
  assert.equal(b.context.paperclipNativeMessage, 'Put them on the Desktop.', 'only the new words in a conversation that has the card');
  assert.equal(opened.length, 1, 'a continued conversation is not handed over again');
  assert.ok(logs.some((l) => l.includes(`Continuing this card's conversation (${SESSION})`)));
  for (const dir of [org, claudeConfig, runBase]) fs.rmSync(dir, { recursive: true, force: true });
});
