/**
 * VALORANT Broadcast Production Tool - local server.
 *
 * Serves the static UI from ./public and proxies two data providers:
 *
 *   riot     - official Riot Games API      (needs RIOT_API_KEY)
 *   tracker  - tracker.gg website via Playwright (needs TRACKER_ENABLED, no API key)
 *
 * Both are normalised in providers.js so the UI renders them identically.
 * The proxy exists because neither source allows cross-origin browser calls,
 * and API keys must never reach the client.
 *
 * It also hosts the broadcast graphic (see graphics.js): /graphic edits the
 * state, /output.html renders it, and they stay in sync over SSE because OBS
 * runs the output page in its own browser process.
 *
 * Zero npm dependencies - Node 18+ built-ins only.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  HENRIK_AFFINITIES,
  HENRIK_MODES,
  HENRIK_PLATFORMS,
  ProviderError,
  TRACKER_MATCH_TYPES,
  henrikAccount,
  henrikMatchDetail,
  henrikMatchList,
  makeRiotClient,
  riotMatchDetail,
  riotMatchList,
  trackerMatchDetail,
  trackerMatchList,
} from './providers.js';
import { makeTrackerBrowser } from './browser.js';
import {
  ANIM_TIER_COUNT,
  FONT_CHOICES,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_TYPES,
  PLAYERS_PER_SIDE,
  STAT_SLOTS,
  TEAM_REGIONS,
  WINNER_STAGES,
  WINNER_STAGE_COUNT,
  inDurationMs,
  isOverlayEntry,
  makeAssetCache,
  makeGraphicStore,
  makeMediaStore,
  makePresetStore,
  displayName,
  isAgentSelectScene,
  makeAliasStore,
  makeSelectStore,
  makeTeamStore,
  makeWinnerStore,
  ingestGame,
  ingestRoster,
  settleSelect,
  stopTimer,
  stageBands,
  stageEnterMs,
} from './graphics.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_DIR = path.join(ROOT, '.state');

/** Riot VAL platform routing hosts - match + content endpoints. */
const PLATFORM_HOSTS = ['ap', 'br', 'esports', 'eu', 'kr', 'latam', 'na'];
/** Riot regional routing hosts - account-v1. */
const ROUTING_HOSTS = ['americas', 'asia', 'esports', 'europe'];
const PROVIDERS = ['henrik', 'riot', 'tracker'];

// ---------------------------------------------------------------- config ---

/** Minimal .env reader. Real environment variables take precedence. */
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const splitAt = line.indexOf('=');
    if (splitAt === -1) continue;

    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function pick(value, allowed, fallback) {
  const candidate = (value ?? '').trim().toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}

const RIOT_API_KEY = (process.env.RIOT_API_KEY ?? '').trim();
const HENRIK_API_KEY = (process.env.HENRIK_API_KEY ?? '').trim();

// tracker.gg is driven from the public website - no API key. It needs a real
// browser: the site is Cloudflare-protected and loads matches by XHR.
const TRACKER_ENABLED = /^(1|true|yes)$/i.test((process.env.TRACKER_ENABLED ?? '').trim());
const TRACKER_HEADLESS = !/^(0|false|no)$/i.test((process.env.TRACKER_HEADLESS ?? 'true').trim());
const TRACKER_CHANNEL = (process.env.TRACKER_BROWSER_CHANNEL ?? 'auto').trim() || 'auto';
const browser = TRACKER_ENABLED
  ? makeTrackerBrowser({
      headless: TRACKER_HEADLESS,
      timeoutMs: Number(process.env.TRACKER_TIMEOUT_MS ?? 45_000),
      channel: TRACKER_CHANNEL,
    })
  : null;
const TRACKER_CONFIG = { browser };
const PORT = Number(process.env.PORT ?? 8080);
const DEFAULT_REGION = pick(process.env.RIOT_REGION, PLATFORM_HOSTS, 'na');
const DEFAULT_ROUTING = pick(process.env.RIOT_ROUTING, ROUTING_HOSTS, 'americas');
const DEFAULT_PROVIDER = pick(process.env.DEFAULT_PROVIDER, PROVIDERS, 'henrik');
const DEFAULT_AFFINITY = pick(process.env.HENRIK_AFFINITY, HENRIK_AFFINITIES, 'ap');
const DEFAULT_PLATFORM = pick(process.env.HENRIK_PLATFORM, HENRIK_PLATFORMS, 'pc');

