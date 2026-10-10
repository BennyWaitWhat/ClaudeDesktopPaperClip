// Claude Desktop helpers shared by the adapter (index.mjs) and the plugin (plugin/worker.js): finding the Claude
// Code that Claude Desktop installed, reading Claude Code's live-session registry, and handing a conversation
// to Claude Desktop's sidebar.
import { spawn } from 'node:child_process';
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
      out.push({ pid: s.pid, sessionId: s.sessionId, status: s.status, kind: s.kind, hostSessionId: s.hostSessionId });
    } catch { /* stale or unreadable */ }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (value) => UUID.test(String(value ?? ''));

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
export function openInDesktop(sessionId, cwd, claude = desktopClaudeCode(windowsUserEnv())?.file ?? 'claude') {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: 'only on Windows so far' });
  if (!isSessionId(sessionId)) return Promise.resolve({ ok: false, reason: 'not a session id' });
  if (!cwd || !path.isAbsolute(String(cwd)) || !fs.existsSync(String(cwd))) return Promise.resolve({ ok: false, reason: 'its folder is gone' });
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
