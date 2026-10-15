#!/usr/bin/env node
// Start a Paperclip routine's run for an org on Claude Desktop, and say which Desktop conversation to tell.
// Paperclip only parks the card its own schedule makes (README > "Paperclip's own wakes wait for Desktop"), so an
// org on Claude Desktop keeps its routines paused in Paperclip and fires them from Claude Desktop scheduled tasks:
// the task runs this, then sends each line's message to its conversation with Claude Desktop's send_message tool
// (mcp__ccd_session_mgmt__send_message; SendMessage refuses in a scheduled run, "this session wasn't opened in
// the app"), which starts that agent's turn on the card.
//   node scripts/run-routine.mjs <routine id>... [--date YYYY-MM-DD] [--again]
// One JSON line per routine: {"routine", "title", "status", "card", "agent", "conversation", "send", "message"},
// or {"routine", "error"}. A second run on the same day (Desktop catching up after a restart) starts nothing new
// and says "send": false; --again starts one anyway (after a run that failed). The exit code is 1 when any
// routine failed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrg } from '../desktop-orgs.mjs';
import { paperclipApi, paperclipInstance } from '../org-sync.mjs';

const INSTANCE = paperclipInstance();
const API = paperclipApi(INSTANCE);

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** YYYY-MM-DD in this computer's time zone: one run per routine per local day. */
export const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');
const day = (t) => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

/**
 * What the agent is told. Today's card is new, or (the routine skips a day while its last card is open) the card
 * still open from an earlier day, which today's run goes on.
 */
export function messageFor({ card, title, now }) {
  const opened = localDate(new Date(card.createdAt));
  if (opened === localDate(new Date(now))) return `Please take ${card.identifier}: ${title}, today's scheduled run (${day(now)}). The card has the steps.`;
  return `Please take ${card.identifier}: ${title}. It is still open from ${day(card.createdAt)}, so Paperclip made no new card today (${day(now)}): do today's run on it, then close it.`;
}

/** A run Paperclip already had for today's key: made before this one asked (`now`), by more than clock jitter. */
export const startedEarlier = (run, now) => Date.parse(run.createdAt) < now - 5_000;

export async function runRoutine(routineId, { date = localDate(), now = Date.now(), again: anew = false } = {}) {
  const fail = (title, error) => ({ routine: routineId, ...(title ? { title } : {}), error });
  const routine = await call(`/api/routines/${routineId}`);
  if (routine.status !== 200) return fail(null, `no such routine (${routine.status})`);
  const { companyId, title, assigneeAgentId } = routine.json;
  const org = readOrg(INSTANCE, companyId);
  if (org?.desktop !== true) return fail(title, 'its org is not on Claude Desktop');
  const conversation = org.conversations?.[assigneeAgentId];
  if (!conversation?.sessionId) return fail(title, `its agent (${assigneeAgentId ?? 'none'}) has no Desktop conversation`);

  const key = `desktop-schedule-${date}${anew ? `-${now}` : ''}`;
  const started = await call(`/api/routines/${routineId}/run`, { method: 'POST', body: { source: 'api', idempotencyKey: key } });
  if (started.status >= 300) return fail(title, `Paperclip refused the run (${started.status}): ${JSON.stringify(started.json?.error ?? started.json).slice(0, 300)}`);
  const run = started.json;
  if (run.status === 'failed') return fail(title, `the run failed: ${run.failureReason} (once fixed: node scripts/run-routine.mjs ${routineId} --again)`);
  const card = run.linkedIssueId ? (await call(`/api/issues/${run.linkedIssueId}`)).json : null;
  if (!card?.identifier) return fail(title, `the run made no card (${run.status})`);

  const again = startedEarlier(run, now);
  return {
    routine: routineId, title, status: run.status, card: card.identifier, agent: conversation.name ?? assigneeAgentId,
    conversation: `local_${conversation.sessionId}`, send: !again,
    ...(again ? { already: `started ${new Date(run.createdAt).toLocaleString('en-US')}; nothing sent again` } : { message: messageFor({ card, title, now }) }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--date');
  const date = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const again = args.includes('--again');
  const ids = args.filter((a) => a !== '--again');
  if (!ids.length) { console.error('usage: node scripts/run-routine.mjs <routine id>... [--date YYYY-MM-DD] [--again]'); process.exit(2); }
  let failed = false;
  for (const id of ids) {
    const line = await runRoutine(id, { date, again }).catch((error) => ({ routine: id, error: `Paperclip did not answer at ${API}: ${error.message}` }));
    failed ||= Boolean(line.error);
    console.log(JSON.stringify(line));
  }
  process.exit(failed ? 1 : 0);
}
