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

async function selectMatch(matchId) {
  state.selectedMatchId = matchId;

  for (const item of els.matchList.querySelectorAll('.match-item')) {
    item.setAttribute('aria-current', String(item.dataset.matchId === String(matchId)));
  }

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

    state.selectedMatch = match;
    renderMatchDetails(match);
    els.copyJson.hidden = false;
    els.downloadJson.hidden = false;
  } catch (error) {
    showError(els.details, error);
  }
}

function resetDetails() {
  state.selectedMatch = null;
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