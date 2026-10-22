// PreToolUse hook (every tool) in an org folder (org-folder.mjs puts it in .claude/settings.json). Claude Desktop runs
// the conversations it is handed in "accept edits" mode at most (it never imports bypass), so without this every Bash
// command and most other tools would ask you first, including while you are away.
//   - An agent whose Paperclip "Skip permissions" switch is on (Paperclip's default for Claude agents; the agent file
//     carries it, agent-files.mjs) goes ahead without asking, the way Paperclip's own Claude type runs it.
//   - Any other conversation in the folder gets its Paperclip calls approved and nothing else: curl to this
//     Paperclip's own API, and hooks/paperclip-card.mjs, with echo, printf, jq, head, tail or sleep alongside. Anything
//     else gets no answer from this hook and is decided as usual.
//   - No conversation here, whatever its switch, sends, deletes, trashes, shares or changes a calendar in Benny's
//     Gmail, Calendar or Drive itself (WORDS_ONLY): the call is refused with the checked path that does it on his words.
// Turning the switch in Paperclip applies from the agent's next tool call (the plugin rewrites the agent file).
//   node paperclip-allow.mjs --api <Paperclip URL> [--chief <Chief of Staff id>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CARD_TOOL = fileURLToPath(new URL('./paperclip-card.mjs', import.meta.url));
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();

// What only Benny's own words open (2026-10-21). Asked who may act once the team's own calls are held, he answered
// "sounds good." to sends going "through the checked path (google-tools.mjs --benny-said ...) ... One send per
// go-ahead.", and picked "On your words" for deleting, trashing, sharing and calendar changes. The checked path is
// google-tools.mjs in Career Catchers' folder: it acts only on words he typed himself in Claude Desktop in the last 24
// hours, one action per go-ahead. Claude Desktop names his connectors claude_ai_<Name> in the team's conversations and
// by their ids (mcp__<uuid>__) elsewhere; a connector of any other name is held by the tool's name alone.
export const WORDS_ONLY = {
  Gmail: ['send_message', 'reply', 'forward', 'delete_draft', 'delete_label', 'trash_message', 'trash_thread'],
  Google_Calendar: ['create_event', 'update_event', 'delete_event', 'respond_to_event'],
  Google_Drive: ['share_file', 'trash_file'],
};
const HELD = [...new Set(Object.values(WORDS_ONLY).flat())];

// Teams whose calendar changes need no words from him. Benny, 2026-10-22, in Career Catchers' thread, quoting our
// "calendar changes": "not needed for calendar. yall have been doing a good job." The calls stay held, so they go
// through the helper, whose plain run changes only the events a request names and adds no guest it does not name.
// Other teams keep his words for calendar changes until he says otherwise.
export const CALENDAR_FREE = new Set(['Career Catchers']);
const CONNECTOR_TOOL = /^mcp__(?:claude_ai_([A-Za-z0-9_]+?)|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})__([a-z0-9_]+)$/;

/** True for a call to one of Benny's claude.ai connectors that only his own words open. */
export function wordsOnly(toolName) {
  const m = CONNECTOR_TOOL.exec(String(toolName ?? ''));
  return Boolean(m) && (WORDS_ONLY[m[1]] ?? HELD).includes(m[2]);
}

/** google-tools.mjs in the org folder or in one beside it (his orgs share one parent folder); null when none is. */
export function checkedPathFor(org) {
  if (!org) return null;
  let beside = [];
  try { beside = fs.readdirSync(path.dirname(org), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(path.dirname(org), d.name)); } catch { /* none */ }
  return [org, ...beside].map((d) => path.join(d, 'google-tools.mjs')).find((f) => fs.existsSync(f)) ?? null;
}

/**
 * What a held call is told: the checked path, with the full command when google-tools.mjs was found. A draft or
 * message call also hears the one delete that needs no words: a draft the team itself staged through google-tools.mjs
 * and has replaced (Benny, 2026-10-09: "latter."; 2026-10-21: "You should be able to delete drafts.").
 */
export function heldReason(tool, toolName = '', { org = null } = {}) {
  const node = `node ${tool ? `"${tool}"` : 'google-tools.mjs'}`;
  const team = org ? path.basename(org) : '';
  if (CALENDAR_FREE.has(team) && /^mcp__claude_ai_Google_Calendar__/.test(String(toolName))) {
    return `Held in Benny's team folders, so it goes through the helper. In ${team} a calendar change needs no words from him (Benny, 2026-10-22: "not needed for calendar. yall have been doing a good job."): ${node} "<the change: which event, and what to add, move, remove or answer>". It changes only the events the request names and adds no guest the request does not name.`;
  }
  const own = /__(delete_draft|trash_message|trash_thread)$/.test(String(toolName))
    ? ` A draft the team staged itself through google-tools.mjs and has replaced needs no words: ${node} --delete-draft <draft-id>.` : '';
  return `Held in Benny's team folders (Benny, 2026-10-21): sending, replying, forwarding, deleting, trashing, sharing and calendar changes happen only on his own words, through the checked path: ${node} --benny-said "<his exact words>" "<what to do>". It acts only if he typed those words himself in Claude Desktop in the last 24 hours, one action per go-ahead.${own} Without his words, stage it (a draft, or the change written on a card) and ask him.`;
}

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
export function decide(input, { api, chiefId = null, agentFor, orgOf = () => null }) {
  if (wordsOnly(input?.tool_name)) {
    const org = orgOf(input?.cwd);
    return { permissionDecision: 'deny', permissionDecisionReason: heldReason(checkedPathFor(org), input.tool_name, { org }) };
  }
  const agent = agentFor({ cwd: input?.cwd, transcriptPath: input?.transcript_path, agentType: input?.agent_type, chiefId });
  if (agent?.skip) return { permissionDecision: 'allow', permissionDecisionReason: 'Skip permissions is on for this agent in Paperclip (ClaudeDesktopPaperClip)' };
  if (input?.tool_name === 'Bash' && paperclipOnly(input.tool_input?.command, { api })) {
    return { permissionDecision: 'allow', permissionDecisionReason: 'A call to this Paperclip (ClaudeDesktopPaperClip)' };
  }
  return null;
}

if (process.argv[1] && norm(fileURLToPath(import.meta.url)) === norm(process.argv[1])) {
  const { conversationAgent, hookArgs, hookInput, orgFolderOf, skipsPermissionsIn } = await import('../paperclip-access.mjs');
  const { api, chiefId } = hookArgs();
  const input = await hookInput();
  const agentFor = (where) => {
    if (!where.cwd) return null;
    const agent = conversationAgent(where);
    return agent ? { ...agent, skip: skipsPermissionsIn(agent.definition) } : null;
  };
  const orgOf = (cwd) => (cwd ? orgFolderOf(cwd) : null);
  const answer = input ? decide(input, { api, chiefId, agentFor, orgOf }) : null;
  if (answer) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...answer } }));
}
