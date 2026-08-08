/**
 * Winner graphic dashboard - drives the end-of-map sequence.
 *
 * Structurally a sibling of dashboard.js: editors write into a local copy of the
 * state and POST it (debounced), the server pushes it back out over SSE, and the
 * preview iframe is the real output page rather than a re-implementation of it.
 *
 * What is different is that this graphic has a *position*, not just an on/off,
 * so the transport bar has five buttons instead of three and the server owns
 * where in the sequence things are. Everything here does is ask.
 *
 * The team library lives on this tab because this is the graphic that needs it
 * most, but it is not owned by it - the scoreboard's side editors read the same
 * list, which is why saving one broadcasts `teams-changed`.
 */

import { FONT_CHOICES } from './preset-schema.js';
import { TEAM_FIELDS, TEAM_REGIONS, EMPTY_TEAM, teamLabel } from './teams.js';
import { el, field, grid, help, makeFields, subhead, title } from './fields.js';
import {
  AUDIO_FIELDS,
  AUDIO_GROUPS,
  SEQ_FIELDS,
  SEQ_GROUPS,
  WINNER_MAP_ROWS,
  WINNER_SIDE_CHOICES,
  WINNER_STAGES,
  WINNER_STAGE_COUNT,
  WINNER_STYLE_FIELDS,
  WINNER_STYLE_GROUPS,
  WINNER_TEXT_FIELDS,
  resolveWinner,
  sequenceRunMs,
} from './winner-schema.js';

const SAVE_DEBOUNCE_MS = 180;
const CUE_WRAP = 1_000_000;

const $ = (id) => document.getElementById(id);

const els = {
  resetBtn: $('w-reset'),
  status: $('w-status'),
  obsUrl: $('w-obs-url'),
  openLink: $('w-open'),
  checker: $('w-checker'),
  frame: $('w-preview-frame'),
  preview: $('w-preview'),

  activateBtn: $('w-activate'),
  backBtn: $('w-back'),
  nextBtn: $('w-next'),
  replayBtn: $('w-replay'),
  stopBtn: $('w-stop'),
  musicBtn: $('w-music'),
  music: $('w-music-state'),
  air: $('w-air'),
  airLabel: $('w-air-label'),
  stages: $('w-stages'),
  cueHint: $('w-cue-hint'),

  editors: {
    content: $('wed-content'),
    teams: $('wed-teams'),
    seq: $('wed-seq'),
    audio: $('wed-audio'),
    style: $('wed-style'),
  },
};

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

// --------------------------------------------------------------- saving ---

let state = null;
let library = [];
let catalogue = { maps: [] };
let saveTimer = null;
let saveGeneration = 0;

function setStatus(kind, label) {
  els.status.className = `save-status ${kind}`.trim();
  els.status.textContent = label;
}

function queueSave() {
  setStatus('saving', 'Saving...');
  // Any timing edit changes what the transport bar reports, so it is refreshed
  // here rather than at each of the twenty-odd controls.
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
    const response = await fetch('/api/winner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

    // Adopt the sanitised copy so the dashboard and the graphic can never
    // disagree - but only if nothing has been typed since this save started.
    if (generation === saveGeneration) state = payload.state;
    setStatus('', 'Saved');
  } catch (error) {
    setStatus('failed', 'Not saved');
    toast(`Winner graphic not saved: ${error.message}`);
  }
}

const fields = makeFields(() => state, queueSave);
const { textField, numberField, choiceField, selectField, colourField, checkField, rangeField } = fields;

// ------------------------------------------------------------- transport ---

/**
 * Every button is the same move: say what the sequence should be doing now and
 * bump the cue. The cue is what separates an operator's intent from the stream
 * of state pushes ordinary typing produces, and it is what makes Replay mean
 * something while the sequence is already on scene one.
 *
 * `restart` rides along because "go to scene 0" is two different gestures - the
 * overlay arriving, and stepping back to the first scene while it is already up.
 */
function cue(change) {
  const seq = state.seq;
  state.seq = { ...seq, restart: false, ...change, cue: ((seq.cue ?? 0) + 1) % CUE_WRAP };
  syncCueUi();
  return saveNow();
}

