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

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { EMPTY_TEAM, TEAM_FIELDS, TEAM_REGIONS, teamSlug } from './public/teams.js';
import {
  AUDIO_FIELDS,
  DEFAULT_AUDIO,
  DEFAULT_SEQ,
  DEFAULT_WINNER,
  DEFAULT_WINNER_STYLE,
  SEQ_FIELDS,
  WINNER_EASING_KEYS,
  WINNER_MAP_ROWS,
  WINNER_OPENING_KEYS,
  WINNER_STAGE_COUNT,
  WINNER_STAGES,
  isOverlayEntry,
  WINNER_STYLE_FIELDS,
  WINNER_TEXT_FIELDS,
  WINNER_TRANSITION_KEYS,
  resolveWinner,
  stageBands,
  stageEnterMs,
} from './public/winner-schema.js';

export { STAT_FIELDS, STAT_KEYS, STAT_SLOTS, FONT_CHOICES, BUILT_IN_PRESETS, ANIM_TIER_COUNT, inDurationMs };
export { TEAM_REGIONS, WINNER_STAGES, WINNER_STAGE_COUNT, isOverlayEntry, resolveWinner, stageBands, stageEnterMs };

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
  // Which library entry the name and logo were filled from. Informational only,
  // exactly like presetId: the fields above are the truth, so editing a team
  // later never rewrites a scoreboard that is already on air.
  teamId: '',
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
    teamId: text(source.teamId, fallback.teamId ?? '', 48),
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

// ------------------------------------------------------ winner sanitising ---

/**
 * The winner graphic. Same rules as the scoreboard - nothing from the browser is
 * trusted - but the shapes are its own: two teams with a series score, a fixed
 * list of map rows, a sequence position, and its own style block.
 */

/** Shared by the team library and the winner graphic's two team blocks. */
export function sanitiseTeamFields(input, fallback = EMPTY_TEAM) {
  const source = input ?? {};
  const base = fallback ?? EMPTY_TEAM;
  const clean = {};

  for (const field of TEAM_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key] ?? EMPTY_TEAM[field.key];

    switch (field.type) {
      case 'image':
        clean[field.key] = imageUrl(value, previous);
        break;
      case 'hex':
        clean[field.key] = colour(value, previous || EMPTY_TEAM.colour);
        break;
      default:
        // Regions are a suggestion list, not a closed set: an event running a
        // region this build has never heard of should keep the name it typed.
        clean[field.key] = text(value, previous, field.max ?? 40);
    }
  }
  return clean;
}

function sanitiseWinnerTeam(input, fallback) {
  const source = input ?? {};
  return {
    // Informational only, exactly like presetId - the copied fields below are
    // the truth, so editing the library never rewrites something already on air.
    teamId: text(source.teamId, fallback.teamId, 48),
    ...sanitiseTeamFields(source, fallback),
    score: int(source.score, fallback.score, 0, 99),
  };
}

function sanitiseMapRow(input, fallback) {
  const source = input ?? {};
  return {
    name: text(source.name, fallback.name, 32),
    left: int(source.left, fallback.left, 0, 99),
    right: int(source.right, fallback.right, 0, 99),
  };
}

/**
 * Driven by SEQ_FIELDS. `active`, `stage` and `cue` are done by hand because
 * they are the command channel rather than configuration.
 */
export function sanitiseSeq(input, fallback = DEFAULT_SEQ) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_SEQ;

  const clean = {
    active: bool(source.active, base.active),
    // Clamped, not wrapped: a stage outside the list has no scene to show, so
    // an out-of-range value has to land somewhere real rather than modulo into
    // an arbitrary scene.
    stage: int(source.stage, base.stage, 0, WINNER_STAGE_COUNT - 1),
    restart: bool(source.restart, base.restart),
    music: bool(source.music, base.music),
    cue: int(source.cue, base.cue, 0, Number.MAX_SAFE_INTEGER) % CUE_WRAP,
  };

  const CHOICES = {
    opening: WINNER_OPENING_KEYS,
    transition: WINNER_TRANSITION_KEYS,
    easing: WINNER_EASING_KEYS,
  };

  for (const field of SEQ_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'choice': {
        const allowed = CHOICES[field.key] ?? [];
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      default:
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }
  return clean;
}

