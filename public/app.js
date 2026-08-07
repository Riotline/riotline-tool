/**
 * VALORANT Broadcast Production Tool - UI logic.
 *
 * Flow: Riot ID -> account -> match list -> match detail.
 *
 * Three interchangeable data sources, chosen with the "Data source" toggle:
 *   henrik   - HenrikDev unofficial API (default; custom games, no production key)
 *   riot     - official Riot Games API (needs a production key for match data)
 *   tracker  - tracker.gg / Tracker Network
 *
 * The server normalises both into one shape, so everything below renders
 * either source without branching on the provider.
 */

import { setLookupMatch } from './store.js';
import {
  WATCH_MAX,
  freshMatch,
  isPermanentFailure,
  mapLimit,
  parseHandles,
  reserveSlot,
  scoreboardReady,
} from './watch-core.js';

// ------------------------------------------------------------ elements ---

const $ = (id) => document.getElementById(id);

const els = {
  form: $('search-form'),
  riotId: $('riot-id'),
  searchBtn: $('search-btn'),
  routingBlock: $('riot-routing'),
  routing: $('routing'),
  region: $('region'),
  henrikBlock: $('henrik-routing'),
  affinity: $('affinity'),
  platform: $('platform'),
  typeField: $('type-field'),
  matchType: $('match-type'),
  keyWarning: $('key-warning'),
  playerCard: $('player-card'),
  playerName: $('player-name'),
  playerPuuidRow: $('player-puuid-row'),
  playerPuuid: $('player-puuid'),
  matchList: $('match-list'),
  matchCount: $('match-count'),
  details: $('match-details'),
  copyJson: $('copy-json'),
  downloadJson: $('download-json'),
  toast: $('toast'),
  watchIds: $('watch-ids'),
  watchBtn: $('watch-btn'),
  watchStatus: $('watch-status'),
  watchState: $('watch-state'),
  watchLog: $('watch-log'),
  watchLogBox: $('watch-log-box'),
  watchLogCount: $('watch-log-count'),
  watchLogCopy: $('watch-log-copy'),
  watchNow: $('watch-now'),
};

const state = {
  config: null,
  provider: 'henrik',
  account: null,
  handle: null,
  matches: [],
  selectedMatchId: null,
  selectedMatch: null,
};

const provider = () => document.querySelector('input[name="provider"]:checked')?.value ?? 'henrik';

// ------------------------------------------------------------- helpers ---

/** Build an element. Text always goes in via textContent - nothing is injected as HTML. */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

function showLoading(node, label) {
  node.replaceChildren(el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), el('span', { text: label })]));
}

function showError(node, error) {
  const box = el('p', { class: 'error' }, [el('strong', { text: `Error ${error.status ?? ''}`.trim() })]);
  box.append(document.createTextNode(error.message ?? 'Something went wrong.'));
  if (error.hint) box.append(el('span', { class: 'hint', text: error.hint }));
  node.replaceChildren(box);
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

// The graphics tab shares this toast rather than growing its own.
window.addEventListener('app-toast', (event) => toast(String(event.detail ?? '')));

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    throw payload.error ?? { status: response.status, message: `Request failed (HTTP ${response.status}).` };
  }
  return payload;
}

