// UserPromptSubmit and Stop hook in an org folder (org-folder.mjs puts it in .claude/settings.json).
// - A turn that starts in one of the org's agents' conversations opens a Paperclip run for that agent (wake reason
//   "desktop_turn", with the agent's own lasting key), on the org card its message names if any, and tells the turn
//   its run id; desktop-turn.mjs records the turn into that run. The turn also opens with what happened in Paperclip
//   since the agent's last turn (paperclip-wakes.mjs), and, once, with the agent's instructions when they were edited
//   in Paperclip since the conversation last had them.
// - Work goes on cards. A turn that names no card is told so, with the agent's open cards and the one command that
//   makes a new card (paperclip-card.mjs --new); and a turn about to end still on no card is stopped once and asked to
//   file its work on a card, or to end as it is when it was only chat.
// - The turn's end (Stop) closes it.
// A Paperclip run brings its own run and is left alone. When Paperclip is not answering, the turn goes on unrecorded.
//   node desktop-turn.mjs --api <Paperclip URL> --instance <Paperclip instance folder> [--chief <agent id>]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedInstructions, currentTurn, endTurnRun, HELLO_ENV, namedCard, openCards, openCardsText, openTurnRun, turnPromptOrigin, turnsDir, waitText } from '../desktop-turn.mjs';
import { agentKey, conversationAgent, hookArgs, hookInput, insidePaperclipRun, paperclipCall } from '../paperclip-access.mjs';
import { inboxText, takeInbox } from '../paperclip-wakes.mjs';

const CARD_TOOL = fileURLToPath(new URL('./paperclip-card.mjs', import.meta.url));
const tool = `node "${CARD_TOOL.replace(/\\/g, '/')}"`;
const NEW_CARD = `${tool} --new "<short title>" --body "<what was asked>"`;
const BOARD_CARD = `${tool} --board "<Verb>: <what>" --body "<what to do, and where>"`;

const { api, instance, chiefId } = hookArgs();
if (insidePaperclipRun() || !instance) process.exit(0);

const input = await hookInput();
if (!input?.session_id || !/^[\w-]+$/.test(input.session_id)) process.exit(0);
const dir = turnsDir(instance);

if (input.hook_event_name === 'Stop') {
  // Once per turn (Claude Code sets stop_hook_active on the stop that follows), never for the hello, and only when the
  // board or a teammate started the turn: a background notice (a finished task, an artifact subscription) asked for no
  // work, and pressing it for a card kept a stopped agent going (Inbox Coordinator, 2026-10-15).
  const turn = currentTurn(dir, input.session_id);
  const origin = turnPromptOrigin(input.transcript_path);
  if (turn && !turn.issueId && !turn.done && !input.stop_hook_active && process.env[HELLO_ENV] !== '1' && (origin === null || origin === 'human' || origin === 'peer')) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `This turn is on no Paperclip card. If the message asked for anything to be done, recorded, tracked or followed up, put it on a card now: ${NEW_CARD} (or ${tool} <CARD> for one of your open cards), put your draft or result on it as a comment, give each step only the board can do (an answer, a decision, a send, a submit) its own card in their inbox with ${BOARD_CARD}, and leave yours done, in_review, or blocked (on the board's card). If the message was only chat or a quick question, end the turn as it is, without a card and without saying more.`,
    }));
    process.exit(0);
  }
  endTurnRun(dir, input.session_id);
  process.exit(0);
}
if (input.hook_event_name !== 'UserPromptSubmit') process.exit(0);

const cwd = input.cwd || process.cwd();
const who = conversationAgent({ cwd, transcriptPath: input.transcript_path, agentType: input.agent_type, chiefId });
if (!who || !input.transcript_path) process.exit(0);

// The hello that makes the conversation is setup: what waits for the agent waits for its first real turn.
const hello = process.env[HELLO_ENV] === '1';
const instructions = hello ? null : changedInstructions(dir, input.session_id, who.definition);