/** Whether starting the sequence should also start the music. */
const hasTrack = () => Boolean(state.audio.enabled && state.audio.track);

// Activate starts the music if it is not already running. Pre-cued music is
// left alone deliberately: the output page only rewinds a track it had to start
// from silence, so an early cue lifts to the bed rather than jumping back to
// the top of the sting.
const activate = () => cue({ active: true, stage: 0, restart: true, music: state.seq.music || hasTrack() });
const replay = activate;

// Stop normally takes the music with the graphic. `keepPlaying` is what leaves
// it running underneath whatever comes next, and Fade music is then the thing
// that ends it.
const stop = () => cue({ active: false, music: state.seq.music && Boolean(state.audio.keepPlaying) });

/**
 * Music on its own, without disturbing the graphic.
 *
 * Deliberately not routed through cue(): the cue counter is what tells the
 * output page an operator asked for something, and it cannot tell which part of
 * the state that was - so bumping it here made fading the music replay whatever
 * scene was on air. `music` is a boolean, so the page can just compare it.
 */
function setMusic(on) {
  state.seq = { ...state.seq, music: on };
  syncCueUi();
  return saveNow();
}

const step = (delta) =>
  cue({ active: true, stage: Math.min(WINNER_STAGE_COUNT - 1, Math.max(0, state.seq.stage + delta)) });

/** The stage pips, doubling as a way to jump straight to a scene. */
function buildStagePips() {
  els.stages.replaceChildren(
    ...WINNER_STAGES.map((stage, index) => {
      const pip = el('button', 'stage-pip', { type: 'button', title: `Cut to "${stage.label}"` });
      pip.append(el('span', 'stage-pip-num', {}, String(index + 1)), el('span', null, {}, stage.label));
      pip.addEventListener('click', () => cue({ active: true, stage: index, restart: index === 0 }));
      return pip;
    }),
  );
}

function syncCueUi() {
  const seq = state?.seq;
  if (!seq) return;

  const active = Boolean(seq.active);
  els.air.classList.toggle('is-live', active);
  els.airLabel.textContent = active ? `On air - scene ${seq.stage + 1}` : 'Off air';

  els.activateBtn.disabled = active;
  els.stopBtn.disabled = !active;
  els.replayBtn.disabled = !active;
  els.backBtn.disabled = !active || seq.stage === 0;
  els.nextBtn.disabled = !active || seq.stage >= WINNER_STAGE_COUNT - 1;

  for (const [index, pip] of [...els.stages.children].entries()) {
    pip.classList.toggle('is-current', active && index === seq.stage);
    pip.classList.toggle('is-done', active && index < seq.stage);
  }

  // One button, both directions. Only there once a track is loaded - otherwise
  // it is a button for nothing.
  const ready = hasTrack();
  els.musicBtn.hidden = !ready;
  els.music.hidden = !ready;
  els.musicBtn.textContent = seq.music ? 'Fade music' : 'Cue music';
  els.musicBtn.title = seq.music
    ? 'Fade the music out without touching the graphic'
    : 'Start the music now, before the sequence - it lifts to the bed level on Activate';
  els.music.classList.toggle('is-live', Boolean(seq.music));
  els.music.title = seq.music ? 'Music playing' : 'Music stopped';

  // Explains an empty preview rather than leaving it looking broken.
  els.frame.classList.toggle('is-hidden', !active);
  els.frame.style.setProperty('--hide-note-delay', `${seq.outMs + 120}ms`);

  const seconds = (ms) => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const summary = seq.autoAdvance
    ? [`runs itself in ${seconds(sequenceRunMs(state))}`, seq.exitAtEnd ? 'then comes off' : 'then holds on the winner']
    : ['manual - Next drives it'];
  if (seq.music) summary.push('music playing');
  els.cueHint.textContent = summary.join('  ·  ');
}

els.activateBtn.addEventListener('click', activate);
els.replayBtn.addEventListener('click', replay);
els.stopBtn.addEventListener('click', stop);
els.nextBtn.addEventListener('click', () => step(1));
els.backBtn.addEventListener('click', () => step(-1));
els.musicBtn.addEventListener('click', () => setMusic(!state.seq.music));

