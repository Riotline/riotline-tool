/**
 * The winner graphic: a full-screen sequence played once a map or series ends.
 *
 * Three scenes, in order, each replacing the last without the overlay ever
 * leaving the screen:
 *
 *   map     the map that was just played
 *   winner  the winning team, large
 *   score   the series score line, plus a row per map
 *
 * The result comes before the detail deliberately: the winner is the thing the
 * audience is waiting for, and a card that makes them read a score line first
 * has spent the loudest moment of the sequence on bookkeeping. The score line
 * then plays as the explanation, which is also a better place to hold under a
 * caster than a 190px team name is.
 *
 * Structurally this is the same idea as animation.js - one ordered field list
 * that the server sanitises against and the dashboard builds its editor from -
 * but the command channel is bigger, because a sequence has a position as well
 * as an on/off:
 *
 *   active   is the overlay on air at all
 *   stage    which of the three scenes is showing
 *   restart  this cue starts the sequence from the top, overlay entry and all
 *   cue      a counter bumped by every Activate/Next/Back/Replay/Stop press
 *
 * `restart` looks redundant next to `stage === 0`, and is not: stepping Back
 * from the score line also lands on stage 0, but the overlay is already up and
 * must not wipe itself on again. It is the difference between "arrive" and
 * "change scene", and the page and the server both have to agree on which one
 * is happening or their timings drift apart.
 *
 * The cue exists for the same reason it does on the scoreboard: every keystroke
 * in the dashboard pushes the whole state, so a page that reacted to state
 * changes would re-run the sequence whenever somebody fixed a typo. It is also
 * the only way Replay can mean anything while stage is already 0.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

import { ANIM_EASINGS, ANIM_EASING_KEYS, easingCurve } from './animation.js';

// The easings are the same broadcast curves the scoreboard uses; there is no
// reason for two graphics in one package to move to different physics.
export { ANIM_EASINGS as WINNER_EASINGS, ANIM_EASING_KEYS as WINNER_EASING_KEYS, easingCurve };

/** How many map rows the score line has room for. A Bo5 is the practical cap. */
export const WINNER_MAP_ROWS = 5;

/**
 * Scene order is the sequence order - Next walks this list. `hold` names the
 * timing field that decides how long the scene sits there when auto-advance is
 * on, so adding a scene means adding its hold field and nothing else.
 *
 * `peak` marks the emotional high point rather than the last scene. The music
 * lifts there and comes down afterwards, so reordering the scenes moves the lift
 * with the winner instead of leaving it on whatever happens to be last.
 */
export const WINNER_STAGES = [
  { key: 'map', label: 'Map played', hold: 'mapHoldMs' },
  { key: 'winner', label: 'Winning team', hold: 'winnerHoldMs', peak: true },
  { key: 'score', label: 'Series score', hold: 'scoreHoldMs' },
];

export const WINNER_STAGE_KEYS = WINNER_STAGES.map((stage) => stage.key);
export const WINNER_STAGE_COUNT = WINNER_STAGES.length;
export const LAST_STAGE = WINNER_STAGE_COUNT - 1;

/**
 * Which scene the music lifts on. Not the last one - the winner is what the lift
 * is for, and it is no longer the scene the sequence ends on.
 */
export const PEAK_STAGE = WINNER_STAGES.findIndex((stage) => stage.peak);

/**
 * How one scene hands over to the next. These are transitions between scenes,
 * not the overlay's own entry - the overlay always arrives and leaves by wiping
 * its backdrop across the frame, because that is the part that has to look like
 * a stinger rather than like a graphic fading up.
 */
export const WINNER_TRANSITIONS = [
  { key: 'push', label: 'Push across' },
  { key: 'fade', label: 'Crossfade' },
  { key: 'wipe', label: 'Wipe across' },
  { key: 'zoom', label: 'Zoom through' },
  { key: 'rise', label: 'Rise up' },
  { key: 'shear', label: 'Shear in' },
  { key: 'glint', label: 'Neon glint' },
];

