// SessionStart hook in a native team folder (setup-org.mjs puts it in .claude/settings.json). A plain new chat in the
// folder is the team's Chief of Staff: it gets the Chief's job file as context, as Paperclip's org folders did
// (hooks/desktop-session.mjs). A member's own conversation (made by hire.mjs with --agent) already runs as that member
// and loads its job file itself, so it gets nothing here; neither does the hello turn that makes it.
//   node session-start.mjs --chief <agent file name>
import fs from 'node:fs';
import path from 'node:path';
import { conversationSlug, hookInput } from '../../paperclip-access.mjs';
import { HELLO_ENV, teamFolderOf } from '../team.mjs';

if (process.env[HELLO_ENV]) process.exit(0);
const input = await hookInput();
if (!input) process.exit(0);
if (conversationSlug({ transcriptPath: input.transcript_path, agentType: input.agent_type })) process.exit(0);

const i = process.argv.indexOf('--chief');
const chief = (i > 0 && /^[A-Za-z0-9_-]+$/.test(process.argv[i + 1] ?? '')) ? process.argv[i + 1] : 'chief-of-staff';
const folder = teamFolderOf(input.cwd || process.cwd()) ?? (input.cwd || process.cwd());
let definition = '';
try { definition = fs.readFileSync(path.join(folder, '.claude', 'agents', `${chief}.md`), 'utf8'); } catch { /* no job file */ }
const body = definition.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

const say = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
if (input.source === 'resume') {
  say(`In this conversation you are the team's Chief of Staff (.claude/agents/${chief}.md), talking with Benny.`);
} else if (body) {
  say(`In this conversation you are the team's Chief of Staff, talking with Benny in Claude Desktop. Your job file (.claude/agents/${chief}.md):\n\n${body}`);
}
