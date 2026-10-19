// A step only the board can do is done when it is done (Benny, 2026-10-15: "they were being marked complete without
// me finishing"), and someone checks it rather than leaving the bookkeeping to him (2026-10-19: "arent there ppl who
// check if its done?"). Paperclip keeps a blocked card from moving while a blocker is open, not every early close,
// so the plugin watches each Desktop org's activity feed and undoes the closes that skip the check:
// - a card for the board closes when the board marks it done, or when an agent that checks the board's steps
//   (adapterConfig.checksBoardSteps) closes it with a "Checked:" note saying what it saw; anyone else's close opens it
//   again;
// - an agent's card closed while a card for the board under it is open goes back to blocked.
// Each undo comes with a comment naming the card, once an hour per card: the comment wakes the agent, so a repeat
// close in that hour is put back without one.
import { checksBoardSteps } from './agent-files.mjs';
import { paperclipCall } from './paperclip-access.mjs';

const CLOSED = new Set(['done', 'cancelled']);
// The checker's note: on the card, by the agent that closed it, written with the close or just before.
const CHECKED = /^\s*Checked:\s*\S/;
const NOTE_MS = 10 * 60_000;

/** True for a feed event that says an agent just moved a card to done. */
export const agentClosedCard = (event) =>
  event?.type === 'activity.logged'
  && event.payload?.action === 'issue.updated'
  && event.payload?.actorType === 'agent'
  && (event.payload?.details?.changes?.status?.to === 'done' || event.payload?.details?.status === 'done')
  && typeof event.payload?.entityId === 'string';

/** A card for the board: assigned to a person rather than an agent. */
const boardsOwn = (issue) => Boolean(issue?.assigneeUserId && !issue.assigneeAgentId);

/** The board's cards that still block this card. */
export const openBoardBlockers = (issue) => (issue?.blockedBy ?? []).filter((b) => boardsOwn(b) && !CLOSED.has(b.status));

const answered = (moved, want) => moved.status === 200 && moved.json?.status === want;
const refused = (moved) => ({ held: false, why: `Paperclip answered ${moved.status}${moved.json?.status ? ` (${moved.json.status})` : ''}` });
const listOf = (json) => (Array.isArray(json) ? json : json?.items ?? json?.comments ?? []);

/** True when the agent left its "Checked:" note on the card in the last ten minutes. */
async function leftCheckedNote(api, issueId, agentId, now) {
  const got = await paperclipCall(api, `/api/issues/${issueId}/comments`);
  return listOf(got.json).some((c) => c?.authorAgentId === agentId && !c.deletedAt && CHECKED.test(c.body ?? '') && now - Date.parse(c.createdAt) < NOTE_MS);
}

/**
 * Undo a close that skipped the check. A card for the board stays closed when a checker closed it with its note, and
 * otherwise opens again (todo); an agent's card with an open card for the board under it goes back to blocked, its
 * blockers sent again with the comment so Paperclip reads the comment as part of a dependency change and does not move
 * the card to todo. actorId is the agent that closed it; quiet leaves the comment out.
 * Returns { held, card, waiting?, reopened? }, { held: false, card, checkedBy } or { held: false, why }.
 */
export async function holdForBoard(api, issueId, { quiet = false, actorId = null, now = Date.now() } = {}) {
  const got = await paperclipCall(api, `/api/issues/${encodeURIComponent(issueId)}`);
  const issue = got.json;
  if (got.status !== 200 || !issue?.id) return { held: false, why: `Paperclip answered ${got.status}` };
  if (issue.status !== 'done') return { held: false, why: `it is ${issue.status}` };
  if (boardsOwn(issue)) {
    const team = listOf((await paperclipCall(api, `/api/companies/${issue.companyId}/agents`)).json).filter((a) => a?.status !== 'terminated');
    const closer = team.find((a) => a.id === actorId);
    if (checksBoardSteps(closer) && await leftCheckedNote(api, issue.id, closer.id, now)) return { held: false, card: issue.identifier, checkedBy: closer.name };
    const checkers = team.filter(checksBoardSteps).map((a) => a.name);
    const comment = checkers.length
      ? `Open again: an agent closed this without a check. A card for the board closes when the board marks it done, or when ${checkers.join(' or ')} has checked that the step is done and closes it with a note starting "Checked:" that says what they saw.`
      : 'Open again: an agent marked this done, and only the board marks its own cards done. It stays in the board\'s inbox until the step is done and the board marks it done.';
    const moved = await paperclipCall(api, `/api/issues/${issue.id}`, { method: 'PATCH', body: { status: 'todo', ...(quiet ? {} : { comment }) } });
    return answered(moved, 'todo') ? { held: true, card: issue.identifier, reopened: true } : refused(moved);
  }
  const waiting = openBoardBlockers(issue);
  if (!waiting.length) return { held: false, why: 'no open card for the board blocks it' };
  const names = waiting.map((b) => `${b.identifier} "${b.title}"`).join(', ');
  const moved = await paperclipCall(api, `/api/issues/${issue.id}`, {
    method: 'PATCH',
    body: {
      status: 'blocked',
      blockedByIssueIds: (issue.blockedBy ?? []).map((b) => b.id),
      ...(quiet ? {} : { comment: `Not done yet: the board's card ${names} is still open. This card waits blocked until that card is closed; then check the result, record it, and close this one.` }),
    },
  });
  return answered(moved, 'blocked') ? { held: true, card: issue.identifier, waiting: waiting.map((b) => b.identifier) } : refused(moved);
}

/**
 * The plugin's feed handler: (api, event) => the hold's result, or null for an event that is not an agent's close.
 * Closes are handled one at a time, in feed order: an agent that closes the board's card and then its own card at
 * once finds the board's card open again by the time its own card is checked.
 */
export function boardGuard({ quietMs = 60 * 60_000, now = Date.now } = {}) {
  const explained = new Map();
  let queue = Promise.resolve();
  return (api, event) => {
    if (!agentClosedCard(event)) return Promise.resolve(null);
    const id = event.payload.entityId;
    const turn = queue.then(async () => {
      const quiet = explained.has(id) && now() - explained.get(id) < quietMs;
      const result = await holdForBoard(api, id, { quiet, actorId: event.payload.actorId ?? null, now: now() });
      if (result.held && !quiet) explained.set(id, now());
      return result;
    });
    queue = turn.catch(() => {});
    return turn;
  };
}