export const WINNER_TRANSITION_KEYS = WINNER_TRANSITIONS.map((entry) => entry.key);

/**
 * How the overlay *arrives*. Separate from the scene transitions above because
 * it is a different job: a scene change happens while the audience is already
 * looking at the graphic, so it wants to be smooth. The opening has to take the
 * screen away from a game feed, so it wants to be loud.
 *
 * It only ever plays on an Activate or a Replay - stepping Back to the first
 * scene is a scene change, not an arrival.
 */
export const WINNER_OPENINGS = [
  // Kept short because they sit in a narrow select; what each one actually does
  // is spelled out in the Sequence panel's help text.
  { key: 'sweep', label: 'Sweep across' },
  { key: 'shards', label: 'Shards - snap in' },
  { key: 'blinds', label: 'Blinds - close in' },
  { key: 'impact', label: 'Impact - slam' },
  { key: 'streak', label: 'Streak - bolt' },
  { key: 'facets', label: 'Facets - shards fill' },
  { key: 'prism', label: 'Prism - lit lattice' },
  { key: 'pulse', label: 'Pulse - neon rings' },
];

export const WINNER_OPENING_KEYS = WINNER_OPENINGS.map((entry) => entry.key);

/**
 * How many slats the backdrop is built from. They tile the frame edge to edge
 * and are the backdrop - a single filled panel could not fly in in pieces. The
 * openings that do not use them simply move all of them as one.
 */
export const OPENING_SLATS = 7;

/**
 * The facet grid: angled shards that sweep across the frame and lock together
 * into the backdrop, in the manner of VALORANT's own end-of-match card.
 *
 * A separate layer from the slats because the geometry is different - these are
 * skewed quads on a two-dimensional grid, overlapping enough that the seams
 * close as they land. Deliberately modest counts: the shapes have to be big
 * enough to read as shapes at 50 frames, and 24 animated layers is already more
 * compositing than the rest of the package put together.
 */
export const FACET_COLS = 8;
export const FACET_ROWS = 3;

/**
 * The prism lattice: the same idea as the facets, drawn as VALORANT draws it.
 *
 * Diamonds rather than leaning quads, each one outlined and lit in the accent
 * colour, spinning up out of nothing in rings from the middle of the frame.
 * Symmetry is the point - a diagonal cascade reads as a wipe with texture, where
 * rings expanding from the centre read as the frame being built.
 *
 * The geometry is a rotated square grid, which tiles exactly: a diamond whose
 * bounding box is PRISM_SIZE shares each of its four edges with a neighbour when
 * the rows step half a box vertically and every other row is offset half a box
 * across. So the lattice really is the backdrop once it lands, rather than a
 * pattern laid over one.
 *
 * PRISM_SIZE trades the look against the tile count, and only against the tile
 * count. Total painted area barely moves - the tiles cover the frame whatever
 * size they are, and the glow adds a fixed margin each - so what grows as they
 * get smaller is the number of composited layers, not the memory. 280px is
 * around 90 of them and seven across the frame, which matches the shape of the
 * reference; going much finer buys detail nobody can see at 50 frames and costs
 * draw calls in a browser source sitting next to a game capture.
 */
export const PRISM_SIZE = 280;
export const PRISM_COLS = Math.ceil(1920 / PRISM_SIZE) + 2;
export const PRISM_ROWS = Math.ceil(1080 / (PRISM_SIZE / 2)) + 2;

/** How many rings the lattice arrives in - tiles the same distance out land together. */
export const PRISM_RINGS = 6;

/**
 * The pulse opening: rings of neon thrown out from the middle of the frame, with
 * the backdrop opening as a circle behind the last of them.
 *
 * Three is not a shy number, it is the readable one. Each ring has to be clear
 * of the one before it to read as a pulse rather than as a thick blurred edge,
 * and at a 760ms opening there is only room for three that are far enough apart.
 */
