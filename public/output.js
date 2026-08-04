/**
 * Broadcast scoreboard - output renderer.
 *
 * Point an OBS browser source at /output.html (1920x1080, transparent) and
 * leave it. State arrives over SSE from the local server, so the dashboard and
 * OBS stay in sync even though they are separate browser processes.
 *
 * Two rules this file is built around:
 *   - Never recreate an element. A repaint that rebuilt the DOM would flash
 *     every portrait and map splash on air. The skeleton in output.html is
 *     built once and only text and src attributes are ever written.
 *   - Never write markup. All text goes in via textContent, so nothing in the
 *     graphic state can become executable, no matter where it was imported from.
 */

import { STAT_SLOTS, statDef } from './stats.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const ROWS_PER_SIDE = 4; // 5 players per side, minus the one shown as MVP.
const ROW_STAT_SLOTS = 2; // roster rows only have room for the first two.

const stage = document.getElementById('stage');
const wrap = document.getElementById('stage-wrap');

// --------------------------------------------------------------- skeleton ---

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** One roster row. `side` picks the mirrored variant via CSS, not markup. */
function buildRow(side, index) {
  const path = `${side}.p${index}`;

  const portrait = el('div', 'row-agent');
  portrait.append(el('img', null, { 'data-img': `${path}.icon`, alt: '' }));
  const pip = el('div', 'role-pip', { 'data-mask': `${path}.role` });
  pip.append(el('span'));
  portrait.append(pip);

  const who = el('div', 'row-who');
  who.append(el('div', 'row-agent-name', { 'data-bind': `${path}.agent` }));
  who.append(el('div', 'row-player-name', { 'data-bind': `${path}.name` }));

  const stats = el('div', 'row-stats');
  for (let slot = 0; slot < ROW_STAT_SLOTS; slot += 1) {
    stats.append(el('div', null, { 'data-bind': `${path}.s${slot}` }));
  }

  const info = el('div', 'row-info');
  // The right side reads inward-out: stats, then name, then portrait.
  info.append(...(side === 'right' ? [stats, who] : [who, stats]));

  const row = el('div', 'row');
  row.append(...(side === 'right' ? [info, portrait] : [portrait, info]));
  return row;
}

for (const side of ['left', 'right']) {
  const host = stage.querySelector(`[data-rows="${side}"]`);
  for (let index = 0; index < ROWS_PER_SIDE; index += 1) host.append(buildRow(side, index));
}

// Centre strip: per-row stat labels, aligned with the roster rows by sharing
// the same flex sizing rather than by measuring anything.
const midRows = document.getElementById('mid-rows');
for (let index = 0; index < ROWS_PER_SIDE; index += 1) {
  const block = el('div', 'mid-row');
  for (let slot = 0; slot < ROW_STAT_SLOTS; slot += 1) {
    block.append(el('div', null, { 'data-bind': `labels.s${slot}` }));
  }
  midRows.append(block);
}

// Collected once - the skeleton never changes shape after this point.
const textTargets = [...stage.querySelectorAll('[data-bind]')];
const imageTargets = [...stage.querySelectorAll('[data-img]')];
const maskTargets = [...stage.querySelectorAll('[data-mask]')];
const fitTargets = [...stage.querySelectorAll('[data-fit]')];

/**
 * A logo URL that 404s would otherwise draw the browser's broken-image icon,
 * which is far worse on air than showing nothing.
 *
 * The failed URLs are remembered because `error` only fires when the src is
 * assigned: a later repaint that re-shows the same element would otherwise
 * un-hide the broken image with nothing left to fire and hide it again.
 */
const failedImages = new Set();

for (const node of imageTargets) {
  node.addEventListener('error', () => {
    const src = node.getAttribute('src');
    if (src) failedImages.add(src);
    node.hidden = true;
  });
}

// ------------------------------------------------------------ view model ---

let agentsByName = new Map();
let mapsByName = new Map();

const key = (value) => String(value ?? '').trim().toLowerCase();

