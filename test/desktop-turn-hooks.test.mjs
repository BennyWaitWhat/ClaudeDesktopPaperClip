import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { doneFile, runIdFile, seenFile, sessionFile, turnFile, turnsDir } from '../desktop-turn.mjs';
import { chiefOf, ensureGitExclude, ensureOrgSettings, hasSessionHook } from '../org-folder.mjs';
import { addToInbox, inboxFile } from '../paperclip-wakes.mjs';

const HOOK = fileURLToPath(new URL('../hooks/desktop-turn.mjs', import.meta.url));
const SESSION_HOOK = fileURLToPath(new URL('../hooks/desktop-session.mjs', import.meta.url));
const CARD_TOOL = fileURLToPath(new URL('../hooks/paperclip-card.mjs', import.meta.url));
const GIT_BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'].find((f) => fs.existsSync(f));
const made = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still held: left */ } } });
const tmp = (name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); made.push(dir); return dir; };
const line = (e) => `${JSON.stringify(e)}\n`;

/**
 * A stand-in Paperclip: who am I, a key, the org, cards by short name, run status, wakeups (runs end at once with
 * `quick`; `folds` lists runs already going that the next wakes are folded into, as Paperclip does).
 */
async function fakePaperclip({ quick = false, folds = [], cards = [], agents = [] } = {}) {
  const calls = [];
  const runs = new Map(folds.map((f) => [f.id, f.status]));
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, runId: req.headers['x-paperclip-run-id'] ?? null, body: body ? JSON.parse(body) : null });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const last = req.url.split('/').pop();
    if (req.url === '/api/agents/me') return send(req.headers.authorization === 'Bearer pcp_key' ? 200 : 401, { id: 'agent-1', name: 'Cashier', companyId: 'org-1', ...agents.find((a) => a.id === 'agent-1') });
    if (req.url === '/api/agents/agent-1/keys') return send(201, { id: 'key-1', token: 'pcp_key', createdAt: 'now' });
    if (req.url === '/api/companies/org-1') return send(200, { id: 'org-1', name: 'Lemonade Stand', issuePrefix: 'LEM' });
    if (req.method === 'GET' && req.url.startsWith('/api/companies/org-1/issues?')) return send(200, cards);
    if (req.method === 'POST' && req.url === '/api/companies/org-1/issues') return send(201, { id: 'card-10', identifier: 'LEM-10', ...JSON.parse(body) });
    if (req.method === 'POST' && req.url === '/api/issues/card-10/checkout') return send(200, { id: 'card-10', status: 'in_progress' });
    if (req.url === '/api/issues/LEM-8') return send(200, { id: 'card-8', identifier: 'LEM-8' });
    // CAR-631: LEM-9 waits on an open blocker (Paperclip skips its wakes); LEM-13's blocker is done; LEM-15's wakes are
    // refused for another reason
    if (req.url === '/api/issues/LEM-9') return send(200, { id: 'card-9', identifier: 'LEM-9', status: 'blocked', blockedBy: [{ id: 'card-12', identifier: 'LEM-12', title: 'Send: the receipt', status: 'todo' }] });
    if (req.url === '/api/issues/LEM-13') return send(200, { id: 'card-13', identifier: 'LEM-13', status: 'blocked', blockedBy: [{ id: 'card-14', identifier: 'LEM-14', title: 'Answer: lemons or limes', status: 'done' }] });
    if (req.url === '/api/issues/LEM-15') return send(200, { id: 'card-15', identifier: 'LEM-15', status: 'todo', blockedBy: [] });
    if (req.method === 'GET' && req.url === '/api/issues/card-8') return send(200, { id: 'card-8', identifier: 'LEM-8', status: 'done', responsibleUserId: 'local-board' });
    if (req.method === 'POST' && req.url === '/api/issues/card-8/children') return send(201, { id: 'card-11', identifier: 'LEM-11', parentId: 'card-8', ...JSON.parse(body) });
    if (req.method === 'PATCH' && req.url === '/api/issues/card-8') return send(200, { id: 'card-8', ...JSON.parse(body) });
    if (req.method === 'GET' && req.url === '/api/issues/LEM-11') return send(200, { id: 'card-11', identifier: 'LEM-11', title: 'Send: the Taco Maco receipt', status: 'todo', assigneeUserId: 'local-board', assigneeAgentId: null, companyId: 'org-1', parentId: 'card-8' });
    if (req.method === 'PATCH' && req.url === '/api/issues/card-11') return send(200, { id: 'card-11', identifier: 'LEM-11', ...JSON.parse(body) });
    if (req.url.startsWith('/api/issues/')) return send(404, { error: 'Issue not found' });
    if (req.url.startsWith('/api/heartbeat-runs/')) return send(200, { id: last, status: runs.get(last) ?? 'succeeded' });
    if (req.url === '/api/agents/agent-1/wakeup') {
      // as Paperclip's own wake route answers a wake it skips: 202, no run
      const scoped = (body ? JSON.parse(body) : {})?.payload?.issueId;
      if (scoped === 'card-9' || scoped === 'card-15') return send(202, { status: 'skipped' });
      const fold = folds.shift();
      if (fold) return send(202, { id: fold.id, agentId: 'agent-1', status: fold.status });
      const id = `run-${calls.length}`;
      runs.set(id, quick ? 'succeeded' : 'running');
      return send(202, { id, agentId: 'agent-1', status: 'queued' });
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, runs, api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function run(script, args, { stdin, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, PAPERCLIP_RUN_ID: '', PAPERCLIP_API_KEY: '', CLAUDE_DESKTOP_SESSION_ID: '', ...env } }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }));
    child.stdin.end(stdin === undefined ? '' : JSON.stringify(stdin));
  });
}

