// UserPromptSubmit hook for a Paperclip turn (see native-turn.mjs). Hands Claude Paperclip's details for the turn
// as context, so the message itself stays what the person wrote. A conversation that already has replies gets
// Paperclip's shorter version.
//   node turn-context.mjs <full context file> <shorter context file>
import fs from 'node:fs';

const [fullFile, deltaFile] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;

let continuing = false;
try {
  const transcript = JSON.parse(input).transcript_path;
  continuing = Boolean(transcript) && fs.readFileSync(transcript, 'utf8').includes('"type":"assistant"');
} catch { /* a new conversation */ }

const file = continuing && deltaFile ? deltaFile : fullFile;
const text = fs.readFileSync(file, 'utf8').trim();
if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
