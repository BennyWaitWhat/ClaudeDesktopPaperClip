import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doneFile, readNewLines, recordDesktopTurn, sessionFile, turnFile, turnsDir } from '../desktop-turn.mjs';

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

