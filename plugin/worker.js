// The Claude Desktop plugin's worker. It gives each new org its folder, moves the org to Claude Desktop, and keeps
// the org's folder and its agents' Desktop conversations in step with Paperclip (org-sync.mjs): at once when
// Paperclip's live activity feed shows an agent hired, changed or removed, and once a minute besides. It also keeps
// command-line Claude's sign-in fresh for Paperclip's own Claude checks (claude-sign-in.mjs).
import path from 'node:path';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { desktopClaudeCode, handOffWhenQuiet, openInDesktop, windowsUserEnv } from '../desktop.mjs';
import { desktopOrgs, isDesktopOrg, pluginKeeps, readOrg, REHEARSAL_ORG, switchOrg } from '../desktop-orgs.mjs';
import { ALWAYS_TOOLS, desktopTools } from '../agent-files.mjs';
import { boardGuard } from '../board-hold.mjs';
import { keepSignInFresh } from '../claude-sign-in.mjs';
import { claudeTeam, markHandedOff, noteNewCard, paperclipApi, paperclipInstance, syncOrg } from '../org-sync.mjs';
import { paperclipCall } from '../paperclip-access.mjs';
import { applyUiFixes } from '../paperclip-ui-fixes.mjs';
import { desktopFolder, ensureFolder, ensureOrgFolder, orgFolderName } from './folders.mjs';

export const FOLDER_KEY = 'org';
const WHERE_NEW_ORGS_GO = { scopeKind: 'instance', stateKey: 'new-org-parent' };

// What the worker works with; tests swap these before setup.
export const options = {
  instance: paperclipInstance(),
  api: null, // from Paperclip's runtime record when not set
  sync: syncOrg,
  handOff: handOffWhenQuiet,
  noteCard: noteNewCard,
  watch: true,
  tickMs: 60_000,
  signIn: keepSignInFresh,
  signInMs: 60_000,
};
const api = () => options.api ?? paperclipApi(options.instance);
const claude = () => desktopClaudeCode(windowsUserEnv())?.file ?? 'claude';

/** Where new org folders go: the place you chose, or the Desktop. */
export async function newOrgParent(ctx) {
  const saved = await ctx.state.get(WHERE_NEW_ORGS_GO);
  return typeof saved === 'string' && saved.trim() ? saved : desktopFolder();
}

/** Give an org its folder, <where new org folders go>\<org name>, unless it already has one. */
export async function giveOrgAFolder(ctx, companyId) {
  const current = await ctx.localFolders.status(companyId, FOLDER_KEY);
  if (current.configured) return current;
  const company = await ctx.companies.get(companyId);
  if (!company) throw new Error(`No org with id ${companyId}`);
  const dir = ensureOrgFolder(await newOrgParent(ctx), company.name);
  return ctx.localFolders.configure({ companyId, folderKey: FOLDER_KEY, path: dir });
}

let host = null; // setup's ctx
const log = (level, message, meta) => host?.logger?.[level]?.(message, meta);

// One sync at a time per org; asking during a sync runs it once more after.
const syncing = new Map();
const again = new Set();
export function syncSoon(companyId, why) {
  if (!pluginKeeps(readOrg(options.instance, companyId))) return Promise.resolve();
  if (syncing.has(companyId)) { again.add(companyId); return syncing.get(companyId); }
  const run = (async () => {
    do {
      again.delete(companyId);
      try {
        const result = await options.sync({ api: api(), instance: options.instance, companyId, claude: claude() });
        if (result.skipped) log('debug', 'Org not synced', { companyId, why, skipped: result.skipped });
        else if (result.wrote.length || result.made.length) {
          log('info', 'Org in step with Claude Desktop', {
            companyId, org: result.org, why, wrote: result.wrote, skippedSkills: result.skippedSkills,
            made: result.made.map(({ name, ok, sessionId, model, reply, error }) => ({ name, ok, sessionId, model, reply, error })),
          });
        }
        for (const item of result.handOff ?? []) queueHandOff(companyId, result.folder, item);
      } catch (err) {
        log('warn', 'Org sync failed', { companyId, why, error: String(err?.stack ?? err) });
      }
    } while (again.has(companyId));
    syncing.delete(companyId);
  })();
  syncing.set(companyId, run);
  return run;
}

