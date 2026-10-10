// UserPromptSubmit hook that starts a card's conversation without a model call (index.mjs, startConversation):
// Claude Code saves the conversation with its agent and name, and the first real message goes to Claude Desktop's
// copy of it instead, so the card's first turn also runs inside Claude Desktop.
for await (const _chunk of process.stdin) { /* the prompt is not needed */ }
process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Paperclip opened this conversation; its first turn runs in Claude Desktop.' }));
