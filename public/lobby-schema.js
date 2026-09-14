/**
 * The staged lobby: what Overwolf saw, held until an operator says it is right.
 *
 * Shared by Node and the browser, like every other `*-schema.js` here, so the
 * seat shape is defined once and the dashboard panel, the server sanitiser and
 * the GStack export cannot drift apart.
 *
 * This is deliberately *not* the agent-select store. That one is a graphic and
 * goes to air the moment a card changes; this one is a clipboard. The feed
 * writes `incoming` continuously and nothing downstream reads it until the
 * operator presses Stage - which is the same split as the cue counter, for the
 * same reason: "data arrived" and "put it out" are different signals, and a
 * tool that conflates them repaints under the operator mid-check.
 */

import { findAgent } from './select-schema.js';

/** Ten seats, because Overwolf indexes the whole lobby, not one team. */
export const LOBBY_SEATS = 10;

/** Five per side, once the UI order has been applied. */
export const LOBBY_SIDE = 5;

export const EMPTY_SEAT = Object.freeze({
  riotId: '',
  playerId: '',
  character: '',
  teammate: false,
  seen: false,
});

export const emptySeats = () => Array.from({ length: LOBBY_SEATS }, () => ({ ...EMPTY_SEAT }));

export const emptyLobby = () => ({
  /*
   * Overwolf's game id, which for VALORANT is the constant 21640.
   *
   * Kept for the record and explicitly NOT used the way ingestRoster uses it.
   * There it is a per-lobby value, so a change means a new game and the board
   * clears itself; here it never changes, so keying a reset on it would mean
   * the board never clears at all. Clearing is the operator's button instead,
   * and the panel says so - a wrong automatic reset and a missing one are both
   * mid-show surprises, but only one of them is visible.
   */
  gameId: '',
  seats: emptySeats(),
  // Agent names in the game's own on-screen order, top to bottom. Index 0 is
  // the top card. Empty until the UI-order events arrive, which they may never
  // do - see lobbySides for what happens then.
  allies: [],
  enemies: [],
  updatedAt: 0,
  // Moves on every accepted event even when nothing else does. "The hook is
  // wired up and quiet" and "the hook was never wired up" are otherwise the
  // same picture from the operator's side, at exactly the moment it matters.
  count: 0,
});

// Built from a string so no literal control character ever appears in this
// file - one invisible byte inside a character class is unreviewable in a diff.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

const clean = (value, max = 64) =>
  String(value ?? '')
    .slice(0, max)
    .replace(CONTROL, '')
    .trim();

