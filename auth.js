/**
 * Accounts, passwords and login sessions.
 *
 * Node built-ins only, like the rest of this project - `scrypt` is in the
 * standard library and is a password hash rather than a general-purpose digest,
 * which is the whole requirement. Nothing here needs a package.
 *
 * Two stores, deliberately separate files:
 *
 *   users.json     accounts. Changes rarely, and losing it loses everybody.
 *   sessions.json  who is currently logged in. Disposable, but persisted anyway
 *                  so restarting the server mid-broadcast does not sign every
 *                  operator out at the worst possible moment.
 *
 * Three distinct secrets, and it is worth keeping them apart in your head:
 *
 *   password      what a person types. Only ever stored as a scrypt hash.
 *   login token   the cookie. Identifies a browser as a logged-in person.
 *   session key   the UUID in an OBS URL and a webhook URL. Identifies a
 *                 GRAPHICS session, not a person, and is deliberately weaker:
 *                 it is pasted into OBS and into a game client, so it is going
 *                 to end up in config files and screen shares. It grants no
 *                 access to the dashboard, only to the output pages and the
 *                 webhooks for one session.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/*
 * Deliberately above the Node default (N=16384). This is a small deployment
 * where logins are rare and human-paced, so ~100ms of CPU per attempt is free
 * to us and expensive to somebody working through a word list.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const SALT_BYTES = 16;

export const ROLES = ['admin', 'user'];
export const GRANTS = ['editor', 'viewer'];

/** How long a login lasts without being used. Long enough to survive an event. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const now = () => Date.now();

// ------------------------------------------------------------- passwords ---

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = await scrypt(String(password), salt, SCRYPT.keylen, SCRYPT);
  return { salt, hash: derived.toString('hex') };
}

/**
 * Compared in constant time, and never short-circuited on length.
 *
 * A plain `===` on hex strings leaks how much of the hash matched through how
 * long the comparison took. It is a small leak and this is a small deployment,
 * but the fix is one function call.
 */
export async function verifyPassword(password, { salt, hash }) {
  if (!salt || !hash) return false;
  const derived = await scrypt(String(password), salt, SCRYPT.keylen, SCRYPT);
  const stored = Buffer.from(String(hash), 'hex');
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}

/**
 * The rules a password has to clear.
 *
 * Length only. Composition rules ("one capital, one symbol") push people toward
 * `Password1!` and are not what makes a password hard to guess; a floor of
 * twelve characters is.
 */
export const PASSWORD_MIN = 12;

export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (value.length > 200) return 'Password must be shorter than 200 characters.';
  return null;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

export function usernameProblem(username) {
  const value = String(username ?? '').trim();
  if (!USERNAME.test(value)) {
    return 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore.';
  }
  return null;
}

// ----------------------------------------------------------------- users ---

const text = (value, fallback = '', max = 200) =>
  value === null || value === undefined
    ? fallback
    : String(value).slice(0, max).replace(/[\u0000-\u001f]/g, '').trim();

/**
 * One account.
 *
 * `grants` maps another user's id to what they may do with THIS user's graphics
 * session. Held on the owner rather than on the grantee so that revoking is one
 * write to one record, and so deleting an account cannot leave permissions to
 * a session that no longer exists.
 */
function cleanUser(input) {
  const source = input ?? {};
  const grants = {};
  for (const [id, level] of Object.entries(source.grants ?? {})) {
    if (GRANTS.includes(level)) grants[text(id, '', 64)] = level;
  }
  return {
    id: text(source.id, '', 64),
    username: text(source.username, '', 32),
    salt: text(source.salt, '', 64),
    hash: text(source.hash, '', 256),
    role: ROLES.includes(source.role) ? source.role : 'user',
    // The UUID that appears in OBS and webhook URLs for this user's session.
    sessionKey: text(source.sessionKey, '', 64) || randomUUID(),
    disabled: source.disabled === true,
    /*
     * May this account open a tracker.gg Cloudflare solve?
     *
     * Off unless it says otherwise, which is the opposite of how the server
     * switches in settings-schema.js treat a missing value - and deliberately
     * so. Those are features, and a feature that arrives switched off on every
     * server that upgrades is a nasty surprise. This is a permission, and a
     * permission that arrives switched *on* because the field was absent is a
     * worse one. Permissions default closed.
     *
     * What it opens is an interactive keyboard and mouse on a real browser on
     * the production machine, so it is not implied by having an account.
     */
    trackerLogin: source.trackerLogin === true,
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now(),
    lastLoginAt: Number.isFinite(source.lastLoginAt) ? source.lastLoginAt : 0,
    grants,
  };
}

