// Fixes to Paperclip's own web page, applied to the installed copy (the plugin re-applies them each time it starts,
// so a Paperclip update that ships a new page gets them again).
//
// Onboarding offer takeover: the Dashboard opens the setup wizard by itself for an org with no agents, and that call
// replaces whatever the wizard is doing. With the wizard open on a new org and an agentless org on the Dashboard
// behind it, the new org's first agent was made in the other org (Test ORG's setup landed in CloudFlare,
// 2026-10-09). Fixed by making the Dashboard's automatic offer wait while the wizard is open.
//
// Spinning empty column: the Tasks board draws each column's status icon in its header, and Paperclip spins the
// in-progress icon wherever it appears, so the In Progress header spun with no card in it and no agent working
// (Benny, 2026-10-19: "no agents are working, but the progress column is spinning, why?"). A header icon now spins
// only while its column has cards; a card's own icon is unchanged.
//
//   node paperclip-ui-fixes.mjs            apply (prints what it did)
//   node paperclip-ui-fixes.mjs --check    report only
//   node paperclip-ui-fixes.mjs --restore  put Paperclip's original page back
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsUserEnv } from './desktop.mjs';

export const MARKER = '/*claude-desktop-paperclip:onboarding-offer-v1*/';
const OPEN_FLAG = '__pcOnboardingOpen';
const BACKUP_SUFFIX = '.claude-desktop-paperclip.orig';
const STATE_HOOK_ERROR = 'useDialogState must be used within DialogProvider';

