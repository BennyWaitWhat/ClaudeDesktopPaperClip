// A Paperclip turn delivered into the card conversation's open copy: Claude Desktop's loaded copy (or a terminal
// session that has it), through Claude Code's own session pipe. The turn runs there, inside Claude Desktop, with
// Desktop's tools, and Desktop shows it live as "Received message from Paperclip". The adapter waits for the turn
// to end and reads what it did from the conversation's transcript, for Paperclip's run record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The way into a live session: its pipe, and the token Claude Code keeps beside its registry entry. */
export function sessionPipe(session, { sessionsDir = path.join(claudeHome(), 'sessions') } = {}) {
  if (!session?.messagingSocketPath || !Number.isInteger(session.pid)) return null;
  for (const f of list(sessionsDir)) {
    if (!f.startsWith(`${session.pid}.`) || !f.endsWith('.key')) continue;
    try {
      const key = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
      if (session.procStart !== undefined && key.procStartFt !== undefined && String(key.procStartFt) !== String(session.procStart)) continue;
      if (typeof key.peerToken === 'string' && key.peerToken) return { socketPath: session.messagingSocketPath, token: key.peerToken };
    } catch { /* unreadable */ }
  }
  return null;
}

/** True when the org folder's hook gave this conversation an agent's Paperclip access when it was opened. */
export function hasPaperclipAccess(sessionId, { configDir = claudeHome() } = {}) {
  const dir = path.join(configDir, 'session-env', String(sessionId));
  return list(dir).some((f) => /^sessionstart-hook-\d+\.sh$/.test(f) && /\bPAPERCLIP_API_KEY=/.test(read(path.join(dir, f))));
}

export const PEER_NAME = 'Paperclip';

/** The message as the pipe carries it: Claude Code shows it as a message from another session named Paperclip. */
export const peerContent = (text, name = PEER_NAME) => `<cross-session-message from-name="${name}">\n${text}\n</cross-session-message>`;

/** The turn's text: what people wrote, then Paperclip's details for the turn, with the run to report against. */
export function pipeText({ message, details, runId, card }) {
  const run = runId ? `This is Paperclip run ${runId}${card ? ` on ${card}` : ''}: send the header "X-Paperclip-Run-Id: ${runId}" with the Paperclip API calls you make for it.` : '';
  return [String(message ?? '').trim(), '---', run, String(details ?? '').trim()].filter(Boolean).join('\n\n');
}

/** Send one user message into a live session through its pipe (auth line, then the message). */
export function sendPeerMessage({ socketPath, token, sessionId, uuid, content }, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let reply = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const sock = net.connect(socketPath, () => {
      sock.write(`${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify({ type: 'user', session_id: sessionId, uuid, message: { role: 'user', content } })}\n`);
      sock.end();
    });
    const timer = setTimeout(() => finish({ ok: false, reason: 'the session did not answer' }), timeoutMs);
    sock.on('data', (d) => { reply += d; });
    sock.on('error', (e) => finish({ ok: false, reason: e.message }));
    sock.on('close', () => finish(/"type"\s*:\s*"error"/.test(reply) ? { ok: false, reason: reply.trim().slice(0, 300) } : { ok: true }));
  });
}

/** The transcript entries after our message, and whether the turn it started has ended (Claude Code's stop summary). */
export function readTurn(file, uuid) {
  const entries = [];
  let found = false;
  for (const line of read(file).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!found) { found = e.uuid === uuid; continue; }
    entries.push(e);
    if (e.type === 'system' && e.subtype === 'stop_hook_summary') return { found, done: true, entries };
  }
  return { found, done: false, entries };
}

const lastReply = (entries) => [...entries].reverse().find((e) => e.type === 'assistant' && e.message);
const finishedReply = (entries) => {
  const last = lastReply(entries);
  return Boolean(last) && last.message.stop_reason !== 'tool_use' && entries[entries.length - 1] === last;
};

/** What the turn did, for Paperclip's run record: its last reply, its token use (per API message), its model. */
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

/**
 * Deliver a turn into an open copy and wait for it to end. `copiesOf` lists who has the conversation open, so a copy
 * that goes away mid-turn ends the wait. Returns { delivered: false, reason } when the message could not be sent.
 */
export async function deliverTurn({ copy, sessionId, transcript, text, copiesOf, log = async () => {}, signal, timeoutMs = 0, pollMs = 1000, sessionsDir }) {
  const pipe = sessionPipe(copy, { sessionsDir });
  if (!pipe) return { delivered: false, reason: 'no way into that copy' };
  const uuid = crypto.randomUUID();
  const sent = await sendPeerMessage({ ...pipe, sessionId, uuid, content: peerContent(text) });
  if (!sent.ok) return { delivered: false, reason: sent.reason };
  const started = Date.now();
  let idleChecks = 0;
  let notedWait = false;
  for (;;) {
    const turn = readTurn(transcript, uuid);
    const outcome = (extra) => ({ delivered: true, uuid, ...turnResult(turn.entries), ...extra });
    if (turn.done) return outcome({});
    const still = (await copiesOf(sessionId)).find((s) => s.pid === copy.pid);
    if (!still) return outcome({ ended: true });
    // No stop summary (no Stop hooks ran): the copy idle again after a finished reply also ends the turn.
    idleChecks = turn.found && still.status === 'idle' && finishedReply(turn.entries) ? idleChecks + 1 : 0;
    if (idleChecks >= 3) return outcome({});
    if (!turn.found && !notedWait && Date.now() - started > 60_000) {
      notedWait = true;
      await log("Paperclip's message has not started a turn yet. If Claude Desktop is holding it for you, allow it there.");
    }
    if (signal?.aborted) return outcome({ cancelled: true });
    if (timeoutMs > 0 && Date.now() - started > timeoutMs) return outcome({ timedOut: true });
    await sleep(pollMs);
  }
}
