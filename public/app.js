/**
 * VALORANT Broadcast Production Tool - UI logic.
 *
 * Flow: Riot ID -> account (puuid) -> matchlist -> match detail.
 * All Riot calls go through the local proxy in server.js.
 */

// ------------------------------------------------------------ elements ---

const $ = (id) => document.getElementById(id);

const els = {
  form: $('search-form'),
  riotId: $('riot-id'),
  searchBtn: $('search-btn'),
  routing: $('routing'),
  region: $('region'),
  keyWarning: $('key-warning'),
  playerCard: $('player-card'),
  playerName: $('player-name'),
  playerPuuid: $('player-puuid'),
  matchList: $('match-list'),
  matchCount: $('match-count'),
  details: $('match-details'),
  copyJson: $('copy-json'),
  downloadJson: $('download-json'),
  toast: $('toast'),
};

const state = {
  account: null,
  matches: [],
  selectedMatchId: null,
  selectedMatch: null,
  content: null,
  contentRegion: null,
};

// ------------------------------------------------------------- helpers ---

/** Build an element. Text goes in via textContent, so nothing is ever injected as HTML. */
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

function clear(node) {
  node.replaceChildren();
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

// ------------------------------------------------------- formatting ---

const QUEUE_NAMES = {
  competitive: 'Competitive',
  unrated: 'Unrated',
  swiftplay: 'Swiftplay',
  spikerush: 'Spike Rush',
  deathmatch: 'Deathmatch',
  ggteam: 'Escalation',
  hurm: 'Team Deathmatch',
  onefa: 'Replication',
  premier: 'Premier',
  newmap: 'New Map',
  snowball: 'Snowball Fight',
  '': 'Custom / Unrated Queue',
};

/** Fallback map names by asset path codename - used only when content-v1 is unavailable. */
const MAP_FALLBACK = {
  ascent: 'Ascent',
  duality: 'Bind',
  bonsai: 'Split',
  triad: 'Haven',
  port: 'Icebox',
  foxtrot: 'Breeze',
  canyon: 'Fracture',
  pitt: 'Pearl',
  jam: 'Lotus',
  juliett: 'Sunset',
  infinity: 'Abyss',
  range: 'The Range',
};

const normId = (value) => String(value ?? '').replace(/-/g, '').toUpperCase();

function formatQueue(queueId) {
  const key = String(queueId ?? '').toLowerCase();
  return QUEUE_NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown');
}

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
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

function agentName(characterId) {
  const target = normId(characterId);
  const match = state.content?.characters?.find((c) => normId(c.id) === target);
  return match?.name ?? (characterId ? `${String(characterId).slice(0, 8)}...` : '-');
}

function mapName(mapId) {
  const path = String(mapId ?? '');
  const match = state.content?.maps?.find((m) => (m.assetPath ?? '').toLowerCase() === path.toLowerCase());
  if (match?.name) return match.name;

  const codename = path.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  return MAP_FALLBACK[codename] ?? (codename ? codename.charAt(0).toUpperCase() + codename.slice(1) : 'Unknown map');
}

function rankName(tier) {
  if (tier === undefined || tier === null || tier === 0) return 'Unranked';
  const episodes = state.content?.competitiveTiers ?? [];
  const tiers = episodes.at(-1)?.tiers ?? [];
  const match = tiers.find((t) => t.tier === tier);
  return match?.tierName ? titleCase(match.tierName) : `Tier ${tier}`;
}

const titleCase = (value) =>
  String(value)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------- config ---

async function loadConfig() {
  try {
    const config = await api('/api/config');

    for (const [select, values, selected] of [
      [els.routing, config.routings, config.routing],
      [els.region, config.regions, config.region],
    ]) {
      select.replaceChildren(
        ...values.map((value) => el('option', { value, text: value.toUpperCase(), selected: value === selected })),
      );
      select.value = selected;
    }

    els.keyWarning.hidden = config.hasKey;
  } catch {
    els.matchList.replaceChildren(el('p', { class: 'empty', text: 'Could not reach the local server.' }));
  }
}

/** Agent/map/rank names. Best-effort: the UI degrades to IDs if this fails. */
async function ensureContent(region) {
  if (state.content && state.contentRegion === region) return;
  try {
    state.content = await api('/api/content', { region });
    state.contentRegion = region;
  } catch {
    state.content = state.content ?? null;
  }
}

// ------------------------------------------------- step 1 + 2: search ---

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const riotId = els.riotId.value.trim();
  if (!riotId) return;

  const region = els.region.value;
  els.searchBtn.disabled = true;
  els.playerCard.hidden = true;
  resetDetails();
  showLoading(els.matchList, 'Looking up player...');

  try {
    const account = await api('/api/account', { riotId, routing: els.routing.value });
    state.account = account;

    els.playerName.textContent = `${account.gameName}#${account.tagLine}`;
    els.playerPuuid.textContent = account.puuid;
    els.playerCard.hidden = false;

    showLoading(els.matchList, 'Loading match history...');
    const [matchlist] = await Promise.all([
      api('/api/matches', { puuid: account.puuid, region }),
      ensureContent(region),
    ]);

    state.matches = matchlist.history ?? [];
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
    els.matchList.replaceChildren(el('p', { class: 'empty', text: 'No matches returned for this player.' }));
    return;
  }

  els.matchCount.textContent = `${state.matches.length} match${state.matches.length === 1 ? '' : 'es'}`;
  els.matchCount.hidden = false;

  els.matchList.replaceChildren(
    ...state.matches.map((match) => {
      const button = el('button', { type: 'button', class: 'match-item', 'data-match-id': match.matchId }, [
        el('span', { class: 'match-queue', text: formatQueue(match.queueId) }),
        el('span', { class: 'match-date', text: formatDateTime(match.gameStartTimeMillis) }),
        el('span', { class: 'match-id', text: match.matchId }),
      ]);
      button.addEventListener('click', () => selectMatch(match.matchId));
      return button;
    }),
  );
}

