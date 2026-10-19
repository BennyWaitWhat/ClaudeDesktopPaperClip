import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { agentClosedCard, boardGuard, holdForBoard, openBoardBlockers } from '../board-hold.mjs';

const boardCard = (id, status = 'todo') => ({ id, identifier: `LEM-${id}`, title: `Send: order ${id}`, status, assigneeAgentId: null, assigneeUserId: 'local-board' });
const agentCard = (id, status = 'todo') => ({ id, identifier: `LEM-${id}`, title: `Count ${id}`, status, assigneeAgentId: 'agent-2', assigneeUserId: null });

async function fakePaperclip(cards) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const id = decodeURIComponent(req.url.split('/').pop());
    const card = cards.get(id);
    if (!card) return send(404, { error: 'Issue not found' });
    if (req.method === 'PATCH') { const { comment, blockedByIssueIds, ...fields } = JSON.parse(body); Object.assign(card, fields); return send(200, card); }
    send(200, card);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const closedBy = (actorType, entityId, details = { changes: { status: { from: 'in_progress', to: 'done' } } }) =>
  ({ type: 'activity.logged', payload: { action: 'issue.updated', actorType, entityId, details } });

test("an agent's card closed while the board's card under it is open goes back to blocked, the blockers sent with the comment", async () => {
  const cards = new Map([['c8', { id: 'c8', identifier: 'LEM-8', status: 'done', assigneeAgentId: 'agent-1', blockedBy: [boardCard('c11'), agentCard('c12', 'done')] }]]);
  const paperclip = await fakePaperclip(cards);
  try {
    const result = await holdForBoard(paperclip.api, 'c8');
    assert.deepEqual(result, { held: true, card: 'LEM-8', waiting: ['LEM-c11'] });
    const patch = paperclip.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.status, 'blocked');
    assert.deepEqual(patch.body.blockedByIssueIds, ['c11', 'c12'], 'every blocker sent again, so the comment does not reopen the card to todo');
    assert.match(patch.body.comment, /^Not done yet: the board's card LEM-c11 "Send: order c11" is still open\./);
  } finally {
    paperclip.close();
  }
});

test("a card for the board that an agent closes opens again; the board's own close stands", async () => {
  const cards = new Map([['c11', { ...boardCard('c11', 'done'), identifier: 'LEM-11' }]]);
  const paperclip = await fakePaperclip(cards);
  try {
    const guard = boardGuard();
    assert.equal(await guard(paperclip.api, closedBy('user', 'c11')), null, 'the board closing its own card is left alone');
    assert.equal(paperclip.calls.length, 0);
    assert.deepEqual(await guard(paperclip.api, closedBy('agent', 'c11')), { held: true, card: 'LEM-11', reopened: true });
    const patch = paperclip.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.status, 'todo');
    assert.match(patch.body.comment, /^Open again: an agent marked this done, and only the board marks its own cards done\./);
  } finally {
    paperclip.close();
  }
});

test('a card is left alone when no open card for the board blocks it, or it is not done', async () => {
  const cards = new Map([
    ['a', { id: 'a', identifier: 'LEM-1', status: 'done', assigneeAgentId: 'agent-1', blockedBy: [boardCard('b1', 'done'), agentCard('b2')] }],
    ['b', { id: 'b', identifier: 'LEM-2', status: 'blocked', assigneeAgentId: 'agent-1', blockedBy: [boardCard('b3')] }],
    ['c', { id: 'c', identifier: 'LEM-3', status: 'done', assigneeAgentId: 'agent-1' }],
    ['d', { ...boardCard('d', 'todo') }],
  ]);
  const paperclip = await fakePaperclip(cards);
  try {
    assert.equal((await holdForBoard(paperclip.api, 'a')).held, false, "the board's card is done; the open blocker is an agent's");
    assert.equal((await holdForBoard(paperclip.api, 'b')).held, false, 'still blocked: nothing to do');
    assert.equal((await holdForBoard(paperclip.api, 'c')).held, false, 'no blockers');
    assert.equal((await holdForBoard(paperclip.api, 'd')).held, false, "the board's card is open");
    assert.equal((await holdForBoard(paperclip.api, 'missing')).held, false);
    assert.ok(!paperclip.calls.some((c) => c.method === 'PATCH'));
  } finally {
    paperclip.close();
  }
});

test('the guard explains once an hour per card: a repeat close in that hour is put back without a comment', async () => {
  const cards = new Map([['c8', { id: 'c8', identifier: 'LEM-8', status: 'done', assigneeAgentId: 'agent-1', blockedBy: [boardCard('c11')] }]]);
  const paperclip = await fakePaperclip(cards);
  let clock = 0;
  const guard = boardGuard({ now: () => clock });
  const closeAndGuard = async () => { cards.get('c8').status = 'done'; await guard(paperclip.api, closedBy('agent', 'c8')); return paperclip.calls.filter((c) => c.method === 'PATCH').at(-1).body; };
  try {
    assert.ok((await closeAndGuard()).comment, 'first close: explained');
    clock = 59 * 60_000;
    const repeat = await closeAndGuard();
    assert.equal(repeat.status, 'blocked');
    assert.equal(repeat.comment, undefined, 'a comment would wake the agent again');
    clock = 61 * 60_000;
    assert.ok((await closeAndGuard()).comment, 'an hour on: explained again');
  } finally {
    paperclip.close();
  }
});

test("closes are handled in feed order: the board's card is open again before the agent's own card is checked", async () => {
  const cards = new Map([
    ['c11', { ...boardCard('c11', 'done'), identifier: 'LEM-11' }],
    ['c8', { id: 'c8', identifier: 'LEM-8', status: 'done', assigneeAgentId: 'agent-1', blockedBy: [] }],
  ]);
  const paperclip = await fakePaperclip(cards);
  try {
    // The card read reports its blockers as they are when it is read, as Paperclip does.
    Object.defineProperty(cards.get('c8'), 'blockedBy', { enumerable: true, get: () => [{ ...cards.get('c11') }] });
    const guard = boardGuard();
    const [board, own] = await Promise.all([guard(paperclip.api, closedBy('agent', 'c11')), guard(paperclip.api, closedBy('agent', 'c8'))]);
    assert.equal(board.reopened, true);
    assert.deepEqual(own, { held: true, card: 'LEM-8', waiting: ['LEM-11'] });
  } finally {
    paperclip.close();
  }
});

test('only an agent moving a card to done counts', () => {
  assert.equal(agentClosedCard(closedBy('agent', 'c8')), true);
  assert.equal(agentClosedCard(closedBy('agent', 'c8', { status: 'done', _previous: { status: 'in_review' } })), true, "Paperclip's review path logs the status without changes");
  assert.equal(agentClosedCard(closedBy('user', 'c8')), false, 'the board closes its own way');
  assert.equal(agentClosedCard(closedBy('agent', 'c8', { changes: { status: { from: 'todo', to: 'blocked' } } })), false);
  assert.equal(agentClosedCard({ ...closedBy('agent', 'c8'), payload: { ...closedBy('agent', 'c8').payload, action: 'issue.comment_added' } }), false);
  assert.equal(agentClosedCard({ type: 'heartbeat.run.status', payload: {} }), false);
  assert.deepEqual(openBoardBlockers({ blockedBy: [boardCard('x'), agentCard('y'), boardCard('z', 'cancelled')] }).map((b) => b.id), ['x']);
});