export const PULSE_RINGS = 3;

/**
 * How many stagger steps each opening has. The server times auto-advance off
 * this, so an opening that arrives in pieces has to declare how many.
 *
 * Slat openings fan out from the middle, so seven slats are four steps, not
 * seven. Facets cascade diagonally, so they are as many steps as the longest
 * diagonal. The single-gesture openings are one step by definition.
 */
export const OPENING_STEPS = {
  sweep: 1,
  impact: 1,
  streak: 1,
  shards: Math.ceil(OPENING_SLATS / 2),
  blinds: Math.ceil(OPENING_SLATS / 2),
  facets: FACET_COLS + FACET_ROWS - 1,
  prism: PRISM_RINGS,
  pulse: PULSE_RINGS,
};

// --------------------------------------------------------------- sequence ---

/**
 * type: choice - one of `options`
 *       ms     - a duration in milliseconds
 *       px     - a distance in pixels on the 1920x1080 stage
 *       bool   - a toggle
 */
export const SEQ_FIELDS = [
  { key: 'opening', type: 'choice', options: WINNER_OPENINGS, group: 'Motion', label: 'Opening', default: 'shards' },
  { key: 'transition', type: 'choice', options: WINNER_TRANSITIONS, group: 'Motion', label: 'Scene change', default: 'push' },
  { key: 'easing', type: 'choice', options: ANIM_EASINGS, group: 'Motion', label: 'Easing', default: 'out' },
  { key: 'travel', type: 'px', min: 0, max: 1920, group: 'Motion', label: 'Travel (px, push + zoom)', default: 240 },
  // Openings that arrive in pieces stagger those pieces. Small numbers read as
  // one object breaking apart; large ones read as several objects arriving.
  { key: 'openStaggerMs', type: 'ms', min: 0, max: 400, group: 'Motion', label: 'Opening stagger (ms)', default: 48 },

  // The overlay covers the whole frame, so its entry is longer than the
  // scoreboard's - a wipe across 1920px at 300ms reads as a glitch.
  { key: 'inMs', type: 'ms', min: 60, max: 4000, group: 'Timing', label: 'Overlay in (ms)', default: 760 },
  { key: 'outMs', type: 'ms', min: 60, max: 4000, group: 'Timing', label: 'Overlay out (ms)', default: 560 },
  { key: 'stageMs', type: 'ms', min: 60, max: 4000, group: 'Timing', label: 'Scene change (ms)', default: 620 },
  { key: 'staggerMs', type: 'ms', min: 0, max: 400, group: 'Timing', label: 'Stagger per band (ms)', default: 70 },

  { key: 'mapHoldMs', type: 'ms', min: 200, max: 600000, group: 'Holds', label: 'Hold on map (ms)', default: 3000 },
  { key: 'scoreHoldMs', type: 'ms', min: 200, max: 600000, group: 'Holds', label: 'Hold on score (ms)', default: 4500 },
  { key: 'winnerHoldMs', type: 'ms', min: 200, max: 600000, group: 'Holds', label: 'Hold on winner (ms)', default: 5000 },

  {
    key: 'autoAdvance',
    type: 'bool',
    group: 'Behaviour',
    label: 'Advance through the scenes on its own',
    default: true,
  },
  // Off means the winner scene stays up until Stop, which is what an operator
  // wants when the graphic is holding under a caster outro of unknown length.
  { key: 'exitAtEnd', type: 'bool', group: 'Behaviour', label: 'Take it off after the last scene', default: true },
  {
    key: 'animateOnLoad',
    type: 'bool',
    group: 'Behaviour',
    label: 'Play from the start when a browser source loads',
    default: true,
  },
];

export const SEQ_KEYS = SEQ_FIELDS.map((field) => field.key);
export const SEQ_GROUPS = [...new Set(SEQ_FIELDS.map((field) => field.group))];