// --------------------------------------------- step 3: match details ---

async function selectMatch(matchId) {
  state.selectedMatchId = matchId;

  for (const item of els.matchList.querySelectorAll('.match-item')) {
    item.setAttribute('aria-current', String(item.dataset.matchId === matchId));
  }

  resetDetails();
  showLoading(els.details, 'Pulling match details...');

  try {
    const region = els.region.value;
    await ensureContent(region);
    const match = await api('/api/match', { matchId, region });

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

/** Per-player damage/headshot totals, summed across every round. */
function damageTotals(match) {
  const totals = new Map();

  for (const round of match.roundResults ?? []) {
    for (const entry of round.playerStats ?? []) {
      const current = totals.get(entry.puuid) ?? { damage: 0, head: 0, body: 0, leg: 0 };
      for (const hit of entry.damage ?? []) {
        current.damage += hit.damage ?? 0;
        current.head += hit.headshots ?? 0;
        current.body += hit.bodyshots ?? 0;
        current.leg += hit.legshots ?? 0;
      }
      totals.set(entry.puuid, current);
    }
  }
  return totals;
}

function renderMatchDetails(match) {
  const info = match.matchInfo ?? {};
  const players = match.players ?? [];
  const teams = match.teams ?? [];
  const rounds = match.roundResults ?? [];
  const totals = damageTotals(match);
  const roundsPlayed = teams[0]?.roundsPlayed ?? rounds.length ?? 0;

  const fragment = document.createDocumentFragment();

  // --- scoreline ---------------------------------------------------------
  const red = teams.find((t) => String(t.teamId).toLowerCase() === 'red');
  const blue = teams.find((t) => String(t.teamId).toLowerCase() === 'blue');

  if (red && blue) {
    fragment.append(
      el('div', { class: 'scoreline' }, [
        teamScoreBlock('red', red),
        el('div', { class: 'scoreline-meta' }, [
          el('div', { class: 'map', text: mapName(info.mapId) }),
          el('div', { class: 'sub', text: formatQueue(info.queueId) }),
          el('div', { class: 'sub', text: formatDuration(info.gameLengthMillis) }),
        ]),
        teamScoreBlock('blue', blue),
      ]),
    );
  }

  // --- metadata grid -----------------------------------------------------
  const meta = [
    ['Map', mapName(info.mapId)],
    ['Mode', formatQueue(info.queueId)],
    ['Started', formatDateTime(info.gameStartMillis)],
    ['Duration', formatDuration(info.gameLengthMillis)],
    ['Rounds', roundsPlayed || '-'],
    ['Ranked', info.isRanked ? 'Yes' : 'No'],
    ['Completed', info.isCompleted ? 'Yes' : 'No'],
    ['Season', info.seasonId ?? '-'],
    ['Match ID', info.matchId ?? state.selectedMatchId ?? '-'],
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
    const key = String(player.teamId ?? 'unknown');
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(player);
  }

  const isFreeForAll = byTeam.size > 2; // deathmatch: one "team" per player
  if (isFreeForAll) {
    fragment.append(scoreboard('Players', players, totals, null));
  } else {
    for (const teamId of ['Red', 'Blue']) {
      const roster = byTeam.get(teamId) ?? [];
      if (!roster.length) continue;
      const team = teams.find((t) => String(t.teamId).toLowerCase() === teamId.toLowerCase());
      fragment.append(scoreboard(teamId, roster, totals, team));
    }
    for (const [teamId, roster] of byTeam) {
      if (teamId !== 'Red' && teamId !== 'Blue') fragment.append(scoreboard(teamId, roster, totals, null));
    }
  }

  // --- rounds timeline ---------------------------------------------------
  if (rounds.length && !isFreeForAll) {
    const strip = el('div', { class: 'rounds-strip' });
    for (const round of rounds) {
      const side = String(round.winningTeam ?? '').toLowerCase();
      strip.append(
        el('div', {
          class: `round-chip ${side === 'red' || side === 'blue' ? side : ''}`.trim(),
          title: `Round ${(round.roundNum ?? 0) + 1} - ${round.winningTeam ?? '?'} - ${round.roundResult ?? 'Unknown'}`,
          text: String((round.roundNum ?? 0) + 1),
        }),
      );
    }
    fragment.append(el('div', {}, [el('div', { class: 'meta-cell k', text: 'Round winners' }), strip]));
  }

  // --- raw payload -------------------------------------------------------
  fragment.append(
    el('details', {}, [
      el('summary', { text: 'Raw match JSON' }),
      el('pre', { text: JSON.stringify(match, null, 2) }),
    ]),
  );

  els.details.replaceChildren(fragment);
}

function teamScoreBlock(side, team) {
  return el('div', { class: `scoreline-team ${side}` }, [
    el('div', { class: 'label', text: side }),
    el('div', { class: 'score', text: String(team.roundsWon ?? 0) }),
    el('div', { class: `result${team.won ? ' win' : ''}`, text: team.won ? 'Winner' : 'Loss' }),
  ]);
}

function scoreboard(title, roster, totals, team) {
  const sorted = [...roster].sort((a, b) => (b.stats?.score ?? 0) - (a.stats?.score ?? 0));
  const side = title.toLowerCase() === 'red' || title.toLowerCase() === 'blue' ? title.toLowerCase() : '';

  const head = el('div', { class: `team-head ${side}`.trim() }, [el('span', { text: title })]);
  if (team) {
    head.append(el('span', { class: 'rounds', text: `${team.roundsWon ?? 0} / ${team.roundsPlayed ?? 0} rounds` }));
  }

  const columns = ['Agent', 'Player', 'Rank', 'ACS', 'K', 'D', 'A', '+/-', 'ADR', 'HS%', 'Score'];
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, columns.map((label) => el('th', { text: label })))]),
  ]);

  const body = el('tbody');
  for (const player of sorted) {
    const stats = player.stats ?? {};
    const played = stats.roundsPlayed || 0;
    const damage = totals.get(player.puuid) ?? { damage: 0, head: 0, body: 0, leg: 0 };
    const shots = damage.head + damage.body + damage.leg;
    const diff = (stats.kills ?? 0) - (stats.deaths ?? 0);

    const nameCell = el('td', { class: 'player' }, [document.createTextNode(player.gameName ?? 'Unknown')]);
    nameCell.append(el('span', { class: 'tag', text: `#${player.tagLine ?? '???'}` }));

    body.append(
      el('tr', {}, [
        el('td', { class: 'agent', text: agentName(player.characterId) }),
        nameCell,
        el('td', { class: 'rank', text: rankName(player.competitiveTier) }),
        el('td', { text: played ? Math.round((stats.score ?? 0) / played) : '-' }),
        el('td', { text: String(stats.kills ?? 0) }),
        el('td', { text: String(stats.deaths ?? 0) }),
        el('td', { text: String(stats.assists ?? 0) }),
        el('td', { text: diff > 0 ? `+${diff}` : String(diff) }),
        el('td', { text: played ? Math.round(damage.damage / played) : '-' }),
        el('td', { text: shots ? `${Math.round((damage.head / shots) * 100)}%` : '-' }),
        el('td', { text: String(stats.score ?? 0) }),
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
  const anchor = el('a', { href: url, download: `${state.selectedMatchId ?? 'match'}.json` });
  anchor.click();
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

// Changing the match region invalidates cached agent/map names.
els.region.addEventListener('change', () => {
  state.content = null;
  state.contentRegion = null;
});

loadConfig();
