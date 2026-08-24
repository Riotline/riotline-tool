/**
 * The settings that are not any one graphic's business.
 *
 * Three graphics were each keeping their own map, their own event logo and their
 * own idea of what colour a team is. None of those are really per-graphic facts:
 * one match is played on one map, under one event's branding, with one set of
 * teams. Keeping three copies meant three places to change and three chances to
 * go on air disagreeing with each other.
 *
 * So the value lives here once and the graphics follow it. Following is a choice
 * per setting, not a rule - an operator who genuinely wants the winner sequence
 * showing last map's splash while the scoreboard shows this one can still have
 * it, by switching that setting's sync off.
 *
 * Shared by Node and the browser, like every other *-schema.js here.
 */

import { SIDE_CHOICES } from './teams.js';

export { SIDE_CHOICES };

/**
 * Where a team's colour comes from, everywhere at once.
 *
 * `team` is the ordinary broadcast: an org wears its own colour, and one with
 * none set wears the colour of the side it is playing. `sides` is the plain
 * read - every team wears attack red or defence blue whatever they have saved,
 * which is what a competition with no org branding, or a scrim, actually wants.
 */
export const COLOUR_SOURCES = [
  { key: 'team', label: 'Team colours, falling back to the side' },
  { key: 'sides', label: 'Attack / defence colours only' },
];

export const COLOUR_SOURCE_KEYS = COLOUR_SOURCES.map((entry) => entry.key);

/**
 * What the graphics take from here, and what each one calls it.
 *
 * Named per graphic because they disagree: the scoreboard has always called its
 * map `map` while the other two call it `mapName`. Renaming a field on a live
 * state file to tidy this up would be a migration for no gain, so the mapping
 * is written down instead.
 */
export const SHARED_FIELDS = [
  {
    key: 'mapName',
    label: 'Map',
    sync: 'syncMap',
    // graphic state key, per graphic
    targets: { graphic: 'map', winner: 'mapName', select: 'mapName' },
  },
  {
    key: 'mapImage',
    label: 'Map image override',
    sync: 'syncMap',
    targets: { graphic: 'mapImage', winner: 'mapImage', select: 'mapImage' },
  },
  {
    key: 'eventLogo',
    label: 'Event logo',
    sync: 'syncEventLogo',
    targets: { graphic: 'eventLogo', winner: 'eventLogo', select: 'eventLogo' },
  },
  /*
   * Only agent select takes this today, and deliberately so: it is the one
   * graphic with two live sides, so the only one where "attack red / defence
   * blue" means anything. The winner sequence is end-of-series and has no sides;
   * the scoreboard's panels belong to its preset. If either changes, they join
   * this list and nothing else has to.
   */
  {
    key: 'colourSource',
    label: 'Team colours',
    sync: 'syncColours',
    targets: { select: 'colourSource' },
  },
];

export const SYNC_FIELDS = [
  {
    key: 'syncMap',
    type: 'bool',
    label: 'Keep the map the same on all three graphics',
    default: true,
  },
  {
    key: 'syncEventLogo',
    type: 'bool',
    label: 'Keep the event logo the same on all three graphics',
    default: true,
  },
  {
    key: 'syncColours',
    type: 'bool',
    label: 'Let this page decide where team colours come from',
    default: true,
  },
];

export const SYNC_KEYS = SYNC_FIELDS.map((field) => field.key);

export const DEFAULT_GLOBAL = {
  version: 1,
  mapName: 'Ascent',
  mapImage: '',
  eventLogo: '',
  colourSource: 'team',
  ...Object.fromEntries(SYNC_FIELDS.map((field) => [field.key, field.default])),
};

/** Whether a shared field should be pushed out, given the current settings. */
export const isSynced = (state, field) => Boolean(state?.[field.sync]);

/**
 * The patch one graphic should receive, or null if nothing of its would change.
 *
 * Returns only the keys that actually differ so a save that touched the event
 * logo does not also rewrite - and re-push over SSE - a map nobody edited.
 */
export function graphicPatch(global, name, current) {
  const patch = {};
  for (const field of SHARED_FIELDS) {
    if (!isSynced(global, field)) continue;
    const target = field.targets[name];
    if (!target) continue;
    const value = global[field.key] ?? '';
    if (current?.[target] !== value) patch[target] = value;
  }
  return Object.keys(patch).length ? patch : null;
}
