# How Paperclip works (for the Desktop-native version)

Read this before answering anything about Paperclip or designing against it. Mapped 2026-10-10 from Paperclip's
source (`Desktop\PaperClip\paperclip`, 5717523b9 of 2026-10-07; the installed release is 2026.1005.0, two days
older, so line numbers can drift a little). Paths are from that repo's root: `S` = `server/src`, `U` = `ui/src`,
`SH` = `packages/shared/src`, `DB` = `packages/db/src/schema`. Live checks on Benny's install are marked (seen).

## 1. A new org, start to finish

The wizard (`U/components/OnboardingWizard.tsx`, one global dialog) has four steps: 1, 3, 4, 5 (0 and 2 are gone).

1. **Name your organization.** `POST /api/companies {name}` makes the org: a unique card prefix, Benny as
   owner, a local environment row, activity `company.created` (plugin event `company.created`). Defaults: no
   budget, `requireBoardApprovalForNewAgents` false, `defaultResponsibleUserId` = creator. No agent, goal or
   project yet. Our plugin makes the org folder on that event (seen: `Desktop\PaperClip\Lemonade Stand`).
2. **Create your first agent.** A name only; role forced to `general`. Nothing is sent yet.
3. **Connect a model.** Tiles: Claude (`claude_local`) and OpenAI (`codex_local`). On this PC (local driver)
   Paperclip never reads Benny's own `~/.claude` login: it connects from a Claude subscription he saved before
   (no new sign-in), or runs `claude setup-token` in a throwaway config folder (a link and a code). "An
   existing provider connection is available" only appears on cloud/sandbox drivers. Connections are per org
   and per person (`tool_connections` + grant), so every new org gets its own (seen: Lemonade Stand got a new
   "My Claude subscription", grant 120749f7).
   Connect then runs a real `claude --print "Respond with hello."` probe (spends a little quota; a failure
   blocks the hire) and hires through `POST /api/companies/:id/agent-hires`.
4. **The hire** (`S/routes/agents.ts` ~4672): status `idle` (or `pending_approval` + an approval the wizard
   approves itself when the org requires approval); a chief-of-staff `AGENTS.md` in
   `<instance>/companies/<org>/agents/<agent>/instructions`; Paperclip's 5 core skills plus `first-task`;
   `runtimeConfig.aiConnection {provider, method, mode: responsible_user}`; no model; heartbeat timer off;
   `dangerouslySkipPermissions` on. Activity `agent.hire_created`, which is NOT a plugin event: plugins never
   hear about wizard hires (`agent.created` fires only for `POST /companies/:id/agents`).
