// UserPromptSubmit and Stop hook in an org folder (org-folder.mjs puts it in .claude/settings.json).
// - A turn that starts in one of the org's agents' conversations opens a Paperclip run for that agent (wake reason
//   "desktop_turn", with the agent's own lasting key), on the org card its message names if any, and tells the turn
//   its run id; desktop-turn.mjs records the turn into that run. The turn also opens with what happened in Paperclip
//   since the agent's last turn (paperclip-wakes.mjs), and, once, with the agent's instructions when they were edited
//   in Paperclip since the conversation last had them.
// - The turn's end (Stop) closes it.
// A Paperclip run brings its own run and is left alone. Nothing here blocks or changes the turn: when Paperclip is
// not answering, the turn goes on unrecorded.
//   node desktop-turn.mjs --api <Paperclip URL> --instance <Paperclip instance folder> [--chief <agent id>]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedInstructions, endTurnRun, HELLO_ENV, namedCard, openTurnRun, turnsDir } from '../desktop-turn.mjs';
import { agentKey, conversationAgent, hookArgs, hookInput, insidePaperclipRun, paperclipCall } from '../paperclip-access.mjs';
import { inboxText, takeInbox } from '../paperclip-wakes.mjs';

const CARD_TOOL = fileURLToPath(new URL('./paperclip-card.mjs', import.meta.url));

const { api, instance, chiefId } = hookArgs();
if (insidePaperclipRun() || !instance) process.exit(0);

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

// The hello that makes the conversation is setup: what waits for the agent waits for its first real turn.
const hello = process.env[HELLO_ENV] === '1';
const instructions = hello ? null : changedInstructions(dir, input.session_id, who.definition);

let runId = null;
let card = null;
const key = await agentKey({ api, instance, agentId: who.agentId });
if (key) {
  // Where this turn starts in the transcript: everything after this point is the turn.
  let offset = 0;
  try { offset = fs.statSync(input.transcript_path).size; } catch { /* a new conversation */ }
  // Only the org's own cards count ("UTF-8" is not a card).
  const org = key.agent?.companyId ? await paperclipCall(api, `/api/companies/${key.agent.companyId}`, { token: key.token }) : null;
  card = await namedCard({ api, token: key.token, text: input.prompt, prefix: org?.json?.issuePrefix ?? null });
  runId = await openTurnRun({
    api, token: key.token, agentId: who.agentId, sessionId: input.session_id, transcript: input.transcript_path, cwd, dir, offset, issueId: card?.id ?? null,
  });
}

const tool = `node "${CARD_TOOL.replace(/\\/g, '/')}" <CARD>`;
const run = runId
  ? [
    `Paperclip run ${runId} records this turn${card ? `, on ${card.identifier}` : ' (no card: a plain conversation)'}, and $PAPERCLIP_RUN_ID holds it. Send "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" with the Paperclip API calls you make in this turn.`,
    card
      ? `It already runs on ${card.identifier}: comment on it and update it freely (and up to 20 other cards). To move to a different card, first leave ${card.identifier} done, in_review, blocked, or in backlog, then run ${tool}.`
      : `A run with no card can create cards and check one out, but can't comment on or update any. To work on a card in this turn, first run ${tool}; $PAPERCLIP_RUN_ID then holds that card's run.`,
  ].join(' ')
  : `Paperclip opened no run for this turn (${key ? 'it refused the wake; is the agent paused?' : 'Paperclip is not answering'}), so the turn is not recorded there and Paperclip calls that need a run will fail.`;

const context = [
  hello ? '' : inboxText(takeInbox(instance, who.agentId)),
  instructions ? `Your instructions were edited in Paperclip since this conversation got them. From now on they are:\n\n${instructions}` : '',
  run,
].filter(Boolean).join('\n\n');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