const titleCase = (value) =>
  String(value ?? '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

function formatDateTime(millis) {
  if (!millis) return 'Unknown date';
  return new Date(millis).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(millis) {
  if (!millis) return '-';
  const totalSeconds = Math.round(millis / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

const sideClass = (teamId) => {
  const side = String(teamId ?? '').toLowerCase();
  return side === 'red' || side === 'blue' ? side : '';
};

// -------------------------------------------------------------- config ---

async function loadConfig() {
  try {
    const config = await api('/api/config');
    state.config = config;

    for (const [select, values, selected] of [
      [els.routing, config.routings, config.routing],
      [els.region, config.regions, config.region],
      [els.affinity, config.affinities, config.affinity],
      [els.platform, config.platforms, config.platform],
    ]) {
      select.replaceChildren(
        ...values.map((value) => el('option', { value, text: value.toUpperCase(), selected: value === selected })),
      );
      select.value = selected;
    }

    const radio = document.querySelector(`input[name="provider"][value="${config.provider}"]`);
    if (radio) radio.checked = true;

    syncProviderUi();
  } catch {
    els.matchList.replaceChildren(el('p', { class: 'empty', text: 'Could not reach the local server.' }));
  }
}

const PROVIDER_LABELS = { henrik: 'HenrikDev', riot: 'Riot API', tracker: 'tracker.gg' };

const KEY_WARNINGS = {
  henrik: [
    'No HenrikDev key loaded. ',
    'Set HENRIK_API_KEY in .env - free keys come from the HenrikDev Discord - then restart.',
  ],
  riot: ['No Riot API key loaded. ', 'Set RIOT_API_KEY in .env, then restart the server.'],
  tracker: [
    'tracker.gg source is disabled. ',
    'It drives a real browser (the site is Cloudflare-protected and loads matches by XHR). ' +
      'Set TRACKER_ENABLED=true in .env and make sure Playwright is installed, then restart. No API key needed.',
  ],
};

/** Show only the controls the selected source uses, and warn about a missing key. */
function syncProviderUi() {
  const current = provider();
  state.provider = current;

  const config = state.config;
  if (!config) return;

  // Riot's matchlist has no mode filter; the other two do.
  const modes = current === 'henrik' ? config.henrikModes : current === 'tracker' ? config.matchTypes : null;

  els.typeField.hidden = !modes;
  els.routingBlock.hidden = current !== 'riot';
  els.henrikBlock.hidden = current !== 'henrik';

  if (modes) {
    els.matchType.replaceChildren(...modes.map((value) => el('option', { value, text: titleCase(value) })));
    els.matchType.value = modes.includes('custom') ? 'custom' : modes[0];
  }

  const hasKey = { henrik: config.hasHenrikKey, riot: config.hasRiotKey, tracker: config.hasTrackerKey }[current];
  els.keyWarning.hidden = Boolean(hasKey);

  if (!hasKey) {
    const [lead, body] = KEY_WARNINGS[current];
    els.keyWarning.replaceChildren(el('strong', { text: lead }), document.createTextNode(body));
  }
}

for (const radio of document.querySelectorAll('input[name="provider"]')) {
  radio.addEventListener('change', () => {
    syncProviderUi();
    // The watch is tuned per source and holds a baseline gathered from the old
    // one, so switching source ends it rather than silently changing its rules.
    if (watch.running) stopWatch('stopped - data source changed');
    state.matches = [];
    els.matchCount.hidden = true;
    els.playerCard.hidden = true;
    els.matchList.replaceChildren(
      el('p', { class: 'empty', text: 'Data source changed - search again to reload the match list.' }),
    );
    resetDetails();
  });
}

// -------------------------------------------------- step 1 + 2: search ---

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const riotId = els.riotId.value.trim();
  if (!riotId) return;

  const current = provider();
  state.provider = current;

  els.searchBtn.disabled = true;
  els.playerCard.hidden = true;
  resetDetails();
  showLoading(els.matchList, `Looking up player on ${PROVIDER_LABELS[current] ?? current}...`);

  try {
    const account = await api('/api/account', {
      riotId,
      provider: current,
      routing: els.routing.value,
    });

    state.account = account;
    state.handle = account.handle ?? `${account.gameName}#${account.tagLine}`;

    // HenrikDev's account response carries the player's affinity - trust it
    // over whatever the dropdown happened to be set to.
    if (current === 'henrik' && account.region) {
      const option = [...els.affinity.options].find((o) => o.value === account.region);
      if (option) els.affinity.value = account.region;
    }

    els.playerName.textContent = state.handle;
    els.playerPuuid.textContent = account.puuid ?? '';
    els.playerPuuidRow.hidden = !account.puuid;
    els.playerCard.hidden = false;

    showLoading(els.matchList, 'Loading match history...');
    const result = await api('/api/matches', {
      provider: current,
      puuid: account.puuid,
      handle: state.handle,
      region: els.region.value,
      affinity: els.affinity.value,
      platform: els.platform.value,
      type: els.matchType.value,
    });

    state.matches = result.matches ?? [];
    renderMatchList();
  } catch (error) {
    showError(els.matchList, error);
    els.matchCount.hidden = true;
  } finally {
    els.searchBtn.disabled = false;
  }
});

function renderMatchList() {
  if (!state.matches.length) {
    els.matchCount.hidden = true;
    const note = els.typeField.hidden
      ? 'No matches returned for this player.'
      : `No ${els.matchType.value} matches returned for this player.`;
    els.matchList.replaceChildren(el('p', { class: 'empty', text: note }));
    return;
  }

  els.matchCount.textContent = `${state.matches.length} match${state.matches.length === 1 ? '' : 'es'}`;
  els.matchCount.hidden = false;

  els.matchList.replaceChildren(
    ...state.matches.map((match) => {
      const heading = [match.queue, match.map].filter(Boolean).join(' - ');

      const button = el('button', { type: 'button', class: 'match-item', 'data-match-id': match.id }, [
        el('span', { class: 'match-queue', text: heading || 'Match' }),
        el('span', { class: 'match-date', text: formatDateTime(match.startedAt) }),
      ]);

      if (match.score) {
        const result = el('span', {
          class: `match-score${match.won === true ? ' win' : match.won === false ? ' loss' : ''}`,
          text: match.score,
        });
        button.append(result);
      }

      button.append(el('span', { class: 'match-id', text: match.id ?? '' }));
      button.addEventListener('click', () => selectMatch(match.id));
      return button;
    }),
  );
}

// ---------------------------------------------- step 3: match details ---

function markSelected(matchId) {
  for (const item of els.matchList.querySelectorAll('.match-item')) {
    item.setAttribute('aria-current', String(item.dataset.matchId === String(matchId)));
  }
}

/** Render a detail payload we already hold. The watch below reuses this so a
 *  found match is not fetched a second time - on tracker.gg that is another
 *  browser trip, and the whole point of the watch is speed. */
function showMatch(match, matchId) {
  state.selectedMatchId = matchId;
  state.selectedMatch = match;
  renderMatchDetails(match);
  els.copyJson.hidden = false;
  els.downloadJson.hidden = false;
  // Hand it to the graphics tab so it can be imported without re-fetching.
  setLookupMatch(match, state.handle);
}

async function selectMatch(matchId) {
  state.selectedMatchId = matchId;
  markSelected(matchId);

  resetDetails();
  showLoading(els.details, 'Pulling match details...');

  try {
    const match = await api('/api/match', {
      provider: state.provider,
      matchId,
      handle: state.handle,
      region: els.region.value,
      affinity: els.affinity.value,
      platform: els.platform.value,
      type: els.matchType.value,
    });

    if (state.selectedMatchId !== matchId) return; // a newer selection won

    showMatch(match, matchId);
  } catch (error) {
    showError(els.details, error);
  }
}

function resetDetails() {
  state.selectedMatch = null;
  setLookupMatch(null);
  els.copyJson.hidden = true;
  els.downloadJson.hidden = true;
  els.details.replaceChildren(el('p', { class: 'empty', text: 'Select a match to pull its full detail payload.' }));
}

function renderMatchDetails(match) {
  const fragment = document.createDocumentFragment();
  const teams = match.teams ?? [];
  const players = match.players ?? [];
  const rounds = match.rounds ?? [];

  // --- scoreline ---------------------------------------------------------
  if (teams.length === 2) {
    fragment.append(
      el('div', { class: 'scoreline' }, [
        teamScoreBlock(teams[0]),
        el('div', { class: 'scoreline-meta' }, [
          el('div', { class: 'map', text: match.map ?? 'Unknown map' }),
          el('div', { class: 'sub', text: match.mode ?? '' }),
          el('div', { class: 'sub', text: formatDuration(match.durationMs) }),
        ]),
        teamScoreBlock(teams[1]),
      ]),
    );
  }

  // --- metadata grid -----------------------------------------------------
  const meta = [
    ['Source', PROVIDER_LABELS[match.provider] ?? match.provider],
    ['Map', match.map ?? '-'],
    ['Mode', match.mode ?? '-'],
    ['Started', formatDateTime(match.startedAt)],
    ['Duration', formatDuration(match.durationMs)],
    ['Rounds', teams[0]?.roundsPlayed || rounds.length || '-'],
    ['Ranked', match.isRanked === null ? '-' : match.isRanked ? 'Yes' : 'No'],
    ['Season', match.season ?? '-'],
    ['Match ID', match.matchId ?? '-'],
  ];

  fragment.append(
    el(
      'div',
      { class: 'meta-grid' },
      meta.map(([key, value]) =>
        el('div', { class: 'meta-cell' }, [
          el('div', { class: 'k', text: key }),
          el('div', { class: 'v', text: String(value) }),
        ]),
      ),
    ),
  );

  // --- scoreboards -------------------------------------------------------
  const byTeam = new Map();
  for (const player of players) {
    const key = String(player.teamId ?? 'Players');
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(player);
  }

  if (!players.length) {
    fragment.append(
      el('p', {
        class: 'empty',
        text: 'This source returned no per-player stats for the match. The raw payload below still has everything it sent.',
      }),
    );
  } else if (byTeam.size > 2) {
    // Free-for-all (deathmatch): one "team" per player.
    fragment.append(scoreboard('Players', players, null));
  } else {
    for (const [teamId, roster] of byTeam) {
      const team = teams.find((t) => String(t.id) === teamId);
      fragment.append(scoreboard(teamId, roster, team));
    }
  }

  // --- rounds timeline ---------------------------------------------------
  if (rounds.length) {
    const strip = el('div', { class: 'rounds-strip' });
    for (const round of rounds) {
      strip.append(
        el('div', {
          class: `round-chip ${sideClass(round.winningTeam)}`.trim(),
          title: `Round ${round.num} - ${round.winningTeam ?? '?'} - ${round.result ?? 'Unknown'}`,
          text: String(round.num),
        }),
      );
    }
    fragment.append(el('div', {}, [el('div', { class: 'meta-cell k', text: 'Round winners' }), strip]));
  }

  // --- raw payload -------------------------------------------------------
  fragment.append(
    el('details', {}, [
      el('summary', { text: `Raw ${PROVIDER_LABELS[match.provider] ?? match.provider} JSON` }),
      el('pre', { text: JSON.stringify(match.raw ?? match, null, 2) }),
    ]),
  );

  els.details.replaceChildren(fragment);
}

function teamScoreBlock(team) {
  return el('div', { class: `scoreline-team ${sideClass(team.id)}`.trim() }, [
    el('div', { class: 'label', text: String(team.id ?? 'Team') }),
    el('div', { class: 'score', text: String(team.roundsWon ?? 0) }),
    el('div', {
      class: `result${team.won ? ' win' : ''}`,
      text: team.won === null ? '' : team.won ? 'Winner' : 'Loss',
    }),
  ]);
}

function scoreboard(title, roster, team) {
  const sorted = [...roster].sort((a, b) => (b.acs ?? b.score ?? 0) - (a.acs ?? a.score ?? 0));

  const head = el('div', { class: `team-head ${sideClass(title)}`.trim() }, [el('span', { text: String(title) })]);
  if (team) {
    head.append(el('span', { class: 'rounds', text: `${team.roundsWon ?? 0} / ${team.roundsPlayed ?? 0} rounds` }));
  }

  const columns = ['Agent', 'Player', 'Rank', 'ACS', 'K', 'D', 'A', '+/-', 'ADR', 'HS%', 'Score'];
  const table = el('table', {}, [el('thead', {}, [el('tr', {}, columns.map((label) => el('th', { text: label })))])]);

  const body = el('tbody');
  for (const player of sorted) {
    const diff = (player.kills ?? 0) - (player.deaths ?? 0);

    const nameCell = el('td', { class: 'player' }, [document.createTextNode(player.name ?? 'Unknown')]);
    if (player.tag) nameCell.append(el('span', { class: 'tag', text: `#${player.tag}` }));

    body.append(
      el('tr', {}, [
        el('td', { class: 'agent', text: player.agent ?? '-' }),
        nameCell,
        el('td', { class: 'rank', text: player.rank ?? '-' }),
        el('td', { text: player.acs ?? '-' }),
        el('td', { text: String(player.kills ?? 0) }),
        el('td', { text: String(player.deaths ?? 0) }),
        el('td', { text: String(player.assists ?? 0) }),
        el('td', { text: diff > 0 ? `+${diff}` : String(diff) }),
        el('td', { text: player.adr ?? '-' }),
        el('td', { text: player.hsPct === null || player.hsPct === undefined ? '-' : `${player.hsPct}%` }),
        el('td', { text: String(player.score ?? 0) }),
      ]),
    );
  }

  table.append(body);
  return el('div', { class: 'team-block' }, [head, el('div', { class: 'table-scroll' }, [table])]);
}

// ------------------------------------------------ watch several rosters ---

/**
 * Watch up to ten accounts and take whichever sees the game first.
 *
 * A custom appears on each player's profile at a different moment, so polling
 * the whole roster and racing them is measurably faster than waiting on one
 * account - which is the difference between a scoreboard that makes it to air
 * between maps and one that does not.
 *
 * Two things stop a false start:
 *
 *   baseline    the match ids each account already had when the watch began, so
 *               only a genuinely new game counts. An account whose first fetch
 *               fails has no baseline yet and cannot report a hit until it gets
 *               one, otherwise its whole history would read as new.
 *   completeness a match that has only half-landed comes back as a valid
 *               payload with an empty or one-sided scoreboard rather than as an
 *               error, so the detail is checked for two scoring players before
 *               it is accepted. A rejected match is deliberately not added to
 *               the baseline: the next round tries it again, and meanwhile
 *               another account's fuller copy can win instead.
 */

/**
 * Measured against tracker.gg (tools/tracker-load.js, 2026-08-07):
 *
 *   one lookup every 60s   6/6 clean, ~4.5s each
 *   one lookup every 30s   2/6 clean, failures burning 47.6s each
 *
 * The limit is on how often the site is asked, not how many at once - a sweep
 * never got a clean round even at one account at a time, so concurrency was
 * never the lever. Hence minRequestGapMs, which paces every request the watch
 * makes: a round of ten fired back to back blows the budget no matter how long
 * the pause after it. At that pace a ten-account round takes ten minutes, which
 * is the honest reason this feature wants HenrikDev.
 *
 * HenrikDev's published limit is around 30 requests a minute. Pacing at 2.5s
 * sits just inside that at 24/min, leaving headroom for the detail fetch a hit
 * costs, and puts a ten-account round at 25s.
 *
 * Both sources run with no gap between rounds. Once every request is paced, a
 * pause after the round is a second rate limit stacked on the first, and it
 * lands squarely on the number that matters: the wait between an account
 * getting the game and this asking it again. Rounds therefore run continuously,
 * and worst-case detection is one round.
 */
const WATCH_TUNING = {
  henrik: { concurrency: 5, gapMs: 0, minRequestGapMs: 2_500 },
  tracker: { concurrency: 1, gapMs: 0, minRequestGapMs: 60_000 },
};

/** Worst case between an account having the match and the watch asking it. */
const detectionMs = (tuning, accounts) => accounts * (tuning.minRequestGapMs ?? 0) + tuning.gapMs;

// A tracker.gg check drives a real browser, so it fails in ways a JSON call does
// not: a navigation that times out, a challenge that needed a profile reset, a
// tab that lost the context. Those are worth another go; a 404 for a profile
// that does not exist is not, and retrying it just burns a slot in the round.
const RETRYABLE_STATUS = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 4_000;

const watch = {
  running: false,
  provider: null,
  /** Earliest moment the next request may start, so the whole watch stays in budget. */
  nextSlotAt: 0,
  /** A one-shot burst is in flight. Retries stay live for it; the loop is not running. */
  busy: false,
  /** Accounts that cannot answer at all - private, missing - dropped for this run. */
  skip: new Set(),
  /** Two-click burst: {handles, baseline: Map<handle, Set<id>|null>} once baselined. */
  burst: null,
  /** @type {Map<string, Set<string>|null>} ids already seen; null until a baseline lands */
  seen: new Map(),
  /** @type {Map<string, {text: string, tone: string}>} */
  status: new Map(),
};

// -------------------------------------------------------- the debug log ---

/**
 * Every request the watch makes, timed and stamped.
 *
 * A watch can sit there for twenty minutes finding nothing, and "nothing
 * happened" has several very different causes - the account really has no new
 * game, the request is failing and being retried, or tracker is handing back a
 * match whose scoreboard has not filled in. The status line only has room for
 * the latest of those, so the reasoning is written out in full here instead.
 */
const LOG_MAX = 500;
const watchLog = [];

function logWatch(message, handle = '') {
  const at = new Date();
  const stamp = `${at.toTimeString().slice(0, 8)}.${String(at.getMilliseconds()).padStart(3, '0')}`;
  const line = `${stamp}  ${handle ? `${handle}  ` : ''}${message}`;

  watchLog.push(line);
  if (watchLog.length > LOG_MAX) watchLog.shift();

  // Mirrored so a log that outlives the panel is still in the devtools console.
  console.debug(`[watch] ${line}`);

  els.watchLogCount.textContent = String(watchLog.length);
  els.watchLogCount.hidden = false;
  els.watchLog.textContent = watchLog.join('\n');
  // Only chase the tail when the operator has not scrolled up to read something.
  if (els.watchLogBox.open) els.watchLog.scrollTop = els.watchLog.scrollHeight;
}

els.watchLogCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(watchLog.join('\n'));
    toast('Watch log copied');
  } catch {
    toast('Clipboard blocked by the browser');
  }
});