/** Where the installed Paperclip keeps its built page, or null. */
export function findUiDist(env = process.env, nodeDir = path.dirname(process.execPath)) {
  const candidates = [
    env.PAPERCLIP_UI_DIST,
    path.join(nodeDir, 'node_modules', 'paperclipai', 'node_modules', '@paperclipai', 'server', 'ui-dist'),
    path.join(nodeDir, 'node_modules', '@paperclipai', 'server', 'ui-dist'),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', 'paperclipai', 'node_modules', '@paperclipai', 'server', 'ui-dist'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'paperclipai', 'node_modules', '@paperclipai', 'server', 'ui-dist'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The names a chunk exports, as { exported: local }. */
function chunkExports(chunk) {
  const out = {};
  for (const m of chunk.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const [local, exported] = part.trim().split(/\s+as\s+/);
      if (local) out[(exported ?? local).trim()] = local.trim();
    }
  }
  return out;
}

/** The local name the main bundle gives `exported` from `chunkFile`, or null. */
function importAlias(main, chunkFile, exported) {
  const from = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"\\./${esc(chunkFile)}"`, 'g');
  for (const m of main.matchAll(from)) {
    for (const part of m[1].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name?.trim() === exported) return (alias ?? name).trim();
    }
  }
  return null;
}

/**
 * Patch the main bundle's text. `dialogChunks` is [{ file, text }] for the page's other chunks (only the one that
 * defines the dialog state hook matters). Returns { text, status: 'patched' | 'already' | 'unrecognized', reason? }.
 */
export function patchMainBundle(main, dialogChunks) {
  if (main.includes(OPEN_FLAG)) return { text: main, status: 'already' };

  // The Dashboard's automatic offer: useEffect(() => { !should || !company || claim(company) && open({...}) }, [should, company, open])
  const effect = /\(0,([\w$]+)\.useEffect\)\(\(\)=>\{!([\w$]+)\|\|!([\w$]+)\|\|([\w$]+)\(\3\)&&([\w$]+)\(\{companyId:\3,initialStep:([\w$]+)\(\)\}\)\},\[\2,\3,\5\]\)/g;
  const effects = [...main.matchAll(effect)];
  if (effects.length !== 1) return { text: main, status: 'unrecognized', reason: `the Dashboard's offer appears ${effects.length} times` };
  const [found] = effects;
  const [, , should, company, , open] = found;

  // The Dashboard's `{ openOnboarding } = useDialogActions()`, the last one before the effect.
  const actions = `{openOnboarding:${open}}=`;
  const actionsAt = main.lastIndexOf(actions, found.index);
  const call = actionsAt < 0 ? null : main.slice(actionsAt).match(/^\{openOnboarding:[\w$]+\}=[\w$]+\(\),/);
  if (!call || found.index - actionsAt > 20_000) return { text: main, status: 'unrecognized', reason: "the Dashboard's dialog actions were not found" };

  // useDialogState, as the main bundle imports it.
  let stateHook = null;
  for (const chunk of dialogChunks) {
    if (!chunk.text.includes(STATE_HOOK_ERROR)) continue;
    const local = chunk.text.match(new RegExp(`function ([\\w$]+)\\(\\)\\{const ([\\w$]+)=\\(0,[\\w$]+\\.useContext\\)\\([\\w$]+\\);if\\(!\\2\\)throw new Error\\("${esc(STATE_HOOK_ERROR)}"\\)`))?.[1];
    const exported = local && Object.entries(chunkExports(chunk.text)).find(([, l]) => l === local)?.[0];
    stateHook = exported && importAlias(main, chunk.file, exported);
    if (stateHook) break;
  }
  if (!stateHook) return { text: main, status: 'unrecognized', reason: "the main bundle's useDialogState was not found" };

  const insertAt = actionsAt + call[0].length;
  const guardFrom = `{!${should}||!${company}||`;
  const guardAt = main.indexOf(guardFrom, found.index);
  if (guardAt !== found.index + found[0].indexOf(guardFrom)) return { text: main, status: 'unrecognized', reason: 'the offer guard moved' };

  // Later edit first, so the earlier index stays valid.
  let text = main.slice(0, guardAt + guardFrom.length) + `${OPEN_FLAG}||` + main.slice(guardAt + guardFrom.length);
  text = text.slice(0, insertAt) + `{onboardingOpen:${OPEN_FLAG}}=${stateHook}(),` + text.slice(insertAt);
  return { text: `${MARKER}${text}`, status: 'patched' };
}

export const KANBAN_MARKER = '/*claude-desktop-paperclip:kanban-still-v1*/';
// The board's chunk keeps this name for its column colors whatever the chunk file is called.
const KANBAN_TONE = '"getKanbanColumnTone"';
const STILL = '"motion-safe:animate-none"';
const ID = '[\\w$]+';
// A column header: its status icon, then the column name in caps, then the card count.
const OPEN_HEADER = new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{status:(${ID})\\}\\)(?=,\\(0,\\1\\.jsx\\)\\("span",\\{className:(${ID})\\("text-xs font-semibold uppercase tracking-wide",(${ID})\\.header\\),children:${ID}\\(\\3\\)\\}\\),\\(0,\\1\\.jsx\\)\\("span",\\{className:\\4\\("ml-auto text-xs tabular-nums",\\5\\.count\\),children:(${ID})\\.length\\}\\))`, 'g');
// A folded column: the count in its title, then its status icon.
const FOLDED_HEADER = new RegExp(`(?<=title:\`\\$\\{${ID}\\((${ID})\\)\\}: \\$\\{(${ID})\\.length\\}\`,children:\\[)\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{status:\\1\\}\\)`, 'g');

/**
 * Keep the Tasks board's header icons still while their column is empty: each header icon gets
 * className `cards.length ? undefined : "motion-safe:animate-none"`, which Paperclip's class merge (tailwind-merge)
 * lets win over the icon's own `motion-safe:animate-spin`. Returns { text, status, reason? }.
 */
