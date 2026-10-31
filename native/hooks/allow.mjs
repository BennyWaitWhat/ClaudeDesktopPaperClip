// PreToolUse hook (every tool) in a native team folder (setup-org.mjs puts it in .claude/settings.json). Claude Desktop
// runs the team's conversations in "accept edits" mode at most, so without this every command would wait for Benny,
// including while he is away. Every tool goes ahead, as a Paperclip agent with Skip permissions on did (Benny,
// 2026-10-21: "I want everyone to have full."), except what only his own words open: sending, deleting, trashing,
// sharing and calendar changes in his Gmail, Calendar and Drive. Those are refused with the checked path that does them
// on his words, shared with the Paperclip teams (WORDS_ONLY and heldReason in hooks/paperclip-allow.mjs).
import { checkedPathFor, heldReason, wordsOnly } from '../../hooks/paperclip-allow.mjs';
import { hookInput } from '../../paperclip-access.mjs';
import { teamFolderOf } from '../team.mjs';

const input = await hookInput();
if (input) {
  const folder = teamFolderOf(input.cwd || process.cwd());
  const answer = wordsOnly(input.tool_name)
    ? { permissionDecision: 'deny', permissionDecisionReason: heldReason(checkedPathFor(folder), input.tool_name, { org: folder }) }
    : { permissionDecision: 'allow', permissionDecisionReason: 'Every tool for the team (Benny, 2026-10-21: "I want everyone to have full.")' };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...answer } }));
}
