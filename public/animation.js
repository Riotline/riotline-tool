/**
 * How the scoreboard gets on and off air.
 *
 * Same pattern as preset-schema.js: one ordered field list that the server
 * sanitises against and the dashboard builds its editor from, so an option
 * cannot exist in the UI and be silently dropped on the way in.
 *
 * Two things in the state are *not* config and so are not listed here:
 *
 *   visible - what the operator asked for, shown or hidden
 *   cue     - a counter bumped by every Show/Hide/Replay press
 *
 * The cue is what makes "Replay" possible at all. An output page that only
 * watched `visible` could never be told to run the entry again while already
 * shown, and every keystroke in the dashboard pushes a fresh copy of the whole
 * state - so a page keying off state changes alone would re-animate on air
 * every time somebody fixed a typo. Comparing the cue instead means the
 * animation runs when, and only when, an operator cued it.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

/**
 * The travel direction of each style is decided in CSS by the column a band
 * belongs to, not here - a band never has to know which side it is on.
 */
export const ANIM_STYLES = [
  { key: 'slide', label: 'Slide from edges' },
  { key: 'wipe', label: 'Wipe from edges' },
  { key: 'rise', label: 'Rise up' },
  { key: 'scale', label: 'Pop' },
  { key: 'fade', label: 'Fade only' },
];

export const ANIM_EASINGS = [
  // Fast out of the gate and a long settle - the curve most broadcast packages
  // use, because it reads as deliberate at 50 frames rather than springy.
  { key: 'out', label: 'Ease out (broadcast)', curve: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  { key: 'inOut', label: 'Ease in and out', curve: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  { key: 'back', label: 'Overshoot', curve: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  { key: 'linear', label: 'Linear', curve: 'linear' },
];

export const ANIM_STYLE_KEYS = ANIM_STYLES.map((entry) => entry.key);
export const ANIM_EASING_KEYS = ANIM_EASINGS.map((entry) => entry.key);

const EASING_BY_KEY = new Map(ANIM_EASINGS.map((entry) => [entry.key, entry]));

/** @returns {string} a CSS timing function - falls back to the first easing */
export const easingCurve = (key) => (EASING_BY_KEY.get(key) ?? ANIM_EASINGS[0]).curve;

/**
 * type: choice - one of `options`
 *       ms     - a duration in milliseconds
 *       px     - a distance in pixels on the 1920x1080 stage
 *       bool   - a toggle
 */
export const ANIM_FIELDS = [
  { key: 'style', type: 'choice', options: ANIM_STYLES, group: 'Motion', label: 'Animation', default: 'slide' },
  { key: 'easing', type: 'choice', options: ANIM_EASINGS, group: 'Motion', label: 'Easing', default: 'out' },
  {
    key: 'distance',
    type: 'px',
    min: 0,
    max: 800,
    group: 'Motion',
    label: 'Travel (px, slide + rise)',
    default: 110,
  },

  { key: 'durationMs', type: 'ms', min: 60, max: 4000, group: 'Timing', label: 'In duration (ms)', default: 520 },
  // Exits are shorter than entries by convention: an entry is being watched, an
  // exit is getting out of the way of whatever comes next.
  { key: 'outDurationMs', type: 'ms', min: 60, max: 4000, group: 'Timing', label: 'Out duration (ms)', default: 340 },
  { key: 'staggerMs', type: 'ms', min: 0, max: 400, group: 'Timing', label: 'Stagger per tier (ms)', default: 55 },
  { key: 'delayMs', type: 'ms', min: 0, max: 5000, group: 'Timing', label: 'Lead-in delay (ms)', default: 0 },
  {
    key: 'holdMs',
    type: 'ms',
    min: 0,
    max: 600000,
    group: 'Timing',
    label: 'Auto-hide after (ms, 0 = off)',
    default: 0,
  },

  {
    key: 'reverseOut',
    type: 'bool',
    group: 'Behaviour',
    label: 'Reverse the tier order on the way out',
    default: true,
  },
  {
    key: 'animateOnLoad',
    type: 'bool',
    group: 'Behaviour',
    label: 'Animate in when a browser source loads',
    default: true,
  },
];

export const ANIM_KEYS = ANIM_FIELDS.map((field) => field.key);
export const ANIM_GROUPS = [...new Set(ANIM_FIELDS.map((field) => field.group))];

/**
 * Stagger steps in the layout: headers, MVP panels, map/art, then one per roster
 * row. Which elements are in which tier is a DOM question and lives in
 * output.js; only the count is needed here, so the server can work out how long
 * an entry takes without a browser. output.js warns if the two disagree.
 */
export const ANIM_TIER_COUNT = 7;

/**
 * Shown by default: a fresh install that came up blank would look broken rather
 * than look hidden.
 */
export const DEFAULT_ANIM = {
  visible: true,
  cue: 0,
  ...Object.fromEntries(ANIM_FIELDS.map((field) => [field.key, field.default])),
};

/**
 * How long from cueing an entry to the last tier settling. The server uses it to
 * time auto-hide, so "auto-hide after 8s" means eight seconds fully on screen
 * rather than eight seconds from the button press.
 *
 * @param {object} anim
 * @param {number} tiers how many stagger steps the layout has
 */
export const inDurationMs = (anim, tiers = 1) =>
  (anim?.delayMs ?? 0) + (anim?.durationMs ?? 0) + Math.max(0, tiers - 1) * (anim?.staggerMs ?? 0);
