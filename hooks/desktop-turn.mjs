// UserPromptSubmit and Stop hook in an org folder (org-folder.mjs puts it in .claude/settings.json).
// - A turn that starts in one of the org's agents' conversations opens a Paperclip run for that agent (wake reason
//   "desktop_turn", with the agent's own lasting key), on the card its message names if any, and tells the turn its
//   run id; desktop-turn.mjs records the turn into that run.
// - The turn's end (Stop) closes it.
// A Paperclip run brings its own run and is left alone. Nothing here blocks or changes the turn: when Paperclip is
// not answering, the turn goes on unrecorded.
//   node desktop-turn.mjs --api <Paperclip URL> --instance <Paperclip instance folder> [--chief <agent id>]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endTurnRun, namedCard, openTurnRun, turnsDir } from '../desktop-turn.mjs';
import { agentKey, conversationAgent, hookArgs, hookInput } from '../paperclip-access.mjs';

const CARD_TOOL = fileURLToPath(new URL('./paperclip-card.mjs', import.meta.url));

const { api, instance, chiefId } = hookArgs();
if (process.env.PAPERCLIP_RUN_ID || !instance) process.exit(0);

const input = await hookInput();
if (!input?.session_id || !/^[\w-]+$/.test(input.session_id)) process.exit(0);
const dir = turnsDir(instance);

if (input.hook_event_name === 'Stop') {
  endTurnRun(dir, input.session_id);
  process.exit(0);
}
if (input.hook_event_name !== 'UserPromptSubmit') process.exit(0);

const cwd = input.cwd || process.cwd();
const who = conversationAgent({ cwd, transcriptPath: input.transcript_path, agentType: input.agent_type, chiefId });
if (!who || !input.transcript_path) process.exit(0);
const key = await agentKey({ api, instance, agentId: who.agentId });
if (!key) process.exit(0);

// Where this turn starts in the transcript: everything after this point is the turn.
let offset = 0;
try { offset = fs.statSync(input.transcript_path).size; } catch { /* a new conversation */ }

const card = await namedCard({ api, token: key.token, text: input.prompt });
const runId = await openTurnRun({
  api, token: key.token, agentId: who.agentId, sessionId: input.session_id, transcript: input.transcript_path, cwd, dir, offset, issueId: card?.id ?? null,
});
if (!runId) process.exit(0);

const tool = `node "${CARD_TOOL.replace(/\\/g, '/')}" <CARD>`;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: [
      `Paperclip run ${runId} records this turn${card ? `, on ${card.identifier}` : ' (no card: a plain conversation)'}. Send the header "X-Paperclip-Run-Id: ${runId}" with the Paperclip API calls you make in this turn.`,
      card
        ? `It can comment on and update ${card.identifier} freely, and up to 20 other cards. To move the rest of this turn to another card, run ${tool}; it prints that card's run id.`
        : `A run with no card can create cards and check one out, but can't comment on or update any. To work on a card in this turn, first run ${tool}; it prints that card's run id for the rest of the turn.`,
    ].join(' '),
  },
}));