const riotGet = makeRiotClient(RIOT_API_KEY);

// Broadcast graphic: state survives a restart, asset catalogue survives being
// offline. Both live in .state/ so nothing user-authored is at risk.
const graphics = makeGraphicStore(path.join(STATE_DIR, 'graphic.json'));
const winner = makeWinnerStore(path.join(STATE_DIR, 'winner.json'));
const presets = makePresetStore(path.join(STATE_DIR, 'presets.json'));
const teams = makeTeamStore(path.join(STATE_DIR, 'teams.json'));
const media = makeMediaStore(path.join(STATE_DIR, 'media'));
const select = makeSelectStore(path.join(STATE_DIR, 'select.json'));
const aliases = makeAliasStore(path.join(STATE_DIR, 'aliases.json'));
const assets = makeAssetCache(path.join(STATE_DIR, 'valorant-assets.json'));
const restoredGraphic = await graphics.load();
const restoredWinner = await winner.load();
const restoredSelect = await select.load();
await presets.load();
await teams.load();
await aliases.load();

/**
 * Auto-hide.
 *
 * Timed here rather than in the output page so that every browser source and the
 * dashboard agree the graphic came down - a page that hid itself would leave the
 * dashboard's Show button claiming it was still on air.
 *
 * The trigger is the cue counter, not `visible`: an operator adjusting the
 * roster during the hold should not keep resetting the clock. The boot value is
 * seeded here so restoring a visible graphic from disk does not count as a cue
 * and immediately hide it.
 */
let autoHideTimer = null;
let lastSeenCue = graphics.state.anim.cue;

graphics.subscribe(({ state }) => {
  const { cue, visible, holdMs } = state.anim;
  if (cue === lastSeenCue) return;
  lastSeenCue = cue;

  clearTimeout(autoHideTimer);
  autoHideTimer = null;
  if (!visible || !holdMs) return;

  // Measured from the last tier settling, so "hold for 8s" is eight seconds of
  // the graphic fully on screen rather than eight from the button press.
  autoHideTimer = setTimeout(() => {
    autoHideTimer = null;
    const anim = graphics.state.anim;
    if (!anim.visible) return; // hidden by hand in the meantime
    graphics.patch({ anim: { ...anim, visible: false, cue: anim.cue + 1 } });
  }, inDurationMs(state.anim, ANIM_TIER_COUNT) + holdMs);

  // A pending auto-hide must not be the reason the process stays alive.
  autoHideTimer.unref?.();
});

/**
 * The winner sequence driver.
 *
 * Same reasoning as auto-hide, one step further: the sequence has a position, so
 * something has to decide when scene 1 becomes scene 2. Doing it here rather
 * than in the output page means the dashboard's stage indicator, the preview and
 * every browser source are all reading the same position from the same place -
 * a page that advanced itself would leave three of them guessing.
 *
 * Every automatic move bumps the cue exactly like a button press, so the pages
 * cannot tell the difference and do not need to.
 */
let sequenceTimer = null;
let lastSeenSeqCue = winner.state.seq.cue;

function clearSequenceTimer() {
  clearTimeout(sequenceTimer);
  sequenceTimer = null;
}

function scheduleSequence(state) {
  clearSequenceTimer();

  const seq = state.seq;
  if (!seq.active || !seq.autoAdvance) return;

  const stage = WINNER_STAGES[seq.stage];
  if (!stage) return;

  const last = seq.stage >= WINNER_STAGE_COUNT - 1;
  // Nothing left to do: the last scene holds until an operator takes it off.
  if (last && !seq.exitAtEnd) return;

  // Measured from the scene's last band settling, so "hold on the map for 3s" is
  // three seconds of a finished scene rather than three from the cue.
  const bands = stageBands(state, stage.key);
  const wait = stageEnterMs(seq, bands, isOverlayEntry(seq)) + (seq[stage.hold] ?? 0);

  sequenceTimer = setTimeout(() => {
    sequenceTimer = null;
    const current = winner.state.seq;
    // Taken over by hand in the meantime - an operator's cue always wins.
    if (!current.active || current.cue !== seq.cue) return;

    winner.patch({
      seq: {
        ...current,
        active: !last,
        stage: last ? current.stage : current.stage + 1,
        restart: false,
        // The graphic coming off takes the music with it unless the operator
        // asked for it to carry on underneath whatever follows.
        music: last ? Boolean(winner.state.audio.keepPlaying) : current.music,
        cue: current.cue + 1,
      },
    });
  }, wait);

  sequenceTimer.unref?.();
}