export function sanitiseAudio(input, fallback = DEFAULT_AUDIO) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_AUDIO;

  // Same rules as any other media reference: http(s) or a path under this
  // server, never a data: or javascript: URL.
  const clean = { track: imageUrl(source.track, base.track) };

  for (const field of AUDIO_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      default:
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }
  return clean;
}

export function sanitiseWinnerStyle(input, fallback = DEFAULT_WINNER_STYLE) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_WINNER_STYLE;
  const clean = {};

  for (const field of WINNER_STYLE_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'font':
        clean[field.key] = FONT_CHOICES.includes(String(value)) ? String(value) : previous;
        break;
      case 'choice': {
        // The field carries its own allowed values, so a new choice field needs
        // no edit here to be checked.
        const allowed = (field.options ?? []).map((option) => option.key);
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      case 'px':
        clean[field.key] = int(value, previous, field.min, field.max);
        break;
      // Same rule as every other image reference in the graphic: http(s), or a
      // path under this server. The page drops it into a CSS url(), so an
      // unchecked string here would be reaching a good deal further than a src.
      case 'media':
        clean[field.key] = imageUrl(value, previous);
        break;
      default:
        clean[field.key] = colour(value, previous);
    }
  }
  return clean;
}

export function sanitiseWinner(input, base = DEFAULT_WINNER) {
  const source = input ?? {};
  const fallback = base ?? DEFAULT_WINNER;
  const rows = Array.isArray(source.maps) ? source.maps : [];

  const clean = {
    version: 1,
    eventLogo: imageUrl(source.eventLogo, fallback.eventLogo),
    mapName: text(source.mapName, fallback.mapName, 40),
    mapImage: imageUrl(source.mapImage, fallback.mapImage),
    left: sanitiseWinnerTeam(source.left, fallback.left),
    right: sanitiseWinnerTeam(source.right, fallback.right),
    // Always exactly WINNER_MAP_ROWS, for the same reason the rosters are always
    // five: the layout has fixed slots, and a short array should break the edit
    // rather than the render.
    maps: Array.from({ length: WINNER_MAP_ROWS }, (_, index) =>
      sanitiseMapRow(rows[index], fallback.maps[index] ?? { name: '', left: 0, right: 0 }),
    ),
    winner: ['auto', 'left', 'right'].includes(String(source.winner)) ? String(source.winner) : fallback.winner,
    seq: sanitiseSeq(source.seq, fallback.seq),
    style: sanitiseWinnerStyle(source.style, fallback.style),
    audio: sanitiseAudio(source.audio, fallback.audio),
  };

  for (const field of WINNER_TEXT_FIELDS) {
    clean[field.key] = text(source[field.key], fallback[field.key], field.max);
  }
  return clean;
}

// ------------------------------------------------------------ the store ---

/**
 * A piece of live state: sanitised, mirrored to disk, and pushed to every
 * subscriber. The scoreboard and the winner graphic are both one of these -
 * they differ only in shape, and the shape is the sanitiser's business.
 *
 * @param {string} filePath where to mirror state between restarts
 * @param {(input: object, base: object) => object} sanitise
 * @param {object} defaults what `reset` returns to, and the base every merge starts from
 */