/**
 * Interruptible sleeps. Several can be in flight at once - a round gap plus a
 * retry backoff per account - so they are tracked as a set and woken rather than
 * cancelled: a cleared timer whose promise never settles would strand the loop
 * that was waiting on it, which is a worse failure than sitting out the gap.
 */
const sleepers = new Set();

const sleep = (ms) =>
  new Promise((resolve) => {
    const sleeper = { resolve };
    sleeper.id = setTimeout(() => {
      sleepers.delete(sleeper);
      resolve();
    }, ms);
    sleepers.add(sleeper);
  });

function wakeSleepers() {
  for (const sleeper of sleepers) {
    clearTimeout(sleeper.id);
    sleeper.resolve();
  }
  sleepers.clear();
}

/**
 * Run a request, and give a browser-driven failure another chance.
 *
 * Only the transient statuses are retried, and only while the watch is still
 * running - a stop during a backoff should end the round, not serve it out.
 */
/**
 * Hold every request back to the source's measured pace.
 *
 * The cursor moves before anything is awaited, so two concurrent callers cannot
 * be handed the same slot. Retries queue for a slot of their own - a failing
 * account must not be allowed to jump the budget ahead of the nine that are
 * behaving.
 */
async function takeSlot(handle) {
  const minGapMs = (WATCH_TUNING[watch.provider] ?? WATCH_TUNING.henrik).minRequestGapMs ?? 0;
  const { startAt, nextAt } = reserveSlot(Date.now(), watch.nextSlotAt, minGapMs);
  watch.nextSlotAt = nextAt;

  const wait = startAt - Date.now();
  if (wait <= 0) return;

  logWatch(`waiting ${Math.round(wait / 1000)}s for its turn (pacing ${Math.round(minGapMs / 1000)}s)`, handle);
  setStatus(handle, `queued - ${Math.round(wait / 1000)}s`, 'wait');
  await sleep(wait);
}