const CASHIER = (body) => `---\nname: cashier\nmodel: haiku\npaperclip-agent-id: agent-1\n---\n${body}\n`;

function orgFolder() {
  const org = tmp('org');
  fs.mkdirSync(path.join(org, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(org, '.claude', 'agents', 'cashier.md'), CASHIER('You run the till.'));
  const transcript = path.join(org, 'conv.jsonl');
  fs.writeFileSync(transcript, line({ type: 'agent-setting', agentSetting: 'cashier' }));
  return { org, transcript };
}

test("the org folder's hook opens a run for the agent's turn, on the org card its message names, and closes it at Stop", async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const hook = (input, env) => run(HOOK, ['--api', paperclip.api, '--instance', instance], { stdin: input, env });
    const input = {
      hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', transcript_path: transcript, cwd: org,
      prompt: '<cross-session-message from-name="Chief of Staff">Please take LEM-8 (the UTF-8 sign)</cross-session-message>',
    };

    const out = JSON.parse((await hook(input)).stdout);
    const wake = paperclip.calls.find((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.equal(wake.auth, 'Bearer pcp_key', 'the agent wakes itself with its own key');
    assert.equal(wake.body.reason, 'desktop_turn');
    assert.deepEqual(wake.body.payload, { issueId: 'card-8' }, 'the run is tied to the card the message names');
    assert.equal(paperclip.calls.some((c) => c.url === '/api/issues/UTF-8'), false, 'only the org\'s own cards are looked up');
    const runId = `run-${paperclip.calls.indexOf(wake) + 1}`;
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`Paperclip run ${runId} records this turn, on LEM-8`));
    const dir = turnsDir(instance);
    assert.equal(fs.readFileSync(runIdFile(dir, 'conv-1'), 'utf8'), runId, 'the shell\'s $PAPERCLIP_RUN_ID reads this');
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

test('a turn opens with what happened in Paperclip since the last one, and with edited instructions once', async () => {
  const paperclip = await fakePaperclip({ quick: true });
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const hook = (prompt) => run(HOOK, ['--api', paperclip.api, '--instance', instance], {
      stdin: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-2', transcript_path: transcript, cwd: org, prompt },
    }).then((r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext);

    const first = await hook('Morning!');
    assert.doesNotMatch(first, /instructions were edited/, 'the first turn starts the record');
    assert.ok(fs.existsSync(seenFile(turnsDir(instance), 'conv-2')));

    addToInbox(instance, 'agent-1', {
      reason: 'issue_assigned', card: { id: 'card-9', identifier: 'LEM-9', title: 'Restock lemons' }, parked: true,
      comments: [{ author: 'Benny', body: 'Before noon,\nplease.' }],
    });
    fs.writeFileSync(path.join(org, '.claude', 'agents', 'cashier.md'), CASHIER('You run the till. Cash only.'));
    const second = await hook('Hi again');
    assert.match(second, /^Since your last turn, in Paperclip:\n- LEM-9 "Restock lemons" was given to you \(moved to backlog until you take it up\)\.\n {2}Benny: Before noon, please\./);
    assert.match(second, /instructions were edited in Paperclip[\s\S]*You run the till\. Cash only\./);
    assert.ok(!fs.existsSync(inboxFile(instance, 'agent-1')), 'the inbox is emptied');

    const third = await hook('And again');
    assert.doesNotMatch(third, /Since your last turn|instructions were edited/, 'each is handed over once');

    fs.writeFileSync(path.join(org, '.claude', 'agents', 'cashier.md'), CASHIER('You run the till. Cash only.').replace('model: haiku', 'model: opus'));
    assert.doesNotMatch(await hook('Model change'), /instructions were edited/, 'a model change is not an instruction change');
  } finally {
    paperclip.close();
  }
});

test('when Paperclip is not answering, the turn goes on and is told so', async () => {
  const instance = tmp('instance');
  const { org, transcript } = orgFolder();
  addToInbox(instance, 'agent-1', { reason: 'issue_commented', card: { id: 'card-9', identifier: 'LEM-9' }, comments: [] });
  const out = await run(HOOK, ['--api', 'http://127.0.0.1:9', '--instance', instance], {
    stdin: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-3', transcript_path: transcript, cwd: org, prompt: 'Hello' },
  });
  const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /LEM-9 has a new comment/);
  assert.match(context, /Paperclip opened no run for this turn \(Paperclip is not answering\)/);
});

test("the session hook gives the conversation its access, with the current turn's run id read before every command", async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const envFile = path.join(tmp('env'), 'env.sh');
    const start = (source) => run(SESSION_HOOK, ['--api', paperclip.api, '--instance', instance], {
      stdin: { hook_event_name: 'SessionStart', source, session_id: 'conv-4', transcript_path: transcript, cwd: org },
      env: { CLAUDE_ENV_FILE: envFile },
    });

    const out = JSON.parse((await start('startup')).stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /runs as Cashier[\s\S]*\$PAPERCLIP_RUN_ID/);
    const env = fs.readFileSync(envFile, 'utf8');
    assert.match(env, /^export PAPERCLIP_API_KEY='pcp_key'$/m);
    assert.match(env, /^export CLAUDE_DESKTOP_SESSION_ID='conv-4'$/m);
    assert.match(env, /^export PAPERCLIP_RUN_ID="\$\(cat '.*session-conv-4\.run' 2>\/dev\/null\)"$/m);
    const dir = turnsDir(instance);
    assert.ok(fs.existsSync(seenFile(dir, 'conv-4')), 'an agent conversation has its agent file as it is now');

    fs.rmSync(seenFile(dir, 'conv-4'));
    await start('compact');
    assert.ok(!fs.existsSync(seenFile(dir, 'conv-4')), 'a compacted conversation keeps the agent file it started with');

    if (GIT_BASH) {
      const echo = () => new Promise((resolve) => execFile(GIT_BASH, ['-c', `source '${envFile.replace(/\\/g, '/')}'; printf %s "$PAPERCLIP_RUN_ID"`], (_e, stdout) => resolve(stdout)));
      assert.equal(await echo(), '', 'no turn yet');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(runIdFile(dir, 'conv-4'), 'run-77');
      assert.equal(await echo(), 'run-77');
      fs.writeFileSync(runIdFile(dir, 'conv-4'), 'run-78');
      assert.equal(await echo(), 'run-78', 'the next turn\'s run, without restarting anything');
    }
  } finally {
    paperclip.close();
  }
});

