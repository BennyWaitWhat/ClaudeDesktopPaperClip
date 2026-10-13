// PreToolUse hook (every tool) in an org folder (org-folder.mjs puts it in .claude/settings.json). Claude Desktop runs
// the conversations it is handed in "accept edits" mode at most (it never imports bypass), so without this every Bash
// command and most other tools would ask you first, including while you are away.
//   - An agent whose Paperclip "Skip permissions" switch is on (Paperclip's default for Claude agents; the agent file
//     carries it, agent-files.mjs) goes ahead without asking, the way Paperclip's own Claude type runs it.
//   - Any other conversation in the folder gets its Paperclip calls approved and nothing else: curl to this
//     Paperclip's own API, and hooks/paperclip-card.mjs, with echo, printf, jq, head, tail or sleep alongside. Anything
//     else gets no answer from this hook and is decided as usual.
// Turning the switch in Paperclip applies from the agent's next tool call (the plugin rewrites the agent file).
//   node paperclip-allow.mjs --api <Paperclip URL> [--chief <Chief of Staff id>]
import { fileURLToPath } from 'node:url';

const CARD_TOOL = fileURLToPath(new URL('./paperclip-card.mjs', import.meta.url));
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/** Shell words of one simple command, quotes removed; null when it uses anything this hook does not judge. */
function splitCommand(command) {
  const segments = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (c === '`' || (c === '$' && s[i + 1] === '(')) return null; // command substitution, quoted or not
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length) word += s[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (c === '\\' && i + 1 < s.length) { word = (word ?? '') + s[++i]; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === ';') { endSegment(); continue; }
    if (c === '|' || c === '&') {
      if (c === '&' && s[i + 1] !== '&') return null; // runs in the background
      if (s[i + 1] === c) i++;
      endSegment();
      continue;
    }
    if (c === '2' && word === null && s.startsWith('2>/dev/null', i)) { i += '2>/dev/null'.length - 1; continue; }
    if (c === '2' && word === null && s.startsWith('2>&1', i)) { i += 3; continue; }
    const braced = c === '$' ? /^\$\{[A-Za-z_]\w*\}/.exec(s.slice(i)) : null; // ${NAME}
    if (braced) { word = (word ?? '') + braced[0]; i += braced[0].length - 1; continue; }
    if (c === '<' || c === '>' || c === '(' || c === ')' || c === '{' || c === '}') return null; // redirection, subshells, groups
    word = (word ?? '') + c;
  }
  if (quote) return null;
  endSegment();
  return segments;
}

