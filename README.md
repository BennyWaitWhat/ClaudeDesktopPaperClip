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
- **Work goes on cards**, so Paperclip shows what the team is doing. A turn on no card is told so, with the
  agent's open cards, and anything it is asked to do, record, track or follow up goes on a card first:
  `node hooks/paperclip-card.mjs --new "<title>" --body "<what was asked>"` makes the card, assigned to the agent,
  and the rest of the turn records on it, checked out (made in backlog, then claimed by the turn's own run, so
  Paperclip never wakes the agent for it).
- **Your steps get your cards.** Anything only you can do (answer a question, decide, send, submit, book, sign
  in) gets a card of its own, assigned to you, so it is in your Paperclip inbox:
  `node hooks/paperclip-card.mjs --board "Send: the lemon order" --body "<what to do, and where>"` makes it under
  the turn's card (or `--under <CARD>`) with Paperclip's sub-card blocker, and puts the agent's card back to
  blocked even when it was already closed: a card whose last step is yours is not finished. When you mark yours
  done, Paperclip's wake for the agent goes to its Desktop inbox, so its next turn checks the result, records it,
  and closes its card. Your card closes when you mark it done, or when an agent that checks your steps has checked
  the step is done (the email in Sent, the form showing submitted, your words for an answer) and closes it with
  what it saw: `node hooks/paperclip-card.mjs --checked <CARD> "<what you saw, and when>"`. An agent checks your
  steps when its Paperclip settings carry `adapterConfig.checksBoardSteps: true` (`PATCH /api/agents/<id>` with
  `{"adapterConfig":{"checksBoardSteps":true}}`), and every agent's notes name the org's checkers. Paperclip already
  stops an agent moving a blocked card while your card is open, and the plugin (`board-hold.mjs`) undoes the closes
  it allows: any other close of your card by an agent opens it again, and an agent's card closed while yours is open
  goes back to blocked, each with a comment.
- **Stop**: the turn's end ends its run. A turn you or a teammate started that is about to end still on no card is
  stopped once first and asked to put its work on a card; chat and quick answers end as they are, and so does a turn
  a background notice started (a finished task, an artifact subscription). A turn stopped in Claude Desktop runs no
  Stop hook, so its run ends once the transcript stays quiet for 30 seconds after the interrupt; a turn whose Stop
  hook did not run for another reason ends 2 minutes after the agent's last answer. Until then Paperclip shows the
  agent working.
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
agent's Desktop conversation. SendMessage reaches a Desktop conversation only through Claude Desktop's own
messaging tool (`mcp__ccd_session_mgmt__send_message`), so a tool list always keeps it, with Bash and
SendMessage; a conversation gets a changed tool list when it next starts. Every agent has every tool unless a list is
set for it (Settings > Org folder > Tools in Claude Desktop); none is set, by Benny's choice (2026-10-21: "I want
everyone to have full.").

## Routines run from Claude Desktop scheduled tasks

Paperclip's own schedule would only park a routine's card, so an org on Claude Desktop keeps its routines paused
in Paperclip, and a Claude Desktop scheduled task fires each one: it runs `node scripts/run-routine.mjs <routine
id>...`, which starts the run (the card, assigned to the routine's agent) and prints the message naming the card
for that agent's conversation, and sends it with Desktop's `send_message` tool (SendMessage refuses in a scheduled
run). One run per routine per day: a second firing the same day (Desktop catching up after a restart) starts and
sends nothing; `--again` starts one anyway, after a run that failed. A scheduled task runs while Claude Desktop is
open, or at its next launch; in the folder and on the model Desktop gives it, in the permission mode Claude Code's
settings set as default.

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

- each Claude agent's file, the skills, the settings (the hooks above, which make a new chat there the Chief of
  Staff; no folder default agent, since Claude Code gives every conversation it resumes the default agent's tools),
  and `.claude/paperclip-team.md`: the team and each member's Desktop conversation, which agents use to hand each
  other work;
- each agent's one conversation, made with a one-line hello as that agent (one turn, no tools: setup, never work;
  the conversation keeps that agent and its tools from then on), then handed to Claude Desktop's sidebar at a pause
  in your typing. Desktop switches to a conversation it is handed, once per new agent.

Older orgs stay as they are until you move them: Settings > Org folder > **Move to Claude Desktop**. Until then
Paperclip's wakes for their Claude agents stop with a note saying so.

## A new org sets itself up

Making an org in Paperclip (the org switcher > **Create organization**, which opens the setup wizard at
`/onboarding`) is all it takes; nothing else needs doing by hand (`house-setup.mjs`):

