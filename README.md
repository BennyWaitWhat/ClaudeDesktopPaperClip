# ClaudeDesktopPaperClip

Paperclip keeps doing what it is good at: orgs, hiring, cards, the org chart and the run view. The agents
live in Claude Desktop: one Claude Code conversation per agent, in the org's folder, with your own setup
(your login, plugins, skills, memory, MCP servers and claude.ai connectors). You talk to them in Desktop;
Paperclip is where you set them up and watch them work. Paperclip never starts work for a Claude agent.

How Paperclip itself works, and what that means here, is mapped in `PAPERCLIP-WORKFLOWS.md`. The decisions
behind the design are in `.grill/desktop-native-team.md`.

Two parts, both installed into Paperclip from this folder:

- **The adapter** (`index.mjs`): a Paperclip adapter package of type `claude_local`, so it stands in for
  Paperclip's built-in Claude type for every Claude agent in every org.
- **The Claude Desktop plugin** (`plugin/`): gives every new org its own folder, adds Settings > Org folder,
  puts an "Open in Claude Desktop" button on cards, and fixes Paperclip's own page (below).

## Every Desktop turn is a Paperclip run

The org folder's `.claude/settings.json` runs three hooks (`org-folder.mjs` puts them there):

- **SessionStart** (`hooks/desktop-session.mjs`): a conversation that runs as one of the org's agents gets
  that agent's own Paperclip access as environment for its Bash commands: the API address, the agent's own
  lasting key, its ids, its folder, and `$PAPERCLIP_RUN_ID`, which Claude Code reads again before every
  command, so it always names the current turn's run. A plain new conversation in the folder is the org's
  Chief of Staff.
- **UserPromptSubmit** (`hooks/desktop-turn.mjs`): the agent wakes itself in Paperclip with reason
  `desktop_turn`, and the run Paperclip starts records the turn (`desktop-turn.mjs`): the turn's messages and
  tool calls stream into the run's log, its tokens count as subscription use, and the run ends with the turn.
  A turn whose message names one of the org's cards (a hand-off: "please take LEM-8") runs on that card, since
  Paperclip lets a run comment on and update only its own card freely (and up to 20 others). Partway through a
  turn, `node hooks/paperclip-card.mjs <CARD>` moves the rest of it to that card's own run.
