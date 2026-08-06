/**
 * Broadcast graphic state - the thing the dashboard edits and the output page renders.
 *
 * The output page is meant to be an OBS browser source, which is a separate
 * browser process from the dashboard. localStorage/BroadcastChannel therefore
 * cannot reach it, so state lives here on the server: the dashboard POSTs it,
 * the output page subscribes over SSE, and it is mirrored to disk so a restart
 * mid-broadcast does not wipe the graphic.
 *
 * Shape mirrors the scoreboard layout it drives: two sides, five players each,
 * player[0] of each side being that side's MVP.
 *
 * Zero npm dependencies - Node 18+ built-ins only.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// The browser loads these same modules - one definition of what a stat is, and
// one of what a preset is.
import { STAT_FIELDS, STAT_KEYS, STAT_SLOTS } from './public/stats.js';
import { BUILT_IN_IDS, BUILT_IN_PRESETS, FONT_CHOICES, PRESET_FIELDS } from './public/preset-schema.js';
import {
  ANIM_EASING_KEYS,
  ANIM_FIELDS,
  ANIM_STYLE_KEYS,
  ANIM_TIER_COUNT,
  DEFAULT_ANIM,
  inDurationMs,
} from './public/animation.js';

export { STAT_FIELDS, STAT_KEYS, STAT_SLOTS, FONT_CHOICES, BUILT_IN_PRESETS, ANIM_TIER_COUNT, inDurationMs };

export const PLAYERS_PER_SIDE = 5;

const clone = (value) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------- defaults ---

const emptyPlayer = () => ({
  name: '',
  tag: '',
  agent: '',
  ...Object.fromEntries(STAT_FIELDS.map((stat) => [stat.key, 0])),
});

const side = (teamName, result, won, roundsWon) => ({
  teamName,
  result,
  won,
  roundsWon,
  logo: '',
  players: Array.from({ length: PLAYERS_PER_SIDE }, emptyPlayer),
});

export const DEFAULT_STATE = {
  version: 1,
  map: 'Ascent',
  mapImage: '',
  matchId: '',
  eventLogo: '',
  // Which stat each of the three rows shows. Slots 1 and 2 appear on the roster
  // rows as well; slot 3 only has room on the MVP panel.
  statRows: ['kda', 'acs', 'firstKills'],
  // Blank means "use the stat's own name", so changing a slot relabels itself.
  labels: { mvp: 'MVP', stat1: '', stat2: '', stat3: '' },
  left: side('ATK', 'WIN', true, 13),
  right: side('DEF', 'LOSS', false, 5),
  // Which saved preset the styling last came from. Purely informational - the
  // preset block below is the truth, so an edit after applying is never lost.
  presetId: BUILT_IN_PRESETS[0].id,
  preset: clone(BUILT_IN_PRESETS[0].preset),
  // Whether the scoreboard is on air, and how it gets there.
  anim: clone(DEFAULT_ANIM),
};


// ----------------------------------------------------------- sanitising ---

/**
 * Everything below arrives from the browser and is re-emitted into a rendered
 * page, so nothing is trusted. Text is length-clamped (the renderer always uses
 * textContent, so markup is inert), colours must be literal hex, and image URLs
 * are restricted to http/https - `javascript:` and `data:` are the two that
 * would otherwise turn an <img src> into an injection point.
 */

/**
 * Absent means "fall back to the default"; present-but-empty means the operator
 * cleared the field deliberately. Collapsing the two would make a blanked team
 * name spring back to its old value, which is impossible to type into.
 */
const text = (value, fallback = '', max = 120) => {
  if (value === null || value === undefined) return fallback;
  // Control characters would survive textContent and corrupt the saved JSON.
  return String(value)
    .slice(0, max)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
};

const int = (value, fallback = 0, min = -9999, max = 9999) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const bool = (value, fallback = false) => (typeof value === 'boolean' ? value : fallback);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const colour = (value, fallback) => {
  const candidate = String(value ?? '').trim();
  return HEX.test(candidate) ? candidate.toLowerCase() : fallback;
};