test("a turn folded into one of Paperclip's own runs already going waits for it, then gets its own", async () => {
  const paperclip = await fakePaperclip({ folds: [{ id: 'paperclips-own', status: 'running' }] });
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    setTimeout(() => paperclip.runs.set('paperclips-own', 'succeeded'), 400);
    const out = await run(HOOK, ['--api', paperclip.api, '--instance', instance], {
      stdin: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-5', transcript_path: transcript, cwd: org, prompt: 'Take LEM-8' },
    });
    const wakes = paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.equal(wakes.length, 2, 'asked again once that run was over');
    assert.match(wakes[1].body.idempotencyKey, /:1$/, 'as a new request');
    const runId = fs.readFileSync(runIdFile(turnsDir(instance), 'conv-5'), 'utf8');
    assert.notEqual(runId, 'paperclips-own');
    assert.ok(fs.existsSync(turnFile(turnsDir(instance), runId)), 'the turn is recorded by its own run');
    assert.ok(!fs.existsSync(turnFile(turnsDir(instance), 'paperclips-own')));
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, new RegExp(`Paperclip run ${runId} records this turn`));
  } finally {
    paperclip.close();
  }
});

test("paperclip-card moves the rest of a turn to the card's own run", async () => {
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
    assert.equal(fs.readFileSync(runIdFile(dir, 'conv-1'), 'utf8'), runId);
    assert.equal(JSON.parse(fs.readFileSync(turnFile(dir, runId), 'utf8')).issueId, 'card-8');

    const wakesSoFar = paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup').length;
    const again = await run(CARD_TOOL, ['LEM-8'], { env });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /already on LEM-8/);
    assert.equal(paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup').length, wakesSoFar, 'the card it is on: nothing moves');
    assert.ok(!fs.existsSync(doneFile(dir, runId)), 'and its run goes on');

    const unknown = await run(CARD_TOOL, ['LEM-404'], { env });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no card LEM-404/);
    assert.equal((await run(CARD_TOOL, ['LEM-8'], { env: { ...env, CLAUDE_DESKTOP_SESSION_ID: '' } })).code, 2, 'outside an agent conversation');
  } finally {
    paperclip.close();
  }
});

