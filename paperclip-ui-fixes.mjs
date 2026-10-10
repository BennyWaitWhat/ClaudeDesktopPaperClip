// Fixes to Paperclip's own web page, applied to the installed copy (the plugin re-applies them each time it starts,
// so a Paperclip update that ships a new page gets them again).
//
// Onboarding offer takeover: the Dashboard opens the setup wizard by itself for an org with no agents, and that call
// replaces whatever the wizard is doing. With the wizard open on a new org and an agentless org on the Dashboard
// behind it, the new org's first agent was made in the other org (Test ORG's setup landed in CloudFlare,
// 2026-10-09). Fixed by making the Dashboard's automatic offer wait while the wizard is open.
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

const MODULE_SCRIPT = /<script[^>]+type="module"[^>]+src="\/?(assets\/[^"]+\.js)"[^>]*><\/script>/;
const REFRESH_MARKER = '<!-- claude-desktop-paperclip:refresh -->';

/** The page's main bundle file (the script index.html loads). */
function mainBundleOf(uiDist) {
  const src = fs.readFileSync(path.join(uiDist, 'index.html'), 'utf8').match(MODULE_SCRIPT)?.[1];
  return src ? path.join(uiDist, src) : null;
}

/**
 * Paperclip serves its bundle as cacheable for a year, so a browser that loaded the page before the fix keeps
 * running the old copy. index.html is fetched fresh every time: a small script there downloads the fixed bundle
 * once per browser (bypassing the cache, which also refreshes it) and reloads the page once.
 */
export function patchIndexHtml(html, version = 'onboarding-offer-v1') {
  const script = html.match(MODULE_SCRIPT);
  if (!script) return { text: html, status: 'unrecognized', reason: 'index.html has no module script' };
  const bundle = `/${script[1]}`;
  const key = `claude-desktop-paperclip:${version}:${bundle}`;
  const refresh = `${REFRESH_MARKER}<script>(()=>{try{const k=${JSON.stringify(key)};if(localStorage.getItem(k))return;fetch(${JSON.stringify(bundle)},{cache:"reload"}).then(r=>{if(!r.ok)return;localStorage.setItem(k,"1");location.reload()}).catch(()=>{})}catch{}})()</script>`;
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

/** Apply the fixes to the installed page. Returns { status, file?, reason? }; never throws. */
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
    const htmlFile = path.join(uiDist, 'index.html');
    const html = patchIndexHtml(fs.readFileSync(htmlFile, 'utf8'));
    if (bundle.status === 'unrecognized') return { status: 'unrecognized', file, reason: bundle.reason };
    if (check) return { status: bundle.status === 'patched' || html.status === 'patched' ? 'needed' : 'already', file };
    if (bundle.status === 'patched') {
      if (!parsesAsModule(bundle.text)) return { status: 'unrecognized', file, reason: 'the patched page did not parse; left as it was' };
      replaceFile(file, bundle.text);
    }
    if (html.status === 'patched') replaceFile(htmlFile, html.text);
    return { status: bundle.status === 'patched' || html.status === 'patched' ? 'patched' : 'already', file };
  } catch (error) {
    return { status: 'error', reason: error.message };
  }
}

/** Put Paperclip's original page back. */
export function restoreUi({ uiDist = findUiDist() } = {}) {
  const file = uiDist && mainBundleOf(uiDist);
  const restored = [file, uiDist && path.join(uiDist, 'index.html')].filter((f) => f && fs.existsSync(f + BACKUP_SUFFIX));
  for (const f of restored) fs.copyFileSync(f + BACKUP_SUFFIX, f);
  return restored.length ? { status: 'restored', files: restored } : { status: 'nothing-to-restore' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.includes('--restore') ? restoreUi() : applyUiFixes({ check: process.argv.includes('--check') });
  console.log(JSON.stringify(result));
}