let runId = null;
let card = null;
let waiting = null;   // the card the message names, when it waits on an open blocker
let refused = null;   // the card the message names, when Paperclip refused its run for another reason
const key = await agentKey({ api, instance, agentId: who.agentId });
if (key) {
  // Where this turn starts in the transcript: everything after this point is the turn.
  let offset = 0;
  try { offset = fs.statSync(input.transcript_path).size; } catch { /* a new conversation */ }
  // Only the org's own cards count ("UTF-8" is not a card).
  const org = key.agent?.companyId ? await paperclipCall(api, `/api/companies/${key.agent.companyId}`, { token: key.token }) : null;
  card = await namedCard({ api, token: key.token, text: input.prompt, prefix: org?.json?.issuePrefix ?? null });
  // Paperclip starts no run on a card that waits on an open blocker (CAR-631): the turn's run opens on no card instead,
  // so the turn is still recorded and can move to a card that can run.
  if (card?.waitsOn?.length) { waiting = card; card = null; }
  const open = (issueId) => openTurnRun({
    api, token: key.token, agentId: who.agentId, sessionId: input.session_id, transcript: input.transcript_path, cwd, dir, offset, issueId,
  });
  runId = await open(card?.id ?? null);
  // Refused on the card for another reason: a run on no card all the same, never a turn with none.
  if (!runId && card) { refused = card; card = null; runId = await open(null); }
}

// A turn on no card yet sees the agent's open cards, so a follow-up ("business, the Amex") finds its card.
const mine = runId && !card && !hello && key?.agent?.companyId
  ? await openCards({ api, token: key.token, companyId: key.agent.companyId, agentId: who.agentId })
  : [];
const run = runId
  ? [
    `Paperclip run ${runId} records this turn${card ? `, on ${card.identifier}` : ' (on no card yet)'}, and $PAPERCLIP_RUN_ID holds it. Send "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" with the Paperclip API calls you make in this turn.`,
    card
      ? `It already runs on ${card.identifier}: comment on it and update it freely (and up to 20 other cards). To move to a different card, first leave ${card.identifier} done, in_review, blocked, or in backlog, then run ${tool} <CARD>.`
      : `Work goes on cards, so Paperclip shows it: if this message asks for anything to be done, recorded, tracked or followed up, put it on a card before you start. Continue one of your cards with ${tool} <CARD>, or make one with ${NEW_CARD} (assigned to you and in progress; the rest of the turn records on it). A step only the board can do (an answer, a decision, a send, a submit) gets its own card in their inbox, with ${BOARD_CARD}, and your card waits blocked on it. Only chat and quick answers need no card. ${openCardsText(mine)}`,
  ].join(' ')
  : `Paperclip opened no run for this turn (${key ? 'it refused the wake: the agent may be paused' : 'Paperclip is not answering'}), so the turn is not recorded there and Paperclip calls that need a run will fail.`;
// Why the turn is not on the card its message names (CAR-631), and how to work on that card all the same.
const elsewhere = waiting
  ? `${waitText(waiting)}, so Paperclip starts no run on ${waiting.identifier} until that is done (Paperclip's own rule). ${runId ? 'This turn runs on no card instead.' : ''} To work on ${waiting.identifier}, move to one of your open cards that is not blocked with ${tool} <CARD>, or make one with ${NEW_CARD}, then comment on ${waiting.identifier} from there: it counts as one of the 20 other cards a run may write to. Do not run ${tool} ${waiting.identifier} while it waits.`
  : refused
    ? `Paperclip refused a run on ${refused.identifier}, so this turn ${runId ? 'runs on no card instead' : 'has no run'}. To work on it, move to one of your open cards with ${tool} <CARD>, or make one with ${NEW_CARD}, and comment on ${refused.identifier} from there.`
    : '';

const context = [
  hello ? '' : inboxText(takeInbox(instance, who.agentId)),
  instructions ? `Your instructions were edited in Paperclip since this conversation got them. From now on they are:\n\n${instructions}` : '',
  elsewhere,
  run,
].filter(Boolean).join('\n\n');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
