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
  PLAYERS_PER_SIDE,
  STAT_SLOTS,
  inDurationMs,
  makeAssetCache,
  makeGraphicStore,
  makePresetStore,
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
const presets = makePresetStore(path.join(STATE_DIR, 'presets.json'));
const assets = makeAssetCache(path.join(STATE_DIR, 'valorant-assets.json'));
const restoredGraphic = await graphics.load();
await presets.load();

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
      };

    case '/api/valorant-assets':
      return assets.get();

    case '/api/graphic':
      return { revision: graphics.revision, state: graphics.state };

    case '/api/presets':
      return { presets: presets.list(), activeId: graphics.state.presetId };

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

/** Read a JSON request body, capped - this endpoint is the only writable one. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ProviderError(413, 'Graphic payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ProviderError(400, 'Graphic payload was not valid JSON.'));
      }
    });

    req.on('error', reject);
  });
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
 * Server-sent events, one connection per output source. OBS keeps the page
 * open for the whole broadcast, so the heartbeat exists to stop an idle proxy
 * or the OS from quietly dropping a connection that then never updates again.
 */
function streamGraphic(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = ({ revision, state }) => {
    res.write(`event: graphic\ndata: ${JSON.stringify({ revision, state })}\n\n`);
  };

  send({ revision: graphics.revision, state: graphics.state });

  const unsubscribe = graphics.subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  const stop = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', stop);
  res.on('error', stop);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

  if (url.pathname === '/api/graphic/events' && req.method === 'GET') {
    return streamGraphic(req, res);
  }

  // The graphic is the one piece of mutable state, so it is the one writable
  // route; everything else stays read-only.
  if (url.pathname === '/api/graphic' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const state = body?.reset === true ? graphics.reset() : graphics.replace(body?.state ?? body);
      return sendJson(res, 200, { revision: graphics.revision, state });
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 400;
      return sendJson(res, status, { error: { status, message: error.message } });
    }
  }

  if (url.pathname === '/api/presets' && req.method === 'POST') {
    try {
      return sendJson(res, 200, await handlePresetAction(await readJsonBody(req)));
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 400;
      return sendJson(res, status, { error: { status, message: error.message } });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: { status: 405, message: 'Only GET is supported.' } });
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
    void Promise.all([graphics.flush(), presets.flush()])
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
  console.log(`  OBS source      http://127.0.0.1:${PORT}/output.html   (1920x1080, transparent)`);
  console.log(`  Graphic state   ${restoredGraphic ? 'restored from .state/graphic.json' : 'defaults'}`);
  console.log(`  Default source  ${DEFAULT_PROVIDER}`);
  console.log(`  Riot region     ${DEFAULT_REGION} / routing ${DEFAULT_ROUTING}`);
  console.log(`  HenrikDev       ${HENRIK_API_KEY ? 'key loaded' : 'missing (HENRIK_API_KEY)'} | ${DEFAULT_AFFINITY}/${DEFAULT_PLATFORM}`);
  console.log(`  Riot key        ${RIOT_API_KEY ? 'loaded' : 'missing (RIOT_API_KEY)'}`);
  console.log(
    `  tracker.gg      ${browser ? `browser ready (${TRACKER_HEADLESS ? 'headless' : 'headed'})` : 'disabled (set TRACKER_ENABLED=true)'}`,
  );
  console.log('  Ctrl+C to stop');
  console.log(line);

  // Launch the browser now rather than on the first lookup: it spends its first
  // page load warming up, and that is better spent before a show than during it.
  if (browser) {
    void browser.prepare().then((ok) => console.log(`  tracker.gg      ${ok ? 'browser warmed' : 'browser could not start'}`));
  }
});