/**
 * Auto-advance happens on the server, so the sequence moves without this
 * dashboard having asked. Only the command channel is taken from the stream -
 * adopting the whole state would overwrite whatever is being typed.
 */
const stream = new EventSource('/api/winner/events');

stream.addEventListener('winner', (event) => {
  if (!state) return;
  try {
    const seq = JSON.parse(event.data)?.state?.seq;
    if (!seq) return;
    state.seq.active = seq.active;
    state.seq.stage = seq.stage;
    state.seq.restart = seq.restart;
    state.seq.cue = seq.cue;
    syncCueUi();
  } catch {
    // A malformed frame is not worth breaking the dashboard over.
  }
});

// ------------------------------------------------------- editor: content ---

/**
 * A media control: drop a file on it, browse for one, or paste a URL. All three
 * end up as the same string - an upload is just a URL that happens to be served
 * out of .state/media, which is why there is no second "uploaded vs pasted"
 * concept anywhere downstream of here.
 *
 * Takes accessors rather than a path because it is used against three different
 * objects: the live graphic state, the team library's draft, and the music bed.
 *
 * @param {() => string} get
 * @param {(value: string) => void} set
 */
function mediaControl(label, get, set, { accept = 'image/*', placeholder = 'https://... or drop a file here' } = {}) {
  const isAudio = accept.startsWith('audio');

  const preview = el('div', `logo-preview${isAudio ? ' is-audio' : ''}`);
  const image = el('img', null, { alt: '' });
  if (!isAudio) preview.append(image);

  const url = el('input', null, {
    type: 'text',
    spellcheck: 'false',
    placeholder,
    maxlength: 500,
  });

  // An audio file has no thumbnail, so its box just reports whether one is set.
  const showThumb = (value) => {
    if (!isAudio) {
      image.hidden = !value;
      if (value) image.src = value;
      else image.removeAttribute('src');
    }
    preview.classList.toggle('is-empty', !value);
  };

  const paint = () => {
    url.value = get() ?? '';
    showThumb(url.value);
  };

  // Typing writes through but does not repaint the box the operator is in -
  // only the thumbnail needs to follow along.
  url.addEventListener('input', () => {
    set(url.value);
    showThumb(url.value);
  });

  const upload = async (file) => {
    if (!file) return;
    try {
      // No multipart envelope: one file per request, so the body is the file.
      const response = await fetch('/api/media', { method: 'POST', body: file });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      set(payload.url);
      paint();
      toast(`Uploaded ${file.name}`);
    } catch (error) {
      toast(`Logo not uploaded: ${error.message}`);
    }
  };

  const picker = el('input', 'logo-file', { type: 'file', accept });
  picker.addEventListener('change', () => {
    void upload(picker.files?.[0]);
    // Cleared so re-picking the same file still fires a change event.
    picker.value = '';
  });

  const browse = el('button', 'mini-btn', { type: 'button' }, 'Upload');
  browse.addEventListener('click', () => picker.click());

  const clear = el('button', 'mini-btn', { type: 'button', title: 'Remove it' }, 'Clear');
  clear.addEventListener('click', () => {
    set('');
    paint();
  });

  // Dropping onto the thumbnail is the fast path; the button is there because a
  // drop target with no visible affordance is a feature nobody finds.
  preview.addEventListener('dragover', (event) => {
    event.preventDefault();
    preview.classList.add('is-over');
  });
  preview.addEventListener('dragleave', () => preview.classList.remove('is-over'));
  preview.addEventListener('drop', (event) => {
    event.preventDefault();
    preview.classList.remove('is-over');
    void upload(event.dataTransfer?.files?.[0]);
  });

  const tools = el('div', 'logo-tools');
  tools.append(browse, clear, picker);

  const body = el('div', 'logo-body');
  body.append(url, tools);

  const row = el('div', 'logo-row');
  row.append(preview, body);
  paint();

  const wrap = el('div', 'g-field');
  wrap.append(el('span', null, {}, label), row);
  return wrap;
}