async function withRetry(label, handle, run, paced = true) {
  for (let attempt = 1; ; attempt += 1) {
    if (paced) {
      await takeSlot(handle);
      if (!watch.running) throw { status: 0, message: 'watch stopped' };
    }

    const startedAt = performance.now();
    try {
      const value = await run();
      const took = Math.round(performance.now() - startedAt);
      logWatch(`${label} ok in ${took}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`, handle);
      return value;
    } catch (error) {
      const took = Math.round(performance.now() - startedAt);
      const status = error.status ?? 0;
      logWatch(`${label} failed in ${took}ms - ${status || 'network'} ${error.message ?? ''}`.trim(), handle);

      const canRetry = RETRYABLE_STATUS.has(status) && attempt < RETRY_ATTEMPTS && (watch.running || watch.busy);
      if (!canRetry) throw error;

      const backoff = RETRY_BACKOFF_MS * 2 ** (attempt - 1);
      logWatch(`retrying in ${backoff}ms (attempt ${attempt + 1} of ${RETRY_ATTEMPTS})`, handle);
      setStatus(handle, `retrying after ${status || 'network'} error`, 'wait');
      await sleep(backoff);
      if (!watch.running && !watch.busy) throw error;
    }
  }
}

function setWatchState(text) {
  els.watchState.textContent = text;
  els.watchState.hidden = !text;
}