// New conversations go to Claude Desktop one at a time, each at a pause in your typing (Desktop switches to a
// conversation it is handed). One that does not get there is tried again a few minutes later.
const handing = new Set();
const handOffFailed = new Map();
let handOffs = Promise.resolve();
function queueHandOff(companyId, folder, { agentId, name, sessionId }) {
  if (handing.has(sessionId) || Date.now() - (handOffFailed.get(sessionId) ?? 0) < 5 * 60_000) return;
  handing.add(sessionId);
  handOffs = handOffs.then(async () => {
    const result = await options.handOff(sessionId, folder);
    if (result?.ok) {
      markHandedOff(options.instance, companyId, agentId);
      handOffFailed.delete(sessionId);
      log('info', `${name}'s conversation is in Claude Desktop`, { companyId, sessionId, alreadyOpen: Boolean(result.alreadyOpen) });
    } else {
      handOffFailed.set(sessionId, Date.now());
      log('warn', `${name}'s conversation did not reach Claude Desktop`, { companyId, sessionId, reason: result?.reason });
    }
  }).catch((err) => log('warn', 'Handing a conversation to Claude Desktop failed', { error: String(err) }))
    .finally(() => handing.delete(sessionId));
}

// Paperclip's live activity feed, per org on Claude Desktop: hires and agent changes (a hire announces nothing else
// to plugins), and cards an agent closes before the board has done its step (board-hold.mjs).
const AGENT_CHANGES = new Set([
  'agent.hire_created', 'agent.created', 'agent.approved', 'agent.updated', 'agent.terminated', 'agent.deleted', 'agent.config_rolled_back',
  'agent.instructions_path_updated', 'agent.instructions_bundle_updated', 'agent.instructions_file_updated', 'agent.instructions_file_deleted',
  'agent.skills_synced', 'approval.approved',
]);
const feeds = new Map();
const holdForBoard = boardGuard();
function watchOrg(companyId) {
  if (!options.watch || feeds.has(companyId) || typeof WebSocket !== 'function' || !pluginKeeps(readOrg(options.instance, companyId))) return;
  const feed = new WebSocket(`${api().replace(/^http/, 'ws')}/api/companies/${companyId}/events/ws`);
  feeds.set(companyId, feed);
  feed.addEventListener('message', (m) => {
    let event = null;
    try { event = JSON.parse(String(m.data)); } catch { return; }
    if (event?.type === 'activity.logged' && AGENT_CHANGES.has(event.payload?.action)) syncSoon(companyId, event.payload.action);
    holdForBoard(api(), event)
      .then((r) => {
        if (r?.held) log('info', r.reopened ? `${r.card}, a card for the board, was closed by an agent without a check: open again` : `${r.card} was closed while the board's ${r.waiting.join(', ')} is open: back to blocked`, { companyId });
        else if (r?.checkedBy) log('info', `${r.card}, a card for the board, was closed by ${r.checkedBy} as checked`, { companyId });
      })
      .catch((err) => log('warn', 'Holding a card for the board failed', { companyId, error: String(err) }));
  });
  feed.addEventListener('close', () => { if (feeds.get(companyId) === feed) feeds.delete(companyId); });
  feed.addEventListener('error', () => {});
}