const imageUrl = (value, fallback = '') => {
  const candidate = String(value ?? '').trim();
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 500) : fallback;
  } catch {
    // Relative paths stay allowed so operators can drop a logo into ./public.
    return /^\/[\w./-]{0,200}$/.test(candidate) ? candidate : fallback;
  }
};

const ratio = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, Math.round(parsed * 100) / 100)) : fallback;
};

function sanitisePlayer(input, fallback) {
  const source = input ?? {};
  return {
    name: text(source.name, fallback.name, 40),
    tag: text(source.tag, fallback.tag, 16),
    agent: text(source.agent, fallback.agent, 32),
    ...Object.fromEntries(
      STAT_FIELDS.map((stat) => [stat.key, int(source[stat.key], fallback[stat.key] ?? 0, 0, stat.max)]),
    ),
  };
}

function sanitiseSide(input, fallback) {
  const source = input ?? {};
  const players = Array.isArray(source.players) ? source.players : [];

  return {
    teamName: text(source.teamName, fallback.teamName, 24),
    result: text(source.result, fallback.result, 16),
    won: bool(source.won, fallback.won),
    roundsWon: int(source.roundsWon, fallback.roundsWon, 0, 99),
    logo: imageUrl(source.logo, fallback.logo),
    // Always exactly PLAYERS_PER_SIDE: the layout has five fixed slots and a
    // short or long array would silently break the render rather than the edit.
    players: Array.from({ length: PLAYERS_PER_SIDE }, (_, index) =>
      sanitisePlayer(players[index], fallback.players[index] ?? emptyPlayer()),
    ),
  };
}

/** Merge a caller-supplied patch onto a known-good base, field by field. */
export function sanitiseState(input, base = DEFAULT_STATE) {
  const source = input ?? {};
  const fallback = base ?? DEFAULT_STATE;
  const labels = source.labels ?? {};

  return {
    version: 1,
    map: text(source.map, fallback.map, 40),
    mapImage: imageUrl(source.mapImage, fallback.mapImage),
    matchId: text(source.matchId, fallback.matchId, 64),
    eventLogo: imageUrl(source.eventLogo, fallback.eventLogo),
    // Exactly STAT_SLOTS entries, every one a stat the renderer knows how to
    // format - an unknown key would render as a blank row on air.
    statRows: Array.from({ length: STAT_SLOTS }, (_, index) => {
      const requested = String(source.statRows?.[index] ?? '');
      return STAT_KEYS.includes(requested) ? requested : fallback.statRows[index];
    }),
    labels: {
      mvp: text(labels.mvp, fallback.labels.mvp, 16),
      stat1: text(labels.stat1, fallback.labels.stat1, 16),
      stat2: text(labels.stat2, fallback.labels.stat2, 16),
      stat3: text(labels.stat3, fallback.labels.stat3, 16),
    },
    left: sanitiseSide(source.left, fallback.left),
    right: sanitiseSide(source.right, fallback.right),
    presetId: text(source.presetId, fallback.presetId, 48),
    preset: sanitisePreset(source.preset, fallback.preset),
    anim: sanitiseAnim(source.anim, fallback.anim),
  };
}

/**
 * Driven by ANIM_FIELDS, for the same reason sanitisePreset is driven by
 * PRESET_FIELDS. `visible` and `cue` are handled by hand because they are the
 * command channel rather than configuration.
 */
const CUE_WRAP = 1_000_000;

export function sanitiseAnim(input, fallback = DEFAULT_ANIM) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_ANIM;

  const clean = {
    visible: bool(source.visible, base.visible),
    // Wrapped rather than clamped: the output page only compares it for
    // inequality, so wrapping keeps working where a ceiling would silently stop
    // registering cues once it was reached.
    cue: int(source.cue, base.cue, 0, Number.MAX_SAFE_INTEGER) % CUE_WRAP,
  };

  for (const field of ANIM_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'choice': {
        const allowed = field.key === 'style' ? ANIM_STYLE_KEYS : ANIM_EASING_KEYS;
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      default:
        // A zero-length transition would make "animate" a lie, so durations have
        // a floor rather than clamping to 0 - the field's own min carries it.
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }

  return clean;
}

