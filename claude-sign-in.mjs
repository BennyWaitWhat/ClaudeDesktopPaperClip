// Paperclip's own Claude checks (the setup wizard's "Connect a model", its usage view) read command-line Claude's
// sign-in from ~/.claude/.credentials.json and never renew it. Its access token lasts 8 hours and only Claude Code
// renews it, when it runs; with the agents in Claude Desktop nothing may run it for days, and the wizard then says
// "Could not verify the local subscription". This keeps the file fresh: once the token has expired, a one-turn,
// no-tools Haiku call renews it (Claude Code leaves a token with time left alone, so earlier does nothing), about
// once every 8 hours. With no sign-in at all it does nothing (signing in is yours).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsUserEnv } from './desktop.mjs';

// Claude Code's lock while it renews. One left by a renewal cut short (a reboot) blocks every later renewal
// ("another Claude Code process is refreshing it"); no renewal takes minutes, so an older one is left over.
const STALE_LOCK_MS = 5 * 60_000;

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/**
 * When command-line Claude's access token expires (ms), or null with no sign-in to renew: none at all, or one
 * Claude Code signed out (it keeps the file, with no refresh token and an expiry of 0; only `claude auth login`
 * mends that, and every renewal would fail, as one a minute did from 2026-10-14 8 PM to 10-15 4 PM).
 */
export function tokenExpiry(dir = claudeConfigDir()) {
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth;
    return typeof oauth?.expiresAt === 'number' && oauth.refreshToken ? oauth.expiresAt : null;
  } catch {
    return null;
  }
}

export const needsRenewal = (expiresAt, now = Date.now()) => expiresAt != null && expiresAt <= now;

/** Remove Claude Code's renewal lock when it is older than any renewal takes. */
export function clearStaleLock(dir = claudeConfigDir(), now = Date.now()) {
  const lock = path.join(dir, '.oauth_refresh.lock');
  try {
    if (now - fs.statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
    fs.rmSync(lock, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** One turn on Haiku with no tools, no MCP servers and no user hooks, in a scratch folder, so Claude Code renews. */
export function runClaude({ claude, timeoutMs = 120_000 }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpc-sign-in-'));
  const args = ['-p', 'Reply with just: ok', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--strict-mcp-config',
    '--setting-sources', 'project', '--no-session-persistence', '--output-format', 'json'];
  return new Promise((resolve) => {
    const child = execFile(claude, args, { cwd, env: windowsUserEnv(), windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve({ ok: !err, error: err ? String(stderr || err.message).slice(0, 300) : null });
    });
    child.stdin?.end();
  });
}

/** Renew command-line Claude's sign-in when it is about to expire. */
export async function keepSignInFresh({ claude, dir = claudeConfigDir(), now = () => Date.now(), run = runClaude } = {}) {
  const before = tokenExpiry(dir);
  if (before == null) return { renewed: false, reason: 'not signed in' };
  if (!needsRenewal(before, now())) return { renewed: false, reason: 'fresh', expiresAt: before };
  const clearedLock = clearStaleLock(dir, now());
  const result = await run({ claude });
  const after = tokenExpiry(dir);
  const renewed = after != null && after > before;
  return { renewed, clearedLock, expiresAt: after, error: renewed ? null : result.error ?? 'the token did not change' };
}
