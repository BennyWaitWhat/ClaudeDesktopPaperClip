import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const made = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still held: left */ } } });

const ORG = 'org-1', AGENT = 'agent-1', ROUTINE = 'routine-1';

/** A stand-in Paperclip with one routine; its run starts once per idempotency key, as Paperclip's does. */
async function fakePaperclip({ run = {} } = {}) {
  const calls = [], runs = {};
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url === `/api/routines/${ROUTINE}`) return send(200, { id: ROUTINE, companyId: ORG, title: 'Morning sweep', assigneeAgentId: AGENT, status: 'paused' });
    if (req.url === `/api/routines/${ROUTINE}/run`) {
      const key = JSON.parse(body).idempotencyKey;
      runs[key] ??= { id: `run-${key}`, status: 'issue_created', linkedIssueId: 'card-1', createdAt: new Date().toISOString(), ...run };
      return send(202, runs[key]);
    }
    if (req.url === '/api/issues/card-1') return send(200, { id: 'card-1', identifier: 'CAR-50', createdAt: run.cardCreatedAt ?? new Date().toISOString() });
    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, port: server.address().port, close: () => server.close() };
}

/** A Paperclip instance folder that points at the stand-in, with the org on Claude Desktop (or not). */
function instance(port, { desktop = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-routine-'));
  made.push(home);
  const dir = path.join(home, 'instances', 'default');
  fs.mkdirSync(path.join(dir, 'claude-desktop', 'orgs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime-info.json'), JSON.stringify({ port, host: '127.0.0.1' }));
  fs.writeFileSync(path.join(dir, 'claude-desktop', 'orgs', `${ORG}.json`), JSON.stringify({
    companyId: ORG, desktop, folder: home, conversations: { [AGENT]: { sessionId: 'abc', name: 'Tracker' } },
  }));
  return home;
}

async function load(home) {
  process.env.PAPERCLIP_HOME = home;
  return import(`../scripts/run-routine.mjs?home=${encodeURIComponent(home)}`);
}

test("a routine's run makes today's card and names it to the agent's Desktop conversation, once a day", async () => {
  const pc = await fakePaperclip();
  try {
    const { runRoutine } = await load(instance(pc.port));
    const first = await runRoutine(ROUTINE, { date: '2026-10-16' });
    assert.equal(first.card, 'CAR-50');
    assert.equal(first.conversation, 'local_abc');
    assert.equal(first.agent, 'Tracker');
    assert.equal(first.send, true);
    assert.match(first.message, /^Please take CAR-50: Morning sweep, today's scheduled run/);
    assert.deepEqual(pc.calls.find((c) => c.method === 'POST').body, { source: 'api', idempotencyKey: 'desktop-schedule-2026-10-16' });

    const again = await runRoutine(ROUTINE, { date: '2026-10-16', now: Date.now() + 5 * 60_000 });
    assert.equal(again.card, 'CAR-50');
    assert.equal(again.send, false, 'Desktop catching up the same day sends nothing again');
    assert.equal(again.message, undefined);
  } finally { pc.close(); }
});

test('a card still open from an earlier day is the one named, and the agent is told so', async () => {
  const pc = await fakePaperclip({ run: { status: 'skipped', createdAt: '2026-10-16T12:00:00.000Z', cardCreatedAt: '2026-10-14T12:05:00.000Z' } });
  try {
    const { runRoutine } = await load(instance(pc.port));
    const line = await runRoutine(ROUTINE, { date: '2026-10-16', now: Date.parse('2026-10-16T12:00:00.000Z') });
    assert.equal(line.send, true);
    assert.match(line.message, /^Please take CAR-50: Morning sweep\. It is still open from Wed, 10\/14, so Paperclip made no new card today/);
  } finally { pc.close(); }
});

test('nothing starts for an org not on Claude Desktop, and a failed run is an error', async () => {
  const pc = await fakePaperclip();
  try {
    const { runRoutine } = await load(instance(pc.port, { desktop: false }));
    assert.match((await runRoutine(ROUTINE)).error, /not on Claude Desktop/);
    assert.ok(!pc.calls.some((c) => c.method === 'POST'), 'no run was started');
  } finally { pc.close(); }

  const failing = await fakePaperclip({ run: { status: 'failed', failureReason: 'Agent is not invokable in its current state', linkedIssueId: null } });
  try {
    const { runRoutine } = await load(instance(failing.port));
    assert.match((await runRoutine(ROUTINE)).error, /the run failed: Agent is not invokable/);
  } finally { failing.close(); }
});