- **Stop**: the turn's end ends its run.
- **PreToolUse** (`hooks/paperclip-allow.mjs`, every tool): Claude Desktop never imports a conversation in bypass
  mode (it makes it "accept edits"), so most tools would ask first, including while you are away. The agent's
  Paperclip **Skip permissions** switch decides instead: on (Paperclip's default for Claude agents, and how
  Paperclip's own Claude type runs them), the agent goes ahead without asking; off, only its Paperclip calls go
  ahead (curl to this Paperclip's API and `paperclip-card`, with echo, printf, jq, head, tail or sleep alongside)
  and everything else asks as usual. A change in Paperclip applies from the agent's next tool call.

The turn also opens with what happened in Paperclip since the agent's last turn, and, once, with the agent's
instructions when they were edited in Paperclip since the conversation got them.

## Paperclip's own wakes wait for Desktop

Paperclip wakes an agent by itself when you give it a card, comment on its card, answer its question, or when
a sub-card finishes. Here such a run never starts Claude (`paperclip-wakes.mjs`): what happened goes into the
agent's Desktop inbox, which its next Desktop turn opens with, and a card the wake is about that sits in todo
or in_progress moves to backlog with the note "Waiting for my next turn in Claude Desktop." (so Paperclip
neither retries the wake nor sweeps the card as stranded). A card a Desktop turn is working right now is left
alone. Handing work between agents follows the same rule: a card in backlog, plus a message to the other
agent's Desktop conversation.

## Agent files

Each agent is a Claude Code agent in the org folder, `.claude/agents/<agent>.md` (`agent-files.mjs`): a short
note on working from Claude Desktop, then its Paperclip instructions, with the model, effort and Skip permissions
switch Paperclip sets for it. All three are managed in Paperclip: Desktop runs the conversation on the agent's model
and effort (the effort Desktop's footer shows for a handed-over conversation is only its own default until you pick
one there; picking one there overrides Paperclip's for that conversation), and the hook above reads the switch. Claude Code loads it once per conversation as the system prompt; nothing is resent each turn. A
file of that name that is not the agent's is never overwritten. The Paperclip skills the org's agents have
are copied into `.claude/skills/`.

## Org folders and the team in Claude Desktop

Creating an org makes its folder, `<where new orgs' folders go>\<org name>` (on the Desktop until you choose
another place), and moves the org to Claude Desktop. From then on the plugin keeps the folder in step with
Paperclip (`org-sync.mjs`), at once when Paperclip's live activity feed shows an agent hired, changed or removed
(a hire reaches it in well under a second), and once a minute besides:

- each Claude agent's file, the skills, the settings (the hooks above, and the Chief of Staff as the folder's
  default agent, so a new chat there is the Chief of Staff), and `.claude/paperclip-team.md`: the team and each
  member's Desktop conversation, which agents use to hand each other work;
- each agent's one conversation, made with a one-line hello as that agent (one turn, no tools: setup, never work;
  its first reply also keeps the conversation its own agent), then handed to Claude Desktop's sidebar at a pause
  in your typing. Desktop switches to a conversation it is handed, once per new agent.

Older orgs stay as they are until you move them: Settings > Org folder > **Move to Claude Desktop**. Until then
Paperclip's wakes for their Claude agents stop with a note saying so.

Settings > Org folder, in each org:

- **This org's folder**: change it, or give an older org one.
- **Where new orgs' folders go**: the place for the next orgs you create.

## Fixes to Paperclip's own page

The plugin fixes Paperclip's installed page each time it starts (`paperclip-ui-fixes.mjs`), so a Paperclip
update that ships a new page gets the fix again. Paperclip's originals are kept next to the files it changes
(`*.claude-desktop-paperclip.orig`); `node paperclip-ui-fixes.mjs --restore` puts them back, `--check` reports.

- **The setup wizard can no longer be taken over.** Paperclip's Dashboard opens the setup wizard by itself for
  an org with no agents, and that used to replace whatever the wizard was doing: with the wizard open on a new
  org and an agentless org on the Dashboard behind it, the new org's first agent was made in the other org.
  The Dashboard's automatic offer now waits while the wizard is open.
- Paperclip lets browsers keep its page for a year, so `index.html` (always fetched fresh) also gets a small
  script that downloads the fixed page once per browser and reloads once.

A page it does not recognize is left exactly as it was.

## The setup wizard's Claude check

Before it hires an org's first agent, Paperclip's wizard runs a short Claude check (the adapter's
`testEnvironment`). It runs with Claude Desktop's Claude Code and your own setup. The wizard also asks for a
Claude connection per org; the Desktop agents do not use it.

That connection ("Connect a model") reads command-line Claude's sign-in from `~/.claude/.credentials.json` and
never renews it. The token there lasts 8 hours and only Claude Code renews it, when it runs, so with the agents in
Claude Desktop the wizard would soon say "Could not verify the local subscription". The plugin checks the file every
minute and, once the token has expired, renews it with a one-turn, no-tools Haiku call (`claude-sign-in.mjs`), about
once every 8 hours. It also clears the lock a renewal cut short by a reboot leaves behind, which otherwise blocks every
later renewal. With no sign-in at all it does nothing: run `claude auth login` yourself.

## Switch it on

1. `npm install` in `plugin/` (the plugin's one dependency, Paperclip's plugin SDK).
2. The adapter: Paperclip > Settings > Adapters > install from a local path, and give this folder.
3. The plugin: Settings > Plugins > install from a local path, and give `plugin/` in this folder.

Or, with the API:

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install -H "Content-Type: application/json" -d "{\"packageName\":\"<this folder>\",\"isLocalPath\":true}"
curl -X POST http://127.0.0.1:3100/api/plugins/install -H "Content-Type: application/json" -d "{\"packageName\":\"<this folder>/plugin\",\"isLocalPath\":true}"
```

## Switch it off

Settings > Adapters: pause the `claude_local` override (Paperclip's own Claude type comes back at once), or
remove it. Settings > Plugins: disable or remove Claude Desktop (org folders stay on disk).

## After editing

- The adapter's files (`index.mjs`, `desktop-turn.mjs`, `paperclip-wakes.mjs`, `desktop-orgs.mjs`,
  `desktop.mjs`): reload the adapter (`POST /api/adapters/claude_local/reload`).
- `plugin/`: Paperclip reloads the plugin by itself when a file there changes (its dev watcher), so don't edit
  `plugin/` while a new org's conversations are being made: a reload stops a hello partway. The plugin's other
  files (`org-sync.mjs`, `agent-files.mjs`, `org-folder.mjs` and the rest at the top level) are not watched:
  after editing them, touch `plugin/worker.js` and check that the worker process restarted.
- The hooks run fresh each time and need nothing.

## Tests

- `npm test`: offline checks for both parts, no Paperclip server and no model calls (the plugin's need
  `npm install` in `plugin/` first).
- `node scripts/desktop-turn-probe.mjs --org <org id>`: a live check against the running Paperclip with
  throwaway agents and cards, no model calls: Desktop turns become runs, card-tied runs can comment and
  update, back-to-back turns, and clean-up.
- `node scripts/org-rehearsal.mjs`: a live rehearsal on Haiku (a few turns) with a throwaway org named
  `cdpc rehearsal …`, which the plugin leaves alone, so nothing goes to Claude Desktop: agent files, hellos,
  a card the board gives in Paperclip waiting for the Cashier, and the Cashier's next turn (in accept-edits mode)
  taking it to done. `--keep` leaves it for a look; `--clean <org id>` removes it.

## Limits

- Windows first: finding Claude Desktop's Claude Code and handing conversations to it are Windows-only.
- Paperclip's own wakes wait for the agent's next Desktop turn: nothing starts on its own.
- Command-line Claude must be signed in to the same Claude organization as Claude Desktop (`claude auth
  status`).