function setStatus(handle, text, tone = '') {
  watch.status.set(handle, { text, tone });
  els.watchStatus.replaceChildren(
    ...[...watch.status].map(([name, entry]) =>
      el('li', { class: `watch-row${entry.tone ? ` ${entry.tone}` : ''}` }, [
        el('span', { class: 'watch-handle', text: name }),
        el('span', { class: 'watch-note', text: entry.text }),
      ]),
    ),
  );
}

const watchParams = (extra = {}) => ({
  provider: watch.provider,
  affinity: els.affinity.value,
  platform: els.platform.value,
  type: els.matchType.value,
  ...extra,
});

/**
 * One account, one round. Returns the match only if it is new *and* complete.
 */
async function checkAccount(handle) {
  const result = await withRetry('list', handle, () => api('/api/matches', watchParams({ handle })));
  const matches = result.matches ?? [];
  const ids = matches.map((match) => String(match.id)).filter(Boolean);

  const baseline = watch.seen.get(handle);
  if (!baseline) {
    watch.seen.set(handle, new Set(ids));
    logWatch(`baseline ${ids.length} id(s)${ids.length ? `, newest ${ids[0]}` : ''}`, handle);
    setStatus(handle, ids.length ? `baseline set (${ids.length})` : 'baseline set (no matches yet)');
    return null;
  }

  const fresh = freshMatch(matches, baseline);
  if (!fresh) {
    logWatch(`no new id among ${ids.length}`, handle);
    setStatus(handle, 'no new game');
    return null;
  }

  logWatch(`new id ${fresh.id} (${[fresh.queue, fresh.map].filter(Boolean).join(' ') || 'no label'}) - pulling detail`, handle);
  setStatus(handle, 'new game - checking stats', 'hit');
  const match = await withRetry('detail', handle, () => api('/api/match', watchParams({ matchId: fresh.id, handle })));

  const { ok, players } = scoreboardReady(match);
  if (!ok) {
    logWatch(`rejected ${fresh.id}: ${players} player(s) with stats - not baselined, will retry`, handle);
    setStatus(handle, `new game, stats not ready yet (${players} player${players === 1 ? '' : 's'})`, 'wait');
    return null;
  }

  logWatch(`accepted ${fresh.id} with ${players} players`, handle);
  return { handle, match, matchId: fresh.id, matches, players };
}