- The org's folder gets the house `CLAUDE.md` (the team's rules, loaded in every conversation there) and `FACTS.md`
  (what is known about the org), with its name filled in. A file already there is never overwritten.
- Its Chief of Staff, the wizard's first agent or whoever reports to no one, gets the house job file (it works out
  the team with you, one question at a time, and hires on your go through Paperclip's `agent-hires`), Opus 5.5 at max
  effort, every tool, and the check of your steps, whatever the wizard gave it.
- Every later hire gets the house model and effort, and the org folder, where they were left unset; a hire's own
  choices stay.
- On its first turn the Chief of Staff files the team's conversations in a sidebar section named after the org,
  and files each hire's there after.

The house way is a template folder, `<instance>/claude-desktop/org-template` (`CLAUDE.md`, `FACTS.md`,
`chief-of-staff.md` and `defaults.json` for the model and effort), copied from this repo's `templates/org` the first
time it is needed. Edit it there to change every org made after. `{{org}}`, `{{folder}}`, `{{folder_json}}` (the
folder as it goes inside JSON) and `{{date}}` are filled in. Each agent is set up once: one Paperclip refuses to save
is tried again at the next sync and gets no conversation until then, since Desktop keeps the model a conversation was
made with. Orgs on Claude Desktop before this existed (2026-10-21) were adopted as they are.

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
- **An empty In Progress column no longer spins.** Paperclip spins the in-progress icon wherever it appears, so the
  Tasks board's In Progress header spun with no card in it and no agent working. A board header icon now spins
  only while its column has cards; a card's own icon is unchanged.
- Paperclip lets browsers keep its files for a year, and a browser also keeps a loaded file in memory, so a fixed
  file under its old address could go on running in its old form, even after a reload. Each fixed file therefore
  gets an address of its own (`?cdpc=` plus a stamp taken from its fixed text): `index.html`, which is always
  fetched fresh, carries an import map that sends the page there. One reload after a fix picks it up in any browser.

A page it does not recognize is left exactly as it was.

## The setup wizard's Claude check

Before it hires an org's first agent, Paperclip's wizard runs a short Claude check (the adapter's
`testEnvironment`). It runs with Claude Desktop's Claude Code and your own setup, and, since only the sign-in is
checked, on `claude-haiku-5-5` at low effort without Chrome; a hello that fails with Desktop's copy is tried again
with the `claude` on PATH. (Paperclip 2026.1012.0 runs the hello with Paperclip's default model when none is set,
`claude-opus-5`, which Claude refuses here.) The wizard also asks for a Claude connection per org; the Desktop agents
do not use it.

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
  taking it to done, a request made in Desktop becoming a card the Cashier makes itself, and chat making none.
  `--keep` leaves it for a look; `--clean <org id>` removes it.

## Limits

- Windows has no Paperclip service (`paperclipai service` answers "not supported on win32"), so Paperclip runs only
  while something has started it. `scripts/start-paperclip.ps1` starts it, logging to the instance's
  `logs/paperclip-server.log`, and does nothing if it is already up; run through `conhost.exe --headless` it has no
  window at all. `scripts/stop-paperclip.ps1` stops it cleanly (Ctrl+C to its console, so its database closes too,
  and a database worker it leaves behind, which would block the next start, is stopped).
  Start it from Windows (a shortcut, Explorer, the Startup folder), never from a Claude session's shell: started
  there, it stops when Claude Desktop quits (it did on 2026-10-14 at 7:01 PM). On Benny's PC, `Paperclip.lnk` in his
  Startup folder (`shell:startup`) starts it hidden at every logon since 2026-10-15; deleting it undoes that.

- Windows first: finding Claude Desktop's Claude Code and handing conversations to it are Windows-only.
- Paperclip's own wakes wait for the agent's next Desktop turn: nothing starts on its own.
- Command-line Claude must be signed in to the same Claude organization as Claude Desktop (`claude auth
  status`).
- Desktop's sidebar heads a folder only when the folder is one of its saved folders
  (`%APPDATA%\Claude\ccd-session-presets.json`, seeded once from the folders open on 2026-10-14). An org folder
  first used after that lists its conversations under "Default", by repo name. File them in a sidebar section of
  their own (Career Catchers has one); a later hire's conversation is filed there the same way.
- Handing a conversation to Desktop opens it: Desktop starts its Claude Code process and a hidden PowerShell
  terminal, which stay until Desktop restarts (Career Catchers' 13 held about 2.5 GB, and Desktop's limit of about
  16 terminals closed other sessions' terminals). It happens once per agent, at org setup or a hire, never per
  run. Kept as is on 2026-10-14; if orgs get made often, stop each conversation's process right after its
  hand-off (test first that this closes the terminal too).