export function makeStateStore(filePath, sanitise, defaults) {
  let state = clone(defaults);
  let revision = 0;
  let writeChain = Promise.resolve();

  /** @type {Set<(event: {revision: number, state: object}) => void>} */
  const listeners = new Set();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      // Sanitised on the way in as well: the file is editable by hand, and a
      // half-edited one should degrade to defaults rather than break the render.
      state = sanitise(parsed, defaults);
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
      state = sanitise(input, defaults);
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
      return this.replace(defaults);
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

export const makeGraphicStore = (filePath) => makeStateStore(filePath, sanitiseState, DEFAULT_STATE);
export const makeWinnerStore = (filePath) => makeStateStore(filePath, sanitiseWinner, DEFAULT_WINNER);

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

// ---------------------------------------------------------------- teams ---

/**
 * The operator's own team library, mirrored to disk.
 *
 * Unlike presets there are no built-ins: nobody's roster of orgs is guessable,
 * and a shipped list of teams would be wrong for every event that is not the one
 * it was written for.
 *
 * @param {string} filePath where to mirror the library
 */
export function makeTeamStore(filePath) {
  /** @type {{id: string, name: string}[]} */
  let teams = [];
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(teams, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  teams not saved: ${error.message}`));
    return writeChain;
  }

  function uniqueId(name, ignoreId = null) {
    const base = teamSlug(name);
    let candidate = base;
    let counter = 2;
    while (teams.some((entry) => entry.id === candidate && entry.id !== ignoreId)) candidate = `${base}-${counter++}`;
    return candidate;
  }

  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        teams = parsed
          .filter((entry) => entry && typeof entry.id === 'string')
          .map((entry) => ({ id: teamSlug(entry.id), ...sanitiseTeamFields(entry) }))
          // A team with no name cannot be picked out of a list, so it is not a
          // team - dropping it beats leaving a blank row in every dropdown.
          .filter((entry) => entry.name);
        return true;
      } catch {
        return false;
      }
    },

    list() {
      return sortByName(teams).map((entry) => ({ ...entry }));
    },

    get(id) {
      return teams.find((entry) => entry.id === id) ?? null;
    },

    /** Create or update. An unknown id creates rather than failing. */
    save({ id = null, ...fields }) {
      const existing = id ? teams.find((entry) => entry.id === id) : null;
      const clean = sanitiseTeamFields(fields, existing ?? EMPTY_TEAM);
      if (!clean.name) throw new Error('A team needs a name.');

      if (existing) {
        Object.assign(existing, clean);
        persist();
        return { ...existing };
      }

      const entry = { id: uniqueId(clean.name), ...clean };
      teams.push(entry);
      persist();
      return { ...entry };
    },

    remove(id) {
      const before = teams.length;
      teams = teams.filter((entry) => entry.id !== id);
      if (teams.length === before) return false;
      persist();
      return true;
    },

    flush() {
      return writeChain;
    },
  };
}

// ---------------------------------------------------------------- media ---

/**
 * Uploaded logos and music, kept on disk beside the rest of the state.
 *
 * Files are named after a hash of their own bytes, which is doing three jobs:
 * the same file uploaded twice costs one copy, the name can never contain a
 * path an operator typed, and a name is stable enough to sit in a saved graphic
 * without a re-upload invalidating it.
 *
 * The declared Content-Type is ignored entirely - the format is read out of the
 * first few bytes, so a file that merely claims to be a PNG is rejected rather
 * than written and served back as one.
 */

/** Images are logos; audio is a whole music bed, so it gets its own ceiling. */
export const MEDIA_LIMITS = { image: 12 * 1024 * 1024, audio: 32 * 1024 * 1024 };

const ascii = (buffer, from, to) => buffer.toString('latin1', from, to);

const MEDIA_SIGNATURES = [
  { kind: 'image', ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n' },
  {
    kind: 'image',
    ext: 'jpg',
    mime: 'image/jpeg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  { kind: 'image', ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && ascii(b, 0, 4) === 'GIF8' },
  {
    kind: 'image',
    ext: 'webp',
    mime: 'image/webp',
    test: (b) => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
  {
    // Org logos are very often SVG, so refusing them would send operators off to
    // convert files mid-setup. It is served with a locked-down CSP and nosniff
    // (see server.js), which is what keeps script inside one inert.
    kind: 'image',
    ext: 'svg',
    mime: 'image/svg+xml',
    test: (b) => /^\s*(?:<\?xml|<!--|<!doctype svg|<svg)/i.test(b.toString('utf8', 0, 256)),
  },

  {
    // Either an ID3 tag or a bare MPEG frame header - plenty of exported stings
    // have no tag at all.
    kind: 'audio',
    ext: 'mp3',
    mime: 'audio/mpeg',
    test: (b) => b.length > 3 && (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  },
  { kind: 'audio', ext: 'ogg', mime: 'audio/ogg', test: (b) => b.length > 4 && ascii(b, 0, 4) === 'OggS' },
  {
    kind: 'audio',
    ext: 'wav',
    mime: 'audio/wav',
    test: (b) => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE',
  },
  {
    kind: 'audio',
    ext: 'm4a',
    mime: 'audio/mp4',
    test: (b) => b.length > 12 && ascii(b, 4, 8) === 'ftyp',
  },
  {
    kind: 'audio',
    ext: 'webm',
    mime: 'audio/webm',
    test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
];

/** @returns {{kind: string, ext: string, mime: string}|null} null for anything unrecognised */
export function sniffMedia(buffer) {
  return MEDIA_SIGNATURES.find((entry) => entry.test(buffer)) ?? null;
}

export const MEDIA_MIME_TYPES = Object.fromEntries(MEDIA_SIGNATURES.map((entry) => [entry.ext, entry.mime]));

const MEDIA_EXTENSIONS = [...new Set(MEDIA_SIGNATURES.map((entry) => entry.ext))];

/** Hash-shaped names only. Anything else never reaches the filesystem. */
const MEDIA_NAME = new RegExp(`^[0-9a-f]{16}\\.(${MEDIA_EXTENSIONS.join('|')})$`);

/** The largest thing that could ever be accepted, for the request body cap. */
export const MEDIA_MAX_BYTES = Math.max(...Object.values(MEDIA_LIMITS));

/**
 * @param {string} dir where uploads live
 */
export function makeMediaStore(dir) {
  return {
    /**
     * @param {Buffer} buffer the raw upload
     * @returns {Promise<{name: string, url: string, bytes: number, mime: string, kind: string}>}
     */
    async save(buffer) {
      if (!buffer?.length) throw new Error('That upload was empty.');

      const kind = sniffMedia(buffer);
      if (!kind) {
        throw new Error('That file is not an image (PNG, JPEG, GIF, WebP, SVG) or audio (MP3, OGG, WAV, M4A, WebM).');
      }

      // Checked after sniffing so the message can name the right limit - "4 MB"
      // is unhelpful advice for somebody uploading a two-minute sting.
      const limit = MEDIA_LIMITS[kind.kind];
      if (buffer.length > limit) {
        throw new Error(`${kind.kind === 'audio' ? 'Audio' : 'Images'} are capped at ${Math.round(limit / 1024 / 1024)} MB.`);
      }

      const name = `${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}.${kind.ext}`;
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), buffer);
      return { name, url: `/media/${name}`, bytes: buffer.length, mime: kind.mime, kind: kind.kind };
    },

    async list() {
      try {
        const names = (await readdir(dir)).filter((name) => MEDIA_NAME.test(name));
        return names.sort().map((name) => ({ name, url: `/media/${name}` }));
      } catch {
        return [];
      }
    },

    /**
     * Deliberately no delete. A file here is named after its own hash, so
     * leaving one costs a few kilobytes - whereas removing one that a saved
     * graphic still points at breaks that graphic silently, and finding out
     * mid-show is not a trade worth making. Clearing them out is `rm` on
     * .state/media between events.
     */

    /**
     * The absolute path to serve, or null. The name pattern is the whole guard -
     * no separators, no dots, no encoded traversal can match it.
     */
    resolve(name) {
      return MEDIA_NAME.test(String(name)) ? path.join(dir, name) : null;
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
