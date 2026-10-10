import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKER, patchIndexHtml, patchMainBundle } from '../paperclip-ui-fixes.mjs';

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

test('index.html gets a one-time refresh of the cached bundle, and only once', () => {
  const html = '<head>\n    <script type="module" crossorigin src="/assets/index-ChaaJ8xT.js"></script>\n  </head>';
  const first = patchIndexHtml(html);
  assert.equal(first.status, 'patched');
  assert.match(first.text, /fetch\("\/assets\/index-ChaaJ8xT\.js",\{cache:"reload"\}\)/);
  assert.match(first.text, /claude-desktop-paperclip:onboarding-offer-v1:\/assets\/index-ChaaJ8xT\.js/);
  assert.ok(first.text.indexOf('location.reload()') < first.text.indexOf('type="module"'), 'runs before the page loads its bundle');
  assert.equal(patchIndexHtml(first.text).status, 'already');
  assert.equal(patchIndexHtml(first.text).text, first.text);
});