const IDENTIFIER = /^[\w .'/-]{0,32}$/;

export function sanitiseLobbySeat(input, fallback = EMPTY_SEAT) {
  const source = input ?? {};
  const base = fallback ?? EMPTY_SEAT;
  const character = clean(source.character, 32);
  return {
    riotId: clean(source.riotId, 64),
    playerId: clean(source.playerId, 64),
    // Same guard as sanitiseSelectSlot: anything that is not a plain identifier
    // could not have come from the game, so it is not kept.
    character: IDENTIFIER.test(character) ? character : base.character,
    teammate: typeof source.teammate === 'boolean' ? source.teammate : base.teammate,
    seen: Boolean(source.seen ?? base.seen),
  };
}

/**
 * The UI-order payload, which is not JSON.
 *
 * Overwolf's own sample for this feature is `{1:"Fade",2:"Phoenix",...}` -
 * unquoted keys, which `JSON.parse` refuses. Parsing it strictly and giving up
 * would lose the one piece of information that says which card is at the top of
 * the screen, so JSON is tried first (in case a future build tightens it up)
 * and the pairs are pulled out by hand if that fails.
 *
 * Returns names in slot order with gaps preserved, because slot 3 being absent
 * means the third card is empty, not that the fourth moved up.
 *
 * @returns {string[]}
 */
export function parseTeamOrder(value) {
  if (Array.isArray(value)) return value.map((entry) => clean(entry, 32));
  if (value && typeof value === 'object') return fromPairs(Object.entries(value));

  const raw = String(value ?? '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((entry) => clean(entry, 32));
    if (parsed && typeof parsed === 'object') return fromPairs(Object.entries(parsed));
  } catch {
    /* not JSON - which is the documented shape, so this is the normal path */
  }

  return fromPairs([...raw.matchAll(/(\d+)\s*:\s*"([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function fromPairs(pairs) {
  const out = [];
  for (const [key, name] of pairs) {
    // The game numbers its cards from 1; the array is indexed from 0.
    const slot = Number.parseInt(key, 10) - 1;
    if (!Number.isFinite(slot) || slot < 0 || slot >= LOBBY_SIDE) continue;
    out[slot] = clean(name, 32);
  }
  return Array.from({ length: out.length }, (_, index) => out[index] ?? '');
}

const EMPTY_PRESENT = Object.freeze({
  riotId: '',
  playerId: '',
  character: '',
  agentName: '',
  agentUuid: '',
  filled: false,
});

const present = (seat) => ({
  riotId: seat.riotId,
  playerId: seat.playerId,
  character: seat.character,
  // Falls back to the internal name for the same reason agentLabel does:
  // "Sarge" in the panel is wrong but visible, and an operator can act on it.
  agentName: seat.entry?.name ?? seat.character,
  // Blank when the catalogue has not resolved it. The export sends the field
  // empty rather than inventing a uuid, because GStack matches on the uuid and
  // a wrong one would put the wrong portrait on air with no error anywhere.
  agentUuid: seat.entry?.uuid ?? '',
  filled: Boolean(seat.riotId || seat.character),
});

/**
 * Resolve a staged lobby into two sides of five.
 *
 * The two feeds disagree about vocabulary on purpose, which is the whole reason
 * this runs against the catalogue rather than comparing strings: the roster
 * event reports the agent's *internal* name ("Sarge"), and the UI-order event
 * has been seen to report public ones. `findAgent` accepts either, so both are
 * normalised to the same catalogue entry before they are compared - and that
 * entry carries the uuid the GStack export needs.
 *
 * Joining on the agent rather than on the player is safe because an agent is
 * unique within a team. It is also the only join available: the UI-order event
 * names agents and nothing else.
 *
 * The fallback when no UI order has arrived is `teammate`, which is how the
 * lobby looked to whichever client reported it. From an observer seat that flag
 * is arbitrary - hence the swap, which is the operator's and not a guess.
 *
 * @param {object} lobby     a lobby state
 * @param {object[]} agents  the valorant-api catalogue's agent list
 * @param {{swapped?: boolean}} options
 */
export function lobbySides(lobby, agents = [], { swapped = false } = {}) {
  const seats = (lobby?.seats ?? []).map((seat, index) => ({
    ...sanitiseLobbySeat(seat),
    index,
    entry: findAgent(agents, seat?.character),
  }));

  const key = (value) => {
    const entry = findAgent(agents, value);
    return (entry?.name ?? clean(value, 32)).toLowerCase();
  };

  /*
   * One seat may be placed once.
   *
   * Shared across both sides and both strategies, so a player the allies order
   * claimed cannot also appear on the right. Without it a duplicated agent name
   * across the two orders - which a mixed-vocabulary feed can produce - would
   * paint the same person on both teams, and two of the same face on air reads
   * as a bug in the graphic rather than in the join.
   */
  const taken = new Set();

  const byOrder = (order) =>
    Array.from({ length: LOBBY_SIDE }, (_, slot) => {
      const wanted = key(order?.[slot] ?? '');
      if (!wanted) return null;
      const seat = seats.find(
        (candidate) => !taken.has(candidate.index) && candidate.character && key(candidate.character) === wanted,
      );
      if (!seat) return null;
      taken.add(seat.index);
      return seat;
    });

  const byTeammate = (teammate) => {
    const pool = seats.filter((seat) => seat.seen && seat.teammate === teammate && !taken.has(seat.index));
    return Array.from({ length: LOBBY_SIDE }, (_, slot) => {
      const seat = pool[slot];
      if (!seat) return null;
      taken.add(seat.index);
      return seat;
    });
  };

  /*
   * The order is preferred, but never at the cost of the whole side.
   *
   * The join is only possible while the catalogue can normalise both
   * vocabularies. Without it - a cold start with no network, which the asset
   * cache is explicitly built to survive - "Fade" from the UI order and "Sarge"
   * from the roster are two unrelated strings, every slot misses, and the side
   * comes back blank. That is the worst of the three outcomes: an unordered
   * board is one swap away from correct and an operator can see what is wrong
   * with it, where an empty board looks like the feed never arrived.
   *
   * So a placement that lands nobody is rolled back and the teammate split is
   * used instead. Rolled back rather than merely ignored, because a half-tried
   * order would otherwise leave seats marked taken and starve the fallback.
   */
  let ordered = false;
  const resolve = (order, teammate) => {
    if ((order ?? []).some(Boolean)) {
      const before = new Set(taken);
      const placed = byOrder(order);
      if (placed.some(Boolean)) {
        ordered = true;
        return placed;
      }
      taken.clear();
      for (const index of before) taken.add(index);
    }
    return byTeammate(teammate);
  };

  const allies = resolve(lobby?.allies, true);
  const enemies = resolve(lobby?.enemies, false);

  const side = (list) => list.map((seat) => (seat ? present(seat) : { ...EMPTY_PRESENT }));

  return {
    left: side(swapped ? enemies : allies),
    right: side(swapped ? allies : enemies),
    // Seats the join could not place. Surfaced in the panel rather than dropped
    // silently: a player missing from the export is exactly the kind of thing
    // that is invisible until it is on air.
    unplaced: seats.filter((seat) => seat.seen && !taken.has(seat.index)).map(present),
    // Whether the game's own on-screen order was actually applied, not merely
    // received. The panel says which, because "these are in screen order" and
    // "these are in the order the client happened to report them" are different
    // promises and only one of them survives a swap.
    ordered,
  };
}

/** How much of the lobby has arrived - what the panel's pill reports. */
export function lobbyProgress(lobby) {
  const seats = lobby?.seats ?? [];
  return {
    seen: seats.filter((seat) => seat?.seen).length,
    withAgent: seats.filter((seat) => seat?.seen && seat?.character).length,
    total: LOBBY_SEATS,
  };
}
