import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { absorbPaperclipWake, inboxText, takeInbox } from '../paperclip-wakes.mjs';

const made = [];
after(() => { for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still held: left */ } } });
const tmp = (name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); made.push(dir); return dir; };

/** A stand-in Paperclip with cards and runs; records every call. */
async function fakePaperclip({ cards, runs = {} }) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, runId: req.headers['x-paperclip-run-id'], body: body ? JSON.parse(body) : null });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const id = req.url.split('/').pop();
    if (req.url.startsWith('/api/issues/') && cards[id]) {
      if (req.method === 'PATCH') { cards[id] = { ...cards[id], status: JSON.parse(body).status }; return send(200, cards[id]); }
      return send(200, cards[id]);
    }
    if (req.url.startsWith('/api/heartbeat-runs/') && runs[id]) return send(200, { id, status: runs[id] });
    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, cards, api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const ctxFor = (runId, context) => ({ runId, authToken: 'run-jwt', agent: { id: 'agent-1', name: 'Cashier' }, context, onLog: async () => {} });

test("a wake Paperclip starts by itself parks the card in backlog and waits in the agent's Desktop inbox; Claude is never started", async () => {
  const paperclip = await fakePaperclip({
    cards: {
      'card-1': { id: 'card-1', identifier: 'LEM-1', title: 'Restock lemons', status: 'todo', checkoutRunId: null },
      'card-2': { id: 'card-2', identifier: 'LEM-2', title: 'Count the till', status: 'in_progress', checkoutRunId: 'run-live' },
      'card-3': { id: 'card-3', identifier: 'LEM-3', title: 'Paint the sign', status: 'backlog', checkoutRunId: null },
    },
    runs: { 'run-live': 'running' },
  });
  try {
    const instance = tmp('instance');
    const absorb = (runId, context) => absorbPaperclipWake(ctxFor(runId, context), { instance, api: paperclip.api });

    const assigned = await absorb('run-1', {
      wakeReason: 'issue_assigned', issueId: 'card-1',
      paperclipWake: { issue: { id: 'card-1', identifier: 'LEM-1' }, comments: [{ id: 'c1', author: { name: 'Benny' }, body: 'Before noon please' }] },
    });
    assert.equal(assigned.exitCode, 0);
    assert.equal(assigned.billingType, 'subscription');
    assert.equal(assigned.costUsd, 0);
    assert.deepEqual(assigned.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    const patch = paperclip.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.url, '/api/issues/card-1');
    assert.equal(patch.body.status, 'backlog');
    assert.match(patch.body.comment, /next turn in Claude Desktop/);
    assert.equal(patch.auth, 'Bearer run-jwt', "with the run's own token");
    assert.equal(patch.runId, 'run-1');
    assert.equal(paperclip.cards['card-1'].status, 'backlog');

    await absorb('run-2', { wakeReason: 'issue_commented', issueId: 'card-2' });
    await absorb('run-3', { wakeReason: 'issue_commented', issueId: 'card-3' });
    await absorb('run-4', { wakeReason: 'heartbeat_timer' });
    assert.equal(paperclip.calls.filter((c) => c.method === 'PATCH').length, 1, 'a card a Desktop turn is working, or already in backlog, is left alone');
    assert.equal(paperclip.cards['card-2'].status, 'in_progress');

    const items = takeInbox(instance, 'agent-1');
    assert.deepEqual(items.map((i) => [i.reason, i.card?.identifier ?? null, i.parked]), [
      ['issue_assigned', 'LEM-1', true], ['issue_commented', 'LEM-2', false], ['issue_commented', 'LEM-3', false], ['heartbeat_timer', null, false],
    ]);
    assert.deepEqual(items[0].comments, [{ id: 'c1', author: 'Benny', body: 'Before noon please' }]);
    assert.deepEqual(takeInbox(instance, 'agent-1'), [], 'taken once');

    assert.equal(inboxText(items), [
      'Since your last turn, in Paperclip:',
      '- LEM-1 "Restock lemons" was given to you (moved to backlog until you take it up).\n  Benny: Before noon please',
      '- LEM-2 "Count the till" has a new comment.',
      '- LEM-3 "Paint the sign" has a new comment.',
      '- Paperclip woke you (heartbeat_timer).',
    ].join('\n'));
    assert.equal(inboxText([]), '');
  } finally {
    paperclip.close();
  }
});