winner.subscribe(({ state }) => {
  if (state.seq.cue === lastSeenSeqCue) return;
  lastSeenSeqCue = state.seq.cue;
  scheduleSequence(state);
});

/**
 * The agent select clock, expired on the server.
 *
 * The bar in the page fills itself off a start stamp and needs no help to look
 * right, so this exists purely to keep the *state* honest: once the 85 seconds
 * are up the clock is not running, and a dashboard opened a minute later should
 * not be told that it is. Without this the graphic would look finished while
 * every readout still claimed it was counting.
 *
 * Keyed on the start stamp rather than a cue, because restarting the clock is
 * the only thing that should ever cancel a pending expiry.
 */
let timerExpiry = null;
let lastTimerStart = null;

select.subscribe(({ state }) => {
  const { running, startedAt, durationMs } = state.timer;
  if (running && startedAt === lastTimerStart) return;

  clearTimeout(timerExpiry);
  timerExpiry = null;
  lastTimerStart = running ? startedAt : null;
  if (!running) return;

  const wait = Math.max(0, startedAt + durationMs - Date.now());
  timerExpiry = setTimeout(() => {
    timerExpiry = null;
    const current = select.state.timer;
    // Restarted or stopped by hand in the meantime - an operator always wins.
    if (!current.running || current.startedAt !== startedAt) return;
    select.replace(stopTimer(select.state, { filled: true }));
  }, wait);

  timerExpiry.unref?.();
});

// ----------------------------------------------------------------- riot ---

function splitRiotId(riotId) {
  const value = (riotId ?? '').trim();
  if (!value.includes('#')) {
    throw new ProviderError(400, 'Riot ID must include a tagline.', 'Use the full form, for example: TenZ#SEN');
  }

  const splitAt = value.lastIndexOf('#');
  const gameName = value.slice(0, splitAt).trim();
  const tagLine = value.slice(splitAt + 1).trim();

  if (!gameName || !tagLine) throw new ProviderError(400, 'Riot ID must look like Name#TAG.', 'Example: TenZ#SEN');
  return { gameName, tagLine };
}

// --------------------------------------------------------------- routes ---

