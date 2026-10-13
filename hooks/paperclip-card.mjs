// Move the rest of this Desktop turn to a card's own Paperclip run: the run so far ends here, and a new run tied to
// the card records the rest of the turn. Paperclip lets a run comment on and update its own card freely (up to 20
// others), so an agent runs this when it takes up a card its turn's message did not name. With --new it first makes
// the card, for work the board or a teammate asked for in Desktop: assigned to the agent, and claimed by the turn's
// new run (in_progress), the way Paperclip's own agents check out their cards. Run inside the agent's conversation
// (its environment comes from the org folder's SessionStart hook, hooks/desktop-session.mjs).
//   node paperclip-card.mjs LEM-8
//   node paperclip-card.mjs --new "Record the Taco Maco expense" [--body "What was asked, and where it stands"]
import fs from 'node:fs';
import { checkoutCard, createOwnCard, currentTurn, doneFile, namedCard, openTurnRun, sessionFile, turnFile, turnsDir } from '../desktop-turn.mjs';

const env = process.env;
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const making = argv[0] === '--new';
const title = making ? String(flag('--new') ?? '').replace(/\s+/g, ' ').trim() : '';
const body = making ? String(flag('--body') ?? '').trim() : '';
const card = making ? null : argv[0];
const usage = 'Usage: node paperclip-card.mjs <CARD, e.g. LEM-8>\n   or: node paperclip-card.mjs --new "<short title>" [--body "<what was asked>"]';
const need = ['PAPERCLIP_API_URL', 'PAPERCLIP_API_KEY', 'PAPERCLIP_AGENT_ID', ...(making ? ['PAPERCLIP_COMPANY_ID'] : []), 'PAPERCLIP_INSTANCE_ROOT', 'CLAUDE_DESKTOP_SESSION_ID', 'CLAUDE_DESKTOP_TRANSCRIPT'];
const missing = need.filter((k) => !env[k]);
if ((making ? !title : !card) || missing.length) {
  console.error(missing.length ? `Not inside an org agent's Claude Desktop conversation (missing ${missing.join(', ')}).` : usage);
  process.exit(2);
}

const api = env.PAPERCLIP_API_URL;
const token = env.PAPERCLIP_API_KEY;
const agentId = env.PAPERCLIP_AGENT_ID;
const dir = turnsDir(env.PAPERCLIP_INSTANCE_ROOT);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

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
  if (current && readJson(turnFile(dir, current))?.issueId === found.id && !fs.existsSync(doneFile(dir, current))) {
    console.log(`This turn's run ${current} is already on ${found.identifier}, and $PAPERCLIP_RUN_ID holds it: nothing to move.`);
    process.exit(0);
  }
}
let offset = 0;
try { offset = fs.statSync(env.CLAUDE_DESKTOP_TRANSCRIPT).size; } catch { /* nothing yet */ }
const runId = await openTurnRun({
  api, token, agentId, sessionId: env.CLAUDE_DESKTOP_SESSION_ID, transcript: env.CLAUDE_DESKTOP_TRANSCRIPT,
  cwd: process.cwd(), dir, offset, issueId: found.id,
});
if (!runId) {
  console.error(`${making ? `Made ${found.identifier} "${title}", but ` : ''}Paperclip did not start a run on ${found.identifier} (it may already have a run going, or Paperclip is not answering).`);
  process.exit(1);
}
if (making) {
  const claimed = await checkoutCard({ api, token, issueId: found.id, agentId, runId });
  console.log(`Made ${found.identifier} "${title}", assigned to you${claimed ? ' and in progress' : ' (still in backlog: the checkout did not go through)'}. Paperclip run ${runId} records the rest of this turn on it, and $PAPERCLIP_RUN_ID holds it from your next command on. Before the turn ends, leave ${found.identifier} done, in_review, blocked (with your question for the board as a comment), or in backlog.`);
} else {
  console.log(`Paperclip run ${runId} now records the rest of this turn, on ${found.identifier}, and $PAPERCLIP_RUN_ID holds it from your next command on.`);
}