async function runWatch(handles) {
  const { concurrency, gapMs } = WATCH_TUNING[watch.provider] ?? WATCH_TUNING.henrik;
  let round = 0;

  while (watch.running) {
    round += 1;
    setWatchState(`round ${round}`);

    const live = handles.filter((handle) => !watch.skip.has(handle));
    if (!live.length) {
      logWatch('every account is private or missing - nothing left to watch');
      stopWatch('no usable accounts');
      return null;
    }

    const startedAt = performance.now();
    logWatch(
      `round ${round} start - ${live.length} account(s), ${concurrency} at a time` +
        (watch.skip.size ? `, ${watch.skip.size} skipped` : ''),
    );

    let failed = 0;
    const hits = await mapLimit(live, concurrency, async (handle) => {
      if (!watch.running) return null;
      try {
        return await checkAccount(handle);
      } catch (error) {
        // Stopping cancels whatever was queued for a slot. That is not a
        // failure, and painting it red would misreport a clean shutdown.
        if (!watch.running) return null;

        // Nothing about a private or missing profile changes by next round, and
        // at one lookup a minute its slot is better spent on an account that
        // can answer.
        if (isPermanentFailure(error.status)) {
          watch.skip.add(handle);
          logWatch(`dropped for this run: ${error.status} ${error.message ?? ''}`.trim(), handle);
          setStatus(handle, error.status === 403 ? 'private - skipped' : `${error.status} - skipped`, 'err');
          return null;
        }

        // One bad account must not end the watch - the other nine are the point.
        failed += 1;
        const rateLimited = error.status === 429;
        logWatch(`gave up this round: ${error.status ?? 'network'} ${error.message ?? ''}`.trim(), handle);
        setStatus(handle, rateLimited ? 'rate limited - will retry' : `error ${error.status ?? ''}`.trim(), 'err');
        return null;
      }
    });

    const hit = hits.find(Boolean);
    logWatch(
      `round ${round} done in ${Math.round((performance.now() - startedAt) / 100) / 10}s - ` +
        `${failed} failed, ${hit ? `hit on ${hit.handle}` : 'no hit'}`,
    );

    if (hit) return hit;
    if (!watch.running) return null;

    setWatchState(`waiting ${Math.round(gapMs / 1000)}s`);
    await sleep(gapMs);
  }

  return null;
}

/**
 * Take the winning account over, so the rest of the tab behaves as though it
 * had been searched by hand, and show the payload we already hold rather than
 * fetching it a second time.
 */
function adoptHit(hit) {
  setStatus(hit.handle, `taken - ${hit.players} players`, 'hit');

  state.provider = watch.provider;
  state.handle = hit.handle;
  state.matches = hit.matches;
  els.playerName.textContent = hit.handle;
  els.playerPuuidRow.hidden = true;
  els.playerCard.hidden = false;

  renderMatchList();
  markSelected(hit.matchId);
  showMatch(hit.match, hit.matchId);
}

function stopWatch(label = '') {
  if (watch.running) logWatch(`watch stopped${label ? ` - ${label}` : ''}`);
  watch.running = false;
  wakeSleepers();
  els.watchBtn.textContent = 'Start watching';
  setWatchState(label);
}

async function startWatch() {
  const handles = parseHandles(els.watchIds.value, WATCH_MAX);
  if (!handles.length) {
    toast('Add at least one Riot ID in the form Name#TAG');
    return;
  }

  const current = provider();
  if (current === 'riot') {
    toast('Watching needs HenrikDev or tracker.gg - the Riot matchlist has no mode filter.');
    return;
  }

  // ponytail: localStorage, so a ten-player roster survives a page reload
  // mid-show. Nothing here is worth a server round-trip.
  localStorage.setItem('watch-ids', els.watchIds.value);

  watch.running = true;
  watch.provider = current;
  watch.nextSlotAt = 0;
  watch.skip = new Set();
  watch.seen = new Map(handles.map((handle) => [handle, null]));
  watch.status.clear();
  for (const handle of handles) setStatus(handle, 'waiting for baseline');

  const tuning = WATCH_TUNING[current] ?? WATCH_TUNING.henrik;
  logWatch(
    `watch started - source ${current}, type ${els.matchType.value}, ${handles.length} account(s), ` +
      `${tuning.concurrency} at a time, ${Math.round((tuning.minRequestGapMs ?? 0) / 1000)}s between requests, ` +
      `${Math.round(tuning.gapMs / 1000)}s between rounds, up to ${RETRY_ATTEMPTS} attempts per request`,
  );

  // The pacing is measured, not chosen, so what it costs in detection time is
  // stated up front rather than left for the operator to infer from the log.
  const expected = detectionMs(tuning, handles.length);
  logWatch(
    `worst case, a new game is picked up ${Math.round(expected / 1000)}s after it reaches an account ` +
      `(${handles.length} account(s) at one every ${Math.round((tuning.minRequestGapMs ?? 0) / 1000)}s)`,
  );

  if (expected > 60_000) {
    const minutes = Math.round(expected / 60_000);
    toast(`${PROVIDER_LABELS[current]} pacing means up to ~${minutes} min to spot a game - see the debug log`);
  }

  els.watchBtn.textContent = 'Stop watching';

  try {
    const hit = await runWatch(handles);
    if (!hit) return;

    stopWatch(`found on ${hit.handle}`);
    adoptHit(hit);
    toast(`New ${els.matchType.value} found on ${hit.handle}`);
  } catch (error) {
    stopWatch('stopped');
    showError(els.details, error);
  }
}