export const DEFAULT_SEQ = {
  active: false,
  stage: 0,
  restart: false,
  // Part of the command channel rather than the audio config, because whether
  // the music is running is a thing an operator changes during a show, and
  // `keepPlaying` means it does not always follow `active`.
  music: false,
  cue: 0,
  ...Object.fromEntries(SEQ_FIELDS.map((field) => [field.key, field.default])),
};

/**
 * Is this cue the overlay arriving, rather than one scene replacing another?
 * Decides which duration applies, so the page and the server must both use it.
 */
export const isOverlayEntry = (seq) => Boolean(seq?.restart) && (seq?.stage ?? 0) === 0;

// ------------------------------------------------------------------ style ---

/**
 * type: hex   - a colour
 *       ratio - 0..1
 *       bool  - a toggle
 *       font  - one of FONT_CHOICES from preset-schema.js
 */
/**
 * Where the event mark lives.
 *
 * `scenes` lists which scenes carry it as a band of their own - arriving on that
 * scene's stagger, above the headline, and leaving with it. That is the whole
 * point of putting it in a scene rather than in the corner: the result card
 * carries the event's mark, instead of the mark simply being on screen while a
 * result happens.
 *
 * `corner` is the station ident: one fixed mark above all three scenes, no
 * stagger, no band. It is still only there while the sequence is - this overlay
 * has no life of its own between cues, so a logo hanging over the game feed
 * off air is a bug rather than an ident.
 *
 * An empty `scenes` list therefore means "not a band anywhere", which is true of
 * both the corner mark and no mark at all.
 */
export const EVENT_LOGO_PLACEMENTS = [
  { key: 'result', label: 'Winner and score scenes', scenes: ['winner', 'score'] },
  { key: 'winner', label: 'Winner scene only', scenes: ['winner'] },
  { key: 'score', label: 'Score scene only', scenes: ['score'] },
  { key: 'map', label: 'Map scene only', scenes: ['map'] },
  { key: 'corner', label: 'Top corner, every scene', scenes: [] },
  { key: 'hidden', label: 'Not shown', scenes: [] },
];

export const EVENT_LOGO_PLACEMENT_KEYS = EVENT_LOGO_PLACEMENTS.map((entry) => entry.key);

/** Which scenes a placement puts the mark inside, as a band. */
export const eventLogoScenes = (placement) =>
  EVENT_LOGO_PLACEMENTS.find((entry) => entry.key === placement)?.scenes ?? [];

/** Does this scene carry the event mark? Needs a logo as well as a placement. */
export const eventLogoInScene = (state, stageKey) =>
  Boolean(state?.eventLogo) && eventLogoScenes(state?.style?.eventLogoPlacement).includes(stageKey);

/**
 * What the backdrop is made of, over and above a flat colour and a blurred map.
 *
 * A blurred splash is smooth by definition, and smooth reads as empty at
 * broadcast bitrates - large flat areas are exactly what an encoder throws away,
 * so the background of the score line can end up looking like a gradient with
 * banding in it. A little structure gives the encoder something to hold on to
 * and the eye something to sit on.
 */
export const WINNER_TEXTURES = [
  { key: 'none', label: 'Nothing' },
  { key: 'lattice', label: 'Neon lattice' },
  { key: 'image', label: 'Uploaded image' },
];

export const WINNER_TEXTURE_KEYS = WINNER_TEXTURES.map((entry) => entry.key);

/**
 * How the texture meets what is behind it.
 *
 * Screen is the default, and the reason is arithmetic rather than taste. What
 * the texture sits on is a splash blurred and then dimmed to under a quarter -
 * so it is nearly black, and every blend that respects the darks (overlay, soft
 * light, multiply) has almost nothing to work with and the lattice vanishes.
 * Screen only ever lightens, which is also what neon does.
 *
 * The others are worth keeping for the cases that invert this: a light backdrop
 * colour, the plate turned off, or a texture that is meant to read as a picture
 * on the backdrop rather than as light on it.
 */
