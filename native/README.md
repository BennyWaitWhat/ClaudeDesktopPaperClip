# A team without Paperclip

Paperclip's way of working, kept in Claude Desktop and on one claude.ai page, with no Paperclip server. First team: GA Pardon (2026-10-31; Benny: "I really want it to follow the thing that make paperclip, paperclip. But yes go ahead and make a Claude Code native version. like the workflow methodology").

| Paperclip | Here |
|---|---|
| The org chart | `team/<agent>` on the board; each member is a job file in `.claude/agents/` with its own Desktop conversation (`hire.mjs`) |
| Goals | `goals/<id>` under the mission in `meta/org`; Benny approves them |
| Issues | `cards/<PREFIX-n>`: one owner, the seven statuses, parent cards, blocked-by, comments |
| Heartbeats | A turn in a member's conversation, woken by a hand-off message or by Benny; scheduled routines only on his approval |
| Checkout | `in_progress` plus `checkout`, written pinned to the card's version |
| The board (the human) | Benny: approvals and steps assigned to `benny`, at the top of his page under "Waiting on you" |
| Activity | `activity/<id>`, one row per change |
| The UI | The page: Waiting on you, then Work, Goals, Team and Log |

The rules every member follows are in `templates/BOARD.md`, which becomes the team's `BOARD.md`.

## Files

- `templates/board.html`: the page. Published with the Artifact tool, capabilities `{"db": {"rules": [{"path": "", "read": "view", "write": "admin"}]}, "user": {}}`, so only Benny (and editors he adds) can change it. The team writes to it with the ArtifactData tool, as Benny.
- `templates/BOARD.md`: the method, with the page's link filled in.
- `hooks/session-start.mjs`: a plain new chat in the folder is the Chief of Staff.
- `hooks/allow.mjs`: every tool goes ahead, except sends, deletes, trash, sharing and calendar changes in Benny's Google apps, which stay on his words (shared with `hooks/paperclip-allow.mjs`).
- `hire.mjs`: a member's own Desktop conversation (a hello turn as that member, then into Desktop's sidebar).
- `setup-org.mjs`: writes the page's copy, the hooks and `BOARD.md` into a team folder.

## A new team

1. In the team folder, write `CLAUDE.md` (import `@FACTS.md` and `@BOARD.md`), `FACTS.md`, and `.claude/agents/chief-of-staff.md`.
2. `node native/setup-org.mjs --folder "<folder>" --org "<Team>" --prefix ABC`
3. Publish `<folder>/.claude/board.html` with the Artifact tool and the capabilities above.
4. `node native/setup-org.mjs --folder "<folder>" --org "<Team>" --prefix ABC --board <the page's link>`
5. `node native/hire.mjs --folder "<folder>" --agent chief-of-staff --name "Chief of Staff" --org "<Team>"`, then file the conversation in the team's sidebar section.
6. With ArtifactData, write `meta/org`, `team/chief-of-staff` (with its `local_<id>` conversation) and the first card.

A change to the page: edit `templates/board.html`, run step 2 again for each team, and republish each team's page to its own link.
