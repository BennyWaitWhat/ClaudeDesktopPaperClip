# ClaudeDesktopPaperClip

Paperclip keeps doing what it is good at: the UI, the orgs, hiring, cards and the run view. This add-on
makes its Claude agents native: every run is Claude Desktop's own Claude Code with your own setup (your
login, plugins, skills, memory, MCP servers and claude.ai connectors), working in the org's folder like any
Claude Code session.

Two parts, both installed into Paperclip from this folder, and nothing in Paperclip's own files is edited, so
Paperclip updates do not undo them:

- **The adapter** (`index.mjs`): a Paperclip adapter package of type `claude_local`, so it stands in for
  Paperclip's built-in Claude type everywhere: agents you already have, agents you create by hand, and agents
  another agent hires. No per-agent setup.
- **The Claude Desktop plugin** (`plugin/`): gives every new org its own folder as part of creating the org,
  adds Settings > Org folder, and puts an "Open in Claude Desktop" button on cards.

## What changes in a run

Each run is Paperclip's own Claude adapter, unchanged, minus four things:

1. **The throwaway home.** Paperclip's managed AI connection starts Claude Code with a temp `HOME` and
   `CLAUDE_CONFIG_DIR` and its own token, so agents never see your setup. Those are dropped.
2. **"User settings only".** The managed connection adds `--setting-sources user`, which hides the org
   folder's own `.claude` settings. Not added.
3. **The bundled engine.** Runs use the CLI engine with the Claude Code that Claude Desktop installed
   (`%APPDATA%\Claude\claude-code\<newest>\...\claude.exe`), never ACP (an older bundled Claude Code that
   also rewrites `.claude/settings.local.json` on every run). Without Claude Desktop, `claude` on PATH.
4. **Paperclip-only tools.** Paperclip passes its run tools as the only MCP servers
   (`--strict-mcp-config`). Here they load next to your own MCP servers and connectors.

## Claude Desktop sees the agents

- Each agent session is named `<card> · <agent>` (for example `CAR-15 · Chief of Staff`), or just the agent
  for a run with no card. Paperclip keeps one session per agent per card.
- When a run starts a new conversation, it is handed to Claude Desktop with Claude Code's own
  `claude --desktop --resume <id>`. It shows in the sidebar under the folder it ran in, with that name, and you
  can open it and keep going there with everything Claude Desktop has.
- A card whose agent has a conversation shows an **Open in Claude Desktop** button (one per agent when several
  worked on it), which opens that conversation in Claude Desktop.
- A run waits while you are mid-turn in that agent's session in Claude Desktop, so the two never type at once.
- Known gap: if the session is open in Claude Desktop while a run adds to it, the open window does not show the
  run's new turn until the session is reopened.

## Org folders

Creating an org makes its folder: `<where new orgs' folders go><org name>`, on the Desktop until you choose
another place. A folder already there under that name is used as it is. Paperclip's new-org wizard has no
folder step and plugins cannot add one, so this happens on its own the moment the org exists, before its first
agent runs.

Settings > Org folder, in each org:

- **This org's folder**: change it, or give an older org one (it is prefilled with the folder a new org would
  get). A folder you type is made if missing. Moving an org starts its agents' conversations fresh in the new
  folder, since Claude Code keeps conversations per folder.
- **Where new orgs' folders go**: the place for the next orgs you create.

Where a run works, first match wins:

1. The card's project folder, when the project has one (set in the project's settings).
2. The agent's own folder (its `cwd`).
3. The org folder.
4. Only with none of these: Paperclip's own hidden folders, as before.

Claude Code then loads that folder's `CLAUDE.md`, `.claude/` agents, skills and settings, and its memory,
the same as a Claude Code session you open in that folder.

## Switch it on

1. `npm install` in `plugin/` (the plugin's one dependency, Paperclip's plugin SDK).
2. The adapter: Paperclip > Settings > Adapters > install from a local path, and give this folder. Paperclip
   logs `External adapter "claude_local" overrides built-in adapter`, and every org's Claude agents use it from
   their next run.
3. The plugin: Settings > Plugins > install from a local path, and give `plugin/` in this folder.

Or, with the API:

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install -H "Content-Type: application/json" -d "{\"packageName\":\"<this folder>\",\"isLocalPath\":true}"
curl -X POST http://127.0.0.1:3100/api/plugins/install -H "Content-Type: application/json" -d "{\"packageName\":\"<this folder>/plugin\",\"isLocalPath\":true}"
```

## Switch it off

Settings > Adapters: pause the `claude_local` override (Paperclip's own Claude type comes back at once), or
remove it. Settings > Plugins: disable or remove Claude Desktop (org folders stay on disk; runs go back to
Paperclip's own folder choice).

## After editing

- `index.mjs` or `desktop.mjs`: reload the adapter (Settings > Adapters > reload, or
  `POST /api/adapters/claude_local/reload`).
- `plugin/`: reload the plugin (`POST /api/plugins/claude-desktop-paperclip/upgrade`), then refresh the page.

A running Paperclip keeps the old code until then.

## Tests

- `npm test`: offline checks for both parts, no Paperclip server and no model calls (the plugin's need
  `npm install` in `plugin/` first).
- `node scripts/live-smoke.mjs`: one real run on a cheap model, set up like a managed run (throwaway home,
  bogus token). It passes only when the run uses Claude Desktop's Claude Code with your own login, without
  the "user settings only" and Paperclip-only-tools switches, and saves its conversation in your own Claude
  folder.

## Limits

- Windows first: finding Claude Desktop's Claude Code and handing sessions to it are Windows-only; elsewhere
  runs use `claude` on PATH and stay out of the sidebar.
- Local runs only. Remote and sandbox execution targets are not supported.
- Command-line Claude must be signed in to the same Claude organization as Claude Desktop (`claude auth
  status`), or a conversation moved into Claude Desktop cannot reuse its earlier thinking.