export const TEXTURE_BLENDS = [
  { key: 'screen', label: 'Screen - only lightens' },
  { key: 'overlay', label: 'Overlay - follows the picture' },
  { key: 'soft-light', label: 'Soft light - gentler' },
  { key: 'multiply', label: 'Multiply - only darkens' },
  { key: 'normal', label: 'Straight over' },
];

export const TEXTURE_BLEND_KEYS = TEXTURE_BLENDS.map((entry) => entry.key);

export const WINNER_STYLE_FIELDS = [
  { key: 'font', type: 'font', group: 'Typeface', label: 'Font', default: 'Gabarito' },

  {
    key: 'eventLogoPlacement',
    type: 'choice',
    options: EVENT_LOGO_PLACEMENTS,
    group: 'Typeface',
    label: 'Event logo',
    default: 'result',
  },

  { key: 'bg', type: 'hex', group: 'Backdrop', label: 'Backdrop colour', default: '#0b0f14' },
  // Kept as a knob even though the overlay is meant to be opaque: dropping it
  // turns the whole sequence into a tint over the live feed, which is a
  // different look some directors want for the score line.
  { key: 'bgOpacity', type: 'ratio', group: 'Backdrop', label: 'Backdrop opacity', default: 1 },
  { key: 'scrim', type: 'ratio', group: 'Backdrop', label: 'Darken the map splash', default: 0.55 },

  // The splash is one plate that lives behind the whole sequence rather than a
  // picture belonging to the first scene, so it can stay put and simply go soft
  // as the score line and the winner come up over it.
  {
    key: 'plateBehind',
    type: 'bool',
    group: 'Map plate',
    label: 'Keep the map behind the score and winner scenes',
    default: true,
  },
  { key: 'plateBlur', type: 'px', min: 0, max: 60, group: 'Map plate', label: 'Blur behind them (px)', default: 22 },
  { key: 'plateDim', type: 'ratio', group: 'Map plate', label: 'Darken behind them', default: 0.78 },

  // Sits above the plate and below the text, on for the whole sequence rather
  // than switching in behind the score line. A texture that arrives partway
  // through is a second animation nobody asked for; one that is simply there is
  // a finish on the backdrop.
  { key: 'texture', type: 'choice', options: WINNER_TEXTURES, group: 'Texture', label: 'Texture', default: 'lattice' },
  { key: 'textureImage', type: 'media', group: 'Texture', label: 'Texture image', default: '' },
  {
    key: 'textureBlend',
    type: 'choice',
    options: TEXTURE_BLENDS,
    group: 'Texture',
    label: 'How it blends',
    default: 'screen',
  },
  // Deliberately small. This is a finish, and the moment it is legible as a
  // pattern it is competing with the team name.
  { key: 'textureOpacity', type: 'ratio', group: 'Texture', label: 'Strength', default: 0.15 },
  {
    key: 'textureScale',
    type: 'px',
    min: 40,
    max: 800,
    group: 'Texture',
    label: 'Size (px - lattice cell, or tile)',
    default: 190,
  },
  { key: 'textureTile', type: 'bool', group: 'Texture', label: 'Repeat the image instead of filling the frame', default: false },

  {
    key: 'showUpcoming',
    type: 'bool',
    group: 'Upcoming maps',
    label: 'Fade the maps that have not been played',
    default: true,
  },
  { key: 'upcomingDim', type: 'ratio', group: 'Upcoming maps', label: 'How faded', default: 0.42 },

  { key: 'text', type: 'hex', group: 'Colour', label: 'Primary text', default: '#ffffff' },
  { key: 'dimText', type: 'hex', group: 'Colour', label: 'Secondary text', default: '#93a4b5' },
  { key: 'accent', type: 'hex', group: 'Colour', label: 'Accent', default: '#ff4655' },
  { key: 'panel', type: 'hex', group: 'Colour', label: 'Score row fill', default: '#161d26' },

  {
    key: 'useTeamColour',
    type: 'bool',
    group: 'Options',
    label: 'Use the winning team’s own colour as the accent',
    default: true,
  },
  { key: 'uppercase', type: 'bool', group: 'Options', label: 'Uppercase all text', default: true },
  { key: 'showMapSplash', type: 'bool', group: 'Options', label: 'Show the map splash', default: true },
  { key: 'showRegion', type: 'bool', group: 'Options', label: 'Show team regions', default: true },
];