/** The same control, bound to a dotted path in the live graphic state. */
const logoField = (label, path) =>
  mediaControl(
    label,
    () => fields.get(path),
    (value) => fields.set(path, value),
  );

/** Fills one of the two teams on this graphic from the library. */
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
    // Copied, not linked: the score below belongs to this match, and renaming
    // the team next week must not rewrite a graphic that already went to air.
    for (const key of ['name', 'shortName', 'region', 'logo', 'colour']) state[half][key] = team[key];
    state[half].teamId = team.id;
    queueSave();
    buildContentEditor();
    toast(`Filled the ${half} team from "${team.name}"`);
  });

  return field('From the team library', select);
}

function wrapChildren(className, children) {
  const node = el('div', className);
  node.append(...children);
  return node;
}

function teamBlock(half) {
  const swatch = el('span', 'side-swatch');
  swatch.style.background = state[half].colour;

  const heading = subhead(half === 'left' ? 'Left team' : 'Right team');
  heading.prepend(swatch);

  return wrapChildren('team-block', [
    heading,
    grid(null, [teamPicker(half)]),
    grid(2, [
      textField('Name', `${half}.name`, { maxlength: 32 }),
      textField('Tricode', `${half}.shortName`, { maxlength: 8, placeholder: 'SEN' }),
    ]),
    grid(2, [
      selectField('Region', `${half}.region`, TEAM_REGIONS),
      numberField('Maps won', `${half}.score`, { max: 99 }),
    ]),
    grid(2, [colourField('Team colour', `${half}.colour`)]),
    logoField('Logo', `${half}.logo`),
  ]);
}

/** One row of the score line's map breakdown. */
function mapRow(index) {
  const mapNames = catalogue.maps.map((map) => map.name);
  const row = grid(3, [
    selectField(`Map ${index + 1}`, `maps.${index}.name`, mapNames),
    numberField('Left', `maps.${index}.left`, { max: 99 }),
    numberField('Right', `maps.${index}.right`, { max: 99 }),
  ]);
  // Gives the map name the room and leaves the two-digit scores narrow.
  row.classList.add('score-map-row');
  return row;
}

/** What each scene is called in the editor, in the operator's words. */
const SCENE_BLURB = {
  map: 'the map just played',
  winner: 'the winner',
  score: 'the series score',
};

/**
 * One scene's worth of editor, in whatever position the schema puts the scene.
 *
 * Built from WINNER_STAGES rather than written out in order, so a scene that
 * moves in the sequence moves here too. Getting that wrong is quiet and nasty:
 * the panel would still say "Scene 2" over the fields for whatever now plays
 * third, and nothing about the page would look wrong.
 */
function sceneSection(stage, index) {
  const heading = subhead(`Scene ${index + 1} - ${SCENE_BLURB[stage.key] ?? stage.label.toLowerCase()}`);
  const texts = WINNER_TEXT_FIELDS.filter((entry) => entry.stage === stage.key).map((entry) =>
    textField(entry.label, entry.key, { maxlength: entry.max, placeholder: entry.placeholder }),
  );

  switch (stage.key) {
    case 'map':
      return [
        heading,
        grid(2, [selectField('Map', 'mapName', catalogue.maps.map((map) => map.name)), ...texts]),
        grid(null, [
          textField('Map image override', 'mapImage', { placeholder: 'https://... (blank = official splash)' }),
        ]),
      ];

    case 'score':
      return [
        heading,
        grid(2, texts.slice(0, 1)),
        ...Array.from({ length: WINNER_MAP_ROWS }, (_, row) => mapRow(row)),
        help('A map row with no map picked is left out of the graphic, so a Bo3 is just a Bo5 with two rows empty.'),
        grid(2, texts.slice(1)),
        help(
          'A map that is picked but still on 0 - 0 has not been played, so it is faded and carries the note above ' +
            'instead of a score. The last one gets the second wording, once something before it has been played - ' +
            'a decider settles a series already under way. Leave either blank to fade the row with no words on it.',
        ),
      ];

    default: {
      const decided = resolveWinner(state);
      return [
        heading,
        grid(2, [choiceField('Winning team', 'winner', WINNER_SIDE_CHOICES), ...texts.slice(0, 1)]),
        grid(null, texts.slice(1)),
        help(
          state.winner === 'auto'
            ? `The series score makes ${state[decided].name || (decided === 'left' ? 'the left team' : 'the right team')} the winner.`
            : 'Overridden by hand - the series score above is being ignored.',
        ),
      ];
    }
  }
}

