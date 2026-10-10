import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doneFile, sessionFile, turnFile, turnsDir } from '../desktop-turn.mjs';
import { ensureOrgSettings } from '../org-folder.mjs';

const HOOK = fileURLToPath(new URL('../hooks/desktop-turn.mjs', import.meta.url));
const CARD_TOOL = fileURLToPath(new URL('../hooks/paperclip-card.mjs', import.meta.url));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const line = (e) => `${JSON.stringify(e)}\n`;

/** A stand-in Paperclip: who am I, a key, cards by short name, run status, wakeups. */
async function fakePaperclip() {
  const calls = [];
  const runs = new Map();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const last = req.url.split('/').pop();
    if (req.url === '/api/agents/me') return send(req.headers.authorization === 'Bearer pcp_key' ? 200 : 401, { id: 'agent-1', name: 'Cashier', companyId: 'org-1' });
    if (req.url === '/api/agents/agent-1/keys') return send(201, { id: 'key-1', token: 'pcp_key', createdAt: 'now' });
    if (req.url === '/api/issues/LEM-8') return send(200, { id: 'card-8', identifier: 'LEM-8' });
    if (req.url.startsWith('/api/issues/')) return send(404, { error: 'Issue not found' });
    if (req.url.startsWith('/api/heartbeat-runs/')) return send(200, { id: last, status: runs.get(last) ?? 'succeeded' });
    if (req.url === '/api/agents/agent-1/wakeup') {
      const id = `run-${calls.length}`;
      runs.set(id, 'running');
      return send(202, { id, agentId: 'agent-1', status: 'queued' });
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, runs, api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function run(script, args, { stdin, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, PAPERCLIP_RUN_ID: '', ...env } }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }));
    child.stdin.end(stdin === undefined ? '' : JSON.stringify(stdin));
  });
}

function orgFolder() {
  const org = tmp('org');
  fs.mkdirSync(path.join(org, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(org, '.claude', 'agents', 'cashier.md'), '---\nname: cashier\npaperclip-agent-id: agent-1\n---\nYou run the till.\n');
  const transcript = path.join(org, 'conv.jsonl');
  fs.writeFileSync(transcript, line({ type: 'agent-setting', agentSetting: 'cashier' }));
  return { org, transcript };
}

test("the org folder's hook opens a run for the agent's turn, on the card its message names, and closes it at Stop", async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const hook = (input, env) => run(HOOK, ['--api', paperclip.api, '--instance', instance], { stdin: input, env });
    const input = {
      hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', transcript_path: transcript, cwd: org,
      prompt: '<cross-session-message from-name="Chief of Staff">Please take LEM-8</cross-session-message>',
    };

    const out = JSON.parse((await hook(input)).stdout);
    const wake = paperclip.calls.find((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.equal(wake.auth, 'Bearer pcp_key', 'the agent wakes itself with its own key');
    assert.equal(wake.body.reason, 'desktop_turn');
    assert.deepEqual(wake.body.payload, { issueId: 'card-8' }, 'the run is tied to the card the message names');
    const runId = `run-${paperclip.calls.indexOf(wake) + 1}`;
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`X-Paperclip-Run-Id: ${runId}`));
    assert.match(out.hookSpecificOutput.additionalContext, /on LEM-8/);
    const dir = turnsDir(instance);
    const turn = JSON.parse(fs.readFileSync(turnFile(dir, runId), 'utf8'));
    assert.equal(turn.offset, fs.statSync(transcript).size);
    assert.equal(turn.issueId, 'card-8');

    await hook({ hook_event_name: 'Stop', session_id: 'conv-1', transcript_path: transcript, cwd: org });
    assert.ok(fs.existsSync(doneFile(dir, runId)), 'Stop closes the run');

    // The next turn waits for the previous run to finish (Paperclip would fold the wake into it), then opens its own.
    fs.appendFileSync(transcript, line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Took it.' }] } }));
    setTimeout(() => paperclip.runs.set(runId, 'succeeded'), 400);
    const second = JSON.parse((await hook({ ...input, prompt: 'Anything else?' })).stdout);
    const wakes = paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.equal(wakes.length, 2);
    assert.equal(wakes[1].body.payload, undefined, 'no card named: a plain conversation');
    const polls = paperclip.calls.filter((c) => c.url === `/api/heartbeat-runs/${runId}`).length;
    assert.ok(polls >= 2, `waited for the previous run (${polls} checks)`);
    assert.match(second.hookSpecificOutput.additionalContext, /no card/);

    assert.equal((await hook(input, { PAPERCLIP_RUN_ID: 'a-paperclip-run' })).stdout, '', 'a Paperclip run brings its own run');
    assert.equal((await hook({ ...input, cwd: tmp('not-an-org') })).stdout, '', 'not an org agent: nothing');
  } finally {
    paperclip.close();
  }
});