function indexCatalogue(data) {
  agentsByName = new Map(data.agents.map((agent) => [key(agent.name), agent]));
  mapsByName = new Map(data.maps.map((map) => [key(map.name), map]));

  // KAY/O is written a dozen ways across data sources; matching on letters and
  // digits alone absorbs "KAYO", "kay/o" and "KAY-O" without a lookup table.
  for (const agent of data.agents) {
    const loose = key(agent.name).replace(/[^a-z0-9]/g, '');
    if (!agentsByName.has(loose)) agentsByName.set(loose, agent);
  }
}

const findAgent = (name) =>
  agentsByName.get(key(name)) ?? agentsByName.get(key(name).replace(/[^a-z0-9]/g, '')) ?? null;

const findMap = (name) => mapsByName.get(key(name)) ?? null;

/** @param {string[]} statRows the three stat keys the operator picked */
function playerView(player, statRows) {
  const agent = findAgent(player.agent);
  const view = {
    name: player.name || '',
    agent: player.agent || '',
    icon: agent?.icon ?? '',
    portrait: agent?.portrait ?? '',
    role: agent?.role?.icon ?? '',
  };

  // s0..s2 are what the layout binds to; which stat lands in each is config.
  for (let slot = 0; slot < STAT_SLOTS; slot += 1) {
    view[`s${slot}`] = statDef(statRows[slot]).format(player);
  }
  return view;
}

/** Flatten state + catalogue into the dotted paths the skeleton binds to. */
function buildView(state) {
  const statRows = state.statRows;

  const view = {
    // A blank label means "name it after the stat", so switching a row to KAST
    // relabels the column without the operator retyping it.
    labels: {
      mvp: state.labels.mvp,
      ...Object.fromEntries(
        statRows.map((key, slot) => [`s${slot}`, state.labels[`stat${slot + 1}`] || statDef(key).label]),
      ),
    },
    eventLogo: state.eventLogo,
    map: {
      name: state.map,
      image: state.mapImage || findMap(state.map)?.splash || '',
    },
  };

  for (const side of ['left', 'right']) {
    const data = state[side];
    // Slot 0 is the MVP by definition - the dashboard reorders players rather
    // than carrying a separate "who is MVP" flag that could disagree with the list.
    const [mvp, ...rest] = data.players;

    view[side] = {
      teamName: data.teamName,
      result: data.result,
      roundsWon: String(data.roundsWon ?? 0),
      logo: data.logo,
      mvp: playerView(mvp ?? {}, statRows),
    };

    for (let index = 0; index < ROWS_PER_SIDE; index += 1) {
      view[side][`p${index}`] = playerView(rest[index] ?? {}, statRows);
    }
  }

  if (!state.preset.showMvpPortrait) {
    view.left.mvp.portrait = '';
    view.right.mvp.portrait = '';
  }
  if (!state.preset.showRoleIcon) {
    for (const side of ['left', 'right']) {
      for (let index = 0; index < ROWS_PER_SIDE; index += 1) view[side][`p${index}`].role = '';
    }
  }

  return view;
}

const read = (source, path) => path.split('.').reduce((value, part) => (value == null ? value : value[part]), source);

// ------------------------------------------------------------- rendering ---

const PRESET_VARS = {
  leftBg: '--left-bg',
  rightBg: '--right-bg',
  globalText: '--global-text',
  leftBigText: '--left-big',
  leftSmallText: '--left-small',
  rightBigText: '--right-big',
  rightSmallText: '--right-small',
  mvpBannerBg: '--mvp-banner-bg',
  mvpBannerText: '--mvp-banner-text',
  mvpName: '--mvp-name',
  mvpAgent: '--mvp-agent',
};

function applyPreset(preset) {
  const root = document.documentElement.style;
  for (const [field, variable] of Object.entries(PRESET_VARS)) root.setProperty(variable, preset[field]);
  root.setProperty('--panel-opacity', String(preset.panelOpacity));
  root.setProperty('--font', `"${preset.font}"`);

  stage.classList.toggle('uppercase', preset.uppercase);
  document.body.style.background = preset.pageBackground || 'transparent';
}

