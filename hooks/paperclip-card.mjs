// Move the rest of this Desktop turn to a card's own Paperclip run: the run so far ends here, and a new run tied to
// the card records the rest of the turn. Paperclip lets a run comment on and update its own card freely (up to 20
// others), so an agent runs this when it takes up a card its turn's message did not name. With --new it first makes
// the card, for work the board or a teammate asked for in Desktop: assigned to the agent, and claimed by the turn's
// new run (in_progress), the way Paperclip's own agents check out their cards. Run inside the agent's conversation
// (its environment comes from the org folder's SessionStart hook, hooks/desktop-session.mjs).
// With --board it makes a card for the board instead, for a step only they can do (an answer, a decision, a send, a
// submit, a booking): assigned to them, so it is in their Paperclip inbox, and under the turn's card (or --under's),
// which waits blocked on it until it is closed. The turn stays where it is.
// With --checked an agent that checks the board's steps closes the board's card once the step is done, with a
// "Checked:" note saying what it saw (Benny, 2026-10-19: "arent there ppl who check if its done?").
//   node paperclip-card.mjs LEM-8
//   node paperclip-card.mjs --new "Record the Taco Maco expense" [--body "What was asked, and where it stands"]
//   node paperclip-card.mjs --board "Send: the Taco Maco receipt to the bookkeeper" [--body "The draft is in Gmail"] [--under LEM-8]
//   node paperclip-card.mjs --checked LEM-11 "The email to the bookkeeper is in Sent, 10/19 3:52 PM"
import fs from 'node:fs';
import { checkoutCard, closeCheckedCard, createBoardCard, createOwnCard, currentTurn, doneFile, namedCard, openTurnRun, sessionFile, turnFile, turnsDir, waitText } from '../desktop-turn.mjs';

const env = process.env;
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const making = argv[0] === '--new';
const boarding = argv[0] === '--board';
const checking = argv[0] === '--checked';
const title = making || boarding ? String(flag(argv[0]) ?? '').replace(/\s+/g, ' ').trim() : '';
const body = making || boarding ? String(flag('--body') ?? '').trim() : '';
const card = making || boarding ? null : checking ? argv[1] : argv[0];
const seen = checking ? String(argv[2] ?? '').replace(/\s+/g, ' ').trim() : '';
const usage = 'Usage: node paperclip-card.mjs <CARD, e.g. LEM-8>\n   or: node paperclip-card.mjs --new "<short title>" [--body "<what was asked>"]\n   or: node paperclip-card.mjs --board "<Verb>: <what>" [--body "<what to do, and where>"] [--under <CARD>]\n   or: node paperclip-card.mjs --checked <CARD> "<what you saw, and when>"';
const need = ['PAPERCLIP_API_URL', 'PAPERCLIP_API_KEY', 'PAPERCLIP_AGENT_ID', ...(making ? ['PAPERCLIP_COMPANY_ID'] : []), 'PAPERCLIP_INSTANCE_ROOT', 'CLAUDE_DESKTOP_SESSION_ID', ...(boarding || checking ? [] : ['CLAUDE_DESKTOP_TRANSCRIPT'])];
const missing = need.filter((k) => !env[k]);
if ((making || boarding ? !title : !card) || (checking && !seen) || missing.length) {
  console.error(missing.length ? `Not inside an org agent's Claude Desktop conversation (missing ${missing.join(', ')}).` : usage);
  process.exit(2);
}

const api = env.PAPERCLIP_API_URL;
const token = env.PAPERCLIP_API_KEY;
const agentId = env.PAPERCLIP_AGENT_ID;
const dir = turnsDir(env.PAPERCLIP_INSTANCE_ROOT);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

if (boarding) {
  const turn = currentTurn(dir, env.CLAUDE_DESKTOP_SESSION_ID);
  const under = flag('--under');
  const parent = under ? await namedCard({ api, token, text: under }) : turn?.issueId ? { id: turn.issueId } : null;
  if (!parent) {
    console.error(under ? `Paperclip has no card ${under}.` : 'This turn is on no card: name the card the step belongs to with --under <CARD>.');
    process.exit(1);
  }
  const made = await createBoardCard({ api, token, runId: turn?.runId ?? env.PAPERCLIP_RUN_ID, parentId: parent.id, title, description: body });
  if (made.error) {
    console.error(`Paperclip did not make the board's card (${made.error}).`);
    process.exit(1);
  }
  const { identifier: parentName, blocked } = made.parent;
  console.log(`Made ${made.identifier} "${title}" for the board: it is in their Paperclip inbox, under ${parentName}, which ${blocked ? 'waits blocked on it' : 'it blocks, though Paperclip did not set it to blocked: set it yourself'}. When the board marks ${made.identifier} done, check the result, record it, and close ${parentName}.`);
  process.exit(0);
}