/**
 * Two clicks, because "new" only means anything against what was there before.
 *
 * Click one, before the game ends, records what every account already has.
 * Click two, after it ends, asks again and takes the match that was not there
 * the first time. Without a baseline the button can only guess "newest", and
 * the newest thing on a profile is the previous game right up until the new one
 * lands - which is exactly the moment an operator is pressing it, so the guess
 * is wrong precisely when it matters.
 *
 * Five accounts, asked together. Measured, tracker.gg refuses most of a
 * ten-wide burst, so a shorter one spends the budget on requests that come back
 * with something. The trade is real and worth knowing: a game that lands first
 * on account six is not seen until it reaches one of the five, so put the
 * accounts most likely to update first at the top of the list.
 */
const BURST_MAX = 5;
const BURST_CONCURRENCY = 5;
const BURST_DETAIL_TRIES = 4;

/** Ask each account for its list, five at a time. One failure is not fatal. */
async function burstList(handles) {
  return mapLimit(handles, BURST_CONCURRENCY, async (handle) => {
    setStatus(handle, 'asking');
    try {
      const result = await withRetry('list', handle, () => api('/api/matches', watchParams({ handle })), false);
      const matches = result.matches ?? [];
      setStatus(handle, matches.length ? `${matches.length} match(es)` : 'no matches');
      return { handle, matches, ok: true };
    } catch (error) {
      logWatch(`burst failed: ${error.status ?? 'network'} ${error.message ?? ''}`.trim(), handle);
      setStatus(handle, error.status === 403 ? 'private' : `error ${error.status ?? ''}`.trim(), 'err');
      if (isPermanentFailure(error.status)) watch.skip.add(handle);
      return { handle, matches: [], ok: false };
    }
  });
}

/** The button says which half of the job it will do next. */
function syncBurstButton() {
  // Compared against the raw list, not the five actually used: skipping a
  // private account changes the five, and that must not throw away a baseline
  // taken moments before the game ended.
  const listed = parseHandles(els.watchIds.value, WATCH_MAX);
  const stale = watch.burst && String(watch.burst.listed) !== String(listed);
  if (stale) watch.burst = null;

  els.watchNow.textContent = watch.burst ? 'Check for new game' : 'Set baseline';
  els.watchNow.title = watch.burst
    ? 'Ask every account again and take whatever is new since the baseline'
    : 'Record what every account already has, so the next click can spot the new game';
}

async function runBurst() {
  const all = parseHandles(els.watchIds.value, WATCH_MAX);
  // The baseline decides which accounts are in play; the check reuses exactly
  // those, minus any that turned out to be private in the meantime.
  const handles = watch.burst
    ? watch.burst.handles.filter((handle) => !watch.skip.has(handle))
    : all.filter((handle) => !watch.skip.has(handle)).slice(0, BURST_MAX);
  if (!handles.length) {
    toast('Add at least one Riot ID in the form Name#TAG');
    return;
  }

  const current = provider();
  if (current === 'riot') {
    toast('Watching needs HenrikDev or tracker.gg - the Riot matchlist has no mode filter.');
    return;
  }

  localStorage.setItem('watch-ids', els.watchIds.value);
  if (all.length > handles.length) {
    logWatch(`using the first ${handles.length} of ${all.length} account(s) - the burst is capped at ${BURST_MAX}`);
  }

  watch.busy = true;
  watch.provider = current;
  els.watchNow.disabled = true;

  const startedAt = performance.now();
  const took = () => `${Math.round(performance.now() - startedAt) / 1000}s`;

  try {
    if (!watch.burst) return await takeBaseline(all, current, took);
    return await findNewGame(handles, took);
  } finally {
    watch.busy = false;
    els.watchNow.disabled = false;
    syncBurstButton();
  }
}