5. **"Get started".** Reuses or makes a project named "Onboarding" (`project.created`), then makes the first
   card (`issue.created`): "Paperclip onboarding", todo, assigned to the new agent, `originKind:
   onboarding_first_task` (one per org), a hidden description that invokes the `first-task` skill, a canned
   greeting comment from the agent (no model call) and a question card ("Interview me" / "I have a task in
   mind"). The agent is NOT woken; its first wake is Benny answering the question or commenting
   (`issue_commented`). Seen on LEM-1: Benny's comment woke it, the agent was paused, so Paperclip's stranded-work
   recovery marked the card blocked 25 seconds after it was made and posted "Paperclip cannot safely continue
   automatic recovery..." twice.

Dashboard offer (`U/pages/Dashboard.tsx` ~135): an org with no agents (terminated ones don't count) gets the
wizard opened at step 3 once per page load. That call replaced whatever the open wizard was doing, which is how
Test ORG's first agent landed in CloudFlare. Fixed in our `paperclip-ui-fixes.mjs`: the offer waits while the
wizard is open.

Deleting an org (`DELETE /api/companies/:id`) removes ~35 tables in one transaction but cancels no runs, sends
no plugin event and leaves folders: `<instance>/companies/<org>`, `workspaces/<agent>`, `data/run-logs/<org>`.
Archiving (`POST /api/companies/:id/archive`) is reversible: it pauses the org's agents (`company_archived`)
and cancels their runs; `PATCH {status: "active"}` brings it back.

## 2. Agents

- **Instructions**: plain files in the bundle folder above, edited in the agent page
  (`GET/PATCH /api/agents/:id/instructions-bundle`, `GET/PUT/DELETE .../file`). Disk is the truth; history is
  legacy-only (new saves keep no history). An edit logs activity `agent.files_updated` with a content hash and
  sends NO live or plugin event, so following edits means watching the files or their hash.
- **Skills**: the org library lives in `<instance>/skills/<org>/`; an agent's list is
  `adapterConfig.paperclipSkillSync` (`POST /api/agents/:id/skills/sync`). Nothing is copied at sync time; the
  Claude adapter links them per run (`--add-dir` to a prompt cache).
- **claude_local settings**: model, effort, chrome, maxTurnsPerRun, timeoutSec, cwd, instructionsFilePath,
  dangerouslySkipPermissions. A missing model means `claude-opus-5` at run time. The engine defaults to ACP;
  several UI defaults (chrome, maxTurns, skip-permissions) do nothing on ACP.
- **Pause** (`POST /api/agents/:id/pause`, board): cancels the active run, keeps queued wakes, blocks every new
  wake ("not invokable"). **Resume** sets idle. **Terminate** revokes all its API keys. **Delete** hard-deletes
  its runs, comments and activity and refuses agents with budget holds; terminate instead.
- **Agent API keys** (`POST /api/agents/:id/keys`, board only): never expire, scope `standard` by default,
  responsible user = the board user who made it (`local-board` here). A standard key reads the whole org,
  comments, creates and assigns cards; it cannot mint keys, approve, or pause agents.
- **Budgets**: off by default (amount 0). A hard-stop policy pauses on "unpriced" usage by default, so anything
  that reports usage must say `subscription_included` (0 cents) or give a price.

## 3. Wakes and runs

- **Every run starts as a wake** (`S/services/heartbeat.ts` `enqueueWakeup` ~27358). Sources: timer,
  assignment, on_demand, automation. Gates in order: budget, invokable (paused/terminated/pending fail), then
  `runtimeConfig.heartbeat.wakeOnDemand`: when false, EVERY non-timer wake is skipped, including an explicit
  `POST /api/agents/:id/wakeup` (~27847).
- **Who wakes an agent on its own**: a card assigned to it (`issue_assigned`), a comment on its card
  (`issue_commented`, not its own, not on closed cards), an answered question card, blockers resolved,
  children done, approvals, routines, and recovery (below). @mentions never wake.
- **Lifecycle**: queued → running (adapter `execute()`) → succeeded / failed / cancelled / timed_out. The
  adapter streams `onLog` into `<instance>/data/run-logs/<org>/<agent>/<run>.ndjson` (and live to the page) and
  returns usage, model, provider and `billingType`; Paperclip writes the cost row `heartbeat:<run>:final`.
- **No route records a run without executing it.** Run rows, logs and events come only from an adapter. From
  outside you can add cost rows (`POST /api/companies/:id/cost-events`, board or the agent's own key, with
  issue/project/run links), comments, documents and work products; the board can add plain activity rows.
- **Run id rules**: the run's own token (a JWT, 48 h) carries its run id. A lasting agent key has no run, and
  without a real run id an agent cannot check out a card, release it, create or answer question cards, or
  change its own `in_progress` card (401). It can still read, comment, create cards and change cards that are
  not its own `in_progress` ones.
- **After a run** (~26351): a succeeded run woken by an assignment with no comment carrying its run id gets one
  `status_only` retry; a card left todo/in_progress with no wait gets up to two "disposition repair" wakes,
  then escalation.
- **Stranded-work sweep** (`S/services/recovery/service.ts` ~5293): a todo/in_progress card whose assignee has
  no live run gets a bounded number of recovery wakes, then is marked blocked with a board-owned recovery
  action, assignee unchanged. A live run on the card prevents it.
- **Silent-run watchdog**: a running run with no output for 5 minutes is "suspicious", 15 minutes "critical",
  and can get a `stale_active_run_evaluation` card for the board; output resets the clock, and the board (or
  the assigned recovery owner) can snooze it.
- **What the pages read**: Runs = `GET /api/companies/:id/heartbeat-runs`; a run page = `/heartbeat-runs/:id`,
  `/events`, `/log`; a card's run list = runs on that card plus runs named in its activity; Costs from
  `cost_events`; the Dashboard from the summary, activity and live runs.

## 4. Cards

- Statuses: backlog, todo, in_progress, in_review, done, blocked, cancelled. No transition table; the real
  guards: in_progress needs an assignee and no open blockers; blocked needs blockers, a pending question or an
  unblock note; an agent moving to in_review needs a reviewer path.
- One assignee (agent or person). Assigned with no status → todo. Checkout is a lock that needs a run id.
- Question cards ("interactions"): suggest_tasks, ask_user_questions, request_confirmation,
  request_checkbox_confirmation, request_item_verdicts. Agents can answer them too unless
  `resolverPolicy: "human_only"`.
- Documents (`PUT /api/issues/:id/documents/:key` with a base revision) and work products (PR, branch, preview,
  artifact...).
- Reassigning a card cancels the old assignee's active run.

## 5. Routines (recurring jobs)

- A routine (status active/paused/archived) has triggers (cron + IANA time zone, webhooks). Each fire = a
  `routine_runs` row + a `routine_execution` card for the assignee + an assignment wake. The scheduler checks
  every 30 s; a paused routine writes nothing on its ticks.
- `POST /api/routines/:id/run` (manual or api) works while the routine is paused (only archived is refused):
  a real card + wake, recorded in the routine's history. Nothing records a run that happened elsewhere.
- Failures: a wake that throws (paused, terminated, over budget) deletes the card and marks the run failed;
  resuming a routine fires one catch-up run on the next tick because `nextRunAt` is not reset.
- The routine page's "Runs" tab lists the execution cards; the real history is `GET /api/routines/:id/runs`.

## 6. Chat

- Paperclip's agent chat is an experimental flag, off by default: a chat is a card, each message a comment and
  a run. Chat channels (Slack, email, Teams...) map each thread to a card and need a Paperclip-run agent.
- A conversation that happened outside cannot be shown as a Paperclip chat. The honest mirror is runs (section
  3) or comments on a card.

## 7. Plugins and adapter overrides

- 80 capabilities; 33 events, sent only for activity actions that are event names (or mapped) and for run
  started/finished/failed/cancelled. Not sent: agent status changes, cost rows, wizard hires, instruction edits.
  `ctx.events.listLifecycle` shows agent create/pause/resume/terminate.
- A plugin can create cards and comments, write activity (`actorType: plugin`), invoke agents (a wake), keep
  state, run scheduled jobs, register API routes and UI slots, and read/write configured local folders. It
  cannot write runs or costs.
- Upgrading a plugin to a manifest with a NEW capability fails (400) and leaves it stopped until disable +
  enable or a reinstall.
- An external adapter overrides a built-in type (ours overrides `claude_local`); reload with
  `POST /api/adapters/claude_local/reload`; pause is in memory only (a restart forgets it). `execute()`
  succeeds unless it returns an error, a signal or a non-zero exit; usage without `billingType`/`costUsd` is
  recorded as unpriced.

## What this means for the Desktop version

1. **Each Desktop turn needs a Paperclip run around it.** That is the only way a turn shows as a run (log,
   tokens, cost) and the only way the agent gets the run id it needs to check out and finish cards. A run only
   exists when Paperclip runs the adapter, so our `claude_local` adapter becomes the bridge: it does not start
   Claude, it ties the run to the agent's Desktop turn, streams that turn into the run log and reports its
   usage as `subscription_included`.
2. **`wakeOnDemand` stays on for Claude agents.** Turning it off would also refuse the wake that opens a
   Desktop turn's run.
3. **Paperclip's own wakes (assignment, comment, recovery) still arrive at the adapter.** They must neither
   start work nor end empty: an empty run brings retries, repair wakes and finally a blocked card (what LEM-1
   showed). The adapter keeps such a run open as "waiting for this agent in Claude Desktop" until the agent's
   next Desktop turn, which then fills it; an open run also keeps the stranded-work sweep away, and the silent
   watchdog needs a snooze or an occasional log line.
4. **Plugins don't hear about hires or instruction edits.** Setting up a new agent's Desktop conversation, and
   following instruction edits, needs a check on a timer (a plugin job), not an event.
5. **Recurring jobs**: the Desktop scheduled task can call `POST /api/routines/:id/run` on the paused Paperclip
   routine, so Paperclip's history shows every run and its card.
