// SessionStart hook in an org folder (org-folder.mjs puts it in .claude/settings.json). Outside a Paperclip run (in
// Claude Desktop, or a terminal):
// - a conversation that runs as one of the org's Paperclip agents gets that agent's own Paperclip access, the way
//   Paperclip gives it to a run: the API address, the agent's own lasting key, its ids and its folder, and the
//   current turn's run id, as environment for the conversation's commands;
// - a plain new conversation is the org's Chief of Staff (--chief): it gets the Chief of Staff's definition as
//   context, and its access.
// It also notes that the conversation has the agent's instructions as they are now, so the turn hook hands over
// later edits once (desktop-turn.mjs, changedInstructions).
// A Paperclip run brings its own access and is left alone.
//   node desktop-session.mjs --api <Paperclip URL> --instance <Paperclip instance folder> [--chief <agent id>]
import fs from 'node:fs';
import path from 'node:path';
import { markSeen, runIdFile, turnsDir } from '../desktop-turn.mjs';
import { agentKey, conversationAgent, hookArgs, hookInput, insidePaperclipRun } from '../paperclip-access.mjs';

const { api, instance, chiefId } = hookArgs();
if (insidePaperclipRun()) process.exit(0);

const input = await hookInput();
if (!input) process.exit(0);
const cwd = input.cwd || process.cwd();
const who = conversationAgent({ cwd, transcriptPath: input.transcript_path, agentType: input.agent_type, chiefId });
if (!who) process.exit(0); // not one of the org's Paperclip agents
const { slug, agentId, definition } = who;
const sessionId = /^[\w-]+$/.test(input.session_id ?? '') ? input.session_id : null;

// What the conversation has of its instructions: an agent conversation loads its agent file when it starts or is
// opened again; the Chief of Staff's plain conversation gets its definition below, except when opened again.
const handedOver = slug ? ['startup', 'resume'].includes(input.source ?? 'startup') : input.source !== 'resume';
if (instance && sessionId && handedOver) markSeen(turnsDir(instance), sessionId, definition);

const say = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
const key = await agentKey({ api, instance, agentId });
if (!key) {
  say(`Paperclip did not answer at ${api}, so this conversation has no Paperclip access. Once Paperclip is running again (paperclipai run), open the conversation again to get it.`);
  process.exit(0);
}

const name = key.agent?.name ?? slug ?? 'the agent';
const companyId = key.agent?.companyId ?? '';
const home = instance && companyId ? path.join(instance, 'companies', companyId, 'agents', agentId, 'instructions') : '';
const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const forward = (p) => String(p).replace(/\\/g, '/');
const exports = [
  ['PAPERCLIP_API_URL', api], ['PAPERCLIP_API_KEY', key.token], ['PAPERCLIP_AGENT_ID', agentId], ['PAPERCLIP_COMPANY_ID', companyId],
  ['AGENT_HOME', home && fs.existsSync(home) ? forward(home) : ''],
  // For hooks/paperclip-card.mjs, which moves the rest of a turn to a card's own run.
  ['PAPERCLIP_INSTANCE_ROOT', instance ? forward(instance) : ''],
  ['CLAUDE_DESKTOP_SESSION_ID', sessionId ?? ''], ['CLAUDE_DESKTOP_TRANSCRIPT', input.transcript_path ? forward(input.transcript_path) : ''],
].filter(([, v]) => v).map(([k, v]) => `export ${k}=${sh(v)}`);
// Claude Code reads this file again before every command, so the run id is always the current turn's.
if (instance && sessionId) exports.push(`export PAPERCLIP_RUN_ID="$(cat ${sh(forward(runIdFile(turnsDir(instance), sessionId)))} 2>/dev/null)"`);
if (process.env.CLAUDE_ENV_FILE) fs.writeFileSync(process.env.CLAUDE_ENV_FILE, `${exports.join('\n')}\n`, { mode: 0o600 });

const access = `Your own Paperclip access is in the environment of your Bash commands: $PAPERCLIP_API_URL, $PAPERCLIP_API_KEY (your agent key), $PAPERCLIP_AGENT_ID, $PAPERCLIP_COMPANY_ID${home ? ', $AGENT_HOME for your agent folder' : ''}, and $PAPERCLIP_RUN_ID, the Paperclip run that records the current turn.`;
const body = definition.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
if (slug) {
  say(`Paperclip: this conversation runs as ${name}, outside a Paperclip run (in Claude Desktop or a terminal). ${access}`);
} else if (input.source === 'resume') {
  say(`Paperclip: you are ${name}, this org's Chief of Staff, in this conversation with the board. ${access}`);
} else {
  say([
    `Paperclip: in this conversation you are ${name}, this org's Chief of Staff, talking with the board in Claude Desktop. The board's requests become work for the team through Paperclip: cards, assignments and follow-ups, as your definition below says. ${access}`,
    body ? `Your definition as a Paperclip agent:\n\n${body}` : '',
  ].filter(Boolean).join('\n\n'));
}