test('paperclip-card moves the rest of a turn to the card\'s own run', async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { transcript } = orgFolder();
    const dir = turnsDir(instance);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(turnFile(dir, 'run-plain'), JSON.stringify({ runId: 'run-plain', sessionId: 'conv-1', transcript, offset: 0 }));
    fs.writeFileSync(sessionFile(dir, 'conv-1'), JSON.stringify({ runId: 'run-plain' }));
    const env = {
      PAPERCLIP_API_URL: paperclip.api, PAPERCLIP_API_KEY: 'pcp_key', PAPERCLIP_AGENT_ID: 'agent-1', PAPERCLIP_INSTANCE_ROOT: instance,
      CLAUDE_DESKTOP_SESSION_ID: 'conv-1', CLAUDE_DESKTOP_TRANSCRIPT: transcript,
    };

    const moved = await run(CARD_TOOL, ['LEM-8'], { env });
    assert.equal(moved.code, 0, moved.stderr);
    assert.ok(fs.existsSync(doneFile(dir, 'run-plain')), 'the run so far ends here');
    const wake = paperclip.calls.find((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.deepEqual(wake.body.payload, { issueId: 'card-8' });
    const runId = moved.stdout.match(/run (run-\d+)/)[1];
    assert.equal(JSON.parse(fs.readFileSync(sessionFile(dir, 'conv-1'), 'utf8')).runId, runId);
    assert.equal(JSON.parse(fs.readFileSync(turnFile(dir, runId), 'utf8')).issueId, 'card-8');

    const unknown = await run(CARD_TOOL, ['LEM-404'], { env });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no card LEM-404/);
    assert.equal((await run(CARD_TOOL, ['LEM-8'], { env: { ...env, CLAUDE_DESKTOP_SESSION_ID: '' } })).code, 2, 'outside an agent conversation');
  } finally {
    paperclip.close();
  }
});

test('an org folder gets all three hooks, keeps its own, and is left alone when it is a git repo', async () => {
  const folder = tmp('org');
  fs.mkdirSync(path.join(folder, '.claude'));
  fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'haiku' }));
  const options = { node: 'node', apiUrl: 'http://127.0.0.1:3100', instanceRoot: 'C:/instance', chiefId: '11111111-2222-3333-4444-555555555555' };
  assert.equal((await ensureOrgSettings(folder, options)).changed, true);
  const settings = JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'haiku');
  assert.match(settings.hooks.SessionStart.at(-1).hooks[0].command, /desktop-session\.mjs.*--chief 11111111/);
  assert.match(settings.hooks.UserPromptSubmit.at(-1).hooks[0].command, /desktop-turn\.mjs/);
  assert.match(settings.hooks.Stop.at(-1).hooks[0].command, /desktop-turn\.mjs/);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo mine', 'its own Stop hook stays');
  assert.equal((await ensureOrgSettings(folder, { ...options, chiefId: null })).changed, false, 'again: nothing to change, the Chief of Staff kept');

  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  assert.equal((await ensureOrgSettings(repo, options)).reason, 'a git repo');
});
