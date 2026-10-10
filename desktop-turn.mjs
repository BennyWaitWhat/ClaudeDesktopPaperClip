// A Paperclip run that records a turn an agent takes in Claude Desktop (PAPERCLIP-WORKFLOWS.md, "What this means for
// the Desktop version"). When a turn starts in an org agent's Desktop conversation, the org folder's hook
// (hooks/desktop-turn.mjs) wakes that agent in Paperclip with reason "desktop_turn"; Paperclip answers with the new
// run, and the hook writes a turn file named by the run's id: the conversation, its transcript, and where the turn
// starts in it. The run never starts Claude. It waits for that file, streams the turn into the run's log as it
// happens, and ends with the turn (its Stop hook, or the conversation's next turn), reporting the turn's tokens as
// subscription use. So each Desktop turn is a Paperclip run from start to end, and the turn has a real run id for
// the Paperclip calls that need one (checking out a card, question cards).
//
// Paperclip lets a run comment on or update cards only when the run is tied to a card (its own card freely, up to
// 20 others). So a turn whose message names a card (a hand-off: "please take LEM-8") opens its run on that card,
// and an agent that takes up a card partway through a turn moves the rest of the turn to that card's own run
// (hooks/paperclip-card.mjs). A turn that names no card is a plain conversation: a run with no card.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paperclipCall } from './paperclip-access.mjs';

/** What a turn did, for its run: its last reply, its token use (per API message), its model. */
export function turnResult(entries) {
  const usageById = new Map();
  let model = null;
  let summary = '';
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message) continue;
    const m = e.message;
    if (m.model) model = m.model;
    const text = (Array.isArray(m.content) ? m.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) summary = text;
    if (m.usage) usageById.set(m.id ?? e.uuid, m.usage); // each content block repeats its message's usage; the last is final
  }
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const u of usageById.values()) {
    usage.inputTokens += u.input_tokens ?? 0;
    usage.outputTokens += u.output_tokens ?? 0;
    usage.cachedInputTokens += u.cache_read_input_tokens ?? 0;
  }
  return { summary, usage, model };
}

export const DESKTOP_TURN_REASON = 'desktop_turn';
export const turnsDir = (instanceRoot) => path.join(instanceRoot, 'claude-desktop', 'turns');
export const turnFile = (dir, runId) => path.join(dir, `${runId}.json`);
export const doneFile = (dir, runId) => path.join(dir, `${runId}.done`);
export const sessionFile = (dir, sessionId) => path.join(dir, `session-${sessionId}.json`);
// The conversation's current run id as plain text: its shell reads it before every command ($PAPERCLIP_RUN_ID).
export const runIdFile = (dir, sessionId) => path.join(dir, `session-${sessionId}.run`);
// The agent file the conversation last saw (a hash), so an edit made in Paperclip is handed over once.
export const seenFile = (dir, sessionId) => path.join(dir, `session-${sessionId}.agent`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const writePrivate = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); };
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const ANY_CARD = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first card `text` names that Paperclip knows: { id, identifier }, or null. With `prefix` (the org's own, e.g.
 * LEM) only that org's cards count, so "UTF-8" or another org's card never ties a run to the wrong card.
 */
export async function namedCard({ api, token, text, prefix = null }) {
  const seen = new Set();
  const pattern = prefix ? new RegExp(`\\b${escapeRe(prefix)}-\\d{1,7}\\b`, 'g') : ANY_CARD;
  for (const [identifier] of String(text ?? '').matchAll(pattern)) {
    if (seen.has(identifier) || seen.size >= 3) continue;
    seen.add(identifier);
    const found = await paperclipCall(api, `/api/issues/${identifier}`, { token });
    if (found.status === 200 && found.json?.id) return { id: found.json.id, identifier: found.json.identifier ?? identifier };
  }
  return null;
}

/**
 * Remove files no run will read: a run's own files go when it ends, but a run Paperclip cancels before the adapter
 * starts never reads its turn file. Done markers go after an hour, turn files and run ids after a day. What a
 * conversation last saw of its agent file stays: conversations last for weeks.
 */
export function sweepStale(dir, now = Date.now()) {
  for (const f of list(dir)) {
    const file = path.join(dir, f);
    const age = (() => { try { return now - fs.statSync(file).mtimeMs; } catch { return 0; } })();
    if ((f.endsWith('.done') && age > 60 * 60_000) || (/\.(json|run)$/.test(f) && age > 24 * 60 * 60_000)) fs.rmSync(file, { force: true });
  }
}

const bodyOf = (definition) => String(definition ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Note that the conversation has the agent's current instructions (its system prompt, or handed over at its start). */
export function markSeen(dir, sessionId, definition) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(seenFile(dir, sessionId), hashOf(bodyOf(definition)), { mode: 0o600 });
}

/**
 * The agent's instructions when they changed (in Paperclip) since the conversation last had them, else null. Either
 * way they count as seen from here on, so a change is handed over once. A conversation with no record starts one.
 */
export function changedInstructions(dir, sessionId, definition) {
  const body = bodyOf(definition);
  let before = null;
  try { before = fs.readFileSync(seenFile(dir, sessionId), 'utf8').trim(); } catch { /* no record yet */ }
  if (before === hashOf(body)) return null;
  markSeen(dir, sessionId, definition);
  return before && body ? body : null;
}

/** End the conversation's current run (its turn, or the part of it so far). */
export function endTurnRun(dir, sessionId) {
  const runId = readJson(sessionFile(dir, sessionId))?.runId;
  if (runId && fs.existsSync(turnFile(dir, runId))) writePrivate(doneFile(dir, runId), { at: new Date().toISOString() });
  return runId ?? null;
}

/**
 * Open a Paperclip run for this conversation's turn, or for the rest of it from `offset` (tied to `issueId` when
 * given), and point the run at the transcript. The conversation's previous run is ended and waited for first:
 * Paperclip folds a wake into the agent's run that is still going. Returns the run id, or null when Paperclip did not
 * start a run (not answering, or the agent can't run now).
 */
export async function openTurnRun({ api, token, agentId, sessionId, transcript, cwd, dir, offset, issueId = null, waitMs = 5000 }) {
  sweepStale(dir);
  const previous = endTurnRun(dir, sessionId);
  if (previous) {
    for (const end = Date.now() + waitMs; Date.now() < end; await sleep(150)) {
      const run = await paperclipCall(api, `/api/heartbeat-runs/${previous}`, { token });
      if (run.status !== 200 || FINISHED.has(run.json?.status)) break;
    }
  }
  const woke = await paperclipCall(api, `/api/agents/${agentId}/wakeup`, {
    method: 'POST',
    token,
    body: {
      source: 'on_demand', triggerDetail: 'manual', reason: DESKTOP_TURN_REASON,
      ...(issueId ? { payload: { issueId } } : {}),
      idempotencyKey: `desktop-turn:${sessionId}:${offset}${issueId ? `:${issueId}` : ''}`,
    },
  });
  const runId = woke.status === 202 && typeof woke.json?.id === 'string' && woke.json?.agentId === agentId ? woke.json.id : null;
  if (!runId || runId === previous) {
    fs.rmSync(runIdFile(dir, sessionId), { force: true }); // the previous run is over: no run id beats a stale one
    return null;
  }
  writePrivate(turnFile(dir, runId), { runId, agentId, sessionId, transcript, offset, cwd, issueId, startedAt: new Date().toISOString() });
  writePrivate(sessionFile(dir, sessionId), { runId });
  fs.writeFileSync(runIdFile(dir, sessionId), runId, { mode: 0o600 });
  return runId;
}

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
