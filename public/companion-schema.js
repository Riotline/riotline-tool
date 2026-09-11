/**
 * The Companion control channel's contract, defined once.
 *
 * Imported by BOTH sides, like every other schema here: `companion.js` keys its
 * implementations off this list and refuses to start if the two disagree, and
 * the Account tab renders the operator's setup tables straight out of it. An op
 * that exists in one place and not the other is a build error rather than a
 * support question.
 *
 * ---------------------------------------------------------------------------
 * Why the variable list is written down at all
 * ---------------------------------------------------------------------------
 *
 * Because of what Companion's generic WebSocket module actually does with an
 * inbound message, which is much less than it sounds like:
 *
 *   - It does NOT enumerate the JSON and invent variables. Nothing is
 *     auto-discovered. The operator adds one "Update variable with value from
 *     WebSocket message" feedback per variable they want, and types two things
 *     into it: a JSON path, and the variable name to put it in.
 *   - The path separator is a DOT. (The module's own shipped HELP.md shows
 *     `root/1/name` with slashes. That is wrong - it splits on `.` - and an
 *     operator following the help gets a variable that never updates.)
 *   - A path that matches nothing leaves the variable at its previous value.
 *     Silently. So a wrong path and a working one look identical until the
 *     state changes and the button does not.
 *
 * Three consequences that shaped everything below:
 *
 *   1. **Every variable costs the operator a hand-typed feedback**, so the
 *      names have to be right first time. Hence a table in the dashboard,
 *      generated from this file, rather than prose anybody can mistype.
 *   2. **The payload is flat, one segment deep.** Nesting would buy nothing -
 *      there is no flattening to help - and would make every path longer to
 *      type. `winner_scene` is the whole path.
 *   3. **No key may contain a dot**, ever. `a.b` is unreachable: the module
 *      would read it as `a` then `b`.
 *
 * A miss leaving the old value is also what makes the per-graphic targeting in
 * the requirement safe: a winner-only message cannot blank the scoreboard's
 * variables, because their paths simply do not appear in it.
 */

/** Bumped if the message shape ever changes incompatibly. Sent in `hello`. */
export const COMPANION_PROTOCOL = 1;

/**
 * `kind` decides how a value is sent and how the table describes it.
 *
 *   lamp   a true/false. Sent twice - as a real JSON boolean under the name,
 *          and as 1/0 under `<name>_n`. Not redundancy: Companion's "Check
 *          value" feedback compares `=` and `!=` as *strings after coercion*,
 *          so whether a boolean arrives as `true` or as something else depends
 *          on a rendering step outside this server's control. `_n` is the one
 *          that is certain, and it is what the button colour should use.
 *   number arithmetic works, and `>` / `<` comparisons in a feedback work.
 *   text   for a button legend.
 */