// Career Catchers, 2026-10-26 (CAR-631): Paperclip starts no run on a card that waits on an open blocker, so a turn
// whose message named one, or that ran paperclip-card on one, was left with no run, and every write was refused.
test('a turn about a card that waits on an open blocker still gets a run, on no card, and is told why', async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'conv-9', transcript_path: transcript, cwd: org, prompt: 'Where does LEM-9 stand?' };
    const out = JSON.parse((await run(HOOK, ['--api', paperclip.api, '--instance', instance], { stdin: input })).stdout).hookSpecificOutput.additionalContext;
    const wakes = paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.equal(wakes.length, 1, 'one wake');
    assert.equal(wakes[0].body.payload, undefined, 'not on the waiting card, which Paperclip would skip');
    const runId = fs.readFileSync(runIdFile(turnsDir(instance), 'conv-9'), 'utf8');
    assert.match(runId, /^run-\d+$/, 'the turn has a run');
    assert.match(out, /LEM-9 waits on LEM-12 "Send: the receipt" \(todo\), so Paperclip starts no run on LEM-9 until that is done/);
    assert.match(out, /then comment on LEM-9 from there: it counts as one of the 20 other cards/);
    assert.match(out, /Do not run node ".*paperclip-card\.mjs" LEM-9 while it waits/);
    assert.match(out, new RegExp(`Paperclip run ${runId} records this turn \\(on no card yet\\)`));
    assert.doesNotMatch(out, /is the agent paused/);
  } finally {
    paperclip.close();
  }
});

test('a turn whose card Paperclip refuses for another reason still gets a run, on no card', async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'conv-15', transcript_path: transcript, cwd: org, prompt: 'Please take LEM-15' };
    const out = JSON.parse((await run(HOOK, ['--api', paperclip.api, '--instance', instance], { stdin: input })).stdout).hookSpecificOutput.additionalContext;
    const wakes = paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.deepEqual(wakes.map((w) => w.body.payload ?? null), [{ issueId: 'card-15' }, null], 'the card first, then a run on no card');
    const runId = fs.readFileSync(runIdFile(turnsDir(instance), 'conv-15'), 'utf8');
    assert.match(out, /Paperclip refused a run on LEM-15, so this turn runs on no card instead/);
    assert.match(out, new RegExp(`Paperclip run ${runId} records this turn \\(on no card yet\\)`));
  } finally {
    paperclip.close();
  }
});

