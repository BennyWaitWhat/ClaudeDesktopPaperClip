// Move the rest of this Desktop turn to a card's own Paperclip run: the run so far ends here, and a new run tied to
// the card records the rest of the turn. Paperclip lets a run comment on and update its own card freely (up to 20
// others), so an agent runs this when it takes up a card its turn's message did not name. Run inside the agent's
// conversation (its environment comes from the org folder's SessionStart hook, hooks/desktop-session.mjs).
//   node paperclip-card.mjs LEM-8
import fs from 'node:fs';
import { namedCard, openTurnRun, turnsDir } from '../desktop-turn.mjs';

const env = process.env;
const card = process.argv[2];
const need = ['PAPERCLIP_API_URL', 'PAPERCLIP_API_KEY', 'PAPERCLIP_AGENT_ID', 'PAPERCLIP_INSTANCE_ROOT', 'CLAUDE_DESKTOP_SESSION_ID', 'CLAUDE_DESKTOP_TRANSCRIPT'];
const missing = need.filter((k) => !env[k]);
if (!card || missing.length) {
  console.error(!card ? 'Usage: node paperclip-card.mjs <CARD, e.g. LEM-8>' : `Not inside an org agent's Claude Desktop conversation (missing ${missing.join(', ')}).`);
  process.exit(2);
}

const api = env.PAPERCLIP_API_URL;
const token = env.PAPERCLIP_API_KEY;
const found = await namedCard({ api, token, text: card });
if (!found) {
  console.error(`Paperclip has no card ${card}.`);
  process.exit(1);
}
let offset = 0;
try { offset = fs.statSync(env.CLAUDE_DESKTOP_TRANSCRIPT).size; } catch { /* nothing yet */ }
const runId = await openTurnRun({
  api, token, agentId: env.PAPERCLIP_AGENT_ID, sessionId: env.CLAUDE_DESKTOP_SESSION_ID, transcript: env.CLAUDE_DESKTOP_TRANSCRIPT,
  cwd: process.cwd(), dir: turnsDir(env.PAPERCLIP_INSTANCE_ROOT), offset, issueId: found.id,
});
if (!runId) {
  console.error(`Paperclip did not start a run on ${found.identifier} (it may already have a run going, or Paperclip is not answering).`);
  process.exit(1);
}
console.log(`Paperclip run ${runId} now records the rest of this turn, on ${found.identifier}. Send "X-Paperclip-Run-Id: ${runId}" from here on.`);