function buildContentEditor() {
  els.editors.content.replaceChildren(
    title('Content'),

    ...WINNER_STAGES.flatMap(sceneSection),

    subhead('Teams'),
    teamBlock('left'),
    teamBlock('right'),

    subhead('Event'),
    logoField('Event logo', 'eventLogo'),
    help(
      'Only on screen while the sequence is - it comes and goes with the overlay rather than sitting over the game ' +
        'feed between cues. Where it lands is under Style: by default it is part of the winner and score scenes, ' +
        'arriving with them, rather than a mark in the corner.',
    ),
  );
}

// ------------------------------------------------------ editor: sequence ---

/** One editor control per schema field, chosen by its declared type. */
function seqField(entry) {
  const path = `seq.${entry.key}`;
  switch (entry.type) {
    case 'choice':
      return choiceField(entry.label, path, entry.options);
    case 'bool':
      return checkField(entry.label, path);
    default:
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
  }
}

function buildSeqEditor() {
  const host = els.editors.seq;
  const groups = [];

  for (const group of SEQ_GROUPS) {
    const entries = SEQ_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(seqField)));
  }

  host.replaceChildren(
    title('Sequence'),
    help(
      `Three scenes: ${WINNER_STAGES.map((stage) => stage.label.toLowerCase()).join(', then ')}. Each one reveals ` +
        'band by band, and the backdrop carries on off the far side at the end. With auto-advance off, nothing ' +
        'moves until you press Next - the holds below are ignored.',
    ),
    help(
      'The opening plays only when the overlay arrives, on Activate or Replay. Sweep crosses the frame in one ' +
        'move; Shards throws the backdrop in as slats from above and below; Blinds closes it in as bars from the ' +
        'sides; Impact slams it in behind a flash of the accent colour; Streak sends an accent bolt across and ' +
        'drags the backdrop in behind it; Facets cascades angled shards across the frame until they lock together; ' +
        'Prism spins in a lattice of diamonds outlined and lit in the accent colour, in rings out from the middle; ' +
        'Pulse throws rings of neon out from the centre and opens the backdrop as a circle behind the last of them.',
    ),
    help(
      'The scene change is what happens between the three cards. Push and Rise deal the bands in from the side or ' +
        'from below; Crossfade is the quiet one; Wipe reveals by clipping without any fade; Zoom pushes through; ' +
        'Shear throws each band in on a lean that unwinds as it lands; Neon glint sends a lit bar across the frame ' +
        'with the next card arriving behind it.',
    ),
    ...groups,
  );
}

// --------------------------------------------------------- editor: music ---

function audioField(entry) {
  const path = `audio.${entry.key}`;
  switch (entry.type) {
    case 'bool':
      return checkField(entry.label, path);
    case 'ratio':
      return rangeField(entry.label, path);
    default:
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
  }
}

function buildAudioEditor() {
  const host = els.editors.audio;
  const groups = [];

  for (const group of AUDIO_GROUPS) {
    const entries = AUDIO_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(audioField)));
  }

  host.replaceChildren(
    title('Music'),
    help(
      'Starts when you press Activate, lifts when the winner lands, then settles to an ambient level a caster can ' +
        'talk over. It plays in the OBS source only - this preview stays silent so you are not hearing the same ' +
        'sting twice, a frame apart.',
    ),
    trackControl(),
    ...groups,
    help(
      'The level follows the sequence: bed under the map card, up on the winner, then ambient for the score line ' +
        'and everything after it. The settle timer is only for a sequence left holding on the winner - moving on ' +
        'to the score line brings the music down on its own.',
    ),
  );
}