async function takeBaseline(all, current, took) {
  setWatchState('baselining');
  logWatch(`baseline - up to ${BURST_MAX} account(s), ${BURST_CONCURRENCY} at a time, source ${current}`);
  if (current === 'tracker') {
    logWatch('tracker.gg is measured at one lookup a minute, so some of these will be refused');
  }

  const baseline = new Map();
  const used = [];
  let pool = all.filter((handle) => !watch.skip.has(handle));

  // Keep topping the set back up to five. A private account is discovered here,
  // and replacing it now is what makes the next click able to use its stand-in:
  // an account with no baseline can serve a scoreboard but cannot say what is
  // new, so a replacement pulled in later would be along for the ride only.
  while (used.length < BURST_MAX && pool.length) {
    const batch = pool.slice(0, BURST_MAX - used.length);
    pool = pool.slice(batch.length);

    for (const { handle, matches, ok } of await burstList(batch)) {
      // Private or missing: dropped for good, and its slot goes to the next one.
      if (!ok && watch.skip.has(handle)) {
        logWatch(`replaced in the baseline set - ${pool.length} account(s) left to draw from`, handle);
        continue;
      }
      // A transient failure keeps its slot but gets no baseline: an empty set
      // would make its whole history look new next click.
      baseline.set(handle, ok ? new Set(matches.map((match) => String(match.id)).filter(Boolean)) : null);
      used.push(handle);
    }
  }

  const answered = [...baseline.values()].filter(Boolean).length;
  watch.burst = { handles: used, listed: [...all], baseline };
  logWatch(`baseline took ${took()} - ${answered}/${used.length} account(s) answered: ${used.join(', ') || 'none'}`);
  setWatchState(`baseline ${answered}/${used.length}`);

  toast(
    answered
      ? `Baseline set on ${answered} account(s) - press again when the game ends`
      : 'No account answered, so there is no baseline yet - try again',
  );
  if (!answered) watch.burst = null;
}

async function findNewGame(handles, took) {
  setWatchState('checking all');
  logWatch(`checking for a new game - ${handles.length} account(s), ${BURST_CONCURRENCY} at a time`);

  const lists = await burstList(handles);
  const baseline = watch.burst?.baseline ?? new Map();

  // A match counts as new only for an account that had a baseline to compare
  // against. Accounts without one can still serve the detail, they just cannot
  // nominate a candidate.
  const candidates = [];
  for (const { handle, matches } of lists) {
    const before = baseline.get(handle);
    if (!before) continue;
    for (const match of matches) {
      if (!match?.id || before.has(String(match.id))) continue;
      const seen = candidates.find((entry) => String(entry.id) === String(match.id));
      if (seen) continue;
      candidates.push({ id: match.id, startedAt: match.startedAt ?? 0, sources: [] });
    }
  }

  // Any account that lists a candidate can serve its detail - on tracker.gg one
  // account's copy is often complete while another's is still filling in.
  for (const candidate of candidates) {
    for (const { handle, matches } of lists) {
      if (matches.some((match) => String(match?.id) === String(candidate.id))) {
        candidate.sources.push({ handle, matches });
      }
    }
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);

  if (!candidates.length) {
    logWatch(`no new match after ${took()} - nothing here that was not in the baseline`);
    setWatchState('nothing new');
    toast('Nothing new yet - press again in a moment');
    return;
  }

  logWatch(`${candidates.length} new match(es); newest is ${candidates[0].id} on ${candidates[0].sources.length} account(s)`);

  let tries = 0;
  for (const candidate of candidates) {
    for (const source of candidate.sources) {
      if (tries >= BURST_DETAIL_TRIES) break;
      tries += 1;

      try {
        const match = await withRetry(
          'detail',
          source.handle,
          () => api('/api/match', watchParams({ matchId: candidate.id, handle: source.handle })),
          false,
        );
        const { ok, players } = scoreboardReady(match);
        if (!ok) {
          logWatch(`${candidate.id} incomplete here (${players} player(s)) - trying another account`, source.handle);
          continue;
        }

        logWatch(`found in ${took()} - ${candidate.id} with ${players} players`);
        setWatchState(`found on ${source.handle}`);
        adoptHit({ handle: source.handle, match, matchId: candidate.id, matches: source.matches, players });

        // Fold everything just seen into the baseline, so the next click looks
        // for the game after this one rather than finding this one again.
        for (const entry of lists) {
          const before = watch.burst.baseline.get(entry.handle);
          if (before) for (const seen of entry.matches) before.add(String(seen.id));
        }

        toast(`Loaded ${candidate.id} from ${source.handle}`);
        return;
      } catch (error) {
        logWatch(`detail failed: ${error.status ?? 'network'} ${error.message ?? ''}`.trim(), source.handle);
      }
    }
    if (tries >= BURST_DETAIL_TRIES) break;
  }

  setWatchState('new game, no full scoreboard');
  toast('Found a new game, but no full scoreboard yet - press again shortly');
}

els.watchBtn.addEventListener('click', () => {
  if (watch.running) stopWatch('stopped');
  else void startWatch();
});

els.watchNow.addEventListener('click', () => void runBurst());
els.watchIds.addEventListener('input', syncBurstButton);

els.watchIds.value = localStorage.getItem('watch-ids') ?? '';
syncBurstButton();

// ------------------------------------------------------------ exports ---

els.copyJson.addEventListener('click', async () => {
  if (!state.selectedMatch) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.selectedMatch, null, 2));
    toast('Match JSON copied to clipboard');
  } catch {
    toast('Clipboard blocked by the browser');
  }
});

els.downloadJson.addEventListener('click', () => {
  if (!state.selectedMatch) return;
  const blob = new Blob([JSON.stringify(state.selectedMatch, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: `${state.selectedMatchId ?? 'match'}.json` }).click();
  URL.revokeObjectURL(url);
});

document.addEventListener('click', async (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-copy-target]') : null;
  if (!button) return;
  try {
    await navigator.clipboard.writeText($(button.dataset.copyTarget).textContent);
    toast('Copied');
  } catch {
    toast('Clipboard blocked by the browser');
  }
});

loadConfig();