import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyUiFixes, KANBAN_MARKER, MARKER, patchIndexHtml, patchKanbanHeaders, patchMainBundle, restoreUi, unpatchIndexHtml } from '../paperclip-ui-fixes.mjs';

// Shaped like Paperclip's built page (2026.1005.0): the Dashboard takes openOnboarding from useDialogActions and
// offers onboarding in an effect; the dialog hooks live in a shared chunk the main bundle imports under short names.
const IMPORTS = 'import{a as L5,i as zo}from"./heartbeats-AAAA1111.js";';
const DASHBOARD = 'function rft(){const{selectedCompanyId:e,companies:s}=ps(),{openOnboarding:n}=zo(),a=Xr();const v=MYe({});(0,u.useEffect)(()=>{!v||!e||uat(e)&&n({companyId:e,initialStep:t3()})},[v,e,n]);return null}';
const CHUNK = {
  file: 'heartbeats-AAAA1111.js',
  text: 'function B(){const e=(0,s.useContext)(_);if(!e)throw new Error("useDialogActions must be used within DialogProvider");return e}function V(){const e=(0,s.useContext)(M);if(!e)throw new Error("useDialogState must be used within DialogProvider");return e}export{V as a,B as i};',
};

/** Run the (patched) Dashboard once with the wizard open or closed; returns the onboarding calls it made. */
function runDashboard(code, { wizardOpen }) {
  const calls = [];
  const body = code.replace(MARKER, '').replace(IMPORTS, '');
  const effects = [];
  const run = new Function('ps', 'zo', 'L5', 'Xr', 'MYe', 'u', 'uat', 't3', `${body}; rft();`);
  run(
    () => ({ selectedCompanyId: 'org-a', companies: [] }),
    () => ({ openOnboarding: (options) => calls.push(options) }),
    () => ({ onboardingOpen: wizardOpen }),
    () => ({}),
    () => true,
    { useEffect: (fn) => effects.push(fn) },
    () => true,
    () => 3,
  );
  for (const fn of effects) fn();
  return calls;
}

test('the Dashboard offer waits while the setup wizard is open', () => {
  const main = IMPORTS + DASHBOARD;
  assert.deepEqual(runDashboard(main, { wizardOpen: true }), [{ companyId: 'org-a', initialStep: 3 }], 'unpatched: the offer takes over the open wizard');

  const patched = patchMainBundle(main, [CHUNK]);
  assert.equal(patched.status, 'patched');
  assert.ok(patched.text.startsWith(MARKER));
  assert.match(patched.text, /\{openOnboarding:n\}=zo\(\),\{onboardingOpen:__pcOnboardingOpen\}=L5\(\),a=Xr\(\)/);
  assert.deepEqual(runDashboard(patched.text, { wizardOpen: true }), [], 'patched: no takeover while the wizard is open');
  assert.deepEqual(runDashboard(patched.text, { wizardOpen: false }), [{ companyId: 'org-a', initialStep: 3 }], 'patched: the offer still works when the wizard is closed');

  assert.equal(patchMainBundle(patched.text, [CHUNK]).status, 'already');
});

test('a page it does not recognize is left exactly as it was', () => {
  const changed = IMPORTS + DASHBOARD.replace('initialStep:t3()', 'initialStep:t3(),source:"dashboard"');
  const result = patchMainBundle(changed, [CHUNK]);
  assert.equal(result.status, 'unrecognized');
  assert.equal(result.text, changed);
  assert.equal(patchMainBundle(IMPORTS + DASHBOARD, []).status, 'unrecognized', 'no dialog chunk: no guess');
});

// Shaped like Paperclip's index.html (2026.1005.0), with the refresh script this file put there from 2026-10-09 to 10-19.
const PAGE = '<head>\n    <script>(() => { /* theme */ })();</script>\n    <script type="module" crossorigin src="/assets/index-ChaaJ8xT.js"></script>\n    <link rel="modulepreload" crossorigin href="/assets/createLucideIcon-DNYM09J7.js">\n    <link rel="modulepreload" crossorigin href="/assets/RoutineRunVariablesDialog-wOU7aljJ.js">\n  </head>';
const OLD_REFRESH = '<!-- claude-desktop-paperclip:refresh --><script>(()=>{try{const k="claude-desktop-paperclip:ui-fixes-v2:/assets/index-ChaaJ8xT.js";if(localStorage.getItem(k))return;location.reload()}catch{}})()</script>\n    ';
const REFRESHED_PAGE = PAGE.replace('<script type="module"', () => `${OLD_REFRESH}<script type="module"`);

test('index.html sends every import of a fixed file to an address no browser has kept', () => {
  const fresh = [{ file: '/assets/index-ChaaJ8xT.js', stamp: 'aaaa111111' }, { file: '/assets/RoutineRunVariablesDialog-wOU7aljJ.js', stamp: 'bbbb222222' }];
  const result = patchIndexHtml(REFRESHED_PAGE, fresh);
  assert.equal(result.status, 'patched');
  assert.ok(!result.text.includes('claude-desktop-paperclip:refresh'), 'the old reload-once script is gone');
  const map = JSON.parse(result.text.match(/<script type="importmap">([^<]*)<\/script>/)[1]);
  assert.deepEqual(map, { imports: {
    '/assets/index-ChaaJ8xT.js': '/assets/index-ChaaJ8xT.js?cdpc=aaaa111111',
    '/assets/RoutineRunVariablesDialog-wOU7aljJ.js': '/assets/RoutineRunVariablesDialog-wOU7aljJ.js?cdpc=bbbb222222',
  } });
  assert.ok(result.text.indexOf('type="importmap"') < result.text.indexOf('type="module"'), 'the map comes before any module loads');
  assert.match(result.text, /<script type="module" crossorigin data-cdpc-entry="\/assets\/index-ChaaJ8xT\.js">import "\/assets\/index-ChaaJ8xT\.js";<\/script>/, 'the entry loads through the map');
  assert.match(result.text, /href="\/assets\/RoutineRunVariablesDialog-wOU7aljJ\.js\?cdpc=bbbb222222"/, 'the fixed chunk is preloaded at its new address');
  assert.match(result.text, /href="\/assets\/createLucideIcon-DNYM09J7\.js">/, 'other chunks keep theirs');

  assert.equal(patchIndexHtml(result.text, fresh).status, 'already');
  assert.equal(unpatchIndexHtml(result.text), PAGE, "taking it out gives back Paperclip's own page");
  assert.equal(patchIndexHtml(result.text, []).text, PAGE);
  const next = patchIndexHtml(result.text, [{ ...fresh[0], stamp: 'cccc333333' }]);
  assert.equal(next.text.split('type="importmap"').length, 2, 'one map, the old one replaced');
  assert.match(next.text, /<link rel="modulepreload" crossorigin href="\/assets\/RoutineRunVariablesDialog-wOU7aljJ\.js">/, 'a chunk no longer fixed goes back to its own address');
});

test('index.html keeps its own entry tag when only a chunk is fixed', () => {
  const result = patchIndexHtml(PAGE, [{ file: '/assets/RoutineRunVariablesDialog-wOU7aljJ.js', stamp: 'bbbb222222' }]);
  assert.equal(result.status, 'patched');
  assert.match(result.text, /<script type="importmap">[^<]*<\/script>\n    <script type="module" crossorigin src="\/assets\/index-ChaaJ8xT\.js"><\/script>/);
  assert.equal(patchIndexHtml('<head></head>', []).status, 'unrecognized');
});

// Shaped like Paperclip's Tasks board column (2026.1005.0): a folded column shows its count in its title, an open
// one shows its status icon, its name in caps and its card count.
const BOARD = 'function Kc({status:e,issues:t,collapsed:l=!1}){const I=gm(e);return l?(0,r.jsxs)("div",{title:`${Ws(e)}: ${t.length}`,children:[(0,r.jsx)(ft,{status:e}),(0,r.jsx)("span",{className:q("mt-2 [writing-mode:vertical-rl] rotate-180 text-(length:--text-nano) font-semibold uppercase tracking-wide",I.header),children:Ws(e)})]}):(0,r.jsxs)("div",{className:"flex items-center gap-2 px-3 py-2 mb-1",children:[(0,r.jsx)(ft,{status:e}),(0,r.jsx)("span",{className:q("text-xs font-semibold uppercase tracking-wide",I.header),children:Ws(e)}),(0,r.jsx)("span",{className:q("ml-auto text-xs tabular-nums",I.count),children:t.length})]})}a(gm,"getKanbanColumnTone");';

