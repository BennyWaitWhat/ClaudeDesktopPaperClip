# How the team works: the board

The board is Benny's page and the team's record: __BOARD_URL__ (cards are numbered __PREFIX__-1, __PREFIX__-2, ...). It works the way Paperclip does, without Paperclip: an org chart, goals, cards with one owner each, a turn per heartbeat, Benny's approvals, reviews, and a log of every change.

Read and write it with the ArtifactData tool, always with `url` set to the link above. If ArtifactData shows only as a name, load it first (ToolSearch "select:ArtifactData"). What you write is shared and lasting, and Benny sees it live.

## What is on it

- `meta/org` (one document): `name`, `prefix`, `mission`, `missionSource`, `owner`, `ownerShort`, `chief`.
- `goals/<id>`: `title`, `why`, `status` (active, met, dropped), `order`, `createdAt`, `createdBy`.
- `cards/<__PREFIX__-n>`: `number`, `title`, `body`, `status`, `kind` (task, approval, step), `assignee`, `reviewer`, `goal`, `parent`, `blockedBy` (card numbers), `priority` (urgent, high, medium, low), `createdBy`, `createdAt`, `updatedAt`, `updatedBy`, `checkout` (`{by, at}` or null), `decision` (`{verdict, note, by, at}` or null; verdict is approved, declined or changes), `lastCommentAt`, `lastCommentBy`.
- `cards/<__PREFIX__-n>/comments/c-<ms>-<5 letters>`: `author`, `body`, `at`.
- `team/<agent>`: `name`, `title`, `reportsTo` (benny or an agent), `job`, `status` (active, paused, retired), `conversation` (`local_<id>`), `agentFile`, `hiredAt`, `approval` (the card), `lastTurnAt`, `lastTurnSummary`.
- `activity/a-<ms>-<5 letters>`: `at`, `actor`, `action`, `card`, `detail`.

People are written by id: `benny` for Benny, and each agent by its job file's name (`chief-of-staff` for `.claude/agents/chief-of-staff.md`). Times are UTC, written like `2026-10-31T14:05:00.000Z`. Ids such as `a-1761919500000-k3x9q` are the time in milliseconds and five random letters or digits.

## Statuses

- `backlog`: known, not started, not scheduled.
- `todo`: ready; its owner starts it on their next turn.
- `in_progress`: someone is on it right now. Only during a turn.
- `in_review`: the owner is done; the reviewer checks it.
- `blocked`: it waits on another card, named in `blockedBy`.
- `done` and `cancelled`.

## Every turn

A turn is the team's heartbeat: it starts when a message arrives in your conversation (from Benny or a teammate) and ends when you reply.

1. **Read first.** Your cards (query `cards` where `assignee` is you), the cards you review (`reviewer` is you and `status` is in_review), and `team/<you>`. A card whose `lastCommentAt` is after your `lastTurnAt`, and whose `lastCommentBy` is not you, has new comments: read them. Benny's words in your chat come first.
2. **Check out** the card you work on: update it to `in_progress` with `checkout: {by: you, at: now}`, pinned to the version you read. If the write is refused because the card changed, read it again: someone else may have it.
3. **Do the work.** Results go in files in this folder or in comments, never only in the chat.
4. **Leave every card resting:** done, in_review (with a reviewer), blocked (with `blockedBy`), backlog, or todo for its next owner. Never in_progress at the end of a turn, and `checkout` back to null.
5. **Record it:** a comment on each card you worked (what you did, where the result is, what comes next), one activity row per change, then `team/<you>`: `lastTurnAt` and a one-line `lastTurnSummary`. Send these end-of-turn writes as one batch when you can.

Example calls (fill in your own values):
- Your open cards: `action: "query"`, `collection: "cards"`, `query: {where: [["assignee", "==", "chief-of-staff"], ["status", "in", ["backlog", "todo", "in_progress", "in_review", "blocked"]]]}`.
- Check out: `action: "update"`, `collection: "cards"`, `doc_id: "__PREFIX__-7"`, `data: {status: "in_progress", checkout: {by: "chief-of-staff", at: "<now>"}, updatedAt: "<now>", updatedBy: "chief-of-staff"}`, `if_version: <the version you read>`.