export function patchKanbanHeaders(chunk) {
  if (chunk.startsWith(KANBAN_MARKER)) return { text: chunk, status: 'already' };
  const open = [...chunk.matchAll(OPEN_HEADER)];
  if (open.length !== 1) return { text: chunk, status: 'unrecognized', reason: `the board's column header appears ${open.length} times` };
  const edits = [{ match: open[0], status: open[0][3], cards: open[0][6] }];
  const folded = [...chunk.matchAll(FOLDED_HEADER)];
  if (folded.length > 1) return { text: chunk, status: 'unrecognized', reason: `the folded column header appears ${folded.length} times` };
  if (folded.length) edits.push({ match: folded[0], status: folded[0][1], cards: folded[0][2] });
  let text = chunk;
  // Later edit first, so the earlier index stays valid.
  for (const { match, status, cards } of edits.sort((a, b) => b.match.index - a.match.index)) {
    const call = match[0];
    const patched = call.replace(`{status:${status}}`, () => `{status:${status},className:${cards}.length?void 0:${STILL}}`);
    text = text.slice(0, match.index) + patched + text.slice(match.index + call.length);
  }
  return { text: `${KANBAN_MARKER}${text}`, status: 'patched' };
}

/** The board's chunk file in the page's assets, or null. */
function kanbanChunkOf(assets) {
  const files = fs.readdirSync(assets).filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(assets, f), 'utf8').includes(KANBAN_TONE));
  return files.length === 1 ? path.join(assets, files[0]) : null;
}

const MODULE_SCRIPT = /<script[^>]+type="module"[^>]+src="\/?(assets\/[^"]+\.js)"[^>]*><\/script>/;
const REFRESH_MARKER = '<!-- claude-desktop-paperclip:refresh -->';

/** The page's main bundle file (the script index.html loads). */
function mainBundleOf(uiDist) {
  const src = fs.readFileSync(path.join(uiDist, 'index.html'), 'utf8').match(MODULE_SCRIPT)?.[1];
  return src ? path.join(uiDist, src) : null;
}

/**
 * Paperclip serves its bundle and chunks as cacheable for a year, so a browser that loaded the page before a fix
 * keeps running the old copies. index.html is fetched fresh every time: a small script there downloads the fixed
 * files once per browser (bypassing the cache, which also refreshes it) and reloads the page once. `also` lists
 * fixed chunks besides the main bundle; a new `version` makes every browser do it again.
 */
export function patchIndexHtml(html, version = 'onboarding-offer-v1', also = []) {
  const script = html.match(MODULE_SCRIPT);
  if (!script) return { text: html, status: 'unrecognized', reason: 'index.html has no module script' };
  const bundle = `/${script[1]}`;
  const key = `claude-desktop-paperclip:${version}:${bundle}`;
  const files = [bundle, ...also];
  const load = files.length === 1
    ? `fetch(${JSON.stringify(bundle)},{cache:"reload"}).then(r=>{if(!r.ok)return;`
    : `Promise.all(${JSON.stringify(files)}.map(u=>fetch(u,{cache:"reload"}))).then(rs=>{if(rs.some(r=>!r.ok))return;`;
  const refresh = `${REFRESH_MARKER}<script>(()=>{try{const k=${JSON.stringify(key)};if(localStorage.getItem(k))return;${load}localStorage.setItem(k,"1");location.reload()}).catch(()=>{})}catch{}})()</script>`;
  const without = html.replace(new RegExp(`${esc(REFRESH_MARKER)}<script>[\\s\\S]*?</script>\\s*`), '');
  const text = without.replace(MODULE_SCRIPT, (tag) => `${refresh}\n    ${tag}`);
  return { text, status: text === html ? 'already' : 'patched' };
}

