/**
 * Agent select dashboard.
 *
 * Structurally a sibling of the other two: editors write into a local copy of
 * the state and POST it (debounced), the server pushes it back out over SSE, and
 * the preview iframe is the real output page rather than a re-implementation.
 *
 * What is different is where most of the state comes from. The roster is filled
 * in by a webhook while a lobby picks, so this dashboard has to accept updates
 * it did not cause without throwing away whatever is being typed at the time -
 * hence the split in the stream handler below. The roster editors exist for the
 * days the feed is not running, and for fixing the one card it got wrong.
 */

import { FONT_CHOICES } from './preset-schema.js';
import { onState } from './live.js';
import { mediaControl } from './media-field.js';
import { mapDisplayName } from './maps.js';
import { el, field, grid, help, makeFields, subhead, title } from './fields.js';
import {
  SELECT_ANIM_FIELDS,
  SELECT_ANIM_GROUPS,
  SELECT_SIDE_SIZE,
  SELECT_STYLE_FIELDS,
  SELECT_STYLE_GROUPS,
  SELECT_AUTO_FIELDS,
  isAgentSelectScene,
  selectProgress,
  sideSlots,
  stripTagline,
  timerRemainingMs,
} from './select-schema.js';

const SAVE_DEBOUNCE_MS = 180;
const CUE_WRAP = 1_000_000;

const $ = (id) => document.getElementById(id);

const els = {
  resetBtn: $('s-reset'),
  status: $('s-status'),
  obsUrl: $('s-obs-url'),
  hookUrl: $('s-hook-url'),
  gameUrl: $('s-game-url'),
  openLink: $('s-open'),
  checker: $('s-checker'),
  frame: $('s-preview-frame'),
  preview: $('s-preview'),

  showBtn: $('s-show'),
  hideBtn: $('s-hide'),
  swapBtn: $('s-swap'),
  clearBtn: $('s-clear'),
  clockBtn: $('s-clock'),
  endClockBtn: $('s-clock-end'),
  air: $('s-air'),
  airLabel: $('s-air-label'),
  cueHint: $('s-cue-hint'),

  editors: {
    teams: $('sed-teams'),
    roster: $('sed-roster'),
    aliases: $('sed-aliases'),
    anim: $('sed-anim'),
    style: $('sed-style'),
  },
};

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

// --------------------------------------------------------------- saving ---

let state = null;
let library = [];
let players = [];
let catalogue = { maps: [], agents: [] };
let saveTimer = null;
let saveGeneration = 0;
let aliasFilter = '';

function setStatus(kind, label) {
  els.status.className = `save-status ${kind}`.trim();
  els.status.textContent = label;
}