/**
 * May this account open a tracker.gg login session?
 *
 * Admins always may. Not a favour - they can set their own flag on the Admin
 * tab in two clicks, so refusing them would be theatre, and it means a server
 * can never reach a state where nobody is able to clear a challenge.
 */
export const canOpenTrackerLogin = (user) => Boolean(user) && (user.role === 'admin' || user.trackerLogin === true);

/** What may be sent to a browser. Never the hash, never the salt. */
export const publicUser = (user, { includeKey = false } = {}) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  disabled: user.disabled,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
  grants: { ...user.grants },
  // The stored flag and what it works out to. The admin panel edits the first;
  // every other page wants the second, and computing it in three places is how
  // two of them end up disagreeing.
  trackerLogin: user.trackerLogin === true,
  mayOpenTrackerLogin: canOpenTrackerLogin(user),
  ...(includeKey ? { sessionKey: user.sessionKey } : {}),
});

export function makeUserStore(filePath) {
  /** @type {ReturnType<typeof cleanUser>[]} */
  let users = [];
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(users, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  users not saved: ${error.message}`));
    return writeChain;
  }

  const byName = (username) => {
    const wanted = String(username ?? '').trim().toLowerCase();
    return users.find((user) => user.username.toLowerCase() === wanted) ?? null;
  };

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        users = parsed.map(cleanUser).filter((user) => user.id && user.username);
        return true;
      } catch {
        return false;
      }
    },

    get count() {
      return users.length;
    },

    list: () => users.map((user) => ({ ...user })),
    byId: (id) => users.find((user) => user.id === String(id)) ?? null,
    byName,
    bySessionKey: (key) => users.find((user) => user.sessionKey === String(key)) ?? null,

    async create({ username, password, role = 'user' }) {
      const nameProblem = usernameProblem(username);
      if (nameProblem) throw new Error(nameProblem);
      const passProblem = passwordProblem(password);
      if (passProblem) throw new Error(passProblem);
      if (byName(username)) throw new Error('That username is taken.');

      const { salt, hash } = await hashPassword(password);
      const user = cleanUser({
        id: randomUUID(),
        username: String(username).trim(),
        salt,
        hash,
        role: ROLES.includes(role) ? role : 'user',
        sessionKey: randomUUID(),
        createdAt: now(),
      });
      users.push(user);
      await persist();
      return { ...user };
    },

    /**
     * Returns the user on success and null on every kind of failure.
     *
     * One answer for "no such account", "wrong password" and "disabled", because
     * three different answers tell somebody guessing which usernames are real.
     * The scrypt work is done even when the username is unknown, so the reply
     * does not come back measurably faster for one that is not.
     */
    async verify(username, password) {
      const user = byName(username);
      const target = user ?? { salt: 'decoy', hash: '00'.repeat(SCRYPT.keylen) };
      const ok = await verifyPassword(password, target);
      if (!user || !ok || user.disabled) return null;
      user.lastLoginAt = now();
      persist();
      return { ...user };
    },

    async update(id, changes) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');

      if (changes.username !== undefined) {
        const problem = usernameProblem(changes.username);
        if (problem) throw new Error(problem);
        const clash = byName(changes.username);
        if (clash && clash.id !== user.id) throw new Error('That username is taken.');
        user.username = String(changes.username).trim();
      }
      if (changes.password !== undefined) {
        const problem = passwordProblem(changes.password);
        if (problem) throw new Error(problem);
        const { salt, hash } = await hashPassword(changes.password);
        user.salt = salt;
        user.hash = hash;
      }
      if (changes.role !== undefined && ROLES.includes(changes.role)) user.role = changes.role;
      if (changes.disabled !== undefined) user.disabled = changes.disabled === true;
      if (changes.trackerLogin !== undefined) user.trackerLogin = changes.trackerLogin === true;

      await persist();
      return { ...user };
    },

    /** A leaked OBS link is fixed here: every old URL stops working at once. */
    async rotateSessionKey(id) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');
      user.sessionKey = randomUUID();
      await persist();
      return user.sessionKey;
    },

    async setGrant(ownerId, granteeId, level) {
      const owner = users.find((entry) => entry.id === String(ownerId));
      if (!owner) throw new Error('No such user.');
      if (String(ownerId) === String(granteeId)) throw new Error('You already have your own graphics.');
      if (level && !GRANTS.includes(level)) throw new Error('Unknown permission.');
      if (!users.some((entry) => entry.id === String(granteeId))) throw new Error('No such user.');

      if (level) owner.grants[String(granteeId)] = level;
      else delete owner.grants[String(granteeId)];

      await persist();
      return { ...owner };
    },

    async remove(id) {
      const before = users.length;
      users = users.filter((entry) => entry.id !== String(id));
      // Nobody keeps a grant to a session that no longer exists.
      for (const user of users) delete user.grants[String(id)];
      if (users.length !== before) await persist();
      return users.length !== before;
    },
  };
}

// -------------------------------------------------------------- sessions ---

/**
 * What a browser may do with a given graphics session.
 *
 * Admins are deliberately NOT given editor rights over everybody's graphics.
 * Being able to administer accounts is not the same as being able to take over
 * a live broadcast, and an admin who wants to operate somebody's graphics can
 * be granted it like anyone else. What admins can do is see that the session
 * exists, in the admin panel.
 *
 * @returns {'owner'|'editor'|'viewer'|null}
 */
export function accessLevel(user, owner) {
  if (!user || !owner) return null;
  if (user.id === owner.id) return 'owner';
  return owner.grants?.[user.id] ?? null;
}

export const canEdit = (level) => level === 'owner' || level === 'editor';
export const canView = (level) => level === 'owner' || level === 'editor' || level === 'viewer';

export function makeSessionStore(filePath) {
  /** @type {Map<string, {userId: string, createdAt: number, lastSeen: number}>} */
  let sessions = new Map();
  let writeChain = Promise.resolve();
  let dirty = false;

  function persist() {
    const snapshot = JSON.stringify([...sessions.entries()], null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  sessions not saved: ${error.message}`));
    return writeChain;
  }

  function sweep() {
    const cutoff = now() - SESSION_TTL_MS;
    let removed = 0;
    for (const [token, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        sessions.delete(token);
        removed += 1;
      }
    }
    if (removed) persist();
    return removed;
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        sessions = new Map(parsed.filter((entry) => Array.isArray(entry) && entry.length === 2));
        sweep();
        return true;
      } catch {
        return false;
      }
    },

    get count() {
      return sessions.size;
    },

    create(userId) {
      // 256 bits. This is the only thing standing between a stranger and the
      // dashboard, so it is not a place to be clever about length.
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { userId: String(userId), createdAt: now(), lastSeen: now() });
      persist();
      return token;
    },

    /**
     * The userId behind a token, or null.
     *
     * `lastSeen` is written in memory on every hit but only flushed to disk
     * occasionally: this runs on every request including the SSE reconnects, and
     * a disk write per request would be absurd for a field whose only job is to
     * expire a token in thirty days.
     */
    userIdFor(token) {
      const entry = sessions.get(String(token ?? ''));
      if (!entry) return null;
      if (entry.lastSeen < now() - SESSION_TTL_MS) {
        sessions.delete(String(token));
        persist();
        return null;
      }
      entry.lastSeen = now();
      dirty = true;
      return entry.userId;
    },

    destroy(token) {
      if (sessions.delete(String(token ?? ''))) persist();
    },

    /** Every login for one account, for "sign out everywhere" and for deletion. */
    destroyFor(userId) {
      let removed = 0;
      for (const [token, entry] of sessions) {
        if (entry.userId === String(userId)) {
          sessions.delete(token);
          removed += 1;
        }
      }
      if (removed) persist();
      return removed;
    },

    flush() {
      if (!dirty) return;
      dirty = false;
      persist();
    },

    sweep,
  };
}
