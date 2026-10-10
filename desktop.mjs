// Claude Desktop helpers shared by the adapter (index.mjs), the org-folder hooks and the plugin (plugin/worker.js):
// finding the Claude Code that Claude Desktop installed and the running Paperclip's packages, reading Claude Code's
// live-session registry, and handing a conversation to Claude Desktop's sidebar at a pause in your typing.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const compareVersions = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

// Claude Desktop is a packaged Windows app: its %APPDATA%\Claude is only visible under that name to programs
// it starts. Everything else finds the same folder under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming.
function desktopCodeRoots(env) {
  const roots = [path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code')];
  const packages = path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  for (const pkg of list(packages)) if (/^Claude_/i.test(pkg)) roots.push(path.join(packages, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
  return roots;
}

/** Folder of a @paperclipai package next to the running Paperclip (realpath, so the server's own copy). */
export function findPaperclipPackage(name, starts = [
  process.argv[1],
  path.join(path.dirname(process.execPath), 'node_modules', 'paperclipai', 'dist', 'index.js'),
]) {
  for (const start of starts) {
    if (!start) continue;
    let dir = path.dirname(path.resolve(start));
    for (;;) {
      const pkg = path.join(dir, 'node_modules', '@paperclipai', name);
      if (fs.existsSync(path.join(pkg, 'package.json'))) return fs.realpathSync(pkg);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

/** The newest Claude Code that Claude Desktop installed (Windows), or null. */
export function desktopClaudeCode(env = process.env) {
  if (process.platform !== 'win32') return null;
  let best = null;
  for (const root of desktopCodeRoots(env)) {
    for (const version of list(root)) {
      if (!/^\d+\.\d+/.test(version)) continue;
      for (const build of list(path.join(root, version))) {
        const file = path.join(root, version, build, 'claude.exe');
        if (!fs.existsSync(file)) continue;
        const mtime = fs.statSync(file).mtimeMs;
        const order = best ? compareVersions(version, best.version) : 1;
        if (order > 0 || (order === 0 && mtime > best.mtime)) best = { version, file, mtime };
      }
    }
  }
  return best ? { version: best.version, file: best.file } : null;
}

/** Live Claude Code sessions on this PC, from Claude Code's own registry (~/.claude/sessions/<pid>.json). */
export function liveSessions(dir = path.join(os.homedir(), '.claude', 'sessions')) {
  const out = [];
  for (const f of list(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      process.kill(s.pid, 0); // throws when the process is gone
      out.push({
        pid: s.pid, sessionId: s.sessionId, status: s.status, kind: s.kind, hostSessionId: s.hostSessionId,
        entrypoint: s.entrypoint, startedAt: s.startedAt, procStart: s.procStart, cwd: s.cwd,
        messagingSocketPath: s.messagingSocketPath,
      });
    } catch { /* stale or unreadable */ }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (value) => UUID.test(String(value ?? ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a short PowerShell command without holding up the process that asks (Paperclip's server). */
function powershell(command, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout, env: windowsUserEnv() },
      (_err, stdout) => resolve(String(stdout ?? '').trim()));
  });
}

const IDLE_PROBE = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class PaperclipIdle {
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Size; public uint Time; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref Info info);
  public static long Ms() { var i = new Info(); i.Size = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return -1; return (long)(uint)((uint)Environment.TickCount - i.Time); }
}
'@
[PaperclipIdle]::Ms()`;

/** Milliseconds since the last keyboard or mouse input on this PC, or null when it cannot tell. */
export async function idleMs() {
  if (process.platform !== 'win32') return null;
  const value = Number.parseInt(await powershell(IDLE_PROBE), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Hand a new conversation to Claude Desktop at the next pause in your typing (no keyboard or mouse for `quietMs`),
 * because Desktop switches to a conversation it is handed. Waits at most `maxWaitMs`, then hands it over anyway.
 */
export async function handOffWhenQuiet(sessionId, cwd, { open = openInDesktop, idle = idleMs, quietMs = 20_000, maxWaitMs = 15 * 60_000, pollMs = 5_000 } = {}) {
  for (const end = Date.now() + maxWaitMs; Date.now() < end;) {
    const ms = await idle();
    if (ms === null || ms >= quietMs) break;
    await sleep(Math.max(pollMs, quietMs - ms));
  }
  return open(sessionId, cwd);
}

/**
 * The basic Windows user environment, filled in where `base` lacks it. Paperclip starts plugin workers with
 * little more than PATH, and Claude Code and PowerShell need the profile, AppData and Windows folders.
 */
export function windowsUserEnv(base = process.env) {
  const env = { ...base };
  if (process.platform !== 'win32') return env;
  const has = (key) => Object.keys(env).some((k) => k.toLowerCase() === key.toLowerCase() && env[k]);
  const home = os.homedir();
  const windows = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const drive = windows.slice(0, 2);
  const local = path.join(home, 'AppData', 'Local');
  const fill = {
    SystemRoot: windows, windir: windows, SystemDrive: drive, ComSpec: path.join(windows, 'System32', 'cmd.exe'),
    USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: local, TEMP: path.join(local, 'Temp'), TMP: path.join(local, 'Temp'),
    USERNAME: os.userInfo().username, COMPUTERNAME: os.hostname(),
    ProgramData: `${drive}\\ProgramData`, ProgramFiles: `${drive}\\Program Files`, 'ProgramFiles(x86)': `${drive}\\Program Files (x86)`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL',
  };
  for (const [key, value] of Object.entries(fill)) if (!has(key)) env[key] = value;
  return env;
}

/**
 * Hand a Claude Code conversation to Claude Desktop (claude --desktop --resume), which lists it in the sidebar
 * under its folder. Claude Desktop names its copy local_<session id>, so handing one over twice opens the same
 * conversation instead of adding a second.
 */
export function openInDesktop(sessionId, cwd, claude = desktopClaudeCode(windowsUserEnv())?.file ?? 'claude', sessionsDir = undefined) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: 'only on Windows so far' });
  if (!isSessionId(sessionId)) return Promise.resolve({ ok: false, reason: 'not a session id' });
  if (!cwd || !path.isAbsolute(String(cwd)) || !fs.existsSync(String(cwd))) return Promise.resolve({ ok: false, reason: 'its folder is gone' });
  // Claude Desktop already has it loaded (and `claude --desktop` refuses a live session).
  if (liveSessions(sessionsDir).some((s) => s.sessionId === sessionId && s.kind === 'interactive')) return Promise.resolve({ ok: true, alreadyOpen: true });
  // `claude --desktop` refuses to run without a real console, so it gets a hidden one of its own.
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const command = `Start-Process -FilePath ${q(claude)} -ArgumentList '--desktop','--resume',${q(sessionId)} -WorkingDirectory ${q(cwd)} -WindowStyle Hidden -Wait`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore', env: windowsUserEnv() });
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, reason: 'timed out' }); }, 30_000);
    p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code}` }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
  });
}