function queueSave() {
  setStatus('saving', 'Saving...');
  syncCueUi();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

/** For cues, where a debounce would mean the graphic moves late on air. */
function saveNow() {
  clearTimeout(saveTimer);
  setStatus('saving', 'Saving...');
  return save();
}

async function save() {
  const generation = ++saveGeneration;
  try {
    const response = await fetch('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    if (generation === saveGeneration) state = payload.state;
    setStatus('', 'Saved');
  } catch (error) {
    setStatus('failed', 'Not saved');
    toast(`Agent select not saved: ${error.message}`);
  }
}

const fields = makeFields(() => state, queueSave);
const { textField, choiceField, selectField, colourField, checkField, rangeField, numberField } = fields;

// ------------------------------------------------------------- transport ---

function cue(change) {
  state.anim = { ...state.anim, ...change, cue: ((state.anim.cue ?? 0) + 1) % CUE_WRAP };
  syncCueUi();
  return saveNow();
}

const show = () => cue({ visible: true });
const hide = () => cue({ visible: false });

/**
 * Swap moves the rosters, not the identities.
 *
 * The feed numbers players 0-9 and says nothing about which five are which team,
 * so which end of it a team arrives on can differ from game to game. The
 * identities, by contrast, are typed once at the top of a series and stay put -
 * so the useful thing for one button to do is move the five people, and leave
 * the names where the operator put them.
 *
 * Not a cue: nothing about the entrance should replay because the rosters
 * changed ends.
 */
function swapSides() {
  state.swap = !state.swap;
  queueSave();
  buildRosterEditor();
  toast(state.swap ? 'Feed slots 6-10 are now on the left' : 'Feed slots 1-5 are back on the left');
}

function clearRoster() {
  if (!window.confirm('Empty all ten cards? The next roster event will start filling them again.')) return;
  state.slots = state.slots.map(() => ({
    playerId: '',
    riotId: '',
    name: '',
    character: '',
    locked: false,
    teammate: false,
  }));
  // Cleared here too, or the next event from the same lobby would be treated as
  // a continuation and the board would stay half empty.
  state.gameId = '';
  queueSave();
  buildRosterEditor();
}

/**
 * The clock, by hand.
 *
 * Not a cue: the timer is its own state and restarting it should never replay
 * the entrance. Start and Restart are the same move, which is why there is one
 * button - an operator whose clock is out by five seconds wants to press the
 * thing they already pressed, not hunt for a different one.
 */
function startClock() {
  state.timer = { running: true, startedAt: Date.now(), durationMs: state.timer.durationMs, filled: false, stoppedAt: 0 };
  syncCueUi();
  return saveNow();
}

function endClock() {
  state.timer = { ...state.timer, running: false, filled: true, stoppedAt: Date.now() };
  syncCueUi();
  return saveNow();
}

function syncCueUi() {
  const anim = state?.anim;
  if (!anim) return;

  const visible = Boolean(anim.visible);
  els.air.classList.toggle('is-live', visible);
  els.airLabel.textContent = visible ? 'On air' : 'Off air';
  els.showBtn.disabled = visible;
  els.hideBtn.disabled = !visible;
  els.swapBtn.classList.toggle('is-active', Boolean(state.swap));

  els.frame.classList.toggle('is-hidden', !visible);
  els.frame.style.setProperty('--hide-note-delay', `${anim.outMs + 120}ms`);

  els.clockBtn.textContent = state.timer.running ? 'Restart clock' : 'Start clock';
  els.endClockBtn.disabled = !state.timer.running;

  const { picked, locked, total } = selectProgress(state);
  const parts = [`${picked}/${total} picked`, `${locked} locked in`];

  if (state.timer.running) parts.push(`${Math.ceil(timerRemainingMs(state.timer) / 1000)}s left`);
  else if (state.timer.filled) parts.push('clock finished');

  // What the game says it is doing, when anything is telling us. Worth showing
  // because it is the difference between "the automation chose not to" and "the
  // feed is not running at all".
  if (state.scene) parts.push(isAgentSelectScene(state.scene) ? 'agent select' : state.scene);
  if (state.swap) parts.push('sides swapped');
  if (state.gameId) parts.push(`game ${state.gameId}`);
  els.cueHint.textContent = parts.join('  ·  ');

  // The countdown is the only thing here that changes on its own, so it gets a
  // tick of its own rather than the whole dashboard polling.
  clearTimeout(clockTick);
  if (state.timer.running) clockTick = setTimeout(syncCueUi, 500);
}

let clockTick = null;

els.showBtn.addEventListener('click', show);
els.hideBtn.addEventListener('click', hide);
els.swapBtn.addEventListener('click', swapSides);
els.clearBtn.addEventListener('click', clearRoster);
els.clockBtn.addEventListener('click', startClock);
els.endClockBtn.addEventListener('click', endClock);

/**
 * The roster arrives here without this dashboard having asked, so the stream is
 * adopted rather than ignored - unlike the other two tabs, where it only carries
 * the command channel.
 *
 * Everything an editor on this page owns is left alone: adopting the whole state
 * would overwrite a team name halfway through being typed. What comes from the
 * feed is the slots, the game id and the on-air flag, and that is what is taken.
 */
onState('select', (next) => {
  if (!state) return;

  const rosterChanged = JSON.stringify(next.slots) !== JSON.stringify(state.slots);
  state.slots = next.slots;
  state.gameId = next.gameId;
  state.scene = next.scene;
  state.timer = next.timer;
  state.anim.visible = next.anim.visible;
  state.anim.cue = next.anim.cue;
  // The scene feed can change the map without anybody typing it, so this one
  // is adopted too - but only when it actually moved, or a push arriving while
  // somebody is picking from the dropdown would fight them.
  // Resolved on the way in as well as on the server, so a code name that got
  // through before the catalogue loaded still shows the dropdown a value it
  // recognises rather than an "unknown" entry reading "Duality".
  const nextMap = mapDisplayName(catalogue, next.mapName);
  if (nextMap !== state.mapName) {
    state.mapName = nextMap;
    buildTeamsEditor();
  }

  if (rosterChanged) {
    buildRosterEditor();
    // New players only ever appear because the feed reported them.
    refreshAliases();
  }
  syncCueUi();
});

// --------------------------------------------------------- editor: teams ---

/** Fills one of the two sides from the team library. */
function teamPicker(half) {
  const select = el('select');
  select.append(el('option', null, { value: '' }, library.length ? '- pick a team -' : '- no saved teams -'));
  for (const team of library) {
    select.append(el('option', null, { value: team.id }, team.region ? `${team.name} (${team.region})` : team.name));
  }
  select.value = state[half].teamId ?? '';
  select.disabled = !library.length;

  select.addEventListener('change', () => {
    const team = library.find((entry) => entry.id === select.value);
    if (!team) {
      state[half].teamId = '';
      queueSave();
      return;
    }
    // Copied, not linked - same reasoning as everywhere else: editing a team
    // next week must not rewrite a graphic that already went to air.
    for (const key of ['name', 'shortName', 'logo', 'colour']) state[half][key] = team[key];
    state[half].teamId = team.id;
    queueSave();
    buildTeamsEditor();
    toast(`Filled the ${half} side from "${team.name}"`);
  });

  return field('From the team library', select);
}

/** The shared upload-or-paste control, bound to a dotted path in the state. */
const logoField = (label, path) =>
  mediaControl(
    label,
    () => fields.get(path),
    (value) => fields.set(path, value),
  );

function sideBlock(half) {
  const swatch = el('span', 'side-swatch');
  swatch.style.background = state[half].colour;

  const heading = subhead(half === 'left' ? 'Left side' : 'Right side');
  heading.prepend(swatch);

  return wrapChildren('team-block', [
    heading,
    grid(null, [teamPicker(half)]),
    grid(2, [
      textField('Name', `${half}.name`, { maxlength: 32 }),
      textField('Tricode', `${half}.shortName`, { maxlength: 8, placeholder: 'SEN' }),
    ]),
    grid(2, [
      textField('Side label', `${half}.label`, { maxlength: 8, placeholder: half === 'left' ? 'DEF' : 'ATK' }),
      colourField('Colour', `${half}.colour`),
    ]),
    logoField('Logo', `${half}.logo`),
  ]);
}

function wrapChildren(className, children) {
  const node = el('div', className);
  node.append(...children);
  return node;
}

function buildTeamsEditor() {
  const host = els.editors.teams;
  const mapNames = catalogue.maps.map((map) => map.name);

  host.replaceChildren(
    title('Teams and map'),
    help(
      'The feed knows who is in the lobby but not who they play for, so the two identities are yours to set. ' +
        'Defence is on the left by convention - Swap sides moves the five players, not the names, because which ' +
        'end of the feed a team arrives on can change from game to game while the names do not.',
    ),
    sideBlock('left'),
    sideBlock('right'),

    subhead('Map'),
    grid(2, [selectField('Map', 'mapName', mapNames)]),
    grid(null, [textField('Map image override', 'mapImage', { placeholder: 'https://... (blank = official splash)' })]),
    logoField('Event logo', 'eventLogo'),
  );
}

// -------------------------------------------------------- editor: roster ---

/**
 * One card's worth of controls.
 *
 * Addressed by the feed's own slot index rather than by seat, so what is on
 * screen here matches what arrives on the webhook even when the sides are
 * swapped - a mismatch there would make fixing the wrong card very easy.
 */
function slotRow(index) {
  const slot = state.slots[index];

  const name = el('input', null, { type: 'text', spellcheck: 'false', placeholder: 'Player', maxlength: 32 });
  name.value = slot.name ?? '';
  name.addEventListener('input', () => {
    state.slots[index].name = name.value;
    queueSave();
  });

  // Offered as display names but stored as the game's internal name, because
  // that is what the feed sends and the state should look the same however the
  // card got filled in.
  const agent = el('select');
  agent.append(el('option', null, { value: '' }, '- none -'));
  for (const entry of catalogue.agents) agent.append(el('option', null, { value: entry.developerName ?? entry.name }, entry.name));
  const current = slot.character ?? '';
  if (current && !catalogue.agents.some((entry) => (entry.developerName ?? entry.name) === current)) {
    agent.append(el('option', null, { value: current }, `${current} (unknown)`));
  }
  agent.value = current;
  agent.addEventListener('change', () => {
    state.slots[index].character = agent.value;
    queueSave();
    buildRosterEditor();
  });

  const locked = el('input', null, { type: 'checkbox' });
  locked.checked = Boolean(slot.locked);
  locked.addEventListener('change', () => {
    state.slots[index].locked = locked.checked;
    queueSave();
  });
  const lockLine = el('label', 'checkline');
  lockLine.append(locked, el('span', null, {}, 'Locked'));

  const row = grid(3, [field(`Slot ${index + 1}`, name), field('Agent', agent), field(' ', lockLine)]);
  row.classList.add('slot-row');
  // The Riot ID and player id are what the feed actually said, which is the
  // thing worth seeing when a card looks wrong.
  if (slot.playerId) row.title = `${slot.riotId} · ${slot.playerId}`;
  return row;
}

function buildRosterEditor() {
  const host = els.editors.roster;
  const { picked, locked, total } = selectProgress(state);

  const sideBlockFor = (half) => {
    const indices = sideSlots(state, half);
    return wrapChildren('team-block', [
      subhead(`${half === 'left' ? 'Left' : 'Right'} - feed slots ${indices[0] + 1}-${indices[SELECT_SIDE_SIZE - 1] + 1}`),
      ...indices.map(slotRow),
    ]);
  };

  host.replaceChildren(
    title('Roster', el('span', 'pill', {}, `${picked}/${total} picked, ${locked} locked`)),
    help(
      'Filled in by whatever is posting to the roster webhook while the lobby picks. These are here for the days ' +
        'the feed is not running, and for the one card it got wrong - a name typed here is yours and the alias ' +
        'library will not overwrite it, because it has no player id to match on.',
    ),
    sideBlockFor('left'),
    sideBlockFor('right'),
  );
}

// ------------------------------------------------------- editor: aliases ---

async function aliasAction(body) {
  const response = await fetch('/api/aliases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  players = payload.players;
  buildAliasEditor();
  return payload;
}

/**
 * Two rows, not three columns.
 *
 * Who they are is a Riot ID and a UUID; what you call them is an input and a
 * button. Side by side in one row those four fight for the width of a dashboard
 * column and the identity loses - the name truncates to a letter and the id to
 * nothing, which is exactly the half that has to be readable to know which of
 * two similar handles you are naming.
 */
function aliasRow(player) {
  const row = el('div', 'alias-row');

  const who = el('div', 'alias-who');
  who.append(el('div', 'alias-riot', {}, player.riotId || '(unknown Riot ID)'));
  who.append(el('div', 'alias-id', {}, player.id));

  const input = el('input', null, {
    type: 'text',
    spellcheck: 'false',
    maxlength: 32,
    // What the card would say with no alias, so the box shows what it is
    // replacing rather than sitting there empty.
    placeholder: stripTagline(player.riotId) || 'Alias',
  });
  input.value = player.alias ?? '';

  // Committed on blur rather than per keystroke: this writes through the server
  // and re-resolves every card that player is on, which is not something to do
  // eight times while somebody types a name.
  const commit = () => {
    if ((player.alias ?? '') === input.value) return;
    aliasAction({ action: 'save', player: { id: player.id, riotId: player.riotId, alias: input.value } }).catch(
      (error) => toast(`Alias not saved: ${error.message}`),
    );
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);

  const remove = el('button', 'mini-btn', { type: 'button', title: 'Forget this player' }, 'Forget');
  remove.addEventListener('click', () => {
    aliasAction({ action: 'delete', id: player.id }).catch((error) => toast(`Not removed: ${error.message}`));
  });

  const controls = el('div', 'alias-controls');
  controls.append(input, remove);

  row.append(who, controls);
  return row;
}

/**
 * The alias list has to follow the feed.
 *
 * New players only ever appear because a roster event arrived, and that happens
 * without this dashboard asking - so the panel has to refetch when the roster
 * moves or it sits there showing an empty library through an entire lobby, with
 * nothing to suggest a refresh would fix it.
 *
 * Debounced because ten players arrive as ten events in about a second, and one
 * fetch at the end of that is worth ten during it.
 */
let aliasRefresh = null;

function refreshAliases() {
  clearTimeout(aliasRefresh);
  aliasRefresh = setTimeout(async () => {
    try {
      const payload = await fetch('/api/aliases').then((response) => response.json());
      const next = payload.players ?? [];
      // Compared before rebuilding: this fires on every roster change, and
      // replacing the panel under somebody typing an alias would take the box
      // out from under them.
      if (JSON.stringify(next) === JSON.stringify(players)) return;
      players = next;
      buildAliasEditor();
    } catch {
      // The library is an aid, not the graphic. A failed refresh is not worth
      // a toast in the middle of a lobby.
    }
  }, 400);
}

function buildAliasEditor() {
  const host = els.editors.aliases;
  const needle = aliasFilter.trim().toLowerCase();
  const shown = players.filter(
    (player) =>
      !needle ||
      player.riotId.toLowerCase().includes(needle) ||
      (player.alias ?? '').toLowerCase().includes(needle),
  );

  const filter = el('input', null, { type: 'search', spellcheck: 'false', placeholder: 'Filter by name or alias' });
  filter.value = aliasFilter;
  filter.addEventListener('input', () => {
    aliasFilter = filter.value;
    buildAliasEditor();
    // Rebuilding blows away focus, which is unusable in a box you are typing in.
    const next = host.querySelector('input[type="search"]');
    next?.focus();
    next?.setSelectionRange(filter.value.length, filter.value.length);
  });

  const tidy = el('button', 'mini-btn', { type: 'button' }, 'Forget everyone unnamed');
  tidy.addEventListener('click', () => {
    if (!window.confirm('Forget every player who has no alias? The named ones are kept.')) return;
    aliasAction({ action: 'clear-unnamed' }).catch((error) => toast(`Not cleared: ${error.message}`));
  });

  const named = players.filter((player) => player.alias).length;

  host.replaceChildren(
    title('Player aliases', el('span', 'pill', {}, `${named} named of ${players.length}`)),
    help(
      'Every player the feed reports is recorded here, whether or not you have named one - you cannot write an ' +
        'alias for somebody you have no record of having seen. With no alias a card shows their Riot ID without ' +
        'the tagline. Keyed on the player id rather than the name, so somebody who renames themselves keeps theirs.',
    ),
    grid(null, [field('Search', filter)]),
    shown.length
      ? wrapChildren('alias-list', shown.map(aliasRow))
      : el('p', 'empty', {}, players.length ? 'Nobody matches that.' : 'No players seen yet. Run a lobby with the webhook pointed here.'),
    wrapChildren('team-form-actions', [tidy]),
  );
}

// ----------------------------------------------------- editor: animation ---

function animField(entry) {
  const path = `anim.${entry.key}`;
  switch (entry.type) {
    case 'choice':
      return choiceField(entry.label, path, entry.options);
    case 'bool':
      return checkField(entry.label, path);
    default:
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
  }
}

function buildAnimEditor() {
  const host = els.editors.anim;
  const groups = [];

  for (const group of SELECT_ANIM_GROUPS) {
    const entries = SELECT_ANIM_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(animField)));
  }

  host.replaceChildren(
    title('Animation and automation'),
    help(
      'The strip drops in as one piece and the cards arrive behind it. Every entrance is symmetrical about the ' +
        'map, because the strip is - one that favoured an end would read as one team being introduced before the ' +
        'other. Only Show and Hide replay this: a player locking in never does, or the graphic would restart every ' +
        'few seconds all the way through agent select.',
    ),
    ...groups,

    subhead('From the game feed'),
    grid(null, SELECT_AUTO_FIELDS.map((entry) => checkField(entry.label, `auto.${entry.key}`))),
    help(
      'Driven by the scene webhook: the game says which screen it is on, and agent select starting is what trips ' +
        'all of this. With nothing posting to that hook none of it happens and the buttons above are the only ' +
        'thing that moves the graphic.',
    ),
  );
}

// --------------------------------------------------------- editor: style ---

function styleField(entry) {
  const path = `style.${entry.key}`;
  switch (entry.type) {
    case 'font':
      return selectField(entry.label, path, FONT_CHOICES, { allowUnknown: false });
    case 'choice':
      return choiceField(entry.label, path, entry.options);
    case 'ratio':
      return rangeField(entry.label, path);
    case 'bool':
      return checkField(entry.label, path);
    case 'px':
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
    case 'ms':
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
    default:
      return colourField(entry.label, path);
  }
}

function buildStyleEditor() {
  const host = els.editors.style;
  const groups = [];

  for (const group of SELECT_STYLE_GROUPS) {
    const entries = SELECT_STYLE_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(styleField)));

    if (group === 'Before lock-in') {
      groups.push(
        help(
          'How a card looks once somebody has picked but not committed: faded, a little small, and pulsing in ' +
            'their team colour. Both numbers are deliberately mild - pushed far enough the strip reads as broken ' +
            'rather than as pending, and an observer cannot read a roster that is half transparent.',
        ),
      );
    }
  }

  host.replaceChildren(title('Style'), ...groups);
}

