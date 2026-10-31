// The native team (no Paperclip): its setup script, its two hooks, and the hire script's hello. Offline: no model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { helloPrompt } from '../native/hire.mjs';
import { teamFolderOf } from '../native/team.mjs';

const NATIVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native');
const node = (script, args = [], input = '') => execFileSync(process.execPath, [path.join(NATIVE, script), ...args], { input, encoding: 'utf8' });
const BOARD = 'https://claude.ai/artifact/AbC123xyz';

function tempTeam(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-team-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'chief-of-staff.md'), '---\nname: chief-of-staff\n---\n\nYou are the Chief of Staff.\n');
  return dir;
}

test('setup writes the page and hooks, then BOARD.md once the page has its link', (t) => {
  const dir = tempTeam(t);
  const first = JSON.parse(node('setup-org.mjs', ['--folder', dir, '--org', 'Test & Co', '--prefix', 'tst']));
  assert.equal(first.ok, true);
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'board.html'), 'utf8'), /^<title>Test &amp; Co Board<\/title>/);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /native\/hooks\/session-start\.mjs" --chief chief-of-staff$/);
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
  assert.equal(fs.existsSync(path.join(dir, 'BOARD.md')), false);
  assert.deepEqual(first.missing, ['CLAUDE.md', 'FACTS.md']);

  node('setup-org.mjs', ['--folder', dir, '--org', 'Test & Co', '--prefix', 'TST', '--board', BOARD]);
  const method = fs.readFileSync(path.join(dir, 'BOARD.md'), 'utf8');
  assert.ok(method.includes(BOARD) && method.includes('TST-7') && method.includes('native/hire.mjs'));
  assert.doesNotMatch(method, /__[A-Z_]+__/);
  assert.equal(teamFolderOf(path.join(dir, 'drafts', 'letters')), dir); // a conversation that cd'd into a subfolder
});

test('setup refuses a bad link and leaves hooks it did not write alone', (t) => {
  const dir = tempTeam(t);
  assert.throws(() => node('setup-org.mjs', ['--folder', dir, '--org', 'T', '--prefix', 'TST', '--board', 'https://example.com/x']));
  const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node chime.mjs' }] }] } };
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(theirs));
  assert.throws(() => node('setup-org.mjs', ['--folder', dir, '--org', 'T', '--prefix', 'TST']));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')), theirs);
});

test('every tool goes ahead except what only Benny\'s words open', (t) => {
  const dir = tempTeam(t);
  fs.writeFileSync(path.join(dir, 'BOARD.md'), '# board\n');
  const ask = (tool) => JSON.parse(node('hooks/allow.mjs', [], JSON.stringify({ tool_name: tool, cwd: path.join(dir, 'drafts') }))).hookSpecificOutput;
  assert.equal(ask('Bash').permissionDecision, 'allow');
  assert.equal(ask('ArtifactData').permissionDecision, 'allow');
  const held = ask('mcp__d53a8954-d6e2-4a66-9a34-6a88db932b6f__send_message');
  assert.equal(held.permissionDecision, 'deny');
  assert.match(held.permissionDecisionReason, /--benny-said/);
  assert.equal(ask('mcp__claude_ai_Gmail__create_draft').permissionDecision, 'allow');
});

test('a plain chat is the Chief of Staff; a member\'s own conversation and the hello get nothing', (t) => {
  const dir = tempTeam(t);
  fs.writeFileSync(path.join(dir, 'BOARD.md'), '# board\n');
  const start = (input, env = {}) => execFileSync(process.execPath, [path.join(NATIVE, 'hooks', 'session-start.mjs'), '--chief', 'chief-of-staff'],
    { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  const fresh = JSON.parse(start({ source: 'startup', cwd: dir })).hookSpecificOutput.additionalContext;
  assert.match(fresh, /You are the Chief of Staff\.$/);
  assert.doesNotMatch(fresh, /^---/m);
  assert.match(JSON.parse(start({ source: 'resume', cwd: dir })).hookSpecificOutput.additionalContext, /Chief of Staff/);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'agent-setting', agentSetting: 'records-clerk' })}\n`);
  assert.equal(start({ source: 'startup', cwd: dir, transcript_path: transcript }), '');
  assert.equal(start({ source: 'startup', cwd: dir }, { CDPC_NATIVE_HELLO: '1' }), '');
});

test('the hello is setup, never work', () => {
  const text = helloPrompt({ name: 'Records Clerk', org: 'GA Pardon' });
  assert.match(text, /^\(Setup, not work\.\)/);
  assert.match(text, /Records Clerk/);
  assert.match(text, /GA Pardon/);
});
