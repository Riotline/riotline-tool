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
import { WATCH_MAX, freshMatch, mapLimit, parseHandles, scoreboardReady } from './watch-core.js';

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

// tracker.gg drives a real browser per check, so it gets a small fan-out and
// leans on its own latency for spacing. HenrikDev is a plain JSON call, but the
// free tier is roughly 30 requests a minute and ten accounts burn that fast.
const WATCH_TUNING = {
  henrik: { concurrency: 5, gapMs: 25_000 },
  tracker: { concurrency: 2, gapMs: 10_000 },
};

const watch = {
  running: false,
  provider: null,
  timer: null,
  /** @type {Map<string, Set<string>|null>} ids already seen; null until a baseline lands */
  seen: new Map(),
  /** @type {Map<string, {text: string, tone: string}>} */
  status: new Map(),
};

/** Interruptible: stopping the watch clears this so it does not sit out the gap. */
const sleep = (ms) =>
  new Promise((resolve) => {
    watch.timer = setTimeout(resolve, ms);
  });

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
  const result = await api('/api/matches', watchParams({ handle }));
  const matches = result.matches ?? [];
  const ids = matches.map((match) => String(match.id)).filter(Boolean);

  const baseline = watch.seen.get(handle);
  if (!baseline) {
    watch.seen.set(handle, new Set(ids));
    setStatus(handle, ids.length ? `baseline set (${ids.length})` : 'baseline set (no matches yet)');
    return null;
  }

  const fresh = freshMatch(matches, baseline);
  if (!fresh) {
    setStatus(handle, 'no new game');
    return null;
  }

  setStatus(handle, 'new game - checking stats', 'hit');
  const match = await api('/api/match', watchParams({ matchId: fresh.id, handle }));

  const { ok, players } = scoreboardReady(match);
  if (!ok) {
    setStatus(handle, `new game, stats not ready yet (${players} player${players === 1 ? '' : 's'})`, 'wait');
    return null;
  }

  return { handle, match, matchId: fresh.id, matches, players };
}

async function runWatch(handles) {
  const { concurrency, gapMs } = WATCH_TUNING[watch.provider] ?? WATCH_TUNING.henrik;
  let round = 0;

  while (watch.running) {
    round += 1;
    setWatchState(`round ${round}`);

    const hits = await mapLimit(handles, concurrency, async (handle) => {
      if (!watch.running) return null;
      try {
        return await checkAccount(handle);
      } catch (error) {
        // One bad account must not end the watch - the other nine are the point.
        const rateLimited = error.status === 429;
        setStatus(handle, rateLimited ? 'rate limited - will retry' : `error ${error.status ?? ''}`.trim(), 'err');
        return null;
      }
    });

    const hit = hits.find(Boolean);
    if (hit) return hit;
    if (!watch.running) return null;

    setWatchState(`waiting ${Math.round(gapMs / 1000)}s`);
    await sleep(gapMs);
  }

  return null;
}

function stopWatch(label = '') {
  watch.running = false;
  clearTimeout(watch.timer);
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
  watch.seen = new Map(handles.map((handle) => [handle, null]));
  watch.status.clear();
  for (const handle of handles) setStatus(handle, 'waiting for baseline');

  els.watchBtn.textContent = 'Stop watching';

  try {
    const hit = await runWatch(handles);
    if (!hit) return;

    stopWatch(`found on ${hit.handle}`);
    setStatus(hit.handle, `taken - ${hit.players} players`, 'hit');

    // Adopt the winning account so the rest of the tab behaves as though it had
    // been searched by hand, then show the payload we already have.
    state.provider = watch.provider;
    state.handle = hit.handle;
    state.matches = hit.matches;
    els.playerName.textContent = hit.handle;
    els.playerPuuidRow.hidden = true;
    els.playerCard.hidden = false;

    renderMatchList();
    markSelected(hit.matchId);
    showMatch(hit.match, hit.matchId);
    toast(`New ${els.matchType.value} found on ${hit.handle}`);
  } catch (error) {
    stopWatch('stopped');
    showError(els.details, error);
  }
}

els.watchBtn.addEventListener('click', () => {
  if (watch.running) stopWatch('stopped');
  else void startWatch();
});

els.watchIds.value = localStorage.getItem('watch-ids') ?? '';

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