const FLAGS = new Set(['-s', '-S', '-f', '-L', '-i', '-v', '-G', '-g', '--silent', '--show-error', '--fail', '--fail-with-body', '--location', '--include', '--get', '--globoff', '--compressed', '--verbose']);
const WITH_VALUE = new Set(['-X', '-H', '-d', '-w', '-m', '--request', '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '--write-out', '--max-time', '--connect-timeout', '--url']);
const SHORT_FLAGS = new Set('sSfLivGg');
const SHORT_WITH_VALUE = new Set('XHdwm');

/** True for a curl command whose every address is this Paperclip's API. */
function paperclipCurl(args, bases) {
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { urls.push(a); continue; }
    const [name, attached] = a.startsWith('--') ? [a.split('=')[0], a.includes('=') ? a.slice(a.indexOf('=') + 1) : null] : [a, null];
    if (FLAGS.has(name)) continue;
    if ((name === '-o' || name === '--output') && (attached ?? args[i + 1]) === '/dev/null') { if (attached === null) i++; continue; }
    if (WITH_VALUE.has(name)) {
      const value = attached ?? args[++i];
      if (value === undefined) return false;
      if (name === '--url') urls.push(value);
      continue;
    }
    if (!a.startsWith('--')) {
      // Bundled short options: -sS, -fsSL, -sX POST, -XPOST.
      let ok = true;
      for (let j = 1; j < a.length; j++) {
        if (SHORT_FLAGS.has(a[j])) continue;
        if (SHORT_WITH_VALUE.has(a[j])) { if (j === a.length - 1) { if (args[++i] === undefined) ok = false; } break; }
        ok = false;
        break;
      }
      if (ok) continue;
    }
    return false;
  }
  return urls.length > 0 && urls.every((u) => bases.some((b) => u === b || u.startsWith(`${b}/`) || u.startsWith(`${b}?`)));
}

// A plain shell variable holding an id (ID=1b2c-..., CARD=LEM-8); never one that steers curl or the shell, or
// Paperclip's own settings, and never a value with anything but letters, digits, dots, dashes and underscores.
const STEERS = /PROXY|^(PATH|HOME|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND)$|^(CURL|XDG|SSL|LD|NODE|PAPERCLIP)_/i;
const isIdVariable = (w) => {
  const m = /^([A-Za-z_]\w*)=([\w.-]*)$/.exec(w);
  return Boolean(m) && !STEERS.test(m[1]);
};
const PASSIVE = new Set(['echo', 'printf', 'jq', 'head', 'tail']);

/** True when every part of the command is a Paperclip call (or echo, printf, jq, head, tail, sleep alongside). */
export function paperclipOnly(command, { api }) {
  const segments = splitCommand(command);
  if (!segments?.length) return false;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.exec(String(api ?? '').replace(/\/+$/, ''));
  const bases = ['$PAPERCLIP_API_URL', '${PAPERCLIP_API_URL}', ...(local ? [`http://127.0.0.1${local[2] ?? ''}`, `http://localhost${local[2] ?? ''}`] : [])];
  let calls = 0;
  for (const segment of segments) {
    let start = 0;
    while (start < segment.length && segment[start].includes('=') && !segment[start].startsWith('-')) {
      if (!isIdVariable(segment[start])) return false;
      start++;
    }
    const [cmd, ...args] = segment.slice(start);
    if (cmd === undefined) continue; // only setting id variables
    if (cmd === 'curl') { if (!paperclipCurl(args, bases)) return false; calls++; continue; }
    if (cmd === 'node') {
      if (!args.length || norm(args[0]) !== norm(CARD_TOOL)) return false;
      const rest = args.slice(1);
      const moving = rest.length === 1 && /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(rest[0]);
      const making = rest[0] === '--new' && (rest.length === 2 || (rest.length === 4 && rest[2] === '--body'));
      if (!moving && !making) return false;
      calls++;
      continue;
    }
    if (PASSIVE.has(cmd)) continue;
    if (cmd === 'sleep' && args.length === 1 && /^\d{1,3}(\.\d+)?$/.test(args[0])) continue;
    return false;
  }
  return calls > 0;
}

/** The hook's answer for one tool call, or null to leave it to the usual question. */
export function decide(input, { api, chiefId = null, agentFor }) {
  const agent = agentFor({ cwd: input?.cwd, transcriptPath: input?.transcript_path, agentType: input?.agent_type, chiefId });
  if (agent?.skip) return { permissionDecision: 'allow', permissionDecisionReason: 'Skip permissions is on for this agent in Paperclip (ClaudeDesktopPaperClip)' };
  if (input?.tool_name === 'Bash' && paperclipOnly(input.tool_input?.command, { api })) {
    return { permissionDecision: 'allow', permissionDecisionReason: 'A call to this Paperclip (ClaudeDesktopPaperClip)' };
  }
  return null;
}

if (process.argv[1] && norm(fileURLToPath(import.meta.url)) === norm(process.argv[1])) {
  const { conversationAgent, hookArgs, hookInput, skipsPermissionsIn } = await import('../paperclip-access.mjs');
  const { api, chiefId } = hookArgs();
  const input = await hookInput();
  const agentFor = (where) => {
    if (!where.cwd) return null;
    const agent = conversationAgent(where);
    return agent ? { ...agent, skip: skipsPermissionsIn(agent.definition) } : null;
  };
  const answer = input ? decide(input, { api, chiefId, agentFor }) : null;
  if (answer) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...answer } }));
}