async function handleApi(pathname, params) {
  const provider = pick(params.get('provider'), PROVIDERS, DEFAULT_PROVIDER);
  const region = pick(params.get('region'), PLATFORM_HOSTS, DEFAULT_REGION);
  const affinity = pick(params.get('affinity'), HENRIK_AFFINITIES, DEFAULT_AFFINITY);
  const platform = pick(params.get('platform'), HENRIK_PLATFORMS, DEFAULT_PLATFORM);

  const requestedType = params.get('type') ?? '';
  const allowedTypes = provider === 'henrik' ? HENRIK_MODES : TRACKER_MATCH_TYPES;
  const type = allowedTypes.includes(requestedType) ? requestedType : 'custom';

  switch (pathname) {
    case '/api/config':
      return {
        providers: PROVIDERS,
        provider: DEFAULT_PROVIDER,
        hasRiotKey: Boolean(RIOT_API_KEY),
        hasTrackerKey: Boolean(browser),
        hasHenrikKey: Boolean(HENRIK_API_KEY),
        region: DEFAULT_REGION,
        routing: DEFAULT_ROUTING,
        regions: PLATFORM_HOSTS,
        routings: ROUTING_HOSTS,
        matchTypes: TRACKER_MATCH_TYPES,
        affinity: DEFAULT_AFFINITY,
        affinities: HENRIK_AFFINITIES,
        platform: DEFAULT_PLATFORM,
        platforms: HENRIK_PLATFORMS,
        henrikModes: HENRIK_MODES,
        fonts: FONT_CHOICES,
        playersPerSide: PLAYERS_PER_SIDE,
        statSlots: STAT_SLOTS,
        // Distinct from `regions` above, which is Riot's platform routing.
        teamRegions: TEAM_REGIONS,
        mediaMaxBytes: MEDIA_MAX_BYTES,
      };

    case '/api/valorant-assets':
      return assets.get();

    case '/api/graphic':
      return { revision: graphics.revision, state: graphics.state };

    case '/api/winner':
      return { revision: winner.revision, state: winner.state };

    case '/api/select':
      return { revision: select.revision, state: select.state };

    case '/api/aliases':
      return { players: aliases.list() };

    case '/api/presets':
      return { presets: presets.list(), activeId: graphics.state.presetId };

    case '/api/teams':
      return { teams: teams.list() };

    case '/api/media':
      return { media: await media.list() };

    case '/api/account': {
      const { gameName, tagLine } = splitRiotId(params.get('riotId'));

      if (provider === 'henrik') {
        return henrikAccount(HENRIK_API_KEY, { gameName, tagLine });
      }

      // tracker.gg is keyed on the Riot ID itself - no puuid lookup needed,
      // so this pathway works without a Riot key at all.
      if (provider === 'tracker') {
        return { gameName, tagLine, puuid: null, handle: `${gameName}#${tagLine}` };
      }

      const routing = pick(params.get('routing'), ROUTING_HOSTS, DEFAULT_ROUTING);
      return riotGet(
        routing,
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      );
    }

    case '/api/matches': {
      if (provider === 'henrik') {
        const { gameName, tagLine } = splitRiotId(params.get('handle'));
        return henrikMatchList(HENRIK_API_KEY, {
          gameName,
          tagLine,
          affinity,
          platform,
          mode: type,
          puuid: (params.get('puuid') ?? '').trim() || null,
        });
      }

      if (provider === 'tracker') {
        const handle = (params.get('handle') ?? '').trim();
        if (!handle) throw new ProviderError(400, 'Missing Riot ID handle.');
        return trackerMatchList(TRACKER_CONFIG, { handle, type });
      }

      const puuid = (params.get('puuid') ?? '').trim();
      if (!puuid) throw new ProviderError(400, 'Missing puuid.');
      return riotMatchList(riotGet, { puuid, region });
    }

    case '/api/match': {
      const matchId = (params.get('matchId') ?? '').trim();
      if (!matchId) throw new ProviderError(400, 'Missing matchId.');

      if (provider === 'henrik') {
        return henrikMatchDetail(HENRIK_API_KEY, { matchId, affinity });
      }

      if (provider === 'tracker') {
        const handle = (params.get('handle') ?? '').trim();
        if (!handle) throw new ProviderError(400, 'Missing Riot ID handle.');
        return trackerMatchDetail(TRACKER_CONFIG, { matchId, handle, type });
      }

      return riotMatchDetail(riotGet, { matchId, region });
    }

    default:
      throw new ProviderError(404, `No such API route: ${pathname}`);
  }
}

// --------------------------------------------------------------- static ---

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname, res, method = 'GET') {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);

  // Block path traversal outside ./public.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 - forbidden');
  }

  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': file.length,
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - not found');
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ------------------------------------------------------- graphic plumbing ---

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Read a request body into one buffer, refusing anything over `limit`.
 *
 * Once over the limit the rest is drained rather than kept, and the socket is
 * left open: tearing it down here would reach the browser as a network failure
 * instead of as the 413 that says which limit was hit and by how much. The drain
 * has its own ceiling so a client that ignores the response cannot stream for
 * ever into a request nobody is going to answer.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (refused) {
        if (size > limit * 4) req.destroy();
        return;
      }

      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new ProviderError(413, `Payload too large - the limit is ${Math.round(limit / 1024)} KB.`));
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!refused) reject(error);
    });
  });
}

async function readJsonBody(req) {
  const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError(400, 'Payload was not valid JSON.');
  }
}

/**
 * Preset actions. Applying one writes into the live graphic, which is what
 * pushes it out to every open output source; the others only touch the library.
 */