/** The track itself: upload or paste, same control the logos use. */
const trackControl = () =>
  mediaControl(
    'Track',
    () => state.audio.track,
    (value) => fields.set('audio.track', value),
    { accept: 'audio/*', placeholder: 'https://... or drop an MP3, OGG, WAV, M4A here' },
  );

// --------------------------------------------------------- editor: style ---

function styleField(entry) {
  const path = `style.${entry.key}`;
  switch (entry.type) {
    case 'font':
      return selectField(entry.label, path, FONT_CHOICES, { allowUnknown: false });
    case 'choice':
      return choiceField(entry.label, path, entry.options);
    case 'media':
      return logoField(entry.label, path);
    case 'ratio':
      return rangeField(entry.label, path);
    case 'bool':
      return checkField(entry.label, path);
    case 'px':
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
    default:
      return colourField(entry.label, path);
  }
}

function buildStyleEditor() {
  const host = els.editors.style;
  const groups = [];

  for (const group of WINNER_STYLE_GROUPS) {
    const entries = WINNER_STYLE_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(styleField)));

    if (group === 'Texture') {
      groups.push(
        help(
          'A finish on the backdrop, above the map plate and under the text, for the whole sequence. The lattice is ' +
            'the prism opening standing still, so the score line sits on the thing the opening built. Keep it low - ' +
            'the moment it reads as a pattern it is competing with the team name. It also gives an encoder some ' +
            'structure to hold on to, which is what stops a blurred splash banding on a stream.',
        ),
      );
    }
  }

  host.replaceChildren(title('Style'), ...groups);
}

// -------------------------------------------------- editor: team library ---

async function teamAction(body) {
  const response = await fetch('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

  library = payload.teams;
  // The scoreboard's side pickers read the same list.
  window.dispatchEvent(new CustomEvent('teams-changed', { detail: library }));
  buildTeamEditor();
  buildContentEditor();
  return payload;
}

/**
 * The library form edits a draft rather than the live state, because a team is
 * only worth saving once it is complete - a half-typed name should not appear in
 * every dropdown on the page while it is being typed.
 */
let draft = { id: null, ...EMPTY_TEAM };

/**
 * The one control on the form that depends on what has been typed into the rest
 * of it, and therefore the only thing an edit has to update.
 *
 * Rebuilding the panel instead - which is what this used to do - replaces the
 * very input being typed into, so the caret is gone after each keystroke and a
 * team name has to be entered one letter and one click at a time. Nothing else
 * here reads the draft as it is typed, so there is nothing else to refresh.
 */
let teamSaveBtn = null;

const syncTeamForm = () => {
  if (teamSaveBtn) teamSaveBtn.disabled = !String(draft.name ?? '').trim();
};

const draftFields = makeFields(() => draft, syncTeamForm);

function editTeam(team) {
  draft = team ? { ...team } : { id: null, ...EMPTY_TEAM };
  buildTeamEditor();
}

function draftControl(entry) {
  switch (entry.type) {
    case 'choice':
      return draftFields.selectField(entry.label, entry.key, TEAM_REGIONS);
    case 'hex':
      return draftFields.colourField(entry.label, entry.key);
    case 'image':
      return null; // handled below - the logo control is not a plain input
    default:
      return draftFields.textField(entry.label, entry.key, {
        maxlength: entry.max,
        placeholder: entry.placeholder ?? '',
      });
  }
}

/** The same control, writing into the draft rather than the live graphic. */
const draftLogoField = () =>
  mediaControl(
    'Logo',
    () => draft.logo,
    (value) => {
      draft.logo = value;
    },
  );

function teamCard(team) {
  const card = el('div', 'team-card');

  const crest = el('div', 'team-card-logo');
  if (team.logo) crest.append(el('img', null, { src: team.logo, alt: '' }));
  else crest.append(el('span', null, {}, teamLabel(team).slice(0, 3)));
  crest.style.setProperty('--team-colour', team.colour);

  const who = el('div', 'team-card-who');
  who.append(el('div', 'team-card-name', {}, team.name));
  who.append(el('div', 'team-card-meta', {}, [team.shortName, team.region].filter(Boolean).join('  ·  ')));

  const tools = el('div', 'row-tools');

  const edit = el('button', 'mini-btn', { type: 'button' }, 'Edit');
  edit.addEventListener('click', () => editTeam(team));

  const remove = el('button', 'mini-btn', { type: 'button' }, 'Delete');
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${team.name}"? Graphics already using it keep their name and logo.`)) return;
    try {
      await teamAction({ action: 'delete', id: team.id });
      toast(`Deleted "${team.name}"`);
    } catch (error) {
      toast(`Could not delete: ${error.message}`);
    }
  });

  tools.append(edit, remove);
  card.append(crest, who, tools);
  return card;
}