test('paperclip-card never moves a turn to a card that waits on an open blocker, and a refused run still leaves the turn a run', async () => {
  const paperclip = await fakePaperclip({ quick: true });
  try {
    const instance = tmp('instance');
    const { transcript } = orgFolder();
    const dir = turnsDir(instance);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(turnFile(dir, 'run-on-8'), JSON.stringify({ runId: 'run-on-8', sessionId: 'conv-1', transcript, offset: 0, issueId: 'card-8' }));
    fs.writeFileSync(sessionFile(dir, 'conv-1'), JSON.stringify({ runId: 'run-on-8' }));
    const env = {
      PAPERCLIP_API_URL: paperclip.api, PAPERCLIP_API_KEY: 'pcp_key', PAPERCLIP_AGENT_ID: 'agent-1', PAPERCLIP_INSTANCE_ROOT: instance,
      CLAUDE_DESKTOP_SESSION_ID: 'conv-1', CLAUDE_DESKTOP_TRANSCRIPT: transcript,
    };
    const wakes = () => paperclip.calls.filter((c) => c.url === '/api/agents/agent-1/wakeup');

    const stay = await run(CARD_TOOL, ['LEM-9'], { env });
    assert.equal(stay.code, 1);
    assert.match(stay.stderr, /LEM-9 waits on LEM-12 "Send: the receipt" \(todo\), so Paperclip starts no run on LEM-9 until that is done/);
    assert.match(stay.stderr, /This turn stays where it is \(run run-on-8\)\. Comment on LEM-9 from here/);
    assert.equal(wakes().length, 0, 'no wake: Paperclip would skip it');
    assert.ok(!fs.existsSync(doneFile(dir, 'run-on-8')), 'and the run the turn is on goes on');
    assert.equal(JSON.parse(fs.readFileSync(sessionFile(dir, 'conv-1'), 'utf8')).runId, 'run-on-8');

    // a turn on no card is told to move to a card that can run first
    fs.writeFileSync(turnFile(dir, 'run-plain'), JSON.stringify({ runId: 'run-plain', sessionId: 'conv-1', transcript, offset: 0, issueId: null }));
    fs.writeFileSync(sessionFile(dir, 'conv-1'), JSON.stringify({ runId: 'run-plain' }));
    const plainStay = await run(CARD_TOOL, ['LEM-9'], { env });
    assert.equal(plainStay.code, 1);
    assert.match(plainStay.stderr, /This turn is on no card, and a run on no card can write to none: first move to one of your open cards that is not blocked/);
    assert.equal(wakes().length, 0);

    // a blocker that is done holds nothing: the turn moves as usual
    const moved = await run(CARD_TOOL, ['LEM-13'], { env });
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(wakes()[0].body.payload, { issueId: 'card-13' });
    assert.ok(fs.existsSync(doneFile(dir, 'run-plain')), 'the run so far ends there');

    // a run Paperclip refuses for another reason: the run so far has ended, and the turn gets a run on no card
    const onThirteen = fs.readFileSync(runIdFile(dir, 'conv-1'), 'utf8');
    const refused = await run(CARD_TOOL, ['LEM-15'], { env });
    assert.equal(refused.code, 1);
    const plainId = fs.readFileSync(runIdFile(dir, 'conv-1'), 'utf8');
    assert.notEqual(plainId, onThirteen);
    assert.match(refused.stderr, new RegExp(`Paperclip did not start a run on LEM-15[^]*This turn's run ${plainId} is on no card now`));
    assert.deepEqual(wakes().slice(-2).map((w) => w.body.payload ?? null), [{ issueId: 'card-15' }, null], 'the card first, then a run on no card');
  } finally {
    paperclip.close();
  }
});