/**
 * Driven by PRESET_FIELDS rather than a hand-written list, so a styling option
 * cannot exist in the editor but be silently dropped here on the way in.
 */
export function sanitisePreset(input, fallback = DEFAULT_STATE.preset) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_STATE.preset;
  const clean = {};

  for (const field of PRESET_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'font':
        clean[field.key] = FONT_CHOICES.includes(String(value)) ? String(value) : previous;
        break;
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      case 'hexOff':
        // Empty means "leave it transparent", which is what OBS wants.
        clean[field.key] = colour(value, '') || '';
        break;
      default:
        clean[field.key] = colour(value, previous);
    }
  }

  return clean;
}

// ------------------------------------------------------------ the store ---

/**
 * @param {string} filePath where to mirror state between restarts
 */
export function makeGraphicStore(filePath) {
  let state = clone(DEFAULT_STATE);
  let revision = 0;
  let writeChain = Promise.resolve();

  /** @type {Set<(event: {revision: number, state: object}) => void>} */
  const listeners = new Set();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      // Sanitised on the way in as well: the file is editable by hand, and a
      // half-edited one should degrade to defaults rather than break the render.
      state = sanitiseState(parsed, DEFAULT_STATE);
      return true;
    } catch {
      return false;
    }
  }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    // Serialised: concurrent dashboard edits must not interleave partial writes.
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  graphic state not saved: ${error.message}`));
    return writeChain;
  }

  return {
    get state() {
      return state;
    },
    get revision() {
      return revision;
    },
    load,

    /** Replace the whole graphic. Returns the sanitised result. */
    replace(input) {
      state = sanitiseState(input, DEFAULT_STATE);
      revision += 1;
      persist();
      for (const listener of listeners) listener({ revision, state });
      return state;
    },

    /** Shallow-merge a partial update onto the current state. */
    patch(input) {
      return this.replace({ ...state, ...(input ?? {}) });
    },

    reset() {
      return this.replace(DEFAULT_STATE);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get subscriberCount() {
      return listeners.size;
    },

    /** Let the process exit without truncating an in-flight save. */
    flush() {
      return writeChain;
    },
  };
}

// -------------------------------------------------------------- presets ---

/** `My Look #2` -> `my-look-2`, so ids stay readable in the saved file. */
const slug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'preset';

/**
 * Saved looks: the built-ins from preset-schema.js plus whatever the operator
 * has saved, mirrored to disk.
 *
 * Built-ins are never written to the file and cannot be deleted or overwritten,
 * so there is always a known-good look to fall back to mid-broadcast. Saving
 * over one produces a copy instead of an error - a refusal in the middle of a
 * show is not helpful.
 *
 * @param {string} filePath where to mirror the operator's own presets
 */
