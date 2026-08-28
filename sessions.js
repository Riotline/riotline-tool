/**
 * One graphics session per user, created on demand.
 *
 * Everything that used to be a module-level singleton in server.js now lives in
 * a bundle rooted at .state/users/<userId>/. Two operators running two matches
 * at once touch entirely separate files, entirely separate stores and entirely
 * separate timers.
 *
 * Not everything moved. Two things stay server-wide, and the difference is worth
 * stating because it is the whole design:
 *
 *   media/           content-addressed by hash, so two users uploading the same
 *                    logo get the same file, and a /media/<hash> URL saved
 *                    inside a graphic keeps resolving when the session is handed
 *                    to somebody else. What is *not* shared is the list of what
 *                    is in there - see makeMediaOwners at the bottom.
 *   valorant-assets  the game's own catalogue of agents and maps. Identical for
 *                    everybody by definition, and downloading it once per user
 *                    would be rude to an API that costs nothing to nobody.
 *
 * Bundles are never evicted on a timer. A handful of operators is the whole
 * expected scale, the state is small, and a session that got evicted mid-match
 * would drop its auto-hide and its agent-select clock on the floor. They go away
 * when the account does.
 */

import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
  makeAliasStore,
  makeGlobalStore,
  makeGraphicStore,
  makePresetStore,
  makeSelectStore,
  makeTeamStore,
  makeWinnerStore,
} from './graphics.js';

/** The stores a session owns, and the file each one lives in. */
const STORES = [
  ['graphics', makeGraphicStore, 'graphic.json'],
  ['winner', makeWinnerStore, 'winner.json'],
  ['select', makeSelectStore, 'select.json'],
  ['globals', makeGlobalStore, 'global.json'],
  ['presets', makePresetStore, 'presets.json'],
  ['teams', makeTeamStore, 'teams.json'],
  ['aliases', makeAliasStore, 'aliases.json'],
];

/**
 * A user id is a UUID we generated, so it is already safe in a path - but it
 * arrives here having passed through a cookie and a JSON file, and "it cannot
 * happen" is how directory traversal happens. One regexp is cheaper than being
 * wrong.
 */
const SAFE_ID = /^[a-z0-9-]{1,64}$/i;

export function makeSessionRegistry({ root, onCreate, onDispose, log = () => {} }) {
  /** @type {Map<string, object>} */
  const bundles = new Map();
  /** @type {Map<string, Promise<object>>} */
  const opening = new Map();

  const dirFor = (userId) => path.join(root, 'users', String(userId));

  async function open(userId) {
    const id = String(userId);
    if (!SAFE_ID.test(id)) throw new Error('Bad session id.');

    const dir = dirFor(id);
    const bundle = { userId: id, dir, teardown: [] };

    for (const [key, make, file] of STORES) {
      bundle[key] = make(path.join(dir, file));
    }

    // Loaded together: a session with half its state restored would render a
    // scoreboard from disk beside a winner sequence from the defaults.
    const restored = await Promise.all(STORES.map(([key]) => bundle[key].load()));
    log('session', `opened ${id} (${restored.filter(Boolean).length}/${STORES.length} restored from disk)`);

    // The drivers - auto-hide, the winner sequence, the agent-select clock -
    // are wired by the caller, because what they do is server.js's business and
    // only their lifetime is this file's.
    onCreate?.(bundle);
    return bundle;
  }

  return {
    get size() {
      return bundles.size;
    },

    /** Every session that has been opened since boot. For the admin panel. */
    list: () => [...bundles.keys()],

    has: (userId) => bundles.has(String(userId)),

    /** An already-open bundle, without opening one. For shutdown and reporting. */
    peek: (userId) => bundles.get(String(userId)) ?? null,

    /**
     * The bundle for a user, opening it if this is the first time.
     *
     * Concurrent callers share one open. Without that, two requests arriving
     * together - which is exactly what a dashboard load does - would each build
     * a full set of stores over the same files, and the loser's writes would
     * vanish into an object nobody was reading.
     */
    async get(userId) {
      const id = String(userId);
      const existing = bundles.get(id);
      if (existing) return existing;

      const pending = opening.get(id);
      if (pending) return pending;

      const work = open(id)
        .then((bundle) => {
          bundles.set(id, bundle);
          opening.delete(id);
          return bundle;
        })
        .catch((error) => {
          opening.delete(id);
          throw error;
        });

      opening.set(id, work);
      return work;
    },

    /** Stop a session's timers and forget it. The files stay. */
    dispose(userId) {
      const id = String(userId);
      const bundle = bundles.get(id);
      if (!bundle) return false;
      for (const stop of bundle.teardown) {
        try {
          stop();
        } catch {
          /* a driver that will not stop must not block the rest */
        }
      }
      onDispose?.(bundle);
      bundles.delete(id);
      log('session', `closed ${id}`);
      return true;
    },

    /** Everything a deleted account leaves behind. */
    async destroy(userId) {
      const id = String(userId);
      if (!SAFE_ID.test(id)) throw new Error('Bad session id.');
      this.dispose(id);
      await rm(dirFor(id), { recursive: true, force: true });
      log('session', `deleted the state of ${id}`);
    },
  };
}

/**
 * Who uploaded which file.
 *
 * The blobs stay in one shared, content-addressed directory - that is what
 * makes a `/media/<hash>.<ext>` URL saved inside a graphic keep working when
 * you hand the session to a colleague, and it means two operators uploading the
 * same event logo store it once. But `GET /api/media` used to readdir the lot,
 * so every dashboard's picker enumerated every other production's artwork.
 *
 * So: shared bytes, private index. A name is claimed by each account that
 * uploads it, which is a set rather than a single owner because two people
 * uploading identical bytes get identical names and neither of them is wrong.
 * Nothing is ever removed from a claim - there is no delete route for media
 * either, and a dangling name simply stops being listed.
 */
export function makeMediaOwners(filePath) {
  /** @type {Map<string, Set<string>>} name -> userIds */
  let owners = new Map();
  let writeChain = Promise.resolve();

  const persist = () => {
    const snapshot = JSON.stringify([...owners].map(([name, ids]) => [name, [...ids]]), null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  media index not saved: ${error.message}`));
    return writeChain;
  };

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        owners = new Map(parsed.map(([name, ids]) => [String(name), new Set(ids.map(String))]));
        return true;
      } catch {
        return false;
      }
    },

    claim(userId, name) {
      if (!userId || !name) return;
      const ids = owners.get(String(name)) ?? new Set();
      if (ids.has(String(userId))) return;
      ids.add(String(userId));
      owners.set(String(name), ids);
      return persist();
    },

    owns: (userId, name) => Boolean(owners.get(String(name))?.has(String(userId))),

    /**
     * Files this account uploaded.
     *
     * An unclaimed file belongs to nobody and is listed for nobody: on an
     * upgrade from the single-user layout the index starts empty, so the picker
     * starts empty too. The files are still there and every graphic that
     * references one still renders - only the browse list is affected, and it
     * fills up again as soon as somebody uploads.
     */
    filter: (userId, entries) => entries.filter((entry) => owners.get(entry.name)?.has(String(userId))),
  };
}