async function handlePresetAction(body) {
  const action = String(body?.action ?? '');
  const id = String(body?.id ?? '');

  switch (action) {
    case 'apply': {
      const entry = presets.get(id);
      if (!entry) throw new ProviderError(404, `No preset called "${id}".`);
      // Only the styling block moves - never the scoreboard on air.
      graphics.patch({ preset: entry.preset, presetId: entry.id });
      break;
    }

    case 'save': {
      const saved = presets.save({ id: body?.id ?? null, name: body?.name, preset: body?.preset });
      // Adopt it so the dashboard shows the new preset as the active one.
      graphics.patch({ preset: saved.preset, presetId: saved.id });
      await presets.flush();
      return { presets: presets.list(), activeId: saved.id, saved };
    }

    case 'delete': {
      if (!presets.remove(id)) throw new ProviderError(400, 'That preset cannot be deleted.');
      await presets.flush();
      break;
    }

    default:
      throw new ProviderError(400, `Unknown preset action: ${action || '(none)'}`);
  }

  return { presets: presets.list(), activeId: graphics.state.presetId };
}

/**
 * Team library actions. Saving or deleting a team never touches a graphic: the
 * fields were copied on the way in, so what is on air stays on air.
 */
async function handleTeamAction(body) {
  const action = String(body?.action ?? '');

  switch (action) {
    case 'save': {
      const saved = teams.save(body?.team ?? {});
      await teams.flush();
      return { teams: teams.list(), saved };
    }

    case 'delete': {
      if (!teams.remove(String(body?.id ?? ''))) throw new ProviderError(404, 'No such team.');
      await teams.flush();
      return { teams: teams.list() };
    }

    default:
      throw new ProviderError(400, `Unknown team action: ${action || '(none)'}`);
  }
}

/**
 * Player alias actions.
 *
 * Saving an alias re-resolves the names on any card that came from the feed, so
 * naming somebody mid-lobby fixes the strip that is already on air rather than
 * waiting for their next event. Cards typed by hand have no player id and are
 * left exactly as they are - an operator's own words are not the library's to
 * overwrite.
 */
async function handleAliasAction(body) {
  const action = String(body?.action ?? '');

  const reresolve = () => {
    const slots = select.state.slots.map((slot) =>
      slot.playerId ? { ...slot, name: displayName(slot.riotId, aliases.aliasFor(slot.playerId)) } : slot,
    );
    if (slots.some((slot, index) => slot.name !== select.state.slots[index].name)) select.patch({ slots });
  };

  switch (action) {
    case 'save': {
      const players = aliases.save(body?.player ?? {});
      reresolve();
      return { players };
    }

    case 'delete': {
      const players = aliases.remove(String(body?.id ?? ''));
      reresolve();
      return { players };
    }

    case 'clear-unnamed':
      return { players: aliases.clearUnnamed() };

    default:
      throw new ProviderError(400, `Unknown alias action: ${action || '(none)'}`);
  }
}

/**
 * Server-sent events, one connection per output source. OBS keeps the page
 * open for the whole broadcast, so the heartbeat exists to stop an idle proxy
 * or the OS from quietly dropping a connection that then never updates again.
 *
 * @param {string} name the SSE event name the page listens for
 */