test('work goes on cards: a turn on no card is told so with its open cards, and stopped once before it ends', async () => {
  const cards = [
    { id: 'card-8', identifier: 'LEM-8', title: 'Restock lemons', status: 'blocked', assigneeAgentId: 'agent-1', updatedAt: '2026-10-12T10:00:00Z' },
    { id: 'card-7', identifier: 'LEM-7', title: 'Paint the sign', status: 'done', assigneeAgentId: 'agent-1', updatedAt: '2026-10-12T11:00:00Z' },
    { id: 'card-6', identifier: 'LEM-6', title: 'Count the till', status: 'in_review', assigneeAgentId: 'someone-else', updatedAt: '2026-10-12T12:00:00Z' },
  ];
  const paperclip = await fakePaperclip({ quick: true, cards });
  try {
    const instance = tmp('instance');
    const { org, transcript } = orgFolder();
    const hook = (input, env) => run(HOOK, ['--api', paperclip.api, '--instance', instance], { stdin: { session_id: 'conv-5', transcript_path: transcript, cwd: org, ...input }, env });

    const opened = JSON.parse((await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'I spent $20.40 at Taco Maco' })).stdout).hookSpecificOutput.additionalContext;
    assert.match(opened, /on no card yet/);
    assert.match(opened, /Work goes on cards/);
    assert.match(opened, /paperclip-card\.mjs" --new "<short title>" --body "<what was asked>"/);
    assert.match(opened, /Your open cards: LEM-8 "Restock lemons" \(blocked\)\./, 'its own open cards only');

    const stop = { hook_event_name: 'Stop' };
    const dir = turnsDir(instance);
    const runId = fs.readFileSync(runIdFile(dir, 'conv-5'), 'utf8');
    const first = JSON.parse((await hook(stop)).stdout);
    assert.equal(first.decision, 'block', 'a turn ending on no card is stopped');
    assert.match(first.reason, /on no Paperclip card/);
    assert.match(first.reason, /without a card and without saying more/, 'chat can end as it is');
    assert.ok(!fs.existsSync(doneFile(dir, runId)), 'and its run goes on');
    assert.equal((await hook({ ...stop, stop_hook_active: true })).stdout, '', 'only once per turn');
    assert.ok(fs.existsSync(doneFile(dir, runId)), 'then the turn ends');

    // A turn a background notice started is not pressed for a card: it ends at once.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>2 subscriptions paused</task-notification>' });
    fs.appendFileSync(transcript, line({ type: 'user', turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification>2 subscriptions paused</task-notification>' } }));
    const noticeRun = fs.readFileSync(runIdFile(dir, 'conv-5'), 'utf8');
    assert.equal((await hook(stop)).stdout, '', 'a notice turn ends without a card');
    assert.ok(fs.existsSync(doneFile(dir, noticeRun)), 'and its run ends');
    fs.appendFileSync(transcript, line({ type: 'user', turnOrigin: 'human', message: { role: 'user', content: 'Log my lunch' } }));

    // The hello that makes the conversation is never stopped.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Reply with one short line of hello' }, { CLAUDE_DESKTOP_PAPERCLIP_HELLO: '1' });
    assert.equal((await hook(stop, { CLAUDE_DESKTOP_PAPERCLIP_HELLO: '1' })).stdout, '');

    // A turn on a card ends at once.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'LEM-8: the lemons came' });
    assert.equal((await hook(stop)).stdout, '');
  } finally {
    paperclip.close();
  }
});

test("paperclip-card --board gives the board a card in their inbox, under the turn's card, which it keeps blocked", async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { transcript } = orgFolder();
    const dir = turnsDir(instance);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(turnFile(dir, 'run-8'), JSON.stringify({ runId: 'run-8', sessionId: 'conv-1', transcript, offset: 0, issueId: 'card-8' }));
    fs.writeFileSync(sessionFile(dir, 'conv-1'), JSON.stringify({ runId: 'run-8' }));
    const env = { PAPERCLIP_API_URL: paperclip.api, PAPERCLIP_API_KEY: 'pcp_key', PAPERCLIP_AGENT_ID: 'agent-1', PAPERCLIP_INSTANCE_ROOT: instance, CLAUDE_DESKTOP_SESSION_ID: 'conv-1' };

    const made = await run(CARD_TOOL, ['--board', 'Send: the Taco Maco receipt', '--body', 'The draft is in Gmail: send it, then mark this card done.'], { env });
    assert.equal(made.code, 0, made.stderr);
    const child = paperclip.calls.find((c) => c.method === 'POST' && c.url === '/api/issues/card-8/children');
    assert.deepEqual(child.body, { title: 'Send: the Taco Maco receipt', description: 'The draft is in Gmail: send it, then mark this card done.', status: 'todo', assigneeUserId: 'local-board', blockParentUntilDone: true }, "assigned to the board user responsible for the turn's card");
    assert.equal(child.runId, 'run-8', "made by the turn's run");
    const reopened = paperclip.calls.find((c) => c.method === 'PATCH' && c.url === '/api/issues/card-8');
    assert.deepEqual(reopened.body, { status: 'blocked' }, "a card closed before the board's step is open again, blocked");
    assert.match(made.stdout, /Made LEM-11 "Send: the Taco Maco receipt" for the board: it is in their Paperclip inbox, under LEM-8, which waits blocked on it\./);
    assert.ok(!paperclip.calls.some((c) => c.url.endsWith('/wakeup')), 'the turn stays where it is');

    const under = await run(CARD_TOOL, ['--board', 'Answer: business or personal?', '--under', 'LEM-8'], { env });
    assert.equal(under.code, 0, under.stderr);

    fs.writeFileSync(turnFile(dir, 'run-8'), JSON.stringify({ runId: 'run-8', sessionId: 'conv-1', transcript, offset: 0 }));
    const nowhere = await run(CARD_TOOL, ['--board', 'Decide: keep or close'], { env });
    assert.equal(nowhere.code, 1);
    assert.match(nowhere.stderr, /on no card: name the card the step belongs to with --under <CARD>/);
    assert.equal((await run(CARD_TOOL, ['--board'], { env })).code, 2, 'a card needs a title');
  } finally {
    paperclip.close();
  }
});