## Writing safely

- Read before you write, and pin every write to an existing document with `if_version`. If a pinned write is refused, read again and redo it; never overwrite someone else's change.
- A new card, comment or activity row is written without `if_version`, and is refused if its id already exists. A new card takes the highest card number on the board plus one; if refused, try the next number.
- Change a card with `update`, never `set` (`set` replaces the whole card).
- After a comment, update the card's `lastCommentAt` and `lastCommentBy`.
- An activity row: `actor` is you; `action` is a short verb in the past tense that reads after your name and before the card number ("made", "started", "moved", "commented on", "handed", "finished", "asked Benny to approve"); `detail` is one line ("To In review", "To the Records Clerk", a file's name).
- The board holds at most 25,000 documents. Keep comments short; long text goes in a file and the comment names it.

## Owners and hand-offs

- Every card has one owner (`assignee`). The owner does the work or hands it on.
- **A hand-off is the card plus a message.** Update the card (`assignee`: them, `status`: todo), comment why, then SendMessage to their conversation (`team/<them>.conversation`) naming the card: "__PREFIX__-7 is yours: <one line>. Details are on the card." The message wakes them; the card holds the work.
- Work flows along the org chart (`reportsTo`): the Chief of Staff hands work down; a member sends results and questions up to whom they report.
- Big work splits into sub-cards with `parent` set to the big card, which waits blocked on them (`blockedBy`).

## Goals

- The mission (`meta/org`) is Benny's. Goals under it start as an approval for Benny; work aims only at goals he approved.
- Every card names its goal, or says in its body why it has none.

## Benny: approvals and steps

Benny owns the team; he is not a teammate. What only he decides or does goes on a card assigned to `benny`, which puts it at the top of his page under "Waiting on you".

- **Approval** (`kind: approval`): a decision. The body says what is asked, the options, and what you recommend and why. Every hire needs one, and so do the plan and its goals, any change to the mission, spending money, and anything that reaches outside the team (filing, writing or calling anyone). He presses Approve, Decline or Ask for changes, and `decision` holds his answer: approved, go ahead; declined, stop that line of work; changes, the card comes back to its maker as todo with his note.
- **Step** (`kind: step`): something only he can do (sign, pay, sign in, send, mail, call, find a paper). The title starts with the verb ("Sign: ...", "Pay: ...", "Send: ..."). The body says exactly what to do and where, with links and file paths. He presses Mark done, or a checker closes it after checking it happened (the email in Sent, the receipt, his own words): status done, with a comment that starts "Checked:" and says what you saw and when. Nobody else closes it.
- The card that needs his answer waits blocked on his card until it is done.
- An approval is never a send. Sending follows the team's rule 1 in `CLAUDE.md`: his own direct words.
- His buttons wake nobody. You see his decisions on your next turn; he can say "go" in a chat to start one sooner.

## Reviews

Work that leaves the team, or that Benny will rely on (a letter, a form, a filing, a legal point), gets a reviewer before it is done: status in_review, `reviewer` set to a teammate who did not write it, or to benny. The reviewer accepts it (done) or sends it back (todo, with a comment saying what to fix).

## Hiring (the Chief of Staff, after Benny approves)

1. An approval card, "Hire: <Name>, <title>": the job in one paragraph, who it reports to, why now, and its first card.
2. On approval, write its job file `.claude/agents/<agent>.md` (opening "You are <Name> at __ORG__'s team. You report to <boss>.", then "## Your job", "## How you work", "## Output bar" and "## Done", in simple English), then run:
   `node "__HIRE__" --folder "__FOLDER__" --agent <agent> --name "<Name>" --org "__ORG__"`
   It makes the member's own Claude Desktop conversation (a one-line hello, no work) and prints its id.
3. Add `team/<agent>`: name, title, reportsTo, job, status active, conversation (`local_<id>`), agentFile, hiredAt, approval.
4. File its conversation in the sidebar section "__ORG__" (ccd_sidebar: `move_sessions`).
5. Hand it its first card.

## On a schedule

Nobody runs on a timer unless Benny approves it. A routine (a Claude Desktop scheduled task) starts as an approval card.
