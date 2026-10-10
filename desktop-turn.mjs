// A Paperclip run that records a turn an agent takes in Claude Desktop (PAPERCLIP-WORKFLOWS.md, "What this means for
// the Desktop version"). When a turn starts in an org agent's Desktop conversation, the org folder's hook
// (hooks/desktop-turn.mjs) wakes that agent in Paperclip with reason "desktop_turn"; Paperclip answers with the new
// run, and the hook writes a turn file named by the run's id: the conversation, its transcript, and where the turn
// starts in it. The run never starts Claude. It waits for that file, streams the turn into the run's log as it
// happens, and ends with the turn (its Stop hook, or the conversation's next turn), reporting the turn's tokens as
// subscription use. So each Desktop turn is a Paperclip run from start to end, and the turn has a real run id for
// the Paperclip calls that need one (checking out a card, question cards).
import fs from 'node:fs';
import path from 'node:path';
import { turnResult } from './open-copy.mjs';

export const DESKTOP_TURN_REASON = 'desktop_turn';
export const turnsDir = (instanceRoot) => path.join(instanceRoot, 'claude-desktop', 'turns');
export const turnFile = (dir, runId) => path.join(dir, `${runId}.json`);
export const doneFile = (dir, runId) => path.join(dir, `${runId}.done`);
export const sessionFile = (dir, sessionId) => path.join(dir, `session-${sessionId}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/** Complete lines added to `file` since byte `offset`: { lines, offset }. A torn last line waits for the next read. */
export function readNewLines(file, offset) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { lines: [], offset }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset };
    const lines = buf.subarray(0, end).toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
    return { lines, offset: offset + end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** The turn is over: its Stop hook wrote the done file, or the same conversation has started a later turn. */
export function turnOver(dir, runId, turn) {
  if (fs.existsSync(doneFile(dir, runId))) return true;
  for (const f of list(dir)) {
    if (!f.endsWith('.json') || f.startsWith('session-') || f === `${runId}.json`) continue;
    const other = readJson(path.join(dir, f));
    if (other?.sessionId === turn.sessionId && Number(other.offset) > Number(turn.offset)) return true;
  }
  return false;
}

// What goes into the run's log: the conversation's own entries, which Paperclip's Claude transcript view reads like
// Claude Code's stream output. Bookkeeping entries (file snapshots, hook attachments) stay out.
const LOGGED = new Set(['user', 'assistant', 'system']);

/** Record one Desktop turn into this run. Returns Paperclip's adapter result. */
export async function recordDesktopTurn(ctx, { dir, waitForTurnMs = 60_000, pollMs = 500, maxTurnMs = 6 * 60 * 60_000 } = {}) {
  const note = (line) => ctx.onLog('stdout', `[desktop] ${line}\n`);
  const stopped = { exitCode: null, signal: 'SIGTERM', timedOut: false, errorMessage: 'Cancelled in Paperclip; the turn itself goes on in Claude Desktop.' };

  let turn = null;
  for (const end = Date.now() + waitForTurnMs; !turn && Date.now() < end;) {
    turn = readJson(turnFile(dir, ctx.runId));
    if (turn) break;
    if (ctx.signal?.aborted) return stopped;
    await sleep(pollMs);
  }
  if (!turn?.transcript) {
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: 'No Claude Desktop turn claimed this run (it was woken as a Desktop turn, but no turn file arrived).' };
  }

  await note(`${ctx.agent?.name ?? 'The agent'}'s turn in Claude Desktop (conversation ${turn.sessionId}).`);
  let offset = Number(turn.offset) || 0;
  const entries = [];
  const drain = async () => {
    const next = readNewLines(turn.transcript, offset);
    offset = next.offset;
    for (const line of next.lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      entries.push(e);
      if (LOGGED.has(e.type)) await ctx.onLog('stdout', `${line}\n`);
    }
  };

  const started = Date.now();
  let outcome = 'ended';
  for (;;) {
    await drain();
    if (turnOver(dir, ctx.runId, turn)) { await drain(); break; }
    if (ctx.signal?.aborted) { outcome = 'cancelled'; break; }
    if (Date.now() - started > maxTurnMs) { outcome = 'timed out'; break; }
    await sleep(pollMs);
  }

  for (const f of [turnFile(dir, ctx.runId), doneFile(dir, ctx.runId)]) fs.rmSync(f, { force: true });
  const { summary, usage, model } = turnResult(entries);
  if (outcome === 'cancelled') return { ...stopped, usage, model: model ?? undefined, provider: 'anthropic', billingType: 'subscription', costUsd: 0 };
  if (outcome === 'timed out') await note('Still going after the longest a turn is recorded for; the run ends here, the turn goes on in Claude Desktop.');
  return {
    exitCode: 0,
    signal: null,
    timedOut: outcome === 'timed out',
    usage,
    provider: 'anthropic',
    model: model ?? undefined,
    billingType: 'subscription',
    costUsd: 0,
    summary: summary.slice(0, 4000),
  };
}