test("paperclip-card --checked: an agent that checks the board's steps closes the board's card with what it saw; others are sent to the checkers", async () => {
  const cashier = { id: 'agent-1', name: 'Cashier', adapterConfig: { checksBoardSteps: true } };
  const instance = tmp('instance');
  const dir = turnsDir(instance);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(turnFile(dir, 'run-8'), JSON.stringify({ runId: 'run-8', sessionId: 'conv-1', offset: 0, issueId: 'card-8' }));
  fs.writeFileSync(sessionFile(dir, 'conv-1'), JSON.stringify({ runId: 'run-8' }));
  const checker = await fakePaperclip({ agents: [cashier] });
  try {
    const env = { PAPERCLIP_API_URL: checker.api, PAPERCLIP_API_KEY: 'pcp_key', PAPERCLIP_AGENT_ID: 'agent-1', PAPERCLIP_INSTANCE_ROOT: instance, CLAUDE_DESKTOP_SESSION_ID: 'conv-1' };
    const closed = await run(CARD_TOOL, ['--checked', 'LEM-11', 'The receipt email is in Sent, 10/19 3:52 PM'], { env });
    assert.equal(closed.code, 0, closed.stderr);
    const patch = checker.calls.find((c) => c.method === 'PATCH' && c.url === '/api/issues/card-11');
    assert.deepEqual(patch.body, { status: 'done', comment: 'Checked: The receipt email is in Sent, 10/19 3:52 PM' });
    assert.equal(patch.runId, 'run-8', "closed by the turn's run");
    assert.match(closed.stdout, /^Closed LEM-11 "Send: the Taco Maco receipt" with your note \(Checked: The receipt email is in Sent, 10\/19 3:52 PM\)\./);

    const own = await run(CARD_TOOL, ['--checked', 'LEM-8', 'Counted'], { env });
    assert.equal(own.code, 1);
    assert.match(own.stderr, /LEM-8 is not a card for the board: close your own cards the usual way\./);
    assert.equal((await run(CARD_TOOL, ['--checked', 'LEM-11'], { env })).code, 2, 'a check says what was seen');
  } finally {
    checker.close();
  }
  const other = await fakePaperclip({ agents: [{ ...cashier, adapterConfig: {} }] });
  try {
    const env = { PAPERCLIP_API_URL: other.api, PAPERCLIP_API_KEY: 'pcp_key', PAPERCLIP_AGENT_ID: 'agent-1', PAPERCLIP_INSTANCE_ROOT: instance, CLAUDE_DESKTOP_SESSION_ID: 'conv-1' };
    const refused = await run(CARD_TOOL, ['--checked', 'LEM-11', 'Sent'], { env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^You don't check the board's steps: your notes \(Working from Claude Desktop\) name who does\. Tell one of them what you saw, and they check and close LEM-11\./);
    assert.ok(!other.calls.some((c) => c.method === 'PATCH'), 'nothing closed');
  } finally {
    other.close();
  }
});

test('paperclip-card --new makes the card, assigned to the agent, and the rest of the turn records on it, checked out', async () => {
  const paperclip = await fakePaperclip();
  try {
    const instance = tmp('instance');
    const { transcript } = orgFolder();
    const dir = turnsDir(instance);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(turnFile(dir, 'run-plain'), JSON.stringify({ runId: 'run-plain', sessionId: 'conv-1', transcript, offset: 0 }));
    fs.writeFileSync(sessionFile(dir, 'conv-1'), JSON.stringify({ runId: 'run-plain' }));
    const env = {
      PAPERCLIP_API_URL: paperclip.api, PAPERCLIP_API_KEY: 'pcp_key', PAPERCLIP_AGENT_ID: 'agent-1', PAPERCLIP_COMPANY_ID: 'org-1', PAPERCLIP_INSTANCE_ROOT: instance,
      CLAUDE_DESKTOP_SESSION_ID: 'conv-1', CLAUDE_DESKTOP_TRANSCRIPT: transcript,
    };

    const made = await run(CARD_TOOL, ['--new', 'Record the Taco Maco expense', '--body', '$20.40 at Taco Maco; business or personal?'], { env });
    assert.equal(made.code, 0, made.stderr);
    const create = paperclip.calls.find((c) => c.method === 'POST' && c.url === '/api/companies/org-1/issues');
    assert.deepEqual(create.body, { title: 'Record the Taco Maco expense', description: '$20.40 at Taco Maco; business or personal?', status: 'backlog', assigneeAgentId: 'agent-1' }, 'in backlog, so Paperclip does not wake the agent for it');
    assert.equal(create.runId, 'run-plain', 'made by the turn so far');
    const wake = paperclip.calls.find((c) => c.url === '/api/agents/agent-1/wakeup');
    assert.deepEqual(wake.body.payload, { issueId: 'card-10' }, 'the rest of the turn runs on the new card');
    const runId = made.stdout.match(/run (run-\d+)/)[1];
    const checkout = paperclip.calls.find((c) => c.url === '/api/issues/card-10/checkout');
    assert.equal(checkout.runId, runId, "claimed by the card's own run");
    assert.deepEqual(checkout.body.agentId, 'agent-1');
    assert.ok(fs.existsSync(doneFile(dir, 'run-plain')));
    assert.equal(JSON.parse(fs.readFileSync(turnFile(dir, runId), 'utf8')).issueId, 'card-10');
    assert.match(made.stdout, /Made LEM-10 "Record the Taco Maco expense", assigned to you and in progress/);

    assert.equal((await run(CARD_TOOL, ['--new'], { env })).code, 2, 'a card needs a title');
    assert.equal((await run(CARD_TOOL, ['--new', 'X'], { env: { ...env, PAPERCLIP_COMPANY_ID: '' } })).code, 2, 'outside an agent conversation');
  } finally {
    paperclip.close();
  }
});

test('an org folder gets all three hooks and keeps its own', async () => {
  const folder = tmp('org');
  fs.mkdirSync(path.join(folder, '.claude'));
  fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'haiku', agent: 'mine' }));
  const options = { node: 'node', apiUrl: 'http://127.0.0.1:3100', instanceRoot: 'C:/instance', chiefId: '11111111-2222-3333-4444-555555555555', teamAgents: ['chief-of-staff'] };
  assert.equal((await ensureOrgSettings(folder, options)).changed, true);
  const settings = JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'haiku');
  assert.equal(settings.agent, 'mine', "a default agent that is not one of the org's stays");
  assert.match(settings.hooks.SessionStart.at(-1).hooks[0].command, /desktop-session\.mjs.*--chief 11111111/);
  assert.match(settings.hooks.UserPromptSubmit.at(-1).hooks[0].command, /desktop-turn\.mjs/);
  assert.match(settings.hooks.Stop.at(-1).hooks[0].command, /desktop-turn\.mjs/);
  assert.equal(settings.hooks.PreToolUse.at(-1).matcher, '*');
  assert.match(settings.hooks.PreToolUse.at(-1).hooks[0].command, /paperclip-allow\.mjs/);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo mine', 'its own Stop hook stays');
  assert.equal((await ensureOrgSettings(folder, { ...options, chiefId: null })).changed, false, 'again: nothing to change, the Chief of Staff kept');

});