export const COMPANION_GRAPHICS = [
  {
    key: 'scoreboard',
    label: 'Scoreboard',
    note: 'The post-match scoreboard - the Graphics dashboard tab.',
    ops: [
      { key: 'show', label: 'Show', help: 'Put it on air and play the entry.' },
      { key: 'hide', label: 'Hide', help: 'Take it off, playing the exit.' },
      { key: 'toggle', label: 'Toggle', help: 'Whichever of the two would change something.' },
      { key: 'replay', label: 'Replay entry', help: 'Play the entry again from the start, on air or not.' },
      { key: 'swap', label: 'Swap sides', help: 'Move everything to the other side - names, logos, rosters and scores. Colours stay put; they belong to the design, not the teams.' },
      {
        key: 'swapNames',
        label: 'Swap names',
        help: 'Move only the names, logos and library links. Rosters and scores stay where the import put them - which is the usual fix after a map where the orgs changed ends.',
      },
      { key: 'sort', label: 'Sort by ACS', help: 'Re-order both rosters, so the top player becomes the MVP.' },
      { key: 'reset', label: 'Reset', help: 'Clear every field back to defaults. There is no confirmation on a button press.', danger: true },
    ],
    variables: [
      { key: 'visible', kind: 'lamp', label: 'On air' },
      { key: 'air', kind: 'text', label: '"ON AIR" or "OFF", for a legend' },
      { key: 'cue', kind: 'number', label: 'Cue counter - changes on every transport press' },
      { key: 'map', kind: 'text', label: 'Map name' },
      { key: 'left', kind: 'text', label: 'Left team name' },
      { key: 'right', kind: 'text', label: 'Right team name' },
      { key: 'left_score', kind: 'number', label: 'Left rounds won' },
      { key: 'right_score', kind: 'number', label: 'Right rounds won' },
      { key: 'score', kind: 'text', label: 'Both, as "13-5"' },
      { key: 'auto_hide_ms', kind: 'number', label: 'Auto-hide delay, 0 if off' },
    ],
  },

  {
    key: 'winner',
    label: 'Winner graphic',
    note: 'The end-of-map sequence. Three scenes, driven by Next or by auto-advance.',
    ops: [
      { key: 'activate', label: 'Activate', help: 'Bring the overlay on at scene 1, starting the music if a track is loaded.' },
      { key: 'stop', label: 'Stop', help: 'Take the sequence off. The music goes too unless "keep playing" is set.' },
      { key: 'toggle', label: 'Toggle', help: 'Activate if off, stop if on.' },
      { key: 'next', label: 'Next scene', help: 'Advance one scene. Refused when off air or already on the last scene - watch winner_can_next.' },
      { key: 'prev', label: 'Previous scene', help: 'Back one scene. Refused when off air or already on the first - watch winner_can_prev.' },
      { key: 'replay', label: 'Replay', help: 'Play the sequence again from the top.' },
      {
        key: 'stage',
        label: 'Cut to scene',
        arg: 'scene number, 1 to 3',
        help: 'Jump straight to a scene, bringing the overlay on if it is off. This is the one that works cold - send {"op":"winner.stage","value":2}.',
      },
      { key: 'music', label: 'Music toggle', help: 'Start or fade the bed without touching the graphic.' },
      { key: 'musicOn', label: 'Cue music', help: 'Start the bed early, before the sequence.' },
      { key: 'musicOff', label: 'Fade music', help: 'Fade the bed out, leaving the graphic where it is.' },
      { key: 'reset', label: 'Reset', help: 'Clear every field back to defaults. There is no confirmation on a button press.', danger: true },
    ],
    variables: [
      { key: 'active', kind: 'lamp', label: 'Sequence is on air' },
      { key: 'air', kind: 'text', label: '"SCENE 2" or "OFF", for a legend' },
      { key: 'scene', kind: 'number', label: 'Current scene, 1-based' },
      { key: 'scene_count', kind: 'number', label: 'How many scenes there are' },
      { key: 'scene_key', kind: 'text', label: 'Scene id - map / winner / score' },
      { key: 'scene_label', kind: 'text', label: 'Scene name, for a legend' },
      { key: 'can_next', kind: 'lamp', label: 'Next would do something - use it to grey the button' },
      { key: 'can_prev', kind: 'lamp', label: 'Back would do something' },
      { key: 'music', kind: 'lamp', label: 'Bed is playing' },
      { key: 'auto_advance', kind: 'lamp', label: 'The sequence is running itself' },
      { key: 'team', kind: 'text', label: 'Winning team name' },
      { key: 'team_short', kind: 'text', label: 'Winning team tricode' },
      { key: 'left', kind: 'text', label: 'Left team name' },
      { key: 'right', kind: 'text', label: 'Right team name' },
      { key: 'left_score', kind: 'number', label: 'Left series score' },
      { key: 'right_score', kind: 'number', label: 'Right series score' },
      { key: 'cue', kind: 'number', label: 'Cue counter' },
    ],
  },

  {
    key: 'select',
    label: 'Agent select',
    note: 'The draft strip. Updates arrive on their own as the game client feeds picks in.',
    ops: [
      { key: 'show', label: 'Show', help: 'Put the strip on air.' },
      { key: 'hide', label: 'Hide', help: 'Take it off.' },
      { key: 'toggle', label: 'Toggle', help: 'Whichever would change something.' },
      { key: 'swap', label: 'Swap sides', help: 'Put the other five players on the left. Moves the rosters, not the typed names.' },
      { key: 'clear', label: 'Clear roster', help: 'Empty all ten cards and forget the game id. No confirmation on a button press.', danger: true },
      { key: 'clockStart', label: 'Start clock', help: 'Start - or restart - the 85 second clock from now.' },
      { key: 'clockEnd', label: 'End clock', help: 'Fill the bar and stop. Refused if the clock is not running.' },
      { key: 'reset', label: 'Reset', help: 'Clear every field back to defaults.', danger: true },
    ],
    variables: [
      { key: 'visible', kind: 'lamp', label: 'On air' },
      { key: 'air', kind: 'text', label: '"ON AIR" or "OFF"' },
      { key: 'picked', kind: 'number', label: 'How many have picked' },
      { key: 'locked', kind: 'number', label: 'How many have locked in' },
      { key: 'total', kind: 'number', label: 'Seats on the board' },
      { key: 'progress', kind: 'text', label: 'Picked over total, as "7/10"' },
      { key: 'swap', kind: 'lamp', label: 'Sides are swapped' },
      { key: 'clock_running', kind: 'lamp', label: 'Clock is counting' },
      { key: 'clock_filled', kind: 'lamp', label: 'Clock finished' },
      { key: 'clock_remaining', kind: 'number', label: 'Seconds left - ticks once a second while running' },
      { key: 'clock', kind: 'text', label: 'Seconds left as "1:07", blank when stopped' },
      { key: 'scene', kind: 'text', label: 'What the game client last reported' },
      { key: 'in_agent_select', kind: 'lamp', label: 'The client says it is in agent select' },
      { key: 'game_id', kind: 'text', label: 'Lobby id, when one is known' },
      { key: 'cue', kind: 'number', label: 'Cue counter' },
    ],
    /*
     * The board itself, one group per seat.
     *
     * Ten seats is thirty-odd more names in the table, and they are the point
     * of the exercise: "updates when data is being received" means the picks,
     * not a count of them. Generated rather than typed out, so the seat count
     * comes from one place.
     */
    slots: {
      count: 10,
      fields: [
        { key: 'name', kind: 'text', label: 'Player name' },
        { key: 'agent', kind: 'text', label: 'Agent, blank until they pick' },
        { key: 'locked', kind: 'lamp', label: 'Locked in' },
      ],
    },
  },
];

export const COMPANION_GRAPHIC_KEYS = COMPANION_GRAPHICS.map((entry) => entry.key);

/** Other spellings that resolve, so a reasonable guess works. */
export const COMPANION_GRAPHIC_ALIASES = {
  graphic: 'scoreboard',
  graphics: 'scoreboard',
  score: 'scoreboard',
  board: 'scoreboard',
  agentselect: 'select',
  agent: 'select',
  draft: 'select',
};

/**
 * Op spellings that resolve to a canonical one.
 *
 * Kept because the name is typed into a Companion text box by somebody who is
 * not reading this file, and a refusal there teaches nothing - the module
 * surfaces a failed send quietly. Note the deliberate asymmetry between the
 * graphics: `winner.show` is `activate` and `winner.hide` is `stop`, so the
 * same two words work on all three.
 */
export const COMPANION_OP_ALIASES = {
  scoreboard: { on: 'show', off: 'hide', start: 'show', stop: 'hide', sides: 'swap', swapsides: 'swap', names: 'swapNames', sortacs: 'sort' },
  winner: {
    show: 'activate',
    on: 'activate',
    start: 'activate',
    hide: 'stop',
    off: 'stop',
    forward: 'next',
    advance: 'next',
    back: 'prev',
    previous: 'prev',
    scene: 'stage',
    musictoggle: 'music',
  },
  select: {
    on: 'show',
    off: 'hide',
    start: 'show',
    sides: 'swap',
    swapsides: 'swap',
    clearroster: 'clear',
    startclock: 'clockStart',
    endclock: 'clockEnd',
    stopclock: 'clockEnd',
  },
};

const byKey = (key) => COMPANION_GRAPHICS.find((entry) => entry.key === key);

/**
 * Every variable one graphic publishes, flat, in the order the table shows
 * them - `_n` twins expanded, slots expanded.
 *
 * This is the single definition of the payload's key set. The projections in
 * `companion.js` are asserted against it, so the operator's table and the wire
 * cannot drift.
 *
 * @returns {{key: string, kind: string, label: string}[]}
 */
export function companionVariables(graphicKey) {
  const entry = byKey(graphicKey);
  if (!entry) return [];

  const out = [];
  const add = (key, kind, label) => {
    out.push({ key: `${entry.key}_${key}`, kind, label });
    // The certain one. See the note on `kind` above.
    if (kind === 'lamp') out.push({ key: `${entry.key}_${key}_n`, kind: 'lampNumber', label: `${label} - as 1 or 0` });
  };

  for (const field of entry.variables) add(field.key, field.kind, field.label);

  if (entry.slots) {
    for (let seat = 1; seat <= entry.slots.count; seat += 1) {
      for (const field of entry.slots.fields) add(`slot${seat}_${field.key}`, field.kind, `Seat ${seat} - ${field.label}`);
    }
  }
  return out;
}

/** Every op name a graphic answers to, canonical names only. */
export const companionOps = (graphicKey) => (byKey(graphicKey)?.ops ?? []).map((op) => op.key);