export const WINNER_STYLE_KEYS = WINNER_STYLE_FIELDS.map((field) => field.key);
export const WINNER_STYLE_GROUPS = [...new Set(WINNER_STYLE_FIELDS.map((field) => field.group))];

export const DEFAULT_WINNER_STYLE = Object.fromEntries(
  WINNER_STYLE_FIELDS.map((field) => [field.key, field.default]),
);

// ------------------------------------------------------------------ music ---

/**
 * The music bed, in three levels rather than one.
 *
 * A sting that plays flat under the whole sequence fights the caster all the way
 * through it. What a show actually wants is a bed under the map and score cards,
 * a lift when the winner lands, and then a retreat to something the talk can sit
 * on top of - which is why there are three volumes and a delay, not a slider.
 *
 * `track` is not in this list because it is a media URL rather than a number and
 * the dashboard gives it the same upload-or-paste control the logos get.
 */
export const AUDIO_FIELDS = [
  { key: 'enabled', type: 'bool', group: 'Music', label: 'Play music with the sequence', default: false },
  { key: 'loop', type: 'bool', group: 'Music', label: 'Loop the track', default: true },
  // Off means Stop takes the music with the graphic. On leaves it running at the
  // ambient level under whatever comes next, until Fade music.
  {
    key: 'keepPlaying',
    type: 'bool',
    group: 'Music',
    label: 'Keep it running after the graphic comes off',
    default: false,
  },

  { key: 'bedVolume', type: 'ratio', group: 'Levels', label: 'Before the winner lands', default: 0.55 },
  { key: 'peakVolume', type: 'ratio', group: 'Levels', label: 'On the winner scene', default: 0.85 },
  // One number for every quiet part of the show, and that is not a shortcut: it
  // is the same situation each time. Before Activate the music is under an
  // operator still setting up; on the score line it is under a result being
  // explained; after the graphic leaves it is under whatever follows.
  {
    key: 'ambientVolume',
    type: 'ratio',
    group: 'Levels',
    label: 'After the winner, and before it starts',
    default: 0.2,
  },

  { key: 'fadeInMs', type: 'ms', min: 0, max: 20000, group: 'Fades', label: 'Fade in (ms)', default: 900 },
  { key: 'fadeOutMs', type: 'ms', min: 0, max: 20000, group: 'Fades', label: 'Fade out (ms)', default: 1400 },
  { key: 'rampMs', type: 'ms', min: 0, max: 20000, group: 'Fades', label: 'Level change (ms)', default: 900 },
  {
    key: 'settleAfterMs',
    type: 'ms',
    min: 0,
    max: 600000,
    group: 'Fades',
    label: 'Settle to ambient (ms after the winner lands)',
    default: 6000,
  },
];

export const AUDIO_KEYS = AUDIO_FIELDS.map((field) => field.key);
export const AUDIO_GROUPS = [...new Set(AUDIO_FIELDS.map((field) => field.group))];

export const DEFAULT_AUDIO = {
  track: '',
  ...Object.fromEntries(AUDIO_FIELDS.map((field) => [field.key, field.default])),
};

// ---------------------------------------------------------------- content ---

