import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/start-paperclip.ps1 sets a stale database lock aside before it starts Paperclip (CAR-598, Benny: "Fix.").
// On 2026-10-26 at 9:23 AM Benny's PC refused its own database: the 1:07 AM shutdown had left db\postmaster.pid
// behind, and after the reboot the process number in it belonged to a conhost.exe. Each case runs the script on a
// temporary instance folder, with a stand-in for "paperclipai run" and patterns that find only this test's own
// stand-in processes, so the Paperclip running on this PC is never looked at or touched.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'start-paperclip.ps1');
const pwsh = process.platform !== 'win32' ? null
  : ['pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((p) => spawnSync(p, ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0);
const skip = pwsh ? false : 'needs Windows and PowerShell 7';

const made = [];
const kids = [];
after(() => {
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-paperclip-')); made.push(dir); return dir; };
const token = `cc${process.pid}x${Date.now().toString(36)}`;
const NONE = `no-such-process-${token}`;

// An instance folder whose lock names `owner` (a process number; none when undefined), shaped like the real one, and
// a stand-in run that leaves started.txt behind.
function instance(owner) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'db'));
  fs.mkdirSync(path.join(dir, 'logs'));
  const lock = path.join(dir, 'db', 'postmaster.pid');
  if (owner !== undefined) fs.writeFileSync(lock, `${owner}\n${dir.replace(/\\/g, '/')}/db\n1792989276\n54329\n\nlocalhost\n  5432001         0\nready   \n`);
  const run = path.join(dir, 'run.ps1');
  fs.writeFileSync(run, `Set-Content -LiteralPath '${path.join(dir, 'started.txt')}' -Value 'started'\nWrite-Output 'stand-in started'\n`);
  return {
    dir, run, lock,
    started: () => fs.existsSync(path.join(dir, 'started.txt')),
    log: () => { try { return fs.readFileSync(path.join(dir, 'logs', 'paperclip-server.log'), 'utf8'); } catch { return ''; } },
    aside: () => fs.readdirSync(path.join(dir, 'db')).filter((f) => f.startsWith('postmaster.pid.stale-')),
  };
}

// A process that lives until the tests end, with `tag` in its command line: a stand-in database or server.
function stand(tag) {
  const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', tag], { stdio: 'ignore' });
  kids.push(k);
  return k;
}

// A port nothing answers on, for a Paperclip that is not running.
async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// Runs the script; never blocks this process, so a fake health endpoint here can answer it.
async function start(inst, { health, server = NONE, database = NONE } = {}) {
  const url = health ?? `http://127.0.0.1:${await closedPort()}/api/health`;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Instance', inst.dir, '-Health', url, '-ServerMatch', server, '-DatabaseMatch', database, '-RunScript', inst.run];
  return new Promise((resolve) => {
    const p = spawn(pwsh, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => resolve({ status, out }));
  });
}

test('a stale lock whose process number now belongs to another program is set aside, kept, logged once, and Paperclip starts', { skip }, async () => {
  const inst = instance(process.pid);   // alive and not a database, as the conhost.exe of 2026-10-26 was
  const before = fs.readFileSync(inst.lock, 'utf8');
  const r = await start(inst);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.existsSync(inst.lock), false, 'the lock is no longer in the way');
  const aside = inst.aside();
  assert.equal(aside.length, 1, r.out);
  assert.match(aside[0], /^postmaster\.pid\.stale-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.equal(fs.readFileSync(path.join(inst.dir, 'db', aside[0]), 'utf8'), before, 'set aside unchanged, never deleted');
  const lines = inst.log().split(/\r?\n/).filter((l) => l.includes('Set aside a stale database lock'));
  assert.equal(lines.length, 1, inst.log());
  assert.match(lines[0], new RegExp(`named process ${process.pid} \\(now node\\.exe, not a database\\), and no Paperclip database is running\\. Kept as db\\\\${aside[0].replace(/\./g, '\\.')}\\.$`));
  assert.equal(inst.started(), true, 'the start went on');
});

test('a lock whose process has ended is set aside too, and Paperclip starts', { skip }, async () => {
  const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const inst = instance(ended);
  const r = await start(inst);
  assert.equal(r.status, 0, r.out);
  assert.equal(inst.aside().length, 1, r.out);
  assert.match(inst.log(), new RegExp(`named process ${ended} \\(no longer running\\)`));
  assert.equal(inst.started(), true);
});

test('while a Paperclip database is running, its lock stays and the start goes to Paperclip, which reuses that database', { skip }, async () => {
  const db = stand(`${token}-database`);
  for (const owner of [db.pid, process.pid]) {   // the lock names the database itself, or a database runs beside it
    const inst = instance(owner);
    const before = fs.readFileSync(inst.lock, 'utf8');
    const r = await start(inst, { database: `${token}-database` });
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(inst.lock, 'utf8'), before, 'the lock is left as it was');
    assert.deepEqual(inst.aside(), []);
    assert.match(inst.log(), new RegExp(`A Paperclip database is running \\(process ${db.pid}\\): its lock stays`));
    assert.equal(inst.started(), true, 'handed to "paperclipai run", which reuses the running database');
  }
});

test('a Paperclip that is running but not answering yet is not started a second time, and its lock is left alone', { skip }, async () => {
  stand(`${token}-server`);
  const inst = instance(process.pid);   // a lock that would look stale
  const before = fs.readFileSync(inst.lock, 'utf8');
  const r = await start(inst, { server: `${token}-server` });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /does not answer yet: not starting a second one/);
  assert.equal(inst.started(), false, 'no second Paperclip');
  assert.equal(fs.readFileSync(inst.lock, 'utf8'), before);
  assert.deepEqual(inst.aside(), []);
});

test('a Paperclip that answers is left alone: nothing starts and its lock is untouched', { skip }, async () => {
  const s = http.createServer((q, a) => { a.writeHead(200, { 'Content-Type': 'application/json' }); a.end('{"status":"ok"}'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const inst = instance(process.pid);
    const before = fs.readFileSync(inst.lock, 'utf8');
    const r = await start(inst, { health: `http://127.0.0.1:${s.address().port}/api/health` });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Paperclip is already running\./);
    assert.equal(inst.started(), false);
    assert.equal(fs.readFileSync(inst.lock, 'utf8'), before);
    assert.deepEqual(inst.aside(), []);
  } finally {
    s.close();
  }
});

test('with no lock, Paperclip starts and nothing is set aside', { skip }, async () => {
  const inst = instance(undefined);
  const r = await start(inst);
  assert.equal(r.status, 0, r.out);
  assert.equal(inst.started(), true);
  assert.deepEqual(inst.aside(), []);
  assert.doesNotMatch(inst.log(), /Set aside/);
});
