// A step only the board can do is done when the board marks its card done (Benny, 2026-10-15: "they were being
// marked complete without me finishing"). Paperclip keeps a card with open blockers from starting work, not from
// being closed, so the plugin watches each Desktop org's activity feed and undoes an agent's early close:
// - an agent's card closed while a card for the board under it is open goes back to blocked;
// - a card for the board that an agent closes opens again: only the board marks its own cards done.
// Each comes with a comment naming the card, once an hour per card: the comment wakes the agent, so a repeat close
// in that hour is put back without one.
import { paperclipCall } from './paperclip-access.mjs';

const CLOSED = new Set(['done', 'cancelled']);

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

/**
 * Undo a close that came too early. A card of the board's own opens again (todo); an agent's card with an open card
 * for the board under it goes back to blocked, its blockers sent again with the comment so Paperclip reads the comment
 * as part of a dependency change and does not move the card to todo. quiet leaves the comment out.
 * Returns { held, card, waiting?, reopened? } or { held: false, why }.
 */
export async function holdForBoard(api, issueId, { quiet = false } = {}) {
  const got = await paperclipCall(api, `/api/issues/${encodeURIComponent(issueId)}`);
  const issue = got.json;
  if (got.status !== 200 || !issue?.id) return { held: false, why: `Paperclip answered ${got.status}` };
  if (issue.status !== 'done') return { held: false, why: `it is ${issue.status}` };
  if (boardsOwn(issue)) {
    const moved = await paperclipCall(api, `/api/issues/${issue.id}`, {
      method: 'PATCH',
      body: {
        status: 'todo',
        ...(quiet ? {} : { comment: 'Open again: an agent marked this done, and only the board marks its own cards done. It stays in the board\'s inbox until the step is done and the board marks it done.' }),
      },
    });
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
      ...(quiet ? {} : { comment: `Not done yet: the board's card ${names} is still open. This card waits blocked until the board marks it done; then check the result, record it, and close this one.` }),
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
      const result = await holdForBoard(api, id, { quiet });
      if (result.held && !quiet) explained.set(id, now());
      return result;
    });
    queue = turn.catch(() => {});
    return turn;
  };
}