export function makePresetStore(filePath) {
  /** @type {{id: string, name: string, preset: object}[]} */
  let custom = [];
  let writeChain = Promise.resolve();

  const builtIns = () => BUILT_IN_PRESETS.map((entry) => ({ ...entry, preset: clone(entry.preset), builtIn: true }));

  function persist() {
    const snapshot = JSON.stringify(custom, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  presets not saved: ${error.message}`));
    return writeChain;
  }

  function uniqueId(name, ignoreId = null) {
    const base = slug(name);
    let candidate = base;
    let counter = 2;
    const taken = (id) => BUILT_IN_IDS.has(id) || custom.some((entry) => entry.id === id && entry.id !== ignoreId);
    while (taken(candidate)) candidate = `${base}-${counter++}`;
    return candidate;
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        // Sanitised on the way in: the file is hand-editable, and a broken
        // entry should degrade to defaults rather than break the Style panel.
        custom = parsed
          .filter((entry) => entry && typeof entry.id === 'string' && !BUILT_IN_IDS.has(entry.id))
          .map((entry) => ({
            id: slug(entry.id),
            name: text(entry.name, entry.id, 40) || entry.id,
            preset: sanitisePreset(entry.preset),
          }));
        return true;
      } catch {
        return false;
      }
    },

    /** Built-ins first, then the operator's own. */
    list() {
      return [...builtIns(), ...custom.map((entry) => ({ ...entry, preset: clone(entry.preset), builtIn: false }))];
    },

    get(id) {
      return this.list().find((entry) => entry.id === id) ?? null;
    },

    /**
     * Create or update. Passing the id of a built-in saves a copy instead,
     * which is what "Save as" on a shipped look should do anyway.
     */
    save({ id = null, name, preset }) {
      const cleanName = text(name, '', 40) || 'Untitled preset';
      const clean = sanitisePreset(preset);
      const existing = id && !BUILT_IN_IDS.has(id) ? custom.find((entry) => entry.id === id) : null;

      if (existing) {
        existing.name = cleanName;
        existing.preset = clean;
        persist();
        return { ...existing, preset: clone(clean), builtIn: false };
      }

      const entry = { id: uniqueId(cleanName), name: cleanName, preset: clean };
      custom.push(entry);
      persist();
      return { ...entry, preset: clone(clean), builtIn: false };
    },

    remove(id) {
      if (BUILT_IN_IDS.has(id)) return false;
      const before = custom.length;
      custom = custom.filter((entry) => entry.id !== id);
      if (custom.length === before) return false;
      persist();
      return true;
    },

    flush() {
      return writeChain;
    },
  };
}

// --------------------------------------------------------------- assets ---

/**
 * Agent portraits, role icons and map splashes come from valorant-api.com,
 * which is public, key-free and CORS-open. It is proxied rather than called
 * from the page so one cached copy serves the dashboard, the preview and every
 * output source, and so a broadcast survives the site being unreachable.
 */

const ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const MAPS_URL = 'https://valorant-api.com/v1/maps';

export function makeAssetCache(cachePath) {
  let cached = null;
  let fetchedAt = 0;
  let inFlight = null;

  const shrinkAgent = (agent) => ({
    uuid: agent.uuid,
    name: agent.displayName,
    icon: agent.displayIcon,
    portrait: agent.fullPortraitV2 ?? agent.fullPortrait ?? null,
    rightFacing: Boolean(agent.isFullPortraitRightFacing),
    role: agent.role ? { name: agent.role.displayName, icon: agent.role.displayIcon } : null,
    gradient: Array.isArray(agent.backgroundGradientColors) ? agent.backgroundGradientColors : [],
  });

  const shrinkMap = (map) => ({
    uuid: map.uuid,
    name: map.displayName,
    splash: map.splash,
    icon: map.listViewIcon,
  });

  async function download() {
    const [agents, maps] = await Promise.all([
      fetch(AGENTS_URL).then((r) => r.json()),
      fetch(MAPS_URL).then((r) => r.json()),
    ]);

    const payload = {
      fetchedAt: Date.now(),
      agents: (agents?.data ?? []).map(shrinkAgent).sort((a, b) => a.name.localeCompare(b.name)),
      // The map list carries tutorial ranges and unnamed skirmish boxes; a map
      // with no splash is not something a broadcast graphic can use.
      maps: (maps?.data ?? [])
        .filter((map) => map.displayName && map.splash && !/range|basic training|skirmish/i.test(map.displayName))
        .map(shrinkMap)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    if (!payload.agents.length || !payload.maps.length) throw new Error('valorant-api returned an empty catalogue');
    return payload;
  }

  async function readDisk() {
    try {
      const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
      return parsed?.agents?.length && parsed?.maps?.length ? parsed : null;
    } catch {
      return null;
    }
  }

  return {
    /** Cached catalogue; falls back to the disk copy when the network is down. */
    async get() {
      if (cached && Date.now() - fetchedAt < ASSET_TTL_MS) return cached;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          cached = await download();
          fetchedAt = cached.fetchedAt;
          await mkdir(path.dirname(cachePath), { recursive: true });
          await writeFile(cachePath, JSON.stringify(cached), 'utf8').catch(() => {});
          return cached;
        } catch (error) {
          const disk = await readDisk();
          if (!disk) throw error;
          // Stale beats nothing: keep the old timestamp so the next call retries.
          cached = disk;
          fetchedAt = Date.now() - ASSET_TTL_MS + 60_000;
          return cached;
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    },
  };
}
