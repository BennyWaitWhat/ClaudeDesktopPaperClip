import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doneFile, quietEnding, readNewLines, recordDesktopTurn, sessionFile, turnFile, turnsDir } from '../desktop-turn.mjs';

const HOOK = fileURLToPath(new URL('../hooks/desktop-turn.mjs', import.meta.url));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (e) => `${JSON.stringify(e)}\n`;
const assistant = (id, text, usage, extra = {}) => ({ type: 'assistant', uuid: `a-${id}`, message: { id, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }, ...extra });

function ctxFor(runId, logs, signal) {
  return { runId, agent: { id: 'agent-1', name: 'Cashier' }, context: { wakeReason: 'desktop_turn' }, onLog: async (_s, chunk) => { logs.push(chunk); }, signal };
}

test('a run records the Desktop turn its turn file names, from where the turn starts to its Stop', async () => {
  const dir = tmp('turns');
  const transcript = path.join(tmp('conv'), 'conv.jsonl');
  fs.writeFileSync(transcript, line({ type: 'user', uuid: 'old', message: { role: 'user', content: 'an earlier turn' } }));
  const offset = fs.statSync(transcript).size;
  const logs = [];
  const running = recordDesktopTurn(ctxFor('run-1', logs), { dir, pollMs: 20, waitForTurnMs: 2000 });

  await sleep(60); // the hook writes the turn file once Paperclip has answered with the run
  fs.writeFileSync(turnFile(dir, 'run-1'), JSON.stringify({ runId: 'run-1', sessionId: 'conv', transcript, offset }));
  fs.appendFileSync(transcript, line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Sell a lemonade' } }));
  fs.appendFileSync(transcript, line({ type: 'attachment', uuid: 'h1', attachment: { type: 'hook_additional_context' } }));
  fs.appendFileSync(transcript, line(assistant('m1', 'Sold one.', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 })));
  fs.appendFileSync(transcript, '{"type":"assistant","uuid":"torn"'); // a line still being written
  await sleep(60);
  fs.appendFileSync(transcript, `,"message":${JSON.stringify(assistant('m2', 'Logged the sale.', { input_tokens: 3, output_tokens: 7 }).message)}}\n`);
  fs.writeFileSync(doneFile(dir, 'run-1'), '{}');

  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.billingType, 'subscription');
  assert.equal(result.costUsd, 0);
  assert.equal(result.model, 'claude-haiku-5-5');
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 12, cachedInputTokens: 100 });
  assert.equal(result.summary, 'Logged the sale.');
  const logged = logs.join('');
  assert.match(logged, /Sell a lemonade/);
  assert.match(logged, /Logged the sale/);
  assert.doesNotMatch(logged, /an earlier turn/, 'only this turn');
  assert.doesNotMatch(logged, /hook_additional_context/, 'bookkeeping stays out');
  assert.ok(!fs.existsSync(turnFile(dir, 'run-1')) && !fs.existsSync(doneFile(dir, 'run-1')), 'its files are cleaned up');
});

test('an interrupted turn (no Stop) ends when the same conversation starts its next turn', async () => {
  const dir = tmp('turns');
  const transcript = path.join(tmp('conv'), 'conv.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(turnFile(dir, 'run-a'), JSON.stringify({ runId: 'run-a', sessionId: 'conv', transcript, offset: 0 }));
  fs.appendFileSync(transcript, line(assistant('m1', 'Half done', { input_tokens: 1, output_tokens: 1 })));
  const running = recordDesktopTurn(ctxFor('run-a', []), { dir, pollMs: 20 });
  await sleep(60);
  fs.writeFileSync(turnFile(dir, 'run-b'), JSON.stringify({ runId: 'run-b', sessionId: 'conv', transcript, offset: fs.statSync(transcript).size }));
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'Half done');
});

test('a turn stopped in Claude Desktop runs no Stop hook: its run ends once the transcript stays quiet after the interrupt', async () => {
  const dir = tmp('turns');
  const transcript = path.join(tmp('conv'), 'conv.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(turnFile(dir, 'run-s'), JSON.stringify({ runId: 'run-s', sessionId: 'conv', transcript, offset: 0 }));
  fs.appendFileSync(transcript, line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Republish the page' } }));
  fs.appendFileSync(transcript, line(assistant('m1', 'Publishing.', { input_tokens: 4, output_tokens: 2 }, { message: { id: 'm1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Publishing.' }], stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 2 } } })));
  fs.appendFileSync(transcript, line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
  let settled = false;
  const running = recordDesktopTurn(ctxFor('run-s', []), { dir, pollMs: 20, stoppedQuietMs: 250 }).then((r) => { settled = true; return r; });
  await sleep(120);
  // Something more arrives (a task notification continues the turn): not quiet yet, and the newest entry is no interrupt.
  fs.appendFileSync(transcript, line({ type: 'user', uuid: 'u3', turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification>subscriptions paused</task-notification>' } }));
  await sleep(300);
  assert.equal(settled, false, 'a turn that goes on keeps its run');
  fs.appendFileSync(transcript, line({ type: 'user', uuid: 'u4', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.match(result.summary, /^Stopped in Claude Desktop\. Publishing\./);
  assert.ok(!fs.existsSync(turnFile(dir, 'run-s')), 'its files are cleaned up');
});

test("a turn whose Stop hook never ran ends after the agent's last answer stays quiet; a tool still running keeps it open", async () => {
  const dir = tmp('turns');
  const transcript = path.join(tmp('conv'), 'conv.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(turnFile(dir, 'run-q'), JSON.stringify({ runId: 'run-q', sessionId: 'conv', transcript, offset: 0 }));
  const toolUse = { id: 'm1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
  fs.appendFileSync(transcript, line({ type: 'assistant', uuid: 'a-m1', message: toolUse }));
  let settled = false;
  const running = recordDesktopTurn(ctxFor('run-q', []), { dir, pollMs: 20, stoppedQuietMs: 100, endedQuietMs: 150 }).then((r) => { settled = true; return r; });
  await sleep(400);
  assert.equal(settled, false, 'a long tool call is quiet too, and still the turn');
  fs.appendFileSync(transcript, line(assistant('m2', 'All 9 cards are made.', { input_tokens: 2, output_tokens: 3 })));
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'All 9 cards are made.');
});

test('quietEnding reads only the newest message: the interrupt marker, or the last answer', () => {
  assert.equal(quietEnding({ type: 'user', message: { content: '[Request interrupted by user]' } }), 'stopped');
  assert.equal(quietEnding({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }), 'stopped');
  assert.equal(quietEnding({ type: 'user', message: { content: 'Benny wrote [Request interrupted by user] here' } }), null);
  assert.equal(quietEnding({ type: 'assistant', message: { stop_reason: 'end_turn' } }), 'ended');
  assert.equal(quietEnding({ type: 'assistant', message: { stop_reason: 'tool_use' } }), null);
  assert.equal(quietEnding(null), null);
});

test('a Desktop-turn wake that no turn claims fails fast instead of starting Claude', async () => {
  const result = await recordDesktopTurn(ctxFor('run-x', []), { dir: tmp('turns'), pollMs: 20, waitForTurnMs: 100 });
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage, /No Claude Desktop turn/);
});

test('reading a transcript never hands over half a line', () => {
  const file = path.join(tmp('lines'), 't.jsonl');
  fs.writeFileSync(file, 'one\ntwo\nthr');
  const first = readNewLines(file, 0);
  assert.deepEqual(first.lines, ['one', 'two']);
  fs.appendFileSync(file, 'ee\n');
  assert.deepEqual(readNewLines(file, first.offset).lines, ['three']);
});

