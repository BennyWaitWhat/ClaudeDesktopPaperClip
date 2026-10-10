# Grill: a Paperclip team that lives in Claude Desktop

Started 2026-10-09 (`/grill-me-general` "on everything"). Benny's answers are quoted word for word. Updated after every answer.

## Intent

> "Taking PaperClip but let Claude Desktop Claude Code be the agents natively. I don't care to use the chat interface in paperclip. I like paperclip because how it organizes things and make agents work together. paperclip is mainly a config anf observability place. i will interact with all agents from claude desktop claude code." (Q1)

> "im trying to get claude desktop claude code to adopt how it works and populate the ui kinda thing." (Q3)

## Decisions

| # | Question | Answer | Benny's words |
|---|----------|--------|---------------|
| Q1 | What is the setup for? | Paperclip is setup and observability; Desktop conversations are the agents; he talks to every agent in Desktop | see Intent |
| Q2 | What does he open to talk to an agent? | One conversation per agent; all its cards are worked in it | picked "One per agent (Recommended)" |
| Q3 | Desktop closed when work comes in? | Work waits until he opens Desktop | "i like 2, but also why is paperclip commicatung back?" |
| Q4 | Desktop runs the team (agents hand each other work in Desktop); Paperclip is filled in from Desktop; Paperclip holds the setup; Paperclip never starts work | Yes to all four | "Q4 yes." |
| Q4 gap | Recurring jobs run as Desktop scheduled tasks | They still show in Paperclip | "should still show in paperclip for visibitltiy." |
| Q5 | How does an agent learn it has been handed work? | The sender messages the receiver's Desktop conversation directly and records the work as a card in Paperclip; no checking Paperclip on a timer | picked "Direct message + card (Recommended)" |
| Q7 | A new agent is added in Paperclip: how does its conversation get into Desktop? | Automatically, with one Desktop switch; setup only, never work. Hires matter: the hiring agent brings the new hire's conversation into Desktop (after the board's approval where the org requires it), because Paperclip's hire route announces nothing to add-ons | "1 but you need to look at how paperclip handles hires too. and my config rn," |
| Q8 | Where does the job search team live? (asked org-specific) | Its own org folder, plus a copy of Career Ops; then Benny refocused the grill on Paperclip itself: "we're focused on paperclip, not the orgs/projects." | "1+ copy over careers ops" |
| Q9 | A Paperclip project has its own folder: where do the org's agents work on it? | Inside the org folder: conversations at the top, each project a subfolder; new projects are made there; a project folder that already lives elsewhere is copied in once (a git repo as its own copy that syncs through GitHub) | picked "Inside the org folder (Recommended)" |
| Q10 | What should Paperclip show about work done in Desktop? | All four: cards and comments kept current by the agents; every agent turn as a run (when, which agent, message, reply, tokens); Desktop scheduled tasks and their runs; his direct chats with agents | picked all four options |
| Q11 | How do his direct chats show? | As runs in that agent's activity log (his message and the reply), which Q10 already covers; no separate chat page, no automatic tickets. Benny asked "like a ticket?" as a clarifying question, not a request: a run is a log entry, a ticket is a piece of work on the board | "i just asked  if it was like a ticket and then you attached to the idea." |
| Q11 confirm | A run is one line in an agent's activity log | Confirmed | "yes" |
| Q12 | Should agents stop on their own past a usage point? | Liked, but not now; if it is ever built, the line is 98% of the weekly limit (past it, agents work only when Benny messages them; their handoffs and scheduled tasks wait for the reset) | "Nice idea! I like it, but not now. if anything 98% then." |
| Q13 | Agents that aren't Claude (e.g. GA Pardon's Verifier on Codex) | They keep Paperclip's own way (Paperclip starts their work): the one exception to "Paperclip never starts work". A Gemini account comes later. Only this Claude Desktop profile is in scope; the other two profiles on this PC wait | "Sure, if it makes sense. I also have Gemini account as well, but thats for later. Our version of paperclip is going to be claude desktop native. ... lets just ffocus on the one we're on for now." |
| Q14 | An agent's instructions change in Paperclip: when does its Desktop conversation follow them? | From its next turn, in the same conversation, handed over once; unchanged turns add nothing. Agent `.md` files (system prompt, loaded once and cached) are the native carrier, not an output style or per-turn reminders; the org folder names the Chief of Staff as its default agent the native way | "ok. yes." / "arent agent.mds better than when you were using outputstyle or something?" |
| Q15 | The team stalls after a Desktop update: what should happen? | Nothing for now; deal with it if it happens | "Nothing. Lets wait for that to happen." |
| Q16 | Where are recurring jobs set up? | Both: in Paperclip (the owning agent copies it into Desktop as a scheduled task) or by telling an agent in Desktop (it sets the task up there and adds it to Paperclip). Desktop runs it; Paperclip's copy stays paused so nothing runs twice; the latest edit wins | "both?" then "yes" |
| Q17 | Paperclip can still start work today: switch it off until the Desktop version is ready? | Everything paused. Done 2026-10-10: all 8 agents paused (CloudFlare Chief of Staff; GA Pardon Chief of Staff, Case Clerk, Verifier; Career Catchers' four were already paused) and Career Catchers' 5 routines paused | "Everything paused until desktop is done and ready." |
| Q18 | What should work first? | A new test org built from the beginning: "Lemonade Stand", whose Chief of Staff has three reports: Cashier, Lemonade Maker, Supplies Person | "From the beginning. A test org called lemonade stand. chief of staff has 3 reports - cashier, lemonade maker, supplies person" |
| Q19 | Which model for the Lemonade Stand agents? | A model with thinking, at medium effort: Haiku 5.5 (it thinks) | "whichever has thinking. med effort." |
| Q20 | Who drives the test? | Benny, the real way: he created Lemonade Stand (LEM, 2026-10-10 04:16Z) in Paperclip's new-org wizard himself; its agents are paused as they appear until the Desktop version is ready | "ok. i began" |
| Q20 result | He answered the Chief of Staff in Paperclip's onboarding card: why? | Only because Desktop showed nothing: making the org must put its folder and the Chief of Staff's conversation in Desktop's sidebar at once, ready to talk to. Telling it in Paperclip was a deliberate test | "i only did that because i didnt see the claude folder and the agent open on my claude desktop. so just for extra info, i told it do it from paperclip to test. if i didnt you wouldnt have known. i expected you to be forward thinking." / "aka DIDNT have a place to tell it to make 3 agents except thru paperclip because when it was created, i didnt see the session started from claudedesktop end." |
| Q20 next | Keep Lemonade Stand for the test? | No: a fresh test org once the Desktop version is ready. Lemonade Stand was archived 2026-10-10 (reversible) | "ok, maybe should start with fresh test when you're ready and done." |
| Q20 fix | The wizard takeover (an agentless org's Dashboard offer hijacking the open wizard) | Fixed in Paperclip's page instead of working around it, re-applied by the plugin on every start (2f66ef4); work is pushed as it lands | "stop being lazy and fix all that then. i dont even see you pushing to https://github.com/BennyWaitWhat/ClaudeDesktopPaperClip" |
| Q6 | How does he start talking to a specific agent? | Click its one conversation in the sidebar, under the org's folder; a brand-new chat in the org folder is the Chief of Staff; setup gives each agent one short hello reply, once, so it keeps its own identity | picked "Click it in the sidebar (Recommended)" |

## Verified facts (checked in Claude Desktop 2.31226.1 and Claude Code 2.1.295, 2026-10-09)

- **Agent-to-agent messages work while Benny is away.** Desktop's `send_message` goes through the same path as typing into the target conversation; when that conversation is not running, Desktop starts it ("retrying once through the cold-start path") and runs the turn without switching the screen. Reply states: delivered, queued, undelivered.
- **No hold on incoming messages here.** Claude Code holds a message from another session in a bypass-mode conversation unless the user setting allows it; Benny's `~/.claude/settings.json` already has `"crossSessionInbound": "accept"`.
- **Handing on works.** A turn started by another session's message can message a third session. Only starting new sessions (`start_session`, switched off on this account by Anthropic's servers) and moving to the cloud are reserved for the user's own typed words.
- **The presence check near `send_message` in Desktop's code** belongs to remote (SSH) host wake-ups, not to local messages.
- **One folder default agent per folder.** Claude Code prefers a folder's default agent over the agent a conversation started with, until that conversation's first reply; after that the conversation keeps its own agent.
- **Creating a conversation costs nothing** when its first message is held by a hook: the conversation is saved with its agent and name, and no model call happens.

## Paperclip as it stands (read-only snapshot, 2026-10-10)

- **Orgs:** CloudFlare (Chief of Staff only; org folder `Desktop\PaperClip\CloudFlare`), GA Pardon (Chief of Staff, Case Clerk, and the Verifier on Codex, not Claude; org folder `Desktop\PaperClip\ORG1 - Georgia Pardon`; new agents need board approval), Career Catchers (Chief of Staff, Application Writer, Pipeline Runner, Steward, all paused since 2026-10-09; no org folder; they work in the Career Ops repo).
- **Paperclip still starts work:** all 8 agents have `runtimeConfig.heartbeat.wakeOnDemand` true (assignment, comment, status, children-done, approval and recovery wakes); timers are off everywhere. Setting `wakeOnDemand` false stops every non-timer wake for that agent; pausing also blocks them but makes routines fail and delete their issue.
- **Routines:** Career Catchers has 5 (Morning sweep, Apply window prep, Morning brief, Friday scorecard, weekly repo health check). The first four already failed once on paused agents; Monday's runs will too.
- **Hires:** route `POST /api/companies/:id/agent-hires`; approval gate is the company's `require_board_approval_for_new_agents`; the hire route emits no plugin event (only approvals do); a new Claude hire gets no model, a one-line AGENTS.md unless the hirer supplies one, and Paperclip's core skills only for the top role.
- **Pressure signals:** many recent runs failed on the subscription's session limit and on expired sign-ins; weekly usage was 87% on 2026-10-09.

## Paperclip's workflows

Mapped end to end from its source on 2026-10-10: `PAPERCLIP-WORKFLOWS.md` (new org, agents, wakes and runs,
cards, routines, chat, plugins), with what it means for the Desktop version at the end. Benny: "i expected you to
have understood and read thru all the workflows of paperclip."

## What this flips

What was built until now made Paperclip the engine: it woke an agent and ran the turn (in the background, or pushed into Desktop's open copy). Benny wants the reverse: Desktop is the engine and Paperclip mirrors it.

## Code on disk (frozen during the grill, nothing switched on)

- **Survives the new picture:** the session hook that gives a Desktop conversation its agent's own Paperclip key (`hooks/desktop-session.mjs`, `org-folder.mjs`); agent files built from Paperclip's setup (`native-turn.mjs` placeAgent/agentDefinition); starting a conversation with no model call (`hooks/hold-first-message.mjs`).
- **Conflicts with "Paperclip never starts work":** Paperclip-driven turns (the adapter's execute), delivery into Desktop's open copy from Paperclip (`open-copy.mjs`), closing Desktop's copy before a run, handing new card conversations to Desktop.

## Open questions

(filled in as the grill goes)
