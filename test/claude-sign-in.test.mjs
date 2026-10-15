import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearStaleLock, keepSignInFresh, needsRenewal, tokenExpiry } from '../claude-sign-in.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sign-in-'));
const signIn = (dir, expiresAt) => fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'r', expiresAt } }));
const NOW = Date.parse('2026-10-12T23:00:00Z');
const HOUR = 60 * 60_000;

test('reads the expiry, and null with no sign-in', () => {
  const dir = tmp();
  assert.equal(tokenExpiry(dir), null);
  signIn(dir, NOW + HOUR);
  assert.equal(tokenExpiry(dir), NOW + HOUR);
});

test('a sign-in Claude Code signed out (no refresh token, expiry 0) counts as none, and runs nothing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 0, scopes: ['user:inference'] } }));
  assert.equal(tokenExpiry(dir), null);
  let runs = 0;
  assert.equal((await keepSignInFresh({ dir, now: () => NOW, run: async () => { runs++; return { ok: false }; } })).reason, 'not signed in');
  assert.equal(runs, 0);
});

test('renews once the token has expired, never before and never without a sign-in', () => {
  assert.equal(needsRenewal(null, NOW), false);
  assert.equal(needsRenewal(NOW + 2 * HOUR, NOW), false);
  assert.equal(needsRenewal(NOW + 60_000, NOW), false);
  assert.equal(needsRenewal(NOW, NOW), true);
  assert.equal(needsRenewal(NOW - 3 * 24 * HOUR, NOW), true);
});

test('a fresh token or no sign-in runs nothing', async () => {
  const dir = tmp();
  let runs = 0;
  const run = async () => { runs++; return { ok: true }; };
  assert.equal((await keepSignInFresh({ dir, now: () => NOW, run })).reason, 'not signed in');
  signIn(dir, NOW + 5 * HOUR);
  assert.equal((await keepSignInFresh({ dir, now: () => NOW, run })).reason, 'fresh');
  assert.equal(runs, 0);
});

test('an expired token is renewed, and a left-over renewal lock is cleared first', async () => {
  const dir = tmp();
  signIn(dir, NOW - 3 * 24 * HOUR);
  const lock = path.join(dir, '.oauth_refresh.lock');
  fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000));
  const run = async () => { assert.equal(fs.existsSync(lock), false); signIn(dir, NOW + 8 * HOUR); return { ok: true }; };
  const result = await keepSignInFresh({ dir, now: () => NOW, run });
  assert.deepEqual(result, { renewed: true, clearedLock: true, expiresAt: NOW + 8 * HOUR, error: null });
});

test('a renewal lock in use is left alone, and a renewal that changes nothing says so', async () => {
  const dir = tmp();
  signIn(dir, NOW - HOUR);
  fs.mkdirSync(path.join(dir, '.oauth_refresh.lock'));
  assert.equal(clearStaleLock(dir, Date.now()), false);
  const result = await keepSignInFresh({ dir, now: () => Date.now(), run: async () => ({ ok: false, error: 'another Claude Code process is refreshing it' }) });
  assert.equal(result.renewed, false);
  assert.equal(result.clearedLock, false);
  assert.match(result.error, /refreshing/);
});
