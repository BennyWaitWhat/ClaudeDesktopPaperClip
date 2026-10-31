// Makes a team member's own Claude Desktop conversation in a native team folder: a hello turn as that member (one turn,
// no tools, no MCP servers, only the folder's own settings; setup, never work), then hands it to Claude Desktop's
// sidebar at the next pause in Benny's typing, because Desktop switches to a conversation it is handed. The member's
// job file must exist first (.claude/agents/<agent>.md); the conversation keeps that agent from then on.
// Desktop keeps the hello's model and its "accept edits" mode; the folder's PreToolUse hook does the rest.
//   node hire.mjs --folder <team folder> --agent <agent file name> --name "<Name>" --org "<Team>" [--now | --no-open]
// Prints JSON: { ok, sessionId, conversation: "local_<id>", reply, model, error, desktop }.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopClaudeCode, handOffWhenQuiet, openInDesktop, windowsUserEnv } from '../desktop.mjs';
import { HELLO_ENV } from './team.mjs';

export const helloPrompt = ({ name, org }) =>
  `(Setup, not work.) This is your own conversation in Claude Desktop, ${name}: Benny and your teammates in ${org} will talk to you here. Reply with one short line of hello, and nothing else.`;

/** The hello turn. Resolves { ok, sessionId, reply, model, error }. */
export function makeConversation({ claude, folder, agent, name, org, sessionId = crypto.randomUUID(), timeoutMs = 180_000 }) {
  const args = [
    '-p', helloPrompt({ name, org }), '--agent', agent, '--session-id', sessionId, '--name', name,
    '--output-format', 'json', '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--effort', 'low',
    '--permission-mode', 'acceptEdits',
  ];
  return new Promise((resolve) => {
    const child = execFile(claude, args, { cwd: folder, env: { ...windowsUserEnv(), [HELLO_ENV]: '1' }, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* no answer */ }
      const ok = Boolean(!err && out && !out.is_error && out.session_id === sessionId);
      resolve({
        ok, sessionId, reply: typeof out?.result === 'string' ? out.result : null, model: Object.keys(out?.modelUsage ?? {})[0] ?? null,
        error: ok ? null : String(out?.result || stderr || err?.message || 'Claude Code gave no answer').slice(0, 500),
      });
    });
    child.stdin?.end(); // nothing to read: Claude Code would otherwise wait for it
  });
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const folder = arg('folder') ? path.resolve(arg('folder')) : '';
  const agent = arg('agent') ?? '';
  const name = arg('name') ?? '';
  const org = arg('org') ?? (folder ? path.basename(folder) : '');
  const fail = (error) => { process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`); process.exit(1); };
  if (!folder || !fs.existsSync(folder)) fail('--folder must be the team folder');
  if (!/^[A-Za-z0-9_-]+$/.test(agent)) fail('--agent must be the job file name, letters, digits, - and _ only');
  if (!fs.existsSync(path.join(folder, '.claude', 'agents', `${agent}.md`))) fail(`write .claude/agents/${agent}.md first`);
  if (!name.trim()) fail('--name is the member name, such as "Records Clerk"');

  const claude = desktopClaudeCode(windowsUserEnv())?.file ?? 'claude';
  const made = await makeConversation({ claude, folder, agent, name: name.trim(), org });
  let desktop = null;
  if (made.ok && !argv.includes('--no-open')) {
    desktop = argv.includes('--now')
      ? await openInDesktop(made.sessionId, folder, claude)
      : await handOffWhenQuiet(made.sessionId, folder, { open: (id, cwd) => openInDesktop(id, cwd, claude), maxWaitMs: 2 * 60_000 });
  }
  process.stdout.write(`${JSON.stringify({ ...made, conversation: made.ok ? `local_${made.sessionId}` : null, desktop })}\n`);
  process.exit(made.ok ? 0 : 1);
}
