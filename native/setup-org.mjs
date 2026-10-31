// Sets a folder up as a native team: Paperclip's way of working (an org chart, goals, cards, turns, Benny's approvals,
// reviews and a log) kept on a claude.ai page instead of in Paperclip. Writes the team setup, never the team's own
// files: CLAUDE.md, FACTS.md and the job files in .claude/agents are the team's, made once by hand or by the Chief.
//   1. node setup-org.mjs --folder <team folder> --org "<Team>" --prefix GAP
//      writes .claude/board.html (the page to publish with the Artifact tool, capabilities db and user)
//      and .claude/settings.json (the hooks: a plain chat is the Chief of Staff; every tool but Benny's sends goes ahead).
//   2. node setup-org.mjs --folder <team folder> --org "<Team>" --prefix GAP --board <the published page's link>
//      also writes BOARD.md, the method every member reads each turn (CLAUDE.md imports it: @BOARD.md).
// Options: --chief <agent> (default chief-of-staff). Prints JSON: what it wrote, and any Paperclip files left over.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fwd = (p) => String(p).replace(/\\/g, '/');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (error) => { process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`); process.exit(1); };

const folder = arg('folder') ? path.resolve(arg('folder')) : '';
const org = (arg('org') ?? (folder ? path.basename(folder) : '')).trim();
const prefix = (arg('prefix') ?? '').trim().toUpperCase();
const board = arg('board');
const chief = arg('chief') ?? 'chief-of-staff';
if (!folder || !fs.existsSync(folder)) fail('--folder must be the team folder');
if (!org) fail('--org is the team name');
if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) fail('--prefix is the card prefix, such as GAP');
if (!/^[A-Za-z0-9_-]+$/.test(chief)) fail('--chief is the Chief of Staff job file name');
if (board !== undefined && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+$/.test(board)) fail('--board is the page link, https://claude.ai/artifact/<id>');

const wrote = [];
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  wrote.push(path.relative(folder, file));
};
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The page, named for the team.
write(path.join(folder, '.claude', 'board.html'), fs.readFileSync(path.join(HERE, 'templates', 'board.html'), 'utf8').replaceAll('__ORG__', escapeHtml(org)));

// The hooks. Hooks of anyone else's are kept out of reach: the file is replaced only when every hook in it is ours.
const settingsFile = path.join(folder, '.claude', 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* none yet */ }
const commands = Object.values(settings.hooks ?? {}).flat().flatMap((h) => h?.hooks ?? []).map((h) => String(h?.command ?? ''));
const foreign = commands.filter((c) => !/ClaudeDesktopPaperClip\/(hooks|native\/hooks)\//i.test(fwd(c)));
if (foreign.length) fail(`.claude/settings.json has hooks that are not ClaudeDesktopPaperClip's; merge by hand: ${foreign.join(' | ')}`);
const hook = (script, extra = '') => ({ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(HERE, 'hooks', script))}"${extra}` });
settings.hooks = {
  SessionStart: [{ hooks: [hook('session-start.mjs', ` --chief ${chief}`)] }],
  PreToolUse: [{ matcher: '*', hooks: [hook('allow.mjs')] }],
};
write(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

// The method, once the page has its link.
if (board) {
  const text = fs.readFileSync(path.join(HERE, 'templates', 'BOARD.md'), 'utf8')
    .replaceAll('__BOARD_URL__', board).replaceAll('__PREFIX__', prefix).replaceAll('__ORG__', org)
    .replaceAll('__FOLDER__', folder).replaceAll('__HIRE__', fwd(path.join(HERE, 'hire.mjs')));
  write(path.join(folder, 'BOARD.md'), text);
}

// What Paperclip left that the native team no longer uses.
const leftovers = [];
if (fs.existsSync(path.join(folder, '.claude', 'paperclip-team.md'))) leftovers.push('.claude/paperclip-team.md');
for (const f of fs.existsSync(path.join(folder, '.claude', 'agents')) ? fs.readdirSync(path.join(folder, '.claude', 'agents')) : []) {
  if (/^paperclip-agent-id:/m.test(fs.readFileSync(path.join(folder, '.claude', 'agents', f), 'utf8'))) leftovers.push(`.claude/agents/${f}`);
}
const missing = ['CLAUDE.md', 'FACTS.md', `.claude/agents/${chief}.md`].filter((f) => !fs.existsSync(path.join(folder, f)));
process.stdout.write(`${JSON.stringify({ ok: true, folder, wrote, missing, paperclipLeftovers: leftovers }, null, 2)}\n`);
