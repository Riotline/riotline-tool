/**
 * The Global tab.
 *
 * Edits the settings that belong to the production rather than to one graphic,
 * and pushes them at whichever graphics are following. The two libraries beside
 * it - teams and player aliases - are still built by the winner and agent select
 * modules; only the panels they build into moved here, which is the whole of
 * what "put the global things in one place" needed to mean.
 *
 * Deliberately has no preview and opens no connection of its own: it rides the
 * one multiplexed /api/events stream through live.js, exactly like the other
 * three modules. Six connections per origin is a cap this dashboard has already
 * hit once.
 */

import { el, grid, help, makeFields, subhead, title } from './fields.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { mapDisplayName } from './maps.js';
import { COLOUR_SOURCES, SYNC_FIELDS } from './global-schema.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const host = $('ged-shared');

let state = null;
let catalogue = { maps: [] };

const SAVE_DEBOUNCE_MS = 250;
let saveTimer = null;
let saveGeneration = 0;

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  const generation = ++saveGeneration;
  try {
    const response = await fetch('/api/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    if (generation === saveGeneration) state = payload.state;

    // Said out loud, because the whole point of this page is that editing it
    // reaches somewhere else - an operator should see that it landed.
    const pushed = payload.pushed ?? [];
    if (pushed.length) {
      const names = { graphic: 'scoreboard', winner: 'winner', select: 'agent select' };
      toast(`Updated the ${pushed.map((name) => names[name] ?? name).join(', ')}`);
    }
  } catch (error) {
    toast(`Global settings not saved: ${error.message}`);
  }
}

const fields = makeFields(() => state, queueSave);
const { selectField, choiceField, checkField } = fields;

function build() {
  if (!state) return;

  const mapNames = (catalogue.maps ?? []).map((map) => map.name);

  host.replaceChildren(
    title('Shared settings'),

    subhead('The match'),
    grid(2, [selectField('Map', 'mapName', mapNames)]),
    mediaControl(
      'Map image override',
      () => state.mapImage,
      (value) => {
        state.mapImage = value;
        queueSave();
      },
      { placeholder: 'https://... (blank = official splash)' },
    ),
    mediaControl(
      'Event logo',
      () => state.eventLogo,
      (value) => {
        state.eventLogo = value;
        queueSave();
      },
    ),
    help(
      'Set here once and the graphics that are following take it. The agent select webhook writes the map here ' +
        'too, so the game telling you which map it is reaches all three without anybody typing it.',
    ),

    subhead('Team colours'),
    grid(null, [choiceField('Where colours come from', 'colourSource', COLOUR_SOURCES)]),
    help(
      'A team with no colour of its own always wears the colour of the side it is playing. Attack / defence only ' +
        'goes further and puts every team in its side colour whatever they have saved, which is what a scrim or ' +
        'an event with no org branding wants. Only agent select has two live sides, so only it changes.',
    ),

    subhead('What follows this page'),
    grid(null, SYNC_FIELDS.map((entry) => checkField(entry.label, entry.key))),
    help(
      'Switch one off and that setting becomes each graphic’s own again - the value here stops being pushed ' +
        'and whatever a graphic already had stays put. Nothing is ever read back the other way: this page is the ' +
        'one that decides, or two graphics could quietly disagree about which of them won.',
    ),
  );
}

async function start() {
  if (!host) return;

  const [global, assetData] = await Promise.all([
    fetch('/api/global').then((r) => r.json()),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { maps: [] }))
      .catch(() => ({ maps: [] })),
  ]);

  state = global.state;
  catalogue = assetData;

  // Resolved again here for the same reason the other pages do it: a map code
  // name written by the feed before the catalogue loaded should still show as
  // the map's real name once it arrives.
  state.mapName = mapDisplayName(catalogue, state.mapName);
  build();

  // Another dashboard, or the game feed, may move any of this.
  onState('global', ({ state: next }) => {
    if (saveTimer) return; // mid-edit; our own save is about to land
    state = next;
    build();
  });
}

start().catch((error) => toast(`Global settings unavailable: ${error.message}`));
