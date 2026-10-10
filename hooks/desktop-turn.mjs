// UserPromptSubmit and Stop hook in an org folder (org-folder.mjs puts it in .claude/settings.json).
// - A turn that starts in one of the org's agents' conversations opens a Paperclip run for that agent (wake reason
//   "desktop_turn", with the agent's own lasting key), and tells the turn its run id; desktop-turn.mjs records the
//   turn into that run.
// - The turn's end (Stop) closes it.
// A Paperclip run brings its own run and is left alone. Nothing here blocks or changes the turn: when Paperclip is
// not answering, the turn goes on unrecorded.
//   node desktop-turn.mjs --api <Paperclip URL> --instance <Paperclip instance folder> [--chief <agent id>]
import fs from 'node:fs';
import path from 'node:path';
import { doneFile, DESKTOP_TURN_REASON, sessionFile, turnFile, turnsDir } from '../desktop-turn.mjs';
import { agentKey, conversationAgent, hookArgs, hookInput, paperclipCall } from '../paperclip-access.mjs';

const { api, instance, chiefId } = hookArgs();
if (process.env.PAPERCLIP_RUN_ID || !instance) process.exit(0);

const input = await hookInput();
if (!input?.session_id || !/^[\w-]+$/.test(input.session_id)) process.exit(0);
const dir = turnsDir(instance);
const writePrivate = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); };

if (input.hook_event_name === 'Stop') {
  const runId = JSON.parse(fs.existsSync(sessionFile(dir, input.session_id)) ? fs.readFileSync(sessionFile(dir, input.session_id), 'utf8') : '{}').runId;
  if (runId && fs.existsSync(turnFile(dir, runId))) writePrivate(doneFile(dir, runId), { at: new Date().toISOString() });
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

const woke = await paperclipCall(api, `/api/agents/${who.agentId}/wakeup`, {
  method: 'POST',
  token: key.token,
  body: { source: 'on_demand', triggerDetail: 'manual', reason: DESKTOP_TURN_REASON, idempotencyKey: `desktop-turn:${input.session_id}:${offset}` },
});
const runId = woke.status === 202 && typeof woke.json?.id === 'string' && woke.json?.agentId === who.agentId ? woke.json.id : null;
if (!runId) process.exit(0);

writePrivate(turnFile(dir, runId), { runId, agentId: who.agentId, sessionId: input.session_id, transcript: input.transcript_path, offset, cwd, startedAt: new Date().toISOString() });
writePrivate(sessionFile(dir, input.session_id), { runId });
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: `Paperclip run ${runId} records this turn. Send the header "X-Paperclip-Run-Id: ${runId}" with the Paperclip API calls you make in this turn; it is what lets you check out a card or answer a question card.`,
  },
}));