function buildTeamEditor() {
  const host = els.editors.teams;
  const editing = Boolean(draft.id);

  const save = el('button', 'btn btn-primary', { type: 'button' }, editing ? 'Update team' : 'Add team');
  teamSaveBtn = save;
  syncTeamForm();
  save.addEventListener('click', async () => {
    try {
      const { saved } = await teamAction({ action: 'save', team: draft });
      toast(`Saved "${saved.name}"`);
      editTeam(null);
    } catch (error) {
      toast(`Could not save: ${error.message}`);
    }
  });

  const cancel = el('button', 'btn btn-ghost', { type: 'button' }, editing ? 'New team' : 'Clear');
  cancel.addEventListener('click', () => editTeam(null));

  const actions = el('div', 'team-form-actions');
  actions.append(save, cancel);

  const controls = TEAM_FIELDS.map(draftControl).filter(Boolean);

  host.replaceChildren(
    title('Team library'),
    help(
      'Saved once and reused. Picking a team copies its name, tricode, region, logo and colour onto a graphic - it ' +
        'does not link them, so editing a team here never changes something that is already on air.',
    ),
    library.length
      ? wrapChildren('team-list', library.map(teamCard))
      : el('p', 'empty', {}, 'No teams saved yet. Add one below and it will appear on both graphics.'),
    subhead(editing ? `Editing ${draft.name}` : 'Add a team'),
    grid(2, controls),
    draftLogoField(),
    actions,
  );
}

// -------------------------------------------------------------- preview ---

function fitPreview() {
  const width = els.frame.clientWidth;
  if (width) els.preview.style.transform = `scale(${width / 1920})`;
}

new ResizeObserver(fitPreview).observe(els.frame);
window.addEventListener('resize', fitPreview);
window.addEventListener('app-tab', (event) => {
  if (event.detail === 'winner') fitPreview();
});

els.checker.addEventListener('change', () => {
  els.frame.classList.toggle('checker', els.checker.checked);
});

els.resetBtn.addEventListener('click', async () => {
  if (!window.confirm('Reset the winner graphic to defaults? Every field will be cleared.')) return;

  const response = await fetch('/api/winner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  const payload = await response.json();
  state = payload.state;
  buildAll();
  setStatus('', 'Saved');
  toast('Winner graphic reset');
});

// ----------------------------------------------------------------- start ---

function buildAll() {
  buildStagePips();
  buildContentEditor();
  buildTeamEditor();
  buildSeqEditor();
  buildAudioEditor();
  buildStyleEditor();
  syncCueUi();
}

async function start() {
  els.obsUrl.textContent = `${location.origin}/winner.html`;
  els.openLink.href = '/winner.html';
  // The shared overlay points at whichever button would fix an empty preview,
  // and on this tab that is Activate rather than Show.
  els.frame.style.setProperty('--hide-note', '"Off air - press Activate to play the sequence"');

  const [winner, assetData, teamData] = await Promise.all([
    fetch('/api/winner').then((r) => r.json()),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { maps: [] }))
      .catch(() => ({ maps: [] })),
    fetch('/api/teams')
      .then((r) => r.json())
      .catch(() => ({ teams: [] })),
  ]);

  state = winner.state;
  catalogue = assetData;
  library = teamData.teams ?? [];

  buildAll();
  setStatus('', 'Saved');
  fitPreview();
}

start().catch((error) => {
  els.editors.content.replaceChildren(el('p', 'empty', {}, `Could not load the winner graphic: ${error.message}`));
});