function streamStores(entries, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const unsubscribes = entries.map(([name, store]) => {
    const send = ({ revision, state }) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify({ revision, state })}\n\n`);
    };
    send({ revision: store.revision, state: store.state });
    return store.subscribe(send);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  const stop = () => {
    clearInterval(heartbeat);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
  req.on('close', stop);
  res.on('error', stop);
}

const streamState = (store, name, req, res) => streamStores([[name, store]], req, res);

/**
 * Uploads are the one thing served from outside ./public, so they get their own
 * handler rather than a second static root.
 *
 * The two headers are what make it safe to accept SVG at all: nosniff stops a
 * mislabelled file being reinterpreted, and a `default-src 'none'` policy means
 * script inside an SVG has nothing it is allowed to do even if the file is
 * opened directly rather than drawn into an <img>.
 */
async function serveMedia(pathname, res, method = 'GET') {
  const name = decodeURIComponent(pathname.slice('/media/'.length));
  const target = media.resolve(name);

  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 - not found');
  }

  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MEDIA_MIME_TYPES[path.extname(target).slice(1).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': file.length,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Named after their own hash, so a given URL is always the same bytes.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(method === 'HEAD' ? undefined : file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - not found');
  }
}

/** POST bodies all answer the same way, so the error shape is written once. */
async function handleWrite(res, work) {
  try {
    return sendJson(res, 200, await work());
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : 400;
    return sendJson(res, status, { error: { status, message: error.message } });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

  if (req.method === 'GET') {
    if (url.pathname === '/api/graphic/events') return streamState(graphics, 'graphic', req, res);
    if (url.pathname === '/api/winner/events') return streamState(winner, 'winner', req, res);
    if (url.pathname === '/api/select/events') return streamState(select, 'select', req, res);

    /*
     * Every graphic on one connection, for the dashboard.
     *
     * A browser allows six HTTP/1.1 connections to an origin, and a server-sent
     * event stream holds one open for as long as the page lives. The dashboard
     * has a module per graphic and a live preview of each, so one stream apiece
     * came to exactly six - at which point the seventh request, which is the
     * POST that saves what you just typed, queues behind connections that never
     * finish. The symptom is a dashboard stuck on "Saving..." for ever, with
     * nothing in the log to say why.
     *
     * The output pages keep their own single-store streams: each is a separate
     * browser source holding one connection, which was never the problem.
     */
    if (url.pathname === '/api/events') {
      return streamStores(
        [
          ['graphic', graphics],
          ['winner', winner],
          ['select', select],
        ],
        req,
        res,
      );
    }
  }

  // The two graphics and the two libraries are the mutable state, so these are
  // the writable routes; everything else stays read-only.
  if (req.method === 'POST') {
    switch (url.pathname) {
      case '/api/graphic':
        return handleWrite(res, async () => {
          const body = await readJsonBody(req);
          const state = body?.reset === true ? graphics.reset() : graphics.replace(body?.state ?? body);
          return { revision: graphics.revision, state };
        });

      case '/api/winner':
        return handleWrite(res, async () => {
          const body = await readJsonBody(req);
          const state = body?.reset === true ? winner.reset() : winner.replace(body?.state ?? body);
          return { revision: winner.revision, state };
        });

      case '/api/select':
        return handleWrite(res, async () => {
          const body = await readJsonBody(req);
          const previous = select.state;
          const written = body?.reset === true ? select.reset() : select.replace(body?.state ?? body);

          /*
           * Settled after the write rather than before it, because the rule reads
           * the sanitised board: an operator locking the last card by hand has
           * finished agent select, and the clock should shut for that the same
           * way it does for the feed. Only ever a second write on the one save
           * that completes the lobby - once the bar is shut this is a no-op.
           */
          const settled = settleSelect(previous, written);
          const state = settled === written ? written : select.replace(settled);
          return { revision: select.revision, state };
        });

      /*
       * The agent-select feed.
       *
       * A separate route from /api/select on purpose. That one takes a whole
       * graphic and replaces it, which is what a dashboard does; this one takes
       * whatever a client in the lobby happens to send and folds it in, which is
       * a different contract and wants a different name in whatever is
       * configured to call it.
       *
       * Answers with what changed rather than with the whole state: the caller
       * is a game client, not a dashboard, and "applied: 1" is a far more useful
       * thing to find in its log than ten cards of JSON.
       */
      case '/api/roster':
        return handleWrite(res, async () => {
          const result = ingestRoster(select.state, await readJsonBody(req), (id) => aliases.aliasFor(id));

          // Recorded before the state goes out, so a player who has just been
          // seen is already in the library by the time the dashboard repaints.
          aliases.seen(result.seen);

          /*
           * Saved when the state actually moved, which is not the same question
           * as whether an event was accepted. A post can change nothing a seat
           * can see and still finish the lobby - shutting the clock because the
           * last card was already locked, or clearing for a new game - and
           * keying this on `applied` threw those away. Identity is the honest
           * test: ingestRoster only rebuilds what it touched.
           */
          if (result.state !== select.state) select.replace(result.state);
          return {
            applied: result.applied,
            reset: result.reset,
            gameId: select.state.gameId,
            slots: select.state.slots.map((slot) => ({ name: slot.name, character: slot.character, locked: slot.locked })),
          };
        });

      /*
       * The general game feed - scenes and match facts.
       *
       * A second hook rather than a mode on the first, because the two are
       * different shapes doing different jobs: /api/roster addresses a seat and
       * says who is in it, this says what the game as a whole is doing. Whatever
       * is watching the client can point each of its features at its own URL
       * instead of at one that has to work out which it was sent.
       */
      case '/api/game':
        return handleWrite(res, async () => {
          const body = await readJsonBody(req);
          // Cached in memory after the first call, so this costs nothing per
          // event. Null when there is no network and nothing on disk, which the
          // written-down table covers.
          const catalogue = await assets.get().catch(() => null);
          const result = ingestGame(select.state, body, { catalogue });
          if (result.applied) select.replace(result.state);
          return {
            applied: result.applied,
            scene: select.state.scene,
            agentSelect: isAgentSelectScene(select.state.scene),
            entered: result.entered,
            left: result.left,
            map: select.state.mapName,
            onAir: select.state.anim.visible,
          };
        });

      case '/api/aliases':
        return handleWrite(res, async () => handleAliasAction(await readJsonBody(req)));

      case '/api/presets':
        return handleWrite(res, async () => handlePresetAction(await readJsonBody(req)));

      case '/api/teams':
        return handleWrite(res, async () => handleTeamAction(await readJsonBody(req)));

      // Raw bytes rather than multipart: there is exactly one file per request
      // and no other fields, so parsing a multipart envelope by hand would be
      // work with nothing to show for it. The declared type is ignored - the
      // store reads the format out of the bytes themselves.
      case '/api/media':
        return handleWrite(res, async () => media.save(await readBody(req, MEDIA_MAX_BYTES)));

      default:
        break;
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: { status: 405, message: 'Only GET is supported.' } });
  }

  if (url.pathname.startsWith('/media/')) {
    return serveMedia(url.pathname, res, req.method);
  }

  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(url.pathname, res, req.method);
  }

  try {
    sendJson(res, 200, await handleApi(url.pathname, url.searchParams));
  } catch (error) {
    const status = error instanceof ProviderError && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = error instanceof ProviderError ? error.message : `Unexpected server error: ${error.message}`;
    sendJson(res, status, { error: { status, message, hint: error.hint ?? '' } });
  }
});

// Don't leave a headless Chromium behind on Ctrl+C, and don't truncate an
// in-flight graphic save.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void Promise.all([graphics.flush(), winner.flush(), presets.flush(), teams.flush()])
      .catch(() => {})
      .then(() => browser?.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

server.listen(PORT, '127.0.0.1', () => {
  const line = '='.repeat(64);
  console.log(line);
  console.log('  Riotline Tool');
  console.log(line);
  console.log(`  UI              http://127.0.0.1:${PORT}`);
  console.log(`  OBS scoreboard  http://127.0.0.1:${PORT}/output.html   (1920x1080, transparent)`);
  console.log(`  OBS winner      http://127.0.0.1:${PORT}/winner.html   (1920x1080, full screen)`);
  console.log(`  OBS agent sel.  http://127.0.0.1:${PORT}/select.html   (1920x1080, transparent)`);
  console.log(`  Roster webhook  POST http://127.0.0.1:${PORT}/api/roster   (per-player picks and locks)`);
  console.log(`  Game webhook    POST http://127.0.0.1:${PORT}/api/game     (scene and map)`);
  console.log(`  Graphic state   ${restoredGraphic ? 'restored from .state/graphic.json' : 'defaults'}`);
  console.log(`  Winner state    ${restoredWinner ? 'restored from .state/winner.json' : 'defaults'}`);
  console.log(`  Select state    ${restoredSelect ? 'restored from .state/select.json' : 'defaults'}`);
  console.log(`  Default source  ${DEFAULT_PROVIDER}`);
  console.log(`  Riot region     ${DEFAULT_REGION} / routing ${DEFAULT_ROUTING}`);
  console.log(`  HenrikDev       ${HENRIK_API_KEY ? 'key loaded' : 'missing (HENRIK_API_KEY)'} | ${DEFAULT_AFFINITY}/${DEFAULT_PLATFORM}`);
  console.log(`  Riot key        ${RIOT_API_KEY ? 'loaded' : 'missing (RIOT_API_KEY)'}`);
  console.log(
    `  tracker.gg      ${browser ? `browser ready (${TRACKER_HEADLESS ? 'headless' : 'headed'})` : 'disabled (set TRACKER_ENABLED=true)'}`,
  );
  console.log('  Ctrl+C to stop');
  console.log(line);
});