if (checking) {
  const closed = await closeCheckedCard({ api, token, runId: currentTurn(dir, env.CLAUDE_DESKTOP_SESSION_ID)?.runId ?? env.PAPERCLIP_RUN_ID, agentId, text: card, seen });
  if (closed.error === 'not a checker') {
    console.error(`You don't check the board's steps: your notes (Working from Claude Desktop) name who does. Tell one of them what you saw, and they check and close ${card}.`);
    process.exit(1);
  }
  if (closed.error) {
    console.error(`${closed.error}.`);
    process.exit(1);
  }
  console.log(`Closed ${closed.identifier} "${closed.title}" with your note (${closed.note}). Paperclip tells the agent whose card it blocked; its next turn records the result and closes its card.`);
  process.exit(0);
}

let found;
if (making) {
  const made = await createOwnCard({ api, token, companyId: env.PAPERCLIP_COMPANY_ID, agentId, runId: currentTurn(dir, env.CLAUDE_DESKTOP_SESSION_ID)?.runId, title, description: body });
  if (made.error) {
    console.error(`Paperclip did not make the card (${made.error}).`);
    process.exit(1);
  }
  found = { id: made.id, identifier: made.identifier ?? made.id };
} else {
  found = await namedCard({ api, token, text: card });
  if (!found) {
    console.error(`Paperclip has no card ${card}.`);
    process.exit(1);
  }
  // Already on that card: nothing to move (ending the run here would leave the card to Paperclip's repair).
  const current = readJson(sessionFile(dir, env.CLAUDE_DESKTOP_SESSION_ID))?.runId;
  const live = current && !fs.existsSync(doneFile(dir, current)) ? readJson(turnFile(dir, current)) : null;
  if (live && live.issueId === found.id) {
    console.log(`This turn's run ${current} is already on ${found.identifier}, and $PAPERCLIP_RUN_ID holds it: nothing to move.`);
    process.exit(0);
  }
  // Paperclip starts no run on a card that waits on an open blocker: moving there would end this turn's run and open
  // none, and every write after it would be refused (Career Catchers, 2026-10-26: CAR-631). The turn stays where it is.
  if (found.waitsOn?.length) {
    console.error(`${waitText(found)}, so Paperclip starts no run on ${found.identifier} until that is done. This turn stays where it is${live ? ` (run ${current})` : ''}. ${live?.issueId
      ? `Comment on ${found.identifier} from here: it counts as one of the 20 other cards a run may write to.`
      : `This turn is on no card, and a run on no card can write to none: first move to one of your open cards that is not blocked (node paperclip-card.mjs <CARD>), or make one with --new, then comment on ${found.identifier} from there.`}`);
    process.exit(1);
  }
}
let offset = 0;
try { offset = fs.statSync(env.CLAUDE_DESKTOP_TRANSCRIPT).size; } catch { /* nothing yet */ }
const runId = await openTurnRun({
  api, token, agentId, sessionId: env.CLAUDE_DESKTOP_SESSION_ID, transcript: env.CLAUDE_DESKTOP_TRANSCRIPT,
  cwd: process.cwd(), dir, offset, issueId: found.id,
});
if (!runId) {
  // The run so far has ended: a run on no card keeps the turn recorded, never a turn with none (CAR-631).
  const plain = await openTurnRun({
    api, token, agentId, sessionId: env.CLAUDE_DESKTOP_SESSION_ID, transcript: env.CLAUDE_DESKTOP_TRANSCRIPT,
    cwd: process.cwd(), dir, offset, issueId: null,
  });
  console.error(`${making ? `Made ${found.identifier} "${title}", but ` : ''}Paperclip did not start a run on ${found.identifier} (it may already have a run going, or Paperclip is not answering).${plain
    ? ` This turn's run ${plain} is on no card now, and $PAPERCLIP_RUN_ID holds it from your next command on: move to one of your open cards with node paperclip-card.mjs <CARD> before you write to a card.`
    : ''}`);
  process.exit(1);
}
if (making) {
  const claimed = await checkoutCard({ api, token, issueId: found.id, agentId, runId });
  console.log(`Made ${found.identifier} "${title}", assigned to you${claimed ? ' and in progress' : ' (still in backlog: the checkout did not go through)'}. Paperclip run ${runId} records the rest of this turn on it, and $PAPERCLIP_RUN_ID holds it from your next command on. Before the turn ends, leave ${found.identifier} done, in_review, blocked (on a teammate's card, or on a card for the board: --board), or in backlog.`);
} else {
  console.log(`Paperclip run ${runId} now records the rest of this turn, on ${found.identifier}, and $PAPERCLIP_RUN_ID holds it from your next command on.`);
}
