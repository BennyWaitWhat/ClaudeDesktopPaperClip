// Which orgs work from Claude Desktop, and their agents' Desktop conversations: one file per org,
// <Paperclip instance>/claude-desktop/orgs/<org id>.json, written by the plugin (org-sync.mjs) and read by the
// adapter, which lets a Paperclip wake wait for Desktop only in an org switched over. New orgs are switched on as
// they are made; older ones by hand, when they move over.
import fs from 'node:fs';
import path from 'node:path';

export const orgFile = (instance, companyId) => path.join(instance, 'claude-desktop', 'orgs', `${companyId}.json`);

/** The org's record: { companyId, desktop, folder, conversations: { [agent id]: { sessionId, ready, handedOff } } }, or null. */
export function readOrg(instance, companyId) {
  try { return JSON.parse(fs.readFileSync(orgFile(instance, companyId), 'utf8')); } catch { return null; }
}

/** Change the org's record (read, change, write in one go). */
export function updateOrg(instance, companyId, change) {
  const file = orgFile(instance, companyId);
  const next = change(readOrg(instance, companyId) ?? { companyId, desktop: false, folder: null, conversations: {} });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

/** True when the org works from Claude Desktop. */
export const isDesktopOrg = (instance, companyId) => Boolean(companyId) && readOrg(instance, companyId)?.desktop === true;

/**
 * Switch an org to Claude Desktop (with its folder), or back; its conversations are kept either way. `plugin: false`
 * keeps the plugin out of it (a rehearsal brings the org in itself, and nothing goes to Claude Desktop).
 */
export const switchOrg = (instance, companyId, { on, folder, plugin }) =>
  updateOrg(instance, companyId, (org) => ({
    ...org, desktop: Boolean(on), folder: folder ?? org.folder, ...(plugin === undefined ? {} : { plugin }), switchedAt: new Date().toISOString(),
  }));

/** True when the plugin keeps this org in step (every org on Claude Desktop, unless a rehearsal set it aside). */
export const pluginKeeps = (org) => org?.desktop === true && org.plugin !== false;

// Orgs scripts/org-rehearsal.mjs makes: the plugin leaves them to it from the moment they are created.
export const REHEARSAL_ORG = /^cdpc rehearsal /;

/** Every org switched to Claude Desktop: [{ companyId, folder, ... }]. */
export function desktopOrgs(instance) {
  const dir = path.dirname(orgFile(instance, 'x'));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => /^[\w-]+\.json$/.test(f)).map((f) => readOrg(instance, f.slice(0, -5))).filter((o) => o?.desktop === true);
}