// Paperclip's wizard reads command-line Claude's sign-in and never renews it; renew it once it expires. Signed
// out, nothing can renew it: say so once an hour, since new hires' first conversations need it too.
let renewing = null;
let saidSignedOut = 0;
function checkSignIn() {
  renewing ??= options.signIn({ claude: claude() })
    .then((result) => {
      if (result.renewed) log('info', "Renewed command-line Claude's sign-in for Paperclip's Claude checks", { expiresAt: new Date(result.expiresAt).toISOString(), clearedLock: result.clearedLock });
      else if (result.error) log('warn', "Command-line Claude's sign-in did not renew", { error: result.error });
      else if (result.reason === 'not signed in' && Date.now() - saidSignedOut >= 60 * 60_000) {
        saidSignedOut = Date.now();
        log('warn', 'Command-line Claude is signed out: run "claude auth login" (Paperclip\'s Claude checks and new hires\' first conversations need it)');
      }
    })
    .catch((err) => log('warn', "Checking command-line Claude's sign-in failed", { error: String(err) }))
    .finally(() => { renewing = null; });
  return renewing;
}

/** Move an org to Claude Desktop (its folder first), or back. */
export async function setDesktop(ctx, companyId, on) {
  if (!on) return switchOrg(options.instance, companyId, { on: false });
  const folder = await giveOrgAFolder(ctx, companyId);
  const org = switchOrg(options.instance, companyId, { on: true, folder: folder.path });
  watchOrg(companyId);
  syncSoon(companyId, 'moved to Claude Desktop');
  return org;
}

