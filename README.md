# ClaudeDesktopPaperClip

Paperclip keeps doing what it is good at: the UI, the orgs, hiring, cards and the run view. This add-on
makes its Claude agents native: every run is Claude Desktop's own Claude Code with your own setup (your
login, plugins, skills, memory, MCP servers and claude.ai connectors), working in the org's folder like any
Claude Code session.

It is a Paperclip adapter package of type `claude_local`, so it stands in for Paperclip's built-in Claude
type everywhere: agents you already have, agents you create by hand, and agents another agent hires. No
per-agent setup, and nothing in Paperclip's own files is edited, so Paperclip updates do not undo it.

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

## Org folders

Paperclip already runs each agent in a folder: the project's workspace folder, or the agent's `cwd`. Give
each org its own folder there. Claude Code then loads that folder's `CLAUDE.md`, `.claude/` agents, skills
and settings, and its memory, the same as a Claude Code session you open in that folder.

## Switch it on

Paperclip > Settings > Adapters > install from a local path, and give this folder. Or:

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install -H "Content-Type: application/json" -d "{\"packageName\":\"<this folder>\",\"isLocalPath\":true}"
```

Paperclip logs `External adapter "claude_local" overrides built-in adapter`. Every org's Claude agents use it
from their next run.

## Switch it off

Settings > Adapters: pause the `claude_local` override (Paperclip's own Claude type comes back at once), or
remove it.

## After editing `index.mjs`

Reload it: Settings > Adapters > reload, or `POST /api/adapters/claude_local/reload`. A running Paperclip
keeps the old code until then.

## Tests

- `npm test`: offline checks, no Paperclip server and no model calls.
- `node scripts/live-smoke.mjs`: one real run on a cheap model, set up like a managed run (throwaway home,
  bogus token). It passes only when the run uses Claude Desktop's Claude Code with your own login, without
  the "user settings only" and Paperclip-only-tools switches, and saves its conversation in your own Claude
  folder.

## Limits

- Windows first: finding Claude Desktop's Claude Code is Windows-only; elsewhere runs use `claude` on PATH.
- Local runs only. Remote and sandbox execution targets are not supported.
- Agent runs are Claude Code sessions in your normal Claude folder, not Claude Desktop sidebar sessions.
  Follow them in Paperclip's run view, or continue one with `claude --resume <session id>` in the agent's
  folder.
