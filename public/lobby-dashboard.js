/**
 * The Overwolf staging board.
 *
 * A clipboard, not a graphic. Shots Fired posts what the game client can see,
 * this shows it, and nothing leaves until an operator presses Stage - at which
 * point GStack's "GET JSON" can pull it. The panel exists because the two facts
 * the feed cannot get right on its own are both obvious to a human looking at
 * it: which side is which (an observer client's `teammate` flag is about the
 * reporting machine, not the broadcast) and whether the ten names are the ten
 * names. Both are one button.
 *
 * Sits on the lookup tab beside the match-id panel, which is the same shape of
 * thing: data arrives on a hook, an operator decides when it counts.
 */

import { api, outputUrl, targetKey } from './session.js';
import { onState } from './live.js';
import { lobbySides, lobbyProgress } from './lobby-schema.js';

const $ = (id) => document.getElementById(id);

const els = {
  panel: $('lobby-panel'),
  pill: $('lobby-state'),
  left: $('lobby-left'),
  right: $('lobby-right'),
  leftLabel: $('lobby-left-label'),
  rightLabel: $('lobby-right-label'),
  unplaced: $('lobby-unplaced'),
  note: $('lobby-note'),
  stage: $('lobby-stage'),
  swap: $('lobby-swap'),
  clear: $('lobby-clear'),
  hook: $('lobby-hook'),
  export: $('lobby-export'),
};

/** @type {{agents: object[]}} */
let catalogue = { agents: [] };
let latest = null;

function start() {
  void targetKey().then((key) => {
    for (const [node, path] of [
      [els.hook, '/api/lobby'],
      [els.export, '/api/gstack'],
    ]) {
      const url = outputUrl(path, key);
      node.textContent = url;
      node.title = url;
    }
  });

  // The catalogue is what turns "Sarge" into Brimstone and into the uuid GStack
  // matches on. Failing soft: without it the board still shows internal names,
  // which is wrong but visible, where an empty board looks like a dead hook.
  void fetch('/api/valorant-assets')
    .then((r) => (r.ok ? r.json() : { agents: [] }))
    .catch(() => ({ agents: [] }))
    .then((data) => {
      catalogue = data ?? { agents: [] };
      if (latest) render(latest);
    });

  els.stage.addEventListener('click', () => void control('stage'));
  els.swap.addEventListener('click', () => void control('swap'));
  els.clear.addEventListener('click', () => void control('clear'));

  onState('lobby', (next) => {
    latest = next;
    render(next);
  });

  els.panel.hidden = false;

  /*
   * Paint the empty board now rather than on the first frame.
   *
   * The stream does replay current state on connect, so this is not about
   * correctness - it is about the second or so before that lands, during which
   * the panel would be two labels and nothing else. That is the picture of a
   * hook that was never wired up, shown at exactly the moment an operator is
   * checking whether it was. Ten empty seats say "nothing has arrived yet",
   * which is the true statement and a different one.
   *
   * It also fixes the layout in place before any data exists, so the board
   * cannot grow under somebody reading it.
   */
  render(null);
}

async function control(action) {
  for (const button of [els.stage, els.swap, els.clear]) button.disabled = true;
  try {
    const response = await fetch(api('/api/lobby/control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setPill(body?.error?.message ?? 'That did not work', 'warn');
    }
  } catch (error) {
    setPill(`Offline: ${error.message}`, 'warn');
  } finally {
    // Re-enabled by the render the write provokes, but not every write provokes
    // one - a refused action leaves the state alone and would strand the row.
    syncButtons();
  }
}

function setPill(text, tone) {
  els.pill.textContent = text;
  // `pill ok` / `pill warn` - the tone is a second class on the pill, not a
  // modifier name. Getting this wrong shows as an uncoloured pill and nothing
  // else, which is exactly the kind of thing that survives a review.
  els.pill.className = `pill${tone ? ` ${tone}` : ''}`;
  els.pill.hidden = !text;
}

function render(state) {
  const incoming = state?.incoming ?? null;
  const staged = state?.staged ?? null;
  const swapped = Boolean(state?.swapped);

  /*
   * The board shows `incoming`, not `staged`.
   *
   * The operator is checking what has arrived so they can decide whether to
   * stage it; showing them the thing they already staged would make the panel
   * unresponsive to the feed at exactly the moment they are watching it fill.
   * What is staged is reported in the pill instead.
   */
  const sides = lobbySides(incoming ?? { seats: [] }, catalogue.agents ?? [], { swapped });
  const progress = lobbyProgress(incoming);

  paint(els.left, sides.left);
  paint(els.right, sides.right);

  els.leftLabel.textContent = swapped ? 'Left (was enemies)' : 'Left';
  els.rightLabel.textContent = swapped ? 'Right (was allies)' : 'Right';

  if (sides.unplaced.length) {
    els.unplaced.hidden = false;
    els.unplaced.textContent = `Not placed: ${sides.unplaced.map((p) => p.riotId || p.agentName).join(', ')}`;
  } else {
    els.unplaced.hidden = true;
  }

  els.note.textContent = sides.ordered
    ? 'Seats are in the game’s own on-screen order.'
    : 'No on-screen order yet — these are in the order the client reported them, so check the sides before staging.';

  if (!progress.seen) setPill('Waiting for the hook', '');
  else if (staged) setPill(`Staged — ${progress.seen}/10 seen`, 'ok');
  else setPill(`${progress.seen}/10 seen, not staged`, 'warn');

  syncButtons(progress.seen > 0);
}

function syncButtons(hasAnyone = lobbyProgress(latest?.incoming).seen > 0) {
  els.stage.disabled = !hasAnyone;
  els.swap.disabled = !hasAnyone;
  els.clear.disabled = !hasAnyone && !latest?.staged;
}

function paint(list, players) {
  list.replaceChildren();
  players.forEach((player, index) => {
    const row = document.createElement('li');
    row.className = `lobby-row${player.filled ? '' : ' lobby-row-empty'}`;

    const seat = document.createElement('span');
    seat.className = 'lobby-seat';
    seat.textContent = String(index + 1);

    const name = document.createElement('span');
    name.className = 'lobby-name';
    name.textContent = player.riotId || '—';
    name.title = player.riotId;

    const agent = document.createElement('span');
    agent.className = 'lobby-agent';
    agent.textContent = player.agentName || '';
    /*
     * Flagged when the catalogue could not place it, because this is the field
     * that decides whether GStack shows the right portrait: it matches on the
     * uuid, and an unresolved agent exports an empty one. Saying so here is the
     * difference between a known gap and a mystery on air.
     */
    if (player.filled && player.agentName && !player.agentUuid) {
      agent.classList.add('lobby-agent-unknown');
      agent.title = 'Not in the catalogue yet - GStack will not match this agent';
    }

    row.append(seat, name, agent);
    list.append(row);
  });
}

/*
 * Started last, after the module's own bindings exist.
 *
 * `start()` paints the empty board synchronously, and `let` bindings are in the
 * temporal dead zone until their declaration runs - so calling this from the
 * top of the file threw a ReferenceError reaching for the catalogue, killed the
 * module, and left a panel that was visible and permanently blank. Nothing in
 * the page said so; the buttons were simply always disabled.
 *
 * Not every page that loads this has the panel: the output pages share public/
 * with the dashboard.
 */
if (els.panel) start();