test("in a git repo (a project's own clone) the hooks go in settings.local.json and the plugin's files stay out of git", async () => {
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.claude'));
  const tracked = JSON.stringify({ permissions: { allow: ['Bash(node *)'] } });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), tracked);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n');
  // An older sync made the Chief of Staff the folder's default agent.
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ agent: 'chief-of-staff' }));
  const options = { node: 'node', apiUrl: 'http://127.0.0.1:3100', instanceRoot: 'C:/instance', chiefId: '11111111-2222-3333-4444-555555555555', teamAgents: ['chief-of-staff', 'scout'] };

  const result = await ensureOrgSettings(repo, options);
  assert.equal(result.file, path.join(repo, '.claude', 'settings.local.json'));
  assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'), tracked, "the repo's own settings are untouched");
  const local = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(local.agent, undefined, "no folder default agent: it would give every resumed conversation the Chief's tools");
  assert.match(local.hooks.SessionStart[0].hooks[0].command, /desktop-session\.mjs.*--chief 11111111/);
  assert.equal(await chiefOf(repo), '11111111-2222-3333-4444-555555555555');
  assert.equal(await hasSessionHook(repo), true);
  assert.equal((await ensureOrgSettings(repo, { ...options, chiefId: null })).changed, false, 'again: nothing to change');

  const ours = [path.join('.claude', 'agents', 'scout.md'), '.claude/settings.local.json', path.join('.claude', 'skills', 'paperclip')];
  assert.equal((await ensureGitExclude(repo, ours)).changed, true);
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\*\.log$/m, 'the lines already there stay');
  assert.match(exclude, /^\/\.claude\/agents\/scout\.md$/m);
  assert.match(exclude, /^\/\.claude\/skills\/paperclip$/m);
  assert.equal((await ensureGitExclude(repo, [...ours].reverse())).changed, false, 'same files: left as it is');
  await ensureGitExclude(repo, ['.claude/settings.local.json']);
  const after = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.doesNotMatch(after, /scout\.md/, 'a file no longer kept leaves the list');
  assert.equal(after.match(/ClaudeDesktopPaperClip: files/g).length, 1, 'one block, rewritten in place');
  assert.equal(await ensureGitExclude(tmp('plain'), ours), null, 'outside a repo: nothing to do');
});
