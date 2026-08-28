/**
 * Self-check for the stale singleton lock rule.
 *
 *   node tools/test-profile-lock.js
 *
 * The distinction under test is the one that silently breaks tracker.gg: a lock
 * left by a dead browser must be cleared, because real Chrome refuses a profile
 * that looks busy and the channel search then falls through to bundled Chromium
 * under a different user agent - which no Chrome-earned clearance is valid for.
 * A lock held by a *live* browser must survive, because two browsers sharing one
 * profile corrupts it. Those two look identical on disk; only the owner tells
 * them apart.
 */

import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { clearStaleSingletonLock } from '../browser.js';

const lockPath = (dir) => path.join(dir, 'SingletonLock');
// lstat, not stat: the lock is a symlink to "<host>-<pid>", which is not a real
// path, so following it would report every lock as absent.
const exists = async (target) => Boolean(await lstat(target).catch(() => null));

async function profileWithLock(target) {
  const dir = await mkdtemp(path.join(tmpdir(), 'profile-lock-'));
  if (target) await symlink(target, lockPath(dir));
  return dir;
}

// --- a lock from another machine (a recreated container) is stale -----------

let dir = await profileWithLock('0c06eef6bb26-416');
await clearStaleSingletonLock(dir);
assert.equal(await exists(lockPath(dir)), false, 'a lock naming another host must be cleared');
await rm(dir, { recursive: true, force: true });

// --- a lock naming a pid that is gone is stale ------------------------------

// Chosen high and then confirmed dead, rather than assumed: a pid that happens
// to be alive would make this pass for the wrong reason.
let deadPid = 999_999;
for (; deadPid > 1; deadPid -= 1) {
  try {
    process.kill(deadPid, 0);
  } catch {
    break;
  }
}

dir = await profileWithLock(`${hostname()}-${deadPid}`);
await clearStaleSingletonLock(dir);
assert.equal(await exists(lockPath(dir)), false, 'a lock naming a dead pid must be cleared');
await rm(dir, { recursive: true, force: true });

// --- a lock held by a live process is NOT ours to remove --------------------

dir = await profileWithLock(`${hostname()}-${process.pid}`);
await clearStaleSingletonLock(dir);
assert.equal(await exists(lockPath(dir)), true, 'a live lock must be left alone');
await rm(dir, { recursive: true, force: true });

// --- no lock at all is normal, not an error --------------------------------

dir = await profileWithLock(null);
await clearStaleSingletonLock(dir);
await rm(dir, { recursive: true, force: true });

console.log('profile lock self-check passed');
