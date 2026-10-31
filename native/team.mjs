// Shared by the native team's hooks and scripts: which folder is a team's, and the marker the hello turn carries.
import fs from 'node:fs';
import path from 'node:path';

/** Set during the hello turn that makes a member's conversation, so the folder's hooks leave it alone. */
export const HELLO_ENV = 'CDPC_NATIVE_HELLO';

/** The team folder `cwd` is in: the nearest folder from `cwd` up that holds BOARD.md, or null. */
export function teamFolderOf(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'BOARD.md'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}