/** The props the column (patched or not) gives its header icon. */
function headerIcon(code, column) {
  const el = (type, props) => ({ type, props });
  const Kc = new Function('r', 'ft', 'q', 'Ws', 'gm', 'a', `${code.replace(KANBAN_MARKER, '')}; return Kc;`)(
    { jsx: el, jsxs: el }, 'StatusIcon', (...c) => c.join(' '), (s) => s, () => ({ header: 'h', count: 'c' }), () => {},
  );
  return Kc(column).props.children.find((child) => child.type === 'StatusIcon').props;
}

test("a Tasks board header icon is still while its column is empty, and spins again once it has cards", () => {
  assert.deepEqual(headerIcon(BOARD, { status: 'in_progress', issues: [] }), { status: 'in_progress' }, 'unpatched: no say in the spin');
  const patched = patchKanbanHeaders(BOARD);
  assert.equal(patched.status, 'patched');
  assert.ok(patched.text.startsWith(KANBAN_MARKER));
  for (const collapsed of [false, true]) {
    assert.deepEqual(headerIcon(patched.text, { status: 'in_progress', issues: [], collapsed }), { status: 'in_progress', className: 'motion-safe:animate-none' }, `empty ${collapsed ? 'folded' : 'open'} column: still`);
    assert.deepEqual(headerIcon(patched.text, { status: 'in_progress', issues: [{}], collapsed }), { status: 'in_progress', className: undefined }, `a card in the ${collapsed ? 'folded' : 'open'} column: Paperclip's own spin`);
  }
  assert.equal(patchKanbanHeaders(patched.text).status, 'already');
});

test('a board it does not recognize is left exactly as it was', () => {
  const changed = BOARD.replace('ml-auto text-xs tabular-nums', 'ml-auto text-sm tabular-nums');
  const result = patchKanbanHeaders(changed);
  assert.equal(result.status, 'unrecognized');
  assert.equal(result.text, changed);
});

test('applying to an installed page fixes both files, stamps their addresses from their fixed text, and restores', () => {
  const uiDist = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-fixes-'));
  try {
    const page = PAGE.replaceAll('index-ChaaJ8xT', 'index-AAAA1111').replaceAll('RoutineRunVariablesDialog-wOU7aljJ', 'Board-BBBB2222');
    const files = {
      'index.html': page,
      'assets/index-AAAA1111.js': IMPORTS + DASHBOARD,
      'assets/heartbeats-AAAA1111.js': CHUNK.text,
      'assets/Board-BBBB2222.js': BOARD,
    };
    fs.mkdirSync(path.join(uiDist, 'assets'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(uiDist, name), text);
    const read = (name) => fs.readFileSync(path.join(uiDist, name), 'utf8');
    const stamp = (name) => crypto.createHash('sha256').update(read(name)).digest('hex').slice(0, 10);

    const first = applyUiFixes({ uiDist });
    assert.equal(first.status, 'patched', JSON.stringify(first));
    assert.deepEqual([first.fixes.onboarding.status, first.fixes.kanban.status], ['patched', 'patched']);
    assert.ok(read('assets/index-AAAA1111.js').startsWith(MARKER));
    assert.ok(read('assets/Board-BBBB2222.js').startsWith(KANBAN_MARKER));
    const map = JSON.parse(read('index.html').match(/<script type="importmap">([^<]*)<\/script>/)[1]);
    assert.deepEqual(map.imports, {
      '/assets/index-AAAA1111.js': `/assets/index-AAAA1111.js?cdpc=${stamp('assets/index-AAAA1111.js')}`,
      '/assets/Board-BBBB2222.js': `/assets/Board-BBBB2222.js?cdpc=${stamp('assets/Board-BBBB2222.js')}`,
    });

    assert.equal(applyUiFixes({ uiDist }).status, 'already');
    assert.equal(applyUiFixes({ uiDist, check: true }).status, 'already');
    assert.equal(restoreUi({ uiDist }).status, 'restored');
    for (const [name, text] of Object.entries(files)) assert.equal(read(name), text, `${name} is Paperclip's own again`);
  } finally {
    fs.rmSync(uiDist, { recursive: true, force: true });
  }
});