// -------------------------------------------------------------- preview ---

function fitPreview() {
  const width = els.frame.clientWidth;
  if (width) els.preview.style.transform = `scale(${width / 1920})`;
}

new ResizeObserver(fitPreview).observe(els.frame);
window.addEventListener('resize', fitPreview);
window.addEventListener('app-tab', (event) => {
  if (event.detail === 'select') fitPreview();
});

window.addEventListener('teams-changed', (event) => {
  library = event.detail ?? [];
  buildTeamsEditor();
});

els.checker.addEventListener('change', () => {
  els.frame.classList.toggle('checker', els.checker.checked);
});

els.resetBtn.addEventListener('click', async () => {
  if (!window.confirm('Reset agent select to defaults? Every field will be cleared. Aliases are kept.')) return;

  const response = await fetch('/api/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  const payload = await response.json();
  state = payload.state;
  buildAll();
  setStatus('', 'Saved');
  toast('Agent select reset');
});

// ----------------------------------------------------------------- start ---

function buildAll() {
  buildTeamsEditor();
  buildRosterEditor();
  buildAliasEditor();
  buildAnimEditor();
  buildStyleEditor();
  syncCueUi();
}

async function start() {
  els.obsUrl.textContent = `${location.origin}/select.html`;
  els.hookUrl.textContent = `${location.origin}/api/roster`;
  els.gameUrl.textContent = `${location.origin}/api/game`;
  els.openLink.href = '/select.html';
  els.frame.style.setProperty('--hide-note', '"Off air - press Show"');

  const [selectData, assetData, teamData, aliasData] = await Promise.all([
    fetch('/api/select').then((r) => r.json()),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { maps: [], agents: [] }))
      .catch(() => ({ maps: [], agents: [] })),
    fetch('/api/teams')
      .then((r) => r.json())
      .catch(() => ({ teams: [] })),
    fetch('/api/aliases')
      .then((r) => r.json())
      .catch(() => ({ players: [] })),
  ]);

  state = selectData.state;
  catalogue = assetData;
  library = teamData.teams ?? [];
  players = aliasData.players ?? [];

  buildAll();
  setStatus('', 'Saved');
  fitPreview();
}

start().catch((error) => {
  els.editors.teams.replaceChildren(el('p', 'empty', {}, `Could not load agent select: ${error.message}`));
});