const plugin = definePlugin({
  async setup(ctx) {
    host = ctx;

    // Fixes to Paperclip's own page (paperclip-ui-fixes.mjs), again after each Paperclip update ships a new page.
    const fixes = applyUiFixes();
    ctx.logger.info('Paperclip page fixes', fixes);

    const onDesktop = desktopOrgs(options.instance).filter(pluginKeeps);
    ctx.logger.info('Orgs on Claude Desktop', { orgs: onDesktop.map((o) => ({ companyId: o.companyId, folder: o.folder })) });
    for (const org of onDesktop) { watchOrg(org.companyId); syncSoon(org.companyId, 'start'); }
    const tick = setInterval(() => {
      for (const org of desktopOrgs(options.instance)) { watchOrg(org.companyId); syncSoon(org.companyId, 'every minute'); }
    }, options.tickMs);
    tick.unref?.();
    checkSignIn();
    setInterval(checkSignIn, options.signInMs).unref?.();

    // Making an org makes its folder and moves it to Claude Desktop, before its first agent exists.
    ctx.events.on('company.created', async (event) => {
      const companyId = event.companyId ?? event.entityId;
      const company = await ctx.companies.get(companyId);
      if (REHEARSAL_ORG.test(company?.name ?? '')) return; // scripts/org-rehearsal.mjs brings it in itself
      const org = await setDesktop(ctx, companyId, true);
      ctx.logger.info('New org on Claude Desktop', { companyId, folder: org.folder });
    });
    for (const name of ['agent.created', 'agent.updated', 'approval.decided']) {
      ctx.events.on(name, async (event) => {
        if (isDesktopOrg(options.instance, event.companyId)) syncSoon(event.companyId, name);
      });
    }
    // A card the board makes for one of the org's Claude agents waits in that agent's Desktop inbox.
    ctx.events.on('issue.created', async (event) => {
      if (!isDesktopOrg(options.instance, event.companyId)) return;
      const noted = await options.noteCard({ api: api(), instance: options.instance, issueId: event.entityId });
      if (noted) ctx.logger.info('Card waits for its agent in Claude Desktop', { companyId: event.companyId, card: noted.card?.identifier, agentId: noted.agentId });
    });

    // Settings > Org folder. `suggested` is the folder a new org would get, for an org that has none yet.
    ctx.data.register('org-folder', async ({ companyId }) => {
      const parent = await newOrgParent(ctx);
      const company = companyId ? await ctx.companies.get(companyId) : null;
      return {
        folder: companyId ? await ctx.localFolders.status(companyId, FOLDER_KEY) : null,
        suggested: company ? path.join(parent, orgFolderName(company.name)) : null,
        newOrgParent: parent,
        desktop: companyId ? isDesktopOrg(options.instance, companyId) : false,
      };
    });
    ctx.actions.register('set-org-folder', async ({ companyId, path: dir }) => {
      const folder = await ctx.localFolders.configure({ companyId, folderKey: FOLDER_KEY, path: ensureFolder(dir) });
      if (isDesktopOrg(options.instance, companyId)) { switchOrg(options.instance, companyId, { on: true, folder: folder.path }); syncSoon(companyId, 'folder moved'); }
      return folder;
    });
    ctx.actions.register('set-new-org-parent', async ({ path: dir }) => {
      const parent = ensureFolder(dir);
      await ctx.state.set(WHERE_NEW_ORGS_GO, parent);
      return { newOrgParent: parent };
    });
    ctx.actions.register('set-desktop', async ({ companyId, on }) => {
      const org = await setDesktop(ctx, companyId, Boolean(on));
      return { desktop: org.desktop, folder: org.folder };
    });

    // Settings > Org folder > Tools: each Claude agent's tool list in Claude Desktop (adapterConfig.desktopTools), the
    // biggest part of what every model call carries (grill Q24). Bash, SendMessage and Desktop's messaging tool always stay.
    const ownTools = (agent) => desktopTools(agent).filter((t) => !ALWAYS_TOOLS.includes(t));
    ctx.data.register('agent-tools', async ({ companyId }) => {
      if (!companyId) return { always: ALWAYS_TOOLS, agents: [] };
      const listed = await paperclipCall(api(), `/api/companies/${companyId}/agents`);
      if (listed.status !== 200 || !Array.isArray(listed.json)) throw new Error(`Paperclip answered ${listed.status}`);
      return { always: ALWAYS_TOOLS, agents: claudeTeam(listed.json).team.map((a) => ({ id: a.id, name: a.name, title: a.title ?? null, tools: ownTools(a) })) };
    });
    ctx.actions.register('set-agent-tools', async ({ companyId, agentId, tools }) => {
      const agent = await paperclipCall(api(), `/api/agents/${encodeURIComponent(String(agentId))}`);
      if (agent.status !== 200 || agent.json?.companyId !== companyId) throw new Error('No such agent in this org');
      const list = ownTools({ adapterConfig: { desktopTools: tools } });
      // Paperclip takes about 6 seconds to save an agent; its call to this action gives up at 30.
      const saved = await paperclipCall(api(), `/api/agents/${agent.json.id}`, { method: 'PATCH', body: { adapterConfig: { desktopTools: list } }, timeoutMs: 20_000 });
      if (saved.status < 200 || saved.status >= 300) throw new Error(saved.status ? `Paperclip answered ${saved.status}` : 'Paperclip did not answer in time');
      if (isDesktopOrg(options.instance, companyId)) syncSoon(companyId, 'tools changed');
      return { tools: list };
    });

    // The card button: the Desktop conversation of each of the org's agents.
    ctx.data.register('agent-conversations', async ({ companyId }) => {
      const org = companyId ? readOrg(options.instance, companyId) : null;
      const conversations = Object.entries(org?.conversations ?? {})
        .filter(([, c]) => c?.ready && c.sessionId)
        .map(([agentId, c]) => ({ agentId, name: c.name ?? null, sessionId: c.sessionId }));
      return { desktop: org?.desktop === true, folder: org?.folder ?? null, conversations };
    });
    ctx.actions.register('open-in-desktop', async ({ sessionId, cwd }) => openInDesktop(sessionId, cwd));
  },

  // Kept for older adapters, which asked with the run's own token for the agent's org folder.
  async onApiRequest(input) {
    if (input.routeKey !== 'org-folder') return { status: 404, body: { error: 'Unknown route' } };
    const folder = await host.localFolders.status(input.companyId, FOLDER_KEY);
    return { body: { path: folder.healthy ? folder.path : null } };
  },

  async onHealth() {
    return { status: 'ok', message: 'Org folders, Claude Desktop conversations and Open in Claude Desktop are ready' };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
