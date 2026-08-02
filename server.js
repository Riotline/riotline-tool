/**
 * VALORANT Broadcast Production Tool - local server.
 *
 * Serves the static UI from ./public and proxies the official Riot Games API.
 * The proxy exists for two reasons: the Riot API blocks browser CORS requests,
 * and the API key must never be shipped to the client.
 *
 * Zero npm dependencies - Node 18+ built-ins only.
 *
 *   node server.js
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Riot VAL platform routing hosts - match + content endpoints. */
const PLATFORM_HOSTS = ['ap', 'br', 'esports', 'eu', 'kr', 'latam', 'na'];
/** Riot regional routing hosts - account-v1. */
const ROUTING_HOSTS = ['americas', 'asia', 'esports', 'europe'];

const CONTENT_TTL_MS = 6 * 60 * 60 * 1000;

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

const API_KEY = (process.env.RIOT_API_KEY ?? '').trim();
const PORT = Number(process.env.PORT ?? 8080);
const DEFAULT_REGION = pick(process.env.RIOT_REGION, PLATFORM_HOSTS, 'na');
const DEFAULT_ROUTING = pick(process.env.RIOT_ROUTING, ROUTING_HOSTS, 'americas');

function pick(value, allowed, fallback) {
  const candidate = (value ?? '').trim().toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}

// ------------------------------------------------------------- riot layer ---

class RiotError extends Error {
  constructor(status, message, hint = '') {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

function hintFor(status) {
  if (status === 401 || status === 403) {
    return (
      'Riot rejected the key. Either RIOT_API_KEY is missing/expired, or the key lacks ' +
      'access to val-match-v1 - the VALORANT match endpoints require an approved Riot ' +
      'production key, development keys typically return 403.'
    );
  }
  if (status === 404) return 'Not found. Check the Riot ID spelling and tagline, and that the routing region is correct.';
  if (status === 429) return 'Rate limited by Riot. Wait a few seconds and try again.';
  if (status >= 500) return "Riot's API returned a server error - this one is on their side. Retry shortly.";
  return '';
}

function messageFromBody(status, body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.status?.message) return `Riot API ${status}: ${parsed.status.message}`;
  } catch {
    /* body was not JSON - fall through */
  }
  return `Riot API returned HTTP ${status}.`;
}

async function riotGet(host, endpoint, searchParams) {
  if (!API_KEY) {
    throw new RiotError(
      500,
      'No Riot API key configured.',
      'Copy .env.example to .env, set RIOT_API_KEY, then restart the server.',
    );
  }

  const url = new URL(`https://${host}.api.riotgames.com${endpoint}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        'X-Riot-Token': API_KEY,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'val-broadcast-tool/1.0',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'the request timed out' : error.message;
    throw new RiotError(502, `Could not reach the Riot API: ${reason}`, 'Check network/proxy access.');
  }

  const body = await response.text();

  if (!response.ok) {
    throw new RiotError(response.status, messageFromBody(response.status, body), hintFor(response.status));
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new RiotError(502, 'Riot API returned a response that was not valid JSON.');
  }
}

/** VAL-CONTENT-V1 lookup tables (agents, maps, ranks), cached per region. */
const contentCache = new Map();

async function getContent(region) {
  const cached = contentCache.get(region);
  if (cached && Date.now() - cached.at < CONTENT_TTL_MS) return cached.data;

  const raw = await riotGet(region, '/val/content/v1/contents', { locale: 'en-US' });
  const data = {
    version: raw.version,
    characters: (raw.characters ?? []).map(({ id, name, assetName }) => ({ id, name, assetName })),
    maps: (raw.maps ?? []).map(({ id, name, assetPath, assetName }) => ({ id, name, assetPath, assetName })),
    competitiveTiers: raw.competitiveTiers ?? [],
  };

  contentCache.set(region, { at: Date.now(), data });
  return data;
}

function splitRiotId(riotId) {
  const value = (riotId ?? '').trim();
  if (!value.includes('#')) {
    throw new RiotError(400, 'Riot ID must include a tagline.', 'Use the full form, for example: TenZ#SEN');
  }

  const splitAt = value.lastIndexOf('#');
  const gameName = value.slice(0, splitAt).trim();
  const tagLine = value.slice(splitAt + 1).trim();

  if (!gameName || !tagLine) throw new RiotError(400, 'Riot ID must look like Name#TAG.', 'Example: TenZ#SEN');
  return { gameName, tagLine };
}

// ----------------------------------------------------------------- routes ---

async function handleApi(pathname, params) {
  switch (pathname) {
    case '/api/config':
      return {
        hasKey: Boolean(API_KEY),
        region: DEFAULT_REGION,
        routing: DEFAULT_ROUTING,
        regions: PLATFORM_HOSTS,
        routings: ROUTING_HOSTS,
      };

    case '/api/account': {
      const { gameName, tagLine } = splitRiotId(params.get('riotId'));
      const routing = pick(params.get('routing'), ROUTING_HOSTS, DEFAULT_ROUTING);
      return riotGet(
        routing,
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      );
    }

    case '/api/matches': {
      const puuid = (params.get('puuid') ?? '').trim();
      if (!puuid) throw new RiotError(400, 'Missing puuid.');
      const region = pick(params.get('region'), PLATFORM_HOSTS, DEFAULT_REGION);
      return riotGet(region, `/val/match/v1/matchlists/by-puuid/${encodeURIComponent(puuid)}`);
    }

    case '/api/match': {
      const matchId = (params.get('matchId') ?? '').trim();
      if (!matchId) throw new RiotError(400, 'Missing matchId.');
      const region = pick(params.get('region'), PLATFORM_HOSTS, DEFAULT_REGION);
      return riotGet(region, `/val/match/v1/matches/${encodeURIComponent(matchId)}`);
    }

    case '/api/content':
      return getContent(pick(params.get('region'), PLATFORM_HOSTS, DEFAULT_REGION));

    default:
      throw new RiotError(404, `No such API route: ${pathname}`);
  }
}

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: { status: 405, message: 'Only GET is supported.' } });
  }

  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(url.pathname, res, req.method);
  }

  try {
    sendJson(res, 200, await handleApi(url.pathname, url.searchParams));
  } catch (error) {
    const status = error instanceof RiotError && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = error instanceof RiotError ? error.message : `Unexpected server error: ${error.message}`;
    sendJson(res, status, { error: { status, message, hint: error.hint ?? '' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const line = '='.repeat(62);
  console.log(line);
  console.log('  VALORANT Broadcast Production Tool');
  console.log(line);
  console.log(`  UI          http://127.0.0.1:${PORT}`);
  console.log(`  Region      ${DEFAULT_REGION}  (match + content routing)`);
  console.log(`  Routing     ${DEFAULT_ROUTING}  (account lookup)`);
  console.log(`  API key     ${API_KEY ? 'loaded' : 'MISSING - set RIOT_API_KEY in .env'}`);
  console.log('  Ctrl+C to stop');
  console.log(line);
});
