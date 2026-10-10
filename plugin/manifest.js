// The Claude Desktop plugin: org folders and the "Open in Claude Desktop" button. The adapter in the folder
// above (index.mjs) runs the agents; this plugin gives each org its folder and lets a card open its conversation.
const manifest = {
  id: 'claude-desktop-paperclip',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'Claude Desktop',
  description: "Gives each new org its own folder when the org is created (on your Desktop unless you choose another place), runs the org's Claude agents there, and opens a card's agent conversation in Claude Desktop.",
  author: 'ClaudeDesktopPaperClip',
  categories: ['workspace', 'ui'],
  capabilities: [
    'events.subscribe',
    'companies.read',
    'local.folders',
    'plugin.state.read',
    'plugin.state.write',
    'api.routes.register',
    'instance.settings.register',
    'ui.action.register',
  ],
  entrypoints: {
    worker: './worker.js',
    ui: './ui',
  },
  localFolders: [
    {
      folderKey: 'org',
      displayName: 'Org folder',
      description: "The org's own folder. Its Claude agents work here unless a card's project has a folder of its own.",
      access: 'readWrite',
    },
  ],
  apiRoutes: [
    // The adapter asks, with the run's own token, which folder the agent's org works in.
    { routeKey: 'org-folder', method: 'GET', path: '/org-folder', auth: 'agent', capability: 'api.routes.register' },
  ],
  ui: {
    slots: [
      { type: 'companySettingsPage', id: 'org-folder-settings', displayName: 'Org folder', exportName: 'OrgFolderSettings', routePath: 'org-folder' },
      { type: 'toolbarButton', id: 'open-in-claude-desktop', displayName: 'Open in Claude Desktop', exportName: 'OpenInClaudeDesktop', entityTypes: ['issue'] },
    ],
  },
};

export default manifest;