/**
 * The MVP name column is only a third of the panel, but the third beside it
 * holds nothing except the faded edge of the agent portrait - so a long name is
 * allowed to run into it before being squeezed, exactly as the reference layout
 * does. Squeezing horizontally keeps the baseline where the design puts it,
 * which a font-size change would not.
 */
const MIN_SQUEEZE = 0.5; // below this it stops being readable on air

function fitText(node) {
  node.style.transform = 'scale(1)';

  const parent = node.parentElement;
  if (!parent) return;

  // data-fit is the overrun allowance: 1 means "stay inside your own box"
  // (team names, which sit beside the score), higher lets a name spill into
  // adjacent empty space before being squeezed.
  const allowance = Number.parseFloat(node.dataset.fit) || 1;

  // clientWidth/scrollWidth are layout pixels, so the stage's own scale
  // transform does not distort this measurement.
  const style = getComputedStyle(parent);
  const column = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const available = column * allowance;
  const needed = node.scrollWidth;

  if (!(available > 0) || !needed || needed <= available) return;
  node.style.transform = `scaleX(${Math.max(MIN_SQUEEZE, available / needed)})`;
}

function render(state) {
  applyPreset(state.preset);
  const view = buildView(state);

  for (const node of textTargets) {
    const value = read(view, node.dataset.bind);
    const next = value === null || value === undefined ? '' : String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  for (const node of imageTargets) {
    const url = read(view, node.dataset.img) || '';
    // Only touch src when it actually changed: reassigning the same URL is
    // usually a no-op, but "usually" is not good enough on air.
    if (url && node.getAttribute('src') !== url) node.setAttribute('src', url);
    if (!url) node.removeAttribute('src');
    node.hidden = !url || failedImages.has(url);
  }

  for (const node of maskTargets) {
    const url = read(view, node.dataset.mask) || '';
    const glyph = node.firstElementChild;
    if (glyph) {
      // Quoted and escaped: a bare url() would break on any character CSS
      // treats specially, and this string comes from a remote catalogue.
      const value = url ? `url("${url.replace(/["\\]/g, '\\$&')}")` : '';
      glyph.style.maskImage = value;
      glyph.style.webkitMaskImage = value;
    }
    node.hidden = !url;
  }

  // Layout has to have settled before anything can be measured.
  requestAnimationFrame(refit);
}

const refit = () => fitTargets.forEach(fitText);

// Web fonts arrive after first paint and change every text measurement, so
// anything squeezed against the fallback font has to be measured again.
document.fonts?.ready.then(refit).catch(() => {});

// ----------------------------------------------------------------- scale ---

function fitStage() {
  const scale = Math.min(wrap.clientWidth / STAGE_W, wrap.clientHeight / STAGE_H);
  stage.style.transform = `scale(${scale})`;
}

window.addEventListener('resize', fitStage);
fitStage();

// ------------------------------------------------------------ connection ---

let latestState = null;

// Subscribe first so the first frame is not held up by the catalogue fetch;
// names and numbers paint immediately and the art fills in a moment later.
const stream = new EventSource('/api/graphic/events');

stream.addEventListener('graphic', (event) => {
  try {
    latestState = JSON.parse(event.data).state;
    render(latestState);
  } catch (error) {
    console.warn(`ignored a malformed graphic update: ${error.message}`);
  }
});

// EventSource reconnects on its own; nothing here should tear the page down.
stream.addEventListener('error', () => console.warn('graphic stream dropped - reconnecting'));

(async () => {
  try {
    const response = await fetch('/api/valorant-assets');
    if (response.ok) indexCatalogue(await response.json());
  } catch {
    // Agent art is decoration; names and numbers still go to air without it.
    console.warn('valorant-api catalogue unavailable - rendering without agent art');
  }
  if (latestState) render(latestState);
})();