/** The headline strings, so the dashboard builds these rather than hard-coding them. */
export const WINNER_TEXT_FIELDS = [
  { key: 'mapKicker', max: 24, label: 'Map kicker', placeholder: 'MAP 3', stage: 'map' },
  { key: 'mapHeadline', max: 32, label: 'Map headline', placeholder: 'MAP COMPLETE', stage: 'map' },
  { key: 'scoreHeadline', max: 32, label: 'Score headline', placeholder: 'SERIES SCORE', stage: 'score' },
  // Blank means the row is only faded, with no words on it - which is the right
  // answer for a Bo5 listing two maps nobody has any intention of naming yet.
  { key: 'upcomingLabel', max: 16, label: 'Unplayed map note', placeholder: 'UPCOMING', stage: 'score' },
  { key: 'deciderLabel', max: 16, label: 'Last unplayed map note', placeholder: 'DECIDER', stage: 'score' },
  { key: 'winnerHeadline', max: 32, label: 'Winner kicker', placeholder: 'WINNER', stage: 'winner' },
  { key: 'winnerSubtitle', max: 48, label: 'Winner subtitle', placeholder: 'Advances to the grand final', stage: 'winner' },
];

const emptyTeam = () => ({ teamId: '', name: '', shortName: '', region: '', logo: '', colour: '#ff4655', score: 0 });

const emptyMapRow = () => ({ name: '', left: 0, right: 0 });

export const DEFAULT_WINNER = {
  version: 1,
  eventLogo: '',

  mapName: 'Ascent',
  mapImage: '',
  mapKicker: '',
  mapHeadline: 'MAP COMPLETE',
  scoreHeadline: 'SERIES SCORE',
  winnerHeadline: 'WINNER',
  winnerSubtitle: '',
  upcomingLabel: 'UPCOMING',
  deciderLabel: 'DECIDER',

  left: { ...emptyTeam(), name: 'Team A', shortName: 'TMA', colour: '#4ea8de', score: 2 },
  right: { ...emptyTeam(), name: 'Team B', shortName: 'TMB', colour: '#ff4655', score: 1 },

  // Always exactly WINNER_MAP_ROWS. Blank-named rows are skipped at render, so
  // a Bo3 is a Bo5 with two rows left empty rather than a different shape.
  maps: Array.from({ length: WINNER_MAP_ROWS }, emptyMapRow),

  // 'auto' reads the series score. An explicit side is an override for the case
  // where the trophy does not follow the number on screen.
  winner: 'auto',

  seq: { ...DEFAULT_SEQ },
  style: { ...DEFAULT_WINNER_STYLE },
  audio: { ...DEFAULT_AUDIO },
};

export const WINNER_SIDE_CHOICES = [
  { key: 'auto', label: 'From the series score' },
  { key: 'left', label: 'Left team' },
  { key: 'right', label: 'Right team' },
];

// -------------------------------------------------------------- derivation ---

/** Map rows an operator has actually filled in - a blank name means "unused". */
export const activeMaps = (state) => (state?.maps ?? []).filter((row) => String(row?.name ?? '').trim());

/**
 * A listed map nobody has played yet.
 *
 * 0-0 is the tell, and it is a safe one: VALORANT has no scoreline where both
 * sides finish on nothing, so a listed map still sitting on zeroes is a map that
 * has not happened. That means the whole feature needs no extra field for an
 * operator to keep in step with the scores - filling the scores in is what marks
 * the map played.
 */
export const isUpcomingMap = (row) =>
  Boolean(String(row?.name ?? '').trim()) && (row?.left ?? 0) === 0 && (row?.right ?? 0) === 0;

/**
 * What to write on each unplayed map, keyed by its index in `maps`.
 *
 * The last listed map gets the decider wording, but only once something before
 * it has been played: a decider is the map that settles a series already under
 * way, and calling map one of a Bo3 the decider is just wrong. Everything else
 * unplayed gets the ordinary note.
 *
 * An empty string is a real answer - the row is still faded, it simply has no
 * words on it.
 */