/** True when `text` parses as an ES module (checked with this Node, never run). */
function parsesAsModule(text) {
  // Paperclip starts plugin workers without TEMP, so os.tmpdir() alone can point nowhere.
  const tmp = path.join(windowsUserEnv().TEMP ?? os.tmpdir(), `paperclip-ui-check-${process.pid}-${Date.now()}.mjs`);
  try {
    fs.writeFileSync(tmp, text);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function replaceFile(file, text) {
  if (!fs.existsSync(file + BACKUP_SUFFIX)) fs.copyFileSync(file, file + BACKUP_SUFFIX);
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

/**
 * Apply the fixes to the installed page, each on its own: a Paperclip update that changes one part of the page
 * leaves the other fix working. Returns { status, file?, reason?, fixes: { onboarding, kanban } }; never throws.
 */
export function applyUiFixes({ uiDist = findUiDist(), check = false } = {}) {
  try {
    if (!uiDist) return { status: 'not-found', reason: "Paperclip's built page was not found" };
    const file = mainBundleOf(uiDist);
    if (!file || !fs.existsSync(file)) return { status: 'not-found', reason: 'index.html names no main bundle' };
    const main = fs.readFileSync(file, 'utf8');
    const assets = path.dirname(file);
    // The other chunks are only needed to patch, not to see that it is done.
    const chunks = main.includes(OPEN_FLAG) ? [] : fs.readdirSync(assets).filter((f) => f.endsWith('.js') && path.join(assets, f) !== file)
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(assets, f), 'utf8') }))
      .filter((c) => c.text.includes(STATE_HOOK_ERROR));
    const bundle = patchMainBundle(main, chunks);
    const kanbanFile = kanbanChunkOf(assets);
    const kanban = kanbanFile ? patchKanbanHeaders(fs.readFileSync(kanbanFile, 'utf8')) : { status: 'unrecognized', reason: "the Tasks board's chunk was not found" };
    const htmlFile = path.join(uiDist, 'index.html');
    const boardFixed = kanban.status !== 'unrecognized';
    const html = patchIndexHtml(fs.readFileSync(htmlFile, 'utf8'), boardFixed ? 'ui-fixes-v2' : 'onboarding-offer-v1', boardFixed ? [`/assets/${path.basename(kanbanFile)}`] : []);
    const report = (result, extra = {}) => ({ status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...extra });
    const fixes = { onboarding: report(bundle), kanban: report(kanban, kanbanFile ? { file: kanbanFile } : {}) };
    const all = [bundle, kanban];
    if (check) return { status: [...all, html].some((r) => r.status === 'patched') ? 'needed' : all.some((r) => r.status === 'unrecognized') ? 'unrecognized' : 'already', file, fixes };
    for (const [result, target, name] of [[bundle, file, 'onboarding'], [kanban, kanbanFile, 'kanban']]) {
      if (result.status !== 'patched') continue;
      if (parsesAsModule(result.text)) replaceFile(target, result.text);
      else fixes[name] = { status: 'unrecognized', reason: 'the patched file did not parse; left as it was' };
    }
    if (html.status === 'patched') replaceFile(htmlFile, html.text);
    const statuses = Object.values(fixes).map((f) => f.status);
    const status = statuses.includes('patched') || html.status === 'patched' ? 'patched' : statuses.includes('unrecognized') ? 'unrecognized' : 'already';
    const reason = Object.entries(fixes).filter(([, f]) => f.reason).map(([name, f]) => `${name}: ${f.reason}`).join('; ');
    return { status, file, ...(reason ? { reason } : {}), fixes };
  } catch (error) {
    return { status: 'error', reason: error.message };
  }
}

/** Put Paperclip's original page back (every file a fix replaced). */
export function restoreUi({ uiDist = findUiDist() } = {}) {
  const file = uiDist && mainBundleOf(uiDist);
  const dirs = [uiDist, file && path.dirname(file)].filter(Boolean);
  const restored = dirs.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith(BACKUP_SUFFIX)).map((f) => path.join(dir, f.slice(0, -BACKUP_SUFFIX.length))));
  for (const f of restored) fs.copyFileSync(f + BACKUP_SUFFIX, f);
  return restored.length ? { status: 'restored', files: restored } : { status: 'nothing-to-restore' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.includes('--restore') ? restoreUi() : applyUiFixes({ check: process.argv.includes('--check') });
  console.log(JSON.stringify(result));
}
