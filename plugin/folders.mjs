// Where org folders go and what they are called.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsUserEnv } from '../desktop.mjs';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A folder name Windows accepts, from an org name ("Acme: R&D" becomes "Acme R&D"). */
export function orgFolderName(name) {
  let n = String(name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!n) n = 'Org';
  if (RESERVED.test(n.split('.')[0])) n = `${n} org`;
  return n.slice(0, 80).trim();
}

/** The Windows Desktop, where it really is (it can be moved, for example into OneDrive). */
export function desktopFolder(env = process.env) {
  const home = env.USERPROFILE || os.homedir();
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: windowsUserEnv(env) });
      const raw = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim();
      const vars = { USERPROFILE: home, ...env }; // plugin workers start without USERPROFILE
      const dir = raw?.replace(/%([^%]+)%/g, (all, key) => vars[key] ?? vars[key.toUpperCase()] ?? all);
      if (dir && !dir.includes('%') && fs.existsSync(dir)) return dir;
    } catch { /* fall through */ }
  }
  const desktop = path.join(home, 'Desktop');
  return fs.existsSync(desktop) ? desktop : home;
}

/** Make <parent>\<org name> (or reuse it when it is already there) and return its path. */
export function ensureOrgFolder(parent, orgName) {
  if (!parent || !path.isAbsolute(parent)) throw new Error(`Not a full folder path: ${parent}`);
  const dir = path.join(parent, orgFolderName(orgName));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A folder path someone typed: full path required; it is made when missing. */
export function ensureFolder(input) {
  const dir = String(input ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!dir || !path.isAbsolute(dir)) throw new Error('Give the full path, for example C:\\Users\\you\\Desktop');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is a file, not a folder`);
  return path.resolve(dir);
}
