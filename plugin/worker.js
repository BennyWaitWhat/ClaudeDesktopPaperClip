import path from 'node:path';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { openInDesktop } from '../desktop.mjs';
import { applyUiFixes } from '../paperclip-ui-fixes.mjs';
import { desktopFolder, ensureFolder, ensureOrgFolder, orgFolderName } from './folders.mjs';

export const FOLDER_KEY = 'org';
const WHERE_NEW_ORGS_GO = { scopeKind: 'instance', stateKey: 'new-org-parent' };

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

let host = null; // setup's ctx, for API requests

const plugin = definePlugin({
  async setup(ctx) {
    host = ctx;

    // Fixes to Paperclip's own page (paperclip-ui-fixes.mjs), again after each Paperclip update ships a new page.
    const fixes = applyUiFixes();
    ctx.logger.info('Paperclip page fixes', fixes);

    // Part of making an org: its folder exists before its first agent runs.
    ctx.events.on('company.created', async (event) => {
      const companyId = event.companyId ?? event.entityId;
      const folder = await giveOrgAFolder(ctx, companyId);
      ctx.logger.info('Org folder ready', { companyId, path: folder.path });
    });

    // Settings > Org folder. `suggested` is the folder a new org would get, for an org that has none yet.
    ctx.data.register('org-folder', async ({ companyId }) => {
      const parent = await newOrgParent(ctx);
      const company = companyId ? await ctx.companies.get(companyId) : null;
      return {
        folder: companyId ? await ctx.localFolders.status(companyId, FOLDER_KEY) : null,
        suggested: company ? path.join(parent, orgFolderName(company.name)) : null,
        newOrgParent: parent,
      };
    });
    ctx.actions.register('set-org-folder', async ({ companyId, path: dir }) =>
      ctx.localFolders.configure({ companyId, folderKey: FOLDER_KEY, path: ensureFolder(dir) }));
    ctx.actions.register('set-new-org-parent', async ({ path: dir }) => {
      const parent = ensureFolder(dir);
      await ctx.state.set(WHERE_NEW_ORGS_GO, parent);
      return { newOrgParent: parent };
    });

    // The card button: hand the agent's conversation for this card to Claude Desktop.
    ctx.actions.register('open-in-desktop', async ({ sessionId, cwd }) => openInDesktop(sessionId, cwd));
  },

  // The adapter asks with the run's own token; the answer is that agent's org folder.
  async onApiRequest(input) {
    if (input.routeKey !== 'org-folder') return { status: 404, body: { error: 'Unknown route' } };
    const folder = await host.localFolders.status(input.companyId, FOLDER_KEY);
    return { body: { path: folder.healthy ? folder.path : null } };
  },

  async onHealth() {
    return { status: 'ok', message: 'Org folders and Open in Claude Desktop are ready' };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