export function upcomingNotes(state) {
  if (!state?.style?.showUpcoming) return {};

  const rows = state?.maps ?? [];
  const listed = rows.map((row, index) => ({ row, index })).filter(({ row }) => String(row?.name ?? '').trim());
  if (!listed.length) return {};

  const last = listed[listed.length - 1].index;
  const anyPlayed = listed.some(({ row }) => !isUpcomingMap(row));

  const notes = {};
  for (const { row, index } of listed) {
    if (!isUpcomingMap(row)) continue;
    const decider = index === last && anyPlayed;
    notes[index] = String((decider ? state.deciderLabel : state.upcomingLabel) ?? '').trim();
  }
  return notes;
}

/**
 * Which side lifts the trophy. Ties resolve to the left rather than to nothing:
 * a blank winner scene on air is worse than one the operator can see is wrong
 * and override, and the dashboard shows what 'auto' resolved to.
 *
 * @returns {'left'|'right'}
 */
export function resolveWinner(state) {
  if (state?.winner === 'left' || state?.winner === 'right') return state.winner;
  return (state?.right?.score ?? 0) > (state?.left?.score ?? 0) ? 'right' : 'left';
}

/**
 * How many staggered bands a scene reveals. The server needs this to time
 * auto-advance without a browser; winner.js counts its own DOM and warns if the
 * two ever disagree.
 */
export function stageBands(state, stageKey) {
  // The event mark is a band only when it has been placed inside this scene -
  // the corner ident is not one, and neither is a placement with no logo behind it.
  const mark = eventLogoInScene(state, stageKey) ? 1 : 0;

  switch (stageKey) {
    // kicker + map name, then the headline. The splash is not counted: it is a
    // plate behind the whole sequence now, so it arrives with the overlay rather
    // than taking a stagger step of its own.
    case 'map':
      return 2 + mark;
    // headline, the two teams and the series number, then one row per map
    case 'score':
      return 2 + activeMaps(state).length + mark;
    // kicker and team name, plus the crest and the subtitle when there are any.
    // Both collapse rather than reserving space: a 300px hole where a logo was
    // not uploaded pushes the whole composition off centre.
    default: {
      const champion = state?.[resolveWinner(state)] ?? {};
      return (
        2 + mark + (champion.logo ? 1 : 0) + (String(state?.winnerSubtitle ?? '').trim() ? 1 : 0)
      );
    }
  }
}

/**
 * How long the opening takes end to end: the backdrop's own move, plus however
 * long the last slat is held back when the opening arrives in pieces.
 */
export const openingMs = (seq) =>
  (seq?.inMs ?? 0) + Math.max(0, (OPENING_STEPS[seq?.opening] ?? 1) - 1) * (seq?.openStaggerMs ?? 0);

/**
 * How long the first scene's bands wait for the opening before they start
 * arriving. Content that appears the instant the backdrop moves looks like it
 * was already there and got uncovered; a little under half an opening and it
 * looks like the opening brought it.
 */
const ENTRY_LEAD = 0.45;

export const bandLeadMs = (seq, first) => (first ? Math.round(openingMs(seq) * ENTRY_LEAD) : 0);

/**
 * How long from cueing a scene to it being finished - the backdrop and the band
 * stagger run at the same time, so it is settled when the later of the two
 * lands. The first scene after Activate arrives with the overlay itself, which
 * is what `first` selects.
 */
export function stageEnterMs(seq, bands, first = false) {
  const bandsEnd =
    bandLeadMs(seq, first) + (seq?.stageMs ?? 0) + Math.max(0, bands - 1) * (seq?.staggerMs ?? 0);
  return Math.max(first ? openingMs(seq) : 0, bandsEnd);
}

/** Total run time of an unattended sequence, for the dashboard's readout. */
export function sequenceRunMs(state) {
  const seq = state?.seq ?? DEFAULT_SEQ;
  let total = 0;
  WINNER_STAGES.forEach((stage, index) => {
    total += stageEnterMs(seq, stageBands(state, stage.key), index === 0) + (seq[stage.hold] ?? 0);
  });
  return total + (seq.exitAtEnd ? seq.outMs ?? 0 : 0);
}
