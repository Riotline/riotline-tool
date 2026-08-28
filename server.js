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

import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  PASSWORD_MIN,
  SESSION_TTL_MS,
  accessLevel,
  canOpenTrackerLogin,
  canEdit,
  canView,
  makeSessionStore,
  makeUserStore,
  publicUser,
} from './auth.js';
import { makeMediaOwners, makeSessionRegistry } from './sessions.js';
import { LOG_LEVELS, captureConsole, makeLogger, safeUrl as safeLogUrl } from './log.js';
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
  makeMediaStore,
  makeSettingsStore,
  aliasForPlayer,
  displayName,
  isAgentSelectScene,
  ingestGame,
  graphicPatch,
  ingestRoster,
  settleSelect,
  stopTimer,
  stageBands,
  stageEnterMs,
} from './graphics.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
/*
 * Where operator state lives.
 *
 * Relative to the checkout by default, which is right for a laptop. A container
 * points it at a mounted volume instead - everything that must survive a
 * redeploy is under this one directory, so the backup story is "copy this" and
 * the upgrade story is "the volume outlives the image".
 */
const STATE_DIR = path.resolve(ROOT, (process.env.STATE_DIR ?? '').trim() || '.state');

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

/*
 * tracker.gg is driven from the public website - no API key. It needs a real
 * browser: the site is Cloudflare-protected and loads matches by XHR.
 *
 * Two switches, and they answer different questions.
 *
 *   TRACKER_ENABLED (environment)  can this machine do it at all? Playwright
 *                                  installed, a Chromium to drive, a profile
 *                                  directory it may write to. A deployment fact,
 *                                  fixed at boot.
 *   settings.tracker (admin panel) should it, right now? An operational one -
 *                                  tracker.gg is throttling, or nobody wants a
 *                                  browser running during a show.
 *
 * Both have to be true. That is why the environment variable did not simply
 * become a setting: an administrator toggling a switch on a server with no
 * Chromium would be told it was on and then watch every lookup fail.
 */
const TRACKER_AVAILABLE = /^(1|true|yes)$/i.test((process.env.TRACKER_ENABLED ?? '').trim());
const TRACKER_HEADLESS = !/^(0|false|no)$/i.test((process.env.TRACKER_HEADLESS ?? 'true').trim());
const TRACKER_CHANNEL = (process.env.TRACKER_BROWSER_CHANNEL ?? 'auto').trim() || 'auto';

/**
 * The one browser, made on demand and dropped when the switch goes off.
 *
 * It used to be a `const` decided at boot, which is exactly what could not
 * survive a runtime toggle. Made lazily rather than eagerly so that switching
 * tracker off and leaving it off costs nothing at all - no Chromium, no profile
 * lock, no memory - which is half the reason an administrator would want the
 * switch.
 */
let browser = null;

function trackerBrowser() {
  if (!TRACKER_AVAILABLE || !settings.state.tracker) return null;
  browser ??= makeTrackerBrowser({
    headless: TRACKER_HEADLESS,
    timeoutMs: Number(process.env.TRACKER_TIMEOUT_MS ?? 45_000),
    channel: TRACKER_CHANNEL,
  });
  return browser;
}

/** Is the tracker source usable right now? Capability and permission, both. */
const trackerOn = () => TRACKER_AVAILABLE && settings.state.tracker;

/** Is the multi-account post-match watch allowed right now? */
const watchOn = () => settings.state.watch;

/**
 * The log.
 *
 * `LOG_LEVEL=debug` is the verbose mode: every request with its timing, every
 * SSE connection opening and closing, every state save. `info` is the default
 * and is what a show should produce - who signed in, what went on air, what the
 * game feed said, and anything that failed.
 *
 * An administrator can raise or lower it at runtime from the Admin tab, because
 * the moment you want debug output is the moment you cannot afford to restart
 * the server.
 */
const logger = makeLogger({
  level: (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase(),
  capacity: Number(process.env.LOG_BUFFER ?? 500),
});

// Anything written with console.warn or console.error - the state stores report
// a failed save that way - joins the buffer the admin panel reads. Installed
// after the logger, which captured the real console functions on construction.
captureConsole(logger);

/** Kept as a short name because it is used on nearly every other line below. */
const log = logger;

/**
 * Why tracker is unavailable, said in the terms of whoever can fix it.
 *
 * "Disabled" is the same word for two different problems - one an administrator
 * solves in the panel, the other somebody solves with an environment variable
 * and a restart. An operator staring at a failed lookup should be told which.
 */
const trackerOffReason = () =>
  TRACKER_AVAILABLE
    ? 'The tracker.gg source is switched off. An administrator can turn it back on under Admin > Server settings.'
    : 'The tracker.gg source is not available on this server. TRACKER_ENABLED is not set in its environment.';
/*
 * Where to listen, and whether the login cookie insists on HTTPS.
 *
 * The default is still loopback: run it on your own machine and nothing outside
 * it can reach the port, which is what a studio wants. A container has to bind
 * 0.0.0.0 or Docker's port publishing has nothing to forward to, so the image
 * sets HOST - it is a deployment decision and it should have to be made out
 * loud, not inherited from a default.
 *
 * COOKIE_SECURE follows the same shape. Behind the tunnel the browser only ever
 * speaks https, so the cookie should refuse to travel any other way; on
 * http://127.0.0.1 a Secure cookie is silently dropped and nobody can log in.
 */
const HOST = (process.env.HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const COOKIE_SECURE = /^(1|true|yes)$/i.test((process.env.COOKIE_SECURE ?? '').trim());

const TRACKER_LOGIN_PORT = Number(process.env.TRACKER_LOGIN_PORT ?? 6080);
const TRACKER_LOGIN_TIMEOUT_MS = Number(process.env.TRACKER_LOGIN_TIMEOUT_MS ?? 6 * 60 * 1000);
/*
 * A getter, not a captured value.
 *
 * providers.js reads `config.browser` at the moment it needs one, so this hands
 * it whatever the switch says now rather than whatever it said at boot. The
 * whole point of a runtime toggle is that a value captured once is wrong.
 */
const TRACKER_CONFIG = {
  get browser() {
    return trackerBrowser();
  },
};

/**
 * Who is looking something up right now, shared with every open dashboard.
 *
 * Deliberately not a makeStateStore: this is the state of a request in flight,
 * so it is meaningless across a restart and must never touch the disk. It only
 * has to satisfy the shape streamStores reads - a revision, a state, and a way
 * to subscribe.
 *
 * One slot per session, not one per server. Two operators looking up two
 * different matches at once used to overwrite each other's match list - the
 * feature was "a fetch on one dashboard fills in every other one", which is
 * exactly right within a production and exactly wrong across two of them.
 */
function makeLookupSlot() {
  let revision = 0;
  let state = {
    active: false,
    handle: '',
    type: '',
    startedAt: 0,
    finishedAt: 0,
    outcome: '',
    message: '',
    // The list itself, so every dashboard shows what was just fetched rather
    // than only the operator who asked for it.
    matches: null,
  };
  const listeners = new Set();

  const publish = (next) => {
    state = { ...state, ...next };
    revision += 1;
    for (const listener of listeners) {
      try {
        listener({ revision, state });
      } catch {
        /* a dead connection must not take the lookup down with it */
      }
    }
  };

  return {
    get revision() {
      return revision;
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    started(handle, type) {
      publish({ active: true, handle, type, startedAt: Date.now(), finishedAt: 0, outcome: '', message: '' });
    },
    /**
     * @param {object[]|null} matches the list to share, or null to leave the
     *   last one standing - a match-detail lookup has no list of its own, and
     *   blanking it would clear the dashboards mid-broadcast.
     */
    finished(outcome, message = '', matches = null) {
      publish({ active: false, finishedAt: Date.now(), outcome, message, ...(matches ? { matches } : {}) });
    },
  };
}

/**
 * A tracker.gg Cloudflare solve any operator can drive from their own browser.
 *
 * The clearance is bound to the IP and user agent that earned it, so the solve
 * has to happen in this container's Chrome. docker/tracker-login-session.sh
 * puts that browser on a throwaway X display and serves it over noVNC; all
 * this has to do is start one at a time, relay the progress, and make sure the
 * viewer does not outlive the solve.
 *
 * ponytail: state lives in this one object, so a restart mid-solve forgets the
 * session. The script's own EXIT trap still tears the browser down, which is
 * the part that matters.
 *
 * Server-wide, and it has to be: there is one Chromium profile and one noVNC
 * port, so this can never be per-session however many accounts exist. What
 * accounts change is who may drive it - see `canSolveTracker`. Everyone is told
 * a solve is running and by whom, because it takes the lookup browser away from
 * them; only the operator who started it and the administrators are told the
 * password, because that password is an interactive desktop on this machine.
 */
const trackerLogin = (() => {
  let revision = 0;
  let state = {
    active: false,
    phase: 'idle',
    message: '',
    webPort: TRACKER_LOGIN_PORT,
    startedAt: 0,
    password: '',
    startedBy: '',
    startedById: '',
  };
  let child = null;
  let timer = null;
  const listeners = new Set();

  const publish = (next) => {
    const before = state.phase;
    state = { ...state, ...next };
    revision += 1;

    /*
     * Every phase change, once.
     *
     * A solve is the one thing here that involves a human staring at a browser
     * for minutes, and when it goes wrong the useful question is always "how
     * far did it get?" - `starting` and no `ready` means the viewer stack never
     * came up, `ready` and no `passed` means nobody cleared the challenge. The
     * password is in `state` and is never in this line.
     */
    if (state.phase !== before) {
      const level = state.phase === 'failed' ? 'warn' : 'info';
      log[level]('tracker', `login ${state.phase}${state.message ? ` - ${state.message}` : ''}`, {
        by: state.startedBy || '-',
      });
    }

    for (const listener of listeners) {
      try {
        listener({ revision, state });
      } catch {
        /* a dead dashboard must not take the solve down with it */
      }
    }
  };

  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (child) {
      // Negative pid: the whole group, not just the script. SIGTERM so the
      // script's own trap still gets to run - it is what removes the X lock
      // that would otherwise stop the next session starting.
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone, or never made it into a group of its own.
        child.kill('SIGTERM');
      }
      child = null;
    }
  };

  return {
    get revision() {
      return revision;
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(user) {
      if (state.active) throw new ProviderError(409, 'A tracker login is already running.');
      if (!trackerOn()) throw new ProviderError(400, trackerOffReason());

      /*
       * Hand the profile over before starting.
       *
       * The server keeps its own browser warm on the very same profile
       * directory, and Chromium allows exactly one browser per profile. Leave
       * it running and the login's Chrome cannot open the profile at all: the
       * solve dies within seconds, and its teardown closes the viewer while the
       * operator is still watching it connect. The lookup browser reopens by
       * itself on the next request.
       */
      await browser?.close().catch(() => {});

      /*
       * Held in state so the viewer can autoconnect, and redacted on the way
       * out to everyone but the operator who started it and the admins.
       *
       * It used to be broadcast to every dashboard on the grounds that anyone
       * who could see it could start their own session anyway. Accounts remove
       * that premise: what this password opens is a real keyboard and mouse on
       * a real browser on the production machine, which is a bigger thing than
       * a viewer and should not be handed to a "viewer"-level guest who happens
       * to have a dashboard open.
       */
      const password = randomBytes(6).toString('base64url').slice(0, 8);

      // Its own process group, so a cancel can take the whole tree down. The
      // script starts Xvfb, x11vnc and websockify as children: signalling only
      // the script leaves those three running if it dies without its trap.
      child = spawn(path.join(ROOT, 'docker', 'tracker-login-session.sh'), [], {
        env: { ...process.env, VNC_PASSWORD: password, WEB_PORT: String(TRACKER_LOGIN_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      publish({
        active: true,
        phase: 'starting',
        message: 'Starting the browser...',
        startedAt: Date.now(),
        password,
        startedBy: user?.username ?? '',
        startedById: user?.id ?? '',
      });

      const readLines = (stream) => {
        let buffered = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buffered += chunk;
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('STATUS ')) continue;
            const [phase, ...rest] = line.slice('STATUS '.length).split(' ');
            publish({ phase, message: rest.join(' ') });
          }
        });
      };
      readLines(child.stdout);
      readLines(child.stderr);

      child.on('close', (code) => {
        clearTimeout(timer);
        timer = null;
        child = null;

        /*
         * The script reports its own outcome, so this only has to cover the
         * case where it died without saying anything.
         *
         * "closed" counts as a proper ending: pressing Done signals the browser
         * to shut down, which surfaces here as exit 143 (SIGTERM). Reporting
         * that as a failure told operators their solve had not worked when it
         * very likely had.
         */
        const TERMINAL = new Set(['passed', 'failed', 'closed']);
        if (TERMINAL.has(state.phase)) publish({ active: false, password: '' });
        else publish({ active: false, phase: 'failed', message: `the login exited with code ${code}`, password: '' });
      });

      child.on('error', (error) => {
        child = null;
        publish({ active: false, phase: 'failed', message: error.message, password: '' });
      });

      // tracker-login.js waits five minutes for a human; this is that plus room
      // to start up, after which the viewer is not left open indefinitely.
      timer = setTimeout(() => {
        publish({ phase: 'failed', message: 'nobody cleared the challenge in time' });
        stop();
      }, TRACKER_LOGIN_TIMEOUT_MS);

      return { password, webPort: TRACKER_LOGIN_PORT };
    },

    cancel() {
      if (!state.active) return { cancelled: false };
      stop();
      publish({ active: false, phase: 'closed', message: 'browser closed - run a lookup to confirm it took', password: '' });
      return { cancelled: true };
    },
  };
})();

/**
 * Announce a tracker lookup so the other dashboards can show it, and make sure
 * the "finished" always fires - an operator staring at a spinner that a thrown
 * error left running is worse than no indicator at all.
 */
async function announceLookup(lookups, handle, type, run) {
  // A lookup here would relaunch the browser on the profile the solve is using,
  // taking it back mid-challenge and losing both. It is one browser for the
  // whole server, so this waits on anybody's solve, not only your own - hence
  // the message naming who is holding it.
  if (trackerLogin.state.active) {
    const who = trackerLogin.state.startedBy ? ` (${trackerLogin.state.startedBy})` : '';
    throw new ProviderError(409, `A tracker login is in progress${who} - try again once it finishes.`);
  }

  lookups.started(handle, type);
  try {
    const result = await run();
    // Only a match list is worth sharing; a detail lookup answers a question
    // the asking dashboard already has open.
    lookups.finished('ok', '', Array.isArray(result?.matches) ? result.matches : null);
    return result;
  } catch (error) {
    lookups.finished('failed', error?.message ?? 'Lookup failed');
    throw error;
  }
}
const PORT = Number(process.env.PORT ?? 8080);
const DEFAULT_REGION = pick(process.env.RIOT_REGION, PLATFORM_HOSTS, 'na');
const DEFAULT_ROUTING = pick(process.env.RIOT_ROUTING, ROUTING_HOSTS, 'americas');
const DEFAULT_PROVIDER = pick(process.env.DEFAULT_PROVIDER, PROVIDERS, 'henrik');
const DEFAULT_AFFINITY = pick(process.env.HENRIK_AFFINITY, HENRIK_AFFINITIES, 'ap');
const DEFAULT_PLATFORM = pick(process.env.HENRIK_PLATFORM, HENRIK_PLATFORMS, 'pc');

const riotGet = makeRiotClient(RIOT_API_KEY);

/*
 * The two stores that stay server-wide, and why.
 *
 * media  - content-addressed by hash. Two operators uploading the same event
 *          logo get the same file, and every `/media/<hash>.<ext>` URL saved
 *          inside a graphic keeps resolving no matter who is looking at it.
 *          Sharding it per user would break exactly the feature that makes
 *          accounts worth having: handing your session to a colleague.
 * assets - the game's own catalogue of agents and maps. Identical for everyone
 *          by definition, and it is fetched by the output pages, which have no
 *          account at all.
 */
// The administrator's switches. Server-wide, like the two below it, because
// what they decide is what this machine does rather than what one show looks
// like - see public/settings-schema.js.
const settings = makeSettingsStore(path.join(STATE_DIR, 'settings.json'));
const media = makeMediaStore(path.join(STATE_DIR, 'media'));
const mediaOwners = makeMediaOwners(path.join(STATE_DIR, 'media-owners.json'));
const assets = makeAssetCache(path.join(STATE_DIR, 'valorant-assets.json'));
await mediaOwners.load();
await settings.load();

// Accounts, and the login tokens that stand for them. Separate files because
// they have separate lifetimes: signing out everywhere must not touch a
// password, and changing a password must not need the account rewritten.
const users = makeUserStore(path.join(STATE_DIR, 'users.json'));
const logins = makeSessionStore(path.join(STATE_DIR, 'logins.json'));
await users.load();
await logins.load();

/*
 * The first administrator, from the environment.
 *
 * There is no "create the first account" page, deliberately: a route that hands
 * out an admin account to whoever reaches it first is a race that a stranger
 * can win, and this server is reachable over a tunnel. Whoever can set an
 * environment variable already owns the machine, so that is the right place for
 * the one credential that has to exist before anybody can log in.
 */
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
let adminNote = users.count ? `${users.count} account${users.count === 1 ? '' : 's'}` : 'none yet';

if (ADMIN_USERNAME && ADMIN_PASSWORD) {
  const existing = users.byName(ADMIN_USERNAME);
  if (existing) {
    // Present but not re-applied. Rewriting the password on every boot would
    // mean a leaked .env silently undoes a password change made in the UI, and
    // would put the plaintext back in reach of anyone who can read the file.
    adminNote = `${users.count} account${users.count === 1 ? '' : 's'} (${ADMIN_USERNAME} already exists)`;
  } else {
    try {
      await users.create({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin' });
      adminNote = `created administrator "${ADMIN_USERNAME}"`;
    } catch (error) {
      adminNote = `could not create "${ADMIN_USERNAME}": ${error.message}`;
    }
  }
}

/*
 * One set of graphics per account, opened on first use.
 *
 * Everything below this line that used to be a module-level store now comes out
 * of a bundle. The drivers - auto-hide, the winner sequence, the agent-select
 * clock - are wired here rather than in sessions.js because what they do is
 * this file's business; only their lifetime is the registry's.
 */
const sessions = makeSessionRegistry({
  root: STATE_DIR,
  onCreate: installSession,
  log: (tag, message) => log.info(tag, message),
});

// Left where it is, and said out loud on boot. The single-user layout is not
// migrated: a graphic.json from before accounts existed has no owner, and
// guessing one would hand somebody else's production to whoever logs in first.
const legacyState = existsSync(path.join(STATE_DIR, 'graphic.json'));

/**
 * Wire one session's timers, and hand back the way to stop them.
 *
 * These three used to be module-level `let`s with one timer apiece, which is
 * the single most load-bearing assumption multi-user breaks: two productions
 * running at once each need their own auto-hide and their own agent-select
 * clock, and one shared `autoHideTimer` would have the second lobby cancelling
 * the first one's hide. Everything they need is now closed over per bundle.
 *
 * Called by the registry the moment a session opens, so a browser source that
 * connects before its operator has touched anything still gets a live clock.
 */
function installSession(bundle) {
  const { graphics, winner, select } = bundle;

  // Every session gets its own lookup slot - see makeLookupSlot. It is not a
  // persisted store, so the registry does not know about it.
  bundle.lookups = makeLookupSlot();

  /**
   * Auto-hide.
   *
   * Timed here rather than in the output page so that every browser source and
   * the dashboard agree the graphic came down - a page that hid itself would
   * leave the dashboard's Show button claiming it was still on air.
   *
   * The trigger is the cue counter, not `visible`: an operator adjusting the
   * roster during the hold should not keep resetting the clock. The boot value
   * is seeded here so restoring a visible graphic from disk does not count as a
   * cue and immediately hide it.
   */
  let autoHideTimer = null;
  let lastSeenCue = graphics.state.anim.cue;

  const stopGraphics = graphics.subscribe(({ state }) => {
    const { cue, visible, holdMs } = state.anim;
    if (cue === lastSeenCue) return;
    lastSeenCue = cue;

    /*
     * What went on air, and when.
     *
     * At info, because this is the log line a production actually wants
     * afterwards - "the scoreboard was up from 19:42:11 for eleven seconds" is
     * the answer to most questions asked after a show. The cue is exactly the
     * right trigger: it moves on an operator's intent and not on their typing.
     */
    log.info('air', `scoreboard ${visible ? 'on' : 'off'}`, {
      session: bundle.userId,
      ...(visible && holdMs ? { autoHideMs: holdMs } : {}),
    });

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
   * Same reasoning as auto-hide, one step further: the sequence has a position,
   * so something has to decide when scene 1 becomes scene 2. Doing it here
   * rather than in the output page means the dashboard's stage indicator, the
   * preview and every browser source are all reading the same position from the
   * same place - a page that advanced itself would leave three of them guessing.
   *
   * Every automatic move bumps the cue exactly like a button press, so the pages
   * cannot tell the difference and do not need to.
   */
  let sequenceTimer = null;
  let lastSeenSeqCue = winner.state.seq.cue;

  const clearSequenceTimer = () => {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  };

  function scheduleSequence(state) {
    clearSequenceTimer();

    const seq = state.seq;
    if (!seq.active || !seq.autoAdvance) return;

    const stage = WINNER_STAGES[seq.stage];
    if (!stage) return;

    const last = seq.stage >= WINNER_STAGE_COUNT - 1;
    // Nothing left to do: the last scene holds until an operator takes it off.
    if (last && !seq.exitAtEnd) return;

    // Measured from the scene's last band settling, so "hold on the map for 3s"
    // is three seconds of a finished scene rather than three from the cue.
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

  const stopWinner = winner.subscribe(({ state }) => {
    if (state.seq.cue === lastSeenSeqCue) return;
    lastSeenSeqCue = state.seq.cue;
    log.info('air', state.seq.active ? `winner sequence scene ${state.seq.stage + 1}` : 'winner sequence off', {
      session: bundle.userId,
    });
    scheduleSequence(state);
  });

  /**
   * The agent select clock, expired on the server.
   *
   * The bar in the page fills itself off a start stamp and needs no help to look
   * right, so this exists purely to keep the *state* honest: once the 85 seconds
   * are up the clock is not running, and a dashboard opened a minute later
   * should not be told that it is. Without this the graphic would look finished
   * while every readout still claimed it was counting.
   *
   * Keyed on the start stamp rather than a cue, because restarting the clock is
   * the only thing that should ever cancel a pending expiry.
   */
  let timerExpiry = null;
  let lastTimerStart = null;

  const stopSelect = select.subscribe(({ state }) => {
    const { running, startedAt, durationMs } = state.timer;
    if (running && startedAt === lastTimerStart) return;

    clearTimeout(timerExpiry);
    timerExpiry = null;
    // Only a real transition. Every state change on a board whose clock is not
    // running reaches here, so logging "stopped" unconditionally announced the
    // stopping of a clock that had never started - once per roster event.
    const wasRunning = lastTimerStart !== null;
    lastTimerStart = running ? startedAt : null;
    if (running || wasRunning) {
      log.info('air', running ? 'agent select clock started' : 'agent select clock stopped', {
        session: bundle.userId,
        ...(running ? { forMs: durationMs } : {}),
      });
    }

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

  bundle.teardown.push(() => {
    clearTimeout(autoHideTimer);
    clearSequenceTimer();
    clearTimeout(timerExpiry);
    stopGraphics();
    stopWinner();
    stopSelect();
  });
}

/** Flush everything a session holds. Called on shutdown and on eviction. */
const flushSession = (bundle) =>
  Promise.all([
    bundle.graphics.flush(),
    bundle.winner.flush(),
    bundle.select.flush(),
    bundle.globals.flush(),
    bundle.presets.flush(),
    bundle.teams.flush(),
  ]).catch(() => {});

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

async function handleApi(pathname, params, ctx) {
  // The session being read. Resolved by the gate, which has already checked
  // that whoever is asking is allowed to see it - by that point this is just
  // the set of stores to answer from.
  const { graphics, winner, select, globals, aliases, presets, teams, lookups } = ctx.bundle ?? {};

  // The configured default, unless it is the source an administrator has just
  // switched off - in which case falling back to it would break every lookup
  // that did not name a provider of its own.
  const fallbackProvider = DEFAULT_PROVIDER === 'tracker' && !trackerOn() ? 'henrik' : DEFAULT_PROVIDER;
  const provider = pick(params.get('provider'), PROVIDERS, fallbackProvider);
  const region = pick(params.get('region'), PLATFORM_HOSTS, DEFAULT_REGION);
  const affinity = pick(params.get('affinity'), HENRIK_AFFINITIES, DEFAULT_AFFINITY);
  const platform = pick(params.get('platform'), HENRIK_PLATFORMS, DEFAULT_PLATFORM);

  const requestedType = params.get('type') ?? '';
  const allowedTypes = provider === 'henrik' ? HENRIK_MODES : TRACKER_MATCH_TYPES;
  const type = allowedTypes.includes(requestedType) ? requestedType : 'custom';

  /*
   * The two administrator switches, enforced here rather than in the browser.
   *
   * Hiding a panel is a courtesy to an operator, not a control: the routes are
   * reachable by anyone with an account and a URL bar, and "the watch is off"
   * has to mean the server will not run one. The watch marks its own requests
   * because it has no route of its own - it is ordinary lookups, five at a
   * time, and five at a time is exactly the thing being switched off.
   */
  if (provider === 'tracker' && !trackerOn()) throw new ProviderError(400, trackerOffReason());
  if (params.get('watch') === '1' && !watchOn()) {
    throw new ProviderError(
      403,
      'Post-match lookup across several accounts is switched off on this server.',
      'An administrator can turn it back on under Admin > Server settings.',
    );
  }

  switch (pathname) {
    case '/api/config':
      return {
        providers: PROVIDERS,
        provider: fallbackProvider,
        hasRiotKey: Boolean(RIOT_API_KEY),
        // Named for what the lookup tab does with it - show the source or grey
        // it out - so an administrator's switch and a missing Playwright reach
        // the UI as the same fact, which is the only fact it can act on.
        hasTrackerKey: trackerOn(),
        hasHenrikKey: Boolean(HENRIK_API_KEY),
        // What the two administrator switches say, for the panels that have to
        // hide themselves. The server refuses either way; this is so an
        // operator is not offered a button that cannot work.
        trackerEnabled: trackerOn(),
        trackerAvailable: TRACKER_AVAILABLE,
        watchEnabled: watchOn(),
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

    case '/api/global':
      return { revision: globals.revision, state: globals.state };

    case '/api/aliases':
      // The pending list rides along: it is derived from the same records, and a
      // second round trip to ask "anything to confirm?" would only ever be made
      // at exactly the moments this one already is.
      return { players: aliases.list(), pending: aliases.pending() };

    case '/api/presets':
      return { presets: presets.list(), activeId: graphics.state.presetId };

    case '/api/teams':
      return { teams: teams.list() };

    case '/api/media':
      // Your own uploads, not the server's. The files are shared - the list of
      // them is not, or every dashboard's picker would be a window into every
      // other production's artwork.
      return { media: mediaOwners.filter(ctx.owner?.id, await media.list()) };

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
        return announceLookup(lookups, handle, type, () => trackerMatchList(TRACKER_CONFIG, { handle, type }));
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
        return announceLookup(lookups, handle, type, () => trackerMatchDetail(TRACKER_CONFIG, { matchId, handle, type }));
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
  // Inside the try, not before it: decodeURIComponent throws on a malformed
  // escape, and this used to be the outermost statement of an async handler -
  // so `GET /%ZZ` became an unhandled rejection, which under Node's default
  // means the process exits. One stranger, one request, broadcast over.
  let target;
  try {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    target = path.resolve(PUBLIC_DIR, relative);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 - bad request');
  }

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
async function handlePresetAction({ graphics, presets }, body) {
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
async function handleTeamAction({ teams }, body) {
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
/**
 * Copy whatever is shared onto the graphics that are following it.
 *
 * Patches only the keys that actually differ, so a save that changed the event
 * logo does not also re-push a map nobody touched - every push is an SSE frame
 * to every browser source, and a graphic that repaints for no reason is a
 * graphic that can flicker on air.
 *
 * @returns {string[]} the graphics that changed, for the caller to report.
 */
function pushGlobal({ graphics, winner, select, globals }) {
  const pushed = [];
  for (const [name, store] of [['graphic', graphics], ['winner', winner], ['select', select]]) {
    const patch = graphicPatch(globals.state, name, store.state);
    if (!patch) continue;
    store.patch(patch);
    pushed.push(name);
  }
  return pushed;
}

async function handleAliasAction({ graphics, select, aliases }, body) {
  const action = String(body?.action ?? '');

  const reresolve = () => {
    const slots = select.state.slots.map((slot) =>
      slot.playerId ? { ...slot, name: displayName(slot.riotId, aliases.aliasFor(slot.playerId, slot.riotId)) } : slot,
    );
    if (slots.some((slot, index) => slot.name !== select.state.slots[index].name)) select.patch({ slots });

    /*
     * And the scoreboard, for the same reason. A post-match board is on air for
     * minutes rather than seconds, so it is the graphic an operator is most
     * likely to be looking at when they notice a name is wrong.
     *
     * Matched on either key: an imported row may carry a puuid, a Riot ID, or -
     * from tracker.gg - only the second. A row with neither was typed by hand
     * and is left alone.
     */
    const library = aliases.list();
    const patch = {};
    for (const half of ['left', 'right']) {
      const current = graphics.state[half];
      const players = current.players.map((player) => {
        if (!player.playerId && !player.riotId) return player;
        // displayName is the same rule the strip uses: the alias if there is
        // one, otherwise the Riot ID without its tagline - so deleting an alias
        // undoes it rather than leaving the old name behind.
        const next = displayName(player.riotId, aliasForPlayer(library, player)) || player.name;
        return next === player.name ? player : { ...player, name: next };
      });
      if (players.some((player, index) => player !== current.players[index])) {
        // patch is a shallow merge of top-level keys, so the whole side goes.
        patch[half] = { ...current, players };
      }
    }
    if (Object.keys(patch).length) graphics.patch(patch);
  };

  switch (action) {
    case 'save': {
      const players = aliases.save(body?.player ?? {});
      reresolve();
      return { players, pending: aliases.pending() };
    }

    case 'delete': {
      const players = aliases.remove(String(body?.key ?? body?.id ?? ''));
      reresolve();
      return { players, pending: aliases.pending() };
    }

    /*
     * The two answers to "is this hand-written alias this player?".
     *
     * Asked rather than assumed, because a Riot ID is not a stable identity -
     * people rename themselves, and two events can both have a Jett. A name
     * match is enough to raise the question and never enough to settle it.
     */
    case 'link': {
      const players = aliases.link(String(body?.key ?? ''), String(body?.playerId ?? ''));
      reresolve();
      return { players, pending: aliases.pending() };
    }

    case 'reject': {
      const players = aliases.reject(String(body?.key ?? ''), String(body?.playerId ?? ''));
      reresolve();
      return { players, pending: aliases.pending() };
    }

    case 'clear-unnamed':
      return { players: aliases.clearUnnamed(), pending: aliases.pending() };

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
let streamCount = 0;

function streamStores(entries, req, res) {
  streamCount += 1;
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

  let stopped = false;
  const stop = () => {
    if (stopped) return; // close and error both fire on a dropped connection
    stopped = true;
    streamCount -= 1;
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
  // Same reasoning as serveStatic: a malformed escape must be a 404, not an
  // exit code.
  let target = null;
  try {
    target = media.resolve(decodeURIComponent(pathname.slice('/media/'.length)));
  } catch {
    target = null;
  }

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

// ------------------------------------------------------------- accounts ---

const COOKIE_NAME = 'rl_session';

/**
 * Cookies, parsed by hand.
 *
 * One header, one syntax, and the only cookie this server sets is its own -
 * a parser that gets confused by somebody else's is not a risk worth a
 * dependency. Anything malformed is skipped rather than thrown on: a stale
 * cookie from another app on the same host must not 500 the dashboard.
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return part.slice(at + 1).trim();
    }
  }
  return '';
}

/**
 * The login cookie.
 *
 * HttpOnly so a script on the page cannot read it - the whole reason the token
 * is not in localStorage. SameSite=Lax is what closes the CSRF hole the survey
 * found: this server reads JSON bodies without checking Content-Type, so a form
 * on another site could POST to it, and Lax means the browser sends no cookie
 * on that request. Secure is conditional because the tool is also run on plain
 * http://127.0.0.1 in a studio, and a Secure cookie there is simply dropped.
 */
const sessionCookie = (token, { maxAgeSec = Math.floor(SESSION_TTL_MS / 1000) } = {}) =>
  [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    ...(COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');

const clearedCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** The signed-in account behind a request, or null. */
function userFor(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const id = logins.userIdFor(token);
  if (!id) return null;
  const user = users.byId(id);
  // Disabled mid-session: the token stays valid on paper but the account is
  // not, and checking here means switching somebody off takes effect on their
  // next request rather than at their next login.
  if (!user || user.disabled) return null;

  // Recorded for the request log, which runs on `finish` and by then has no
  // other way to know who this was.
  req.rlUser = user.username;
  return user;
}

/**
 * Who is asking, whose graphics they are asking about, and what they may do.
 *
 * Two ways in, and they are deliberately not equal:
 *
 *   cookie  a person at a dashboard. Can address their own session or any
 *           session shared with them, and the level says whether they may write.
 *   ?key=   an OBS browser source or a game-client webhook. Identifies a
 *           session and nothing else - there is no person behind it, it ends up
 *           written into OBS configuration and read out over screen shares, and
 *           it is the weakest of the three secrets in this system by design.
 *           So it never reaches the dashboard API, only the routes in
 *           KEYED_ROUTES.
 *
 * @returns {{user: object|null, owner: object|null, bundle: object|null,
 *   level: 'owner'|'editor'|'viewer'|null, viaKey: boolean}}
 */
async function contextFor(req, url) {
  const key = url.searchParams.get('key');
  if (key) {
    req.rlViaKey = true;
    const owner = users.bySessionKey(key);
    if (!owner || owner.disabled) {
      // Worth a line of its own: a key that names nobody is either a rotated
      // one still sitting in an OBS source, or somebody guessing.
      log.warn('auth', 'a request arrived with a session key that matches no account', { path: safeLogUrl(req.url) });
      return { user: null, owner: null, bundle: null, level: null, viaKey: true };
    }
    req.rlUser = owner.username;
    return { user: null, owner, bundle: await sessions.get(owner.id), level: 'owner', viaKey: true };
  }

  const user = userFor(req);
  if (!user) return { user: null, owner: null, bundle: null, level: null, viaKey: false };

  // Whose production. Absent, it is your own - which is what every dashboard
  // asks for until somebody picks a shared session out of the target selector.
  const wanted = (url.searchParams.get('session') ?? '').trim();
  const owner = wanted ? users.byId(wanted) : user;
  if (!owner || owner.disabled) return { user, owner: null, bundle: null, level: null, viaKey: false };

  const level = accessLevel(user, owner);
  if (!canView(level)) return { user, owner, bundle: null, level: null, viaKey: false };

  return { user, owner, bundle: await sessions.get(owner.id), level, viaKey: false };
}

/**
 * Routes an OBS source or a game client may reach with `?key=`.
 *
 * Kept as an explicit list rather than a rule, because the interesting question
 * about every new route is which side of this line it falls on, and a list makes
 * that a decision somebody has to make rather than one a pattern makes for them.
 * Note what is not here: the libraries, the lookups, anything under /api/auth,
 * and anything that replaces a whole graphic. A key shows a graphic and feeds it
 * a lobby; it does not operate the desk.
 */
const KEYED_ROUTES = new Set([
  '/api/graphic',
  '/api/winner',
  '/api/select',
  '/api/global',
  '/api/graphic/events',
  '/api/winner/events',
  '/api/select/events',
  '/api/events',
  '/api/roster',
  '/api/game',
]);

/** The two webhooks. A key is the only credential a game client can carry. */
const WEBHOOK_ROUTES = new Set(['/api/roster', '/api/game']);

/** Routes only an administrator may reach. */
const isAdminRoute = (pathname) => pathname.startsWith('/api/admin/');

/**
 * Whoever is holding the one interactive browser this machine has.
 *
 * A per-account permission, off by default, granted on the Admin tab.
 *
 * Having an account is not enough, and the reason is that "viewer" is a property
 * of a *grant on one session*, never of a person - everyone owns their own
 * session, where they are the owner. So a check that only asked "are you signed
 * in?" let somebody who had been given a look at one production switch back to
 * their own dashboard and open an interactive desktop on the server. The
 * clearance a solve wins is shared, which is a good argument for letting more
 * than the admins do it and no argument at all for letting everybody.
 */
const canSolveTracker = (ctx) => canOpenTrackerLogin(ctx.user);

// Said the same way wherever it is refused, and it names who can change it -
// the operator reading this cannot, and guessing costs them the show.
const TRACKER_LOGIN_DENIED =
  'Your account is not allowed to open a tracker login. An administrator can allow it under Admin > Accounts.';

/** May this request see the noVNC password? */
const canSeeTrackerPassword = (ctx) =>
  Boolean(ctx.user) && (ctx.user.role === 'admin' || ctx.user.id === trackerLogin.state.startedById);

/**
 * A store seen through a filter, for the SSE fan-out.
 *
 * streamStores sends `store.state` verbatim to every subscriber, which is right
 * for a graphic and wrong for anything that differs by who is watching. Rather
 * than teach the stream about accounts, wrap the store: it satisfies the same
 * three-member shape and the stream never knows.
 */
const filteredView = (store, filter) => ({
  get revision() {
    return store.revision;
  },
  get state() {
    return filter(store.state);
  },
  subscribe: (listener) => store.subscribe(({ revision, state }) => listener({ revision, state: filter(state) })),
});

const trackerLoginView = (ctx) =>
  filteredView(trackerLogin, (state) => (canSeeTrackerPassword(ctx) ? state : { ...state, password: '' }));

const unauthorised = (res, status, message) => sendJson(res, status, { error: { status, message } });

/**
 * The three Content-Types an HTML form can send.
 *
 * A cross-site form post arrives with the browser's cookies attached and no way
 * for us to tell it apart from the real dashboard, which is what CSRF is. It
 * cannot, however, set a Content-Type outside this list without triggering a
 * preflight, and this server answers no preflight at all. So refusing these
 * three on a cookie-authenticated write closes the hole with one comparison -
 * both the JSON saves and the raw-bytes media upload send something else.
 *
 * SameSite=Lax on the cookie already blocks the same attack. Two independent
 * mechanisms, because this is the request that puts something on air.
 */
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

const looksCrossSite = (req) => {
  const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return !declared || FORM_TYPES.includes(declared);
};

/**
 * A URL, or null if the client sent something that cannot be one.
 *
 * `decodeURIComponent` throws on a malformed escape, and it used to sit outside
 * every try block in this file - so `GET /%ZZ` reached an unhandled rejection
 * inside an async request handler, which under Node's default is a process
 * exit. An unauthenticated stranger could stop the broadcast server with one
 * request and nothing in the log would say why.
 */
function safeUrl(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    return null;
  }
}

/**
 * Login attempts, counted per address.
 *
 * Deliberately crude - a Map that empties itself, no dependency, no store. The
 * threat is somebody working through a password list against a dashboard on a
 * public hostname, and 200ms of scrypt per attempt already makes that slow;
 * this makes it slow *and* finite. It counts failures only, so an operator
 * signing in ten times in a morning is never affected.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();

function loginBlocked(from) {
  const entry = loginFailures.get(from);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(from);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(from) {
  const entry = loginFailures.get(from);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(from, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

/**
 * Every session this account can reach, for the dashboard's target selector.
 *
 * Yours first, then the ones other operators have shared with you. An admin is
 * not silently given every session here: administering accounts and taking over
 * somebody's live broadcast are different powers, and an admin who needs to
 * drive a production is granted access to it like anybody else.
 */
const visibleSessions = (user) =>
  users
    .list()
    .filter((owner) => !owner.disabled && canView(accessLevel(user, owner)))
    .map((owner) => {
      const level = accessLevel(user, owner);
      return {
        id: owner.id,
        username: owner.username,
        level,
        live: sessions.has(owner.id),
        // Editors get the key, viewers do not. An editor can already put things
        // on air through the dashboard, so withholding the OBS URL would only
        // stop them setting up the browser source for the show they are running.
        // A viewer writing nothing must not be handed a webhook.
        ...(canEdit(level) ? { sessionKey: owner.sessionKey } : {}),
      };
    })
    .sort((a, b) => (a.level === 'owner' ? -1 : b.level === 'owner' ? 1 : a.username.localeCompare(b.username)));

/** Accounts that could be granted access, for the Access panel's picker. */
const grantableUsers = (user) =>
  users
    .list()
    .filter((other) => other.id !== user.id && !other.disabled)
    .map((other) => ({ id: other.id, username: other.username, level: user.grants?.[other.id] ?? '' }))
    .sort((a, b) => a.username.localeCompare(b.username));

// ---------------------------------------------------------------- routes ---

async function handleAuth(pathname, req, res) {
  switch (pathname) {
    /*
     * Whether anybody exists yet.
     *
     * The login page asks so it can say "no accounts - set ADMIN_USERNAME"
     * rather than leave somebody guessing at a password that was never made.
     * It answers one boolean and no names: whether the server has been set up
     * is not a secret, who is on it is.
     */
    case '/api/auth/state':
      return sendJson(res, 200, { empty: users.count === 0, secure: COOKIE_SECURE });

    case '/api/auth/login': {
      if (req.method !== 'POST') return unauthorised(res, 405, 'Use POST.');

      const from = req.socket.remoteAddress ?? 'unknown';
      if (loginBlocked(from)) {
        log.warn('auth', 'sign-in blocked - too many failures from this address', { from });
        return unauthorised(res, 429, 'Too many failed sign-ins. Wait fifteen minutes and try again.');
      }

      const body = await readJsonBody(req);
      const user = await users.verify(body?.username, body?.password);

      if (!user) {
        noteLoginFailure(from);
        // The username is kept because it is what makes the line useful - a
        // colleague's typo and somebody working through a list look completely
        // different, and only the attempted name tells them apart.
        log.warn('auth', 'sign-in refused', { username: String(body?.username ?? '').slice(0, 32), from });
        // One message for "no such account", "wrong password" and "disabled".
        // Three messages would tell somebody working through a list which
        // usernames are real, which is half of what they came for.
        return unauthorised(res, 401, 'Wrong username or password.');
      }

      loginFailures.delete(from);
      log.info('auth', `${user.username} signed in`, { role: user.role, from });
      // So the request line for the sign-in itself names them too. There was no
      // cookie on the way in, so nothing else has stamped it.
      req.rlUser = user.username;
      const token = logins.create(user.id);
      // Opened here rather than on their first save, so the auto-hide and the
      // agent-select clock are running before they touch anything.
      await sessions.get(user.id);

      res.setHeader('Set-Cookie', sessionCookie(token));
      return sendJson(res, 200, { user: publicUser(user, { includeKey: true }) });
    }

    case '/api/auth/logout': {
      if (req.method !== 'POST') return unauthorised(res, 405, 'Use POST.');
      log.info('auth', `${userFor(req)?.username ?? 'somebody'} signed out`);
      logins.destroy(readCookie(req, COOKIE_NAME));
      res.setHeader('Set-Cookie', clearedCookie());
      return sendJson(res, 200, { ok: true });
    }

    default:
      return unauthorised(res, 404, `No such route: ${pathname}`);
  }
}

/**
 * The account pages: who am I, change my password, rotate my key, share my
 * session. All of it is about the *caller's own* account - there is no id
 * parameter anywhere in here, so no amount of guessing reaches somebody else's.
 */
async function handleAccount(pathname, req, res, ctx) {
  const user = ctx.user;

  if (pathname === '/api/account/me') {
    return sendJson(res, 200, {
      user: publicUser(user, { includeKey: true }),
      sessions: visibleSessions(user),
      grantable: grantableUsers(user),
      passwordMin: PASSWORD_MIN,
    });
  }

  if (req.method !== 'POST') return unauthorised(res, 405, 'Use POST.');

  switch (pathname) {
    case '/api/account/password':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        // The current password, even though they are already signed in. It is
        // the difference between "somebody walked past an unlocked dashboard"
        // and "somebody has the account".
        if (!(await users.verify(user.username, body?.current))) {
          throw new ProviderError(403, 'That is not your current password.');
        }
        await users.update(user.id, { password: String(body?.password ?? '') });

        // Every other login for this account goes. A password change that left
        // an intruder's session running would be a password change that did
        // nothing about the reason it was made.
        log.info('account', `${user.username} changed their password`);
        const token = readCookie(req, COOKIE_NAME);
        logins.destroyFor(user.id);
        const fresh = logins.create(user.id);
        res.setHeader('Set-Cookie', sessionCookie(fresh));
        return { ok: true, signedOutElsewhere: token ? true : false };
      });

    /*
     * A new session key, which changes every OBS and webhook URL this account
     * has. Destructive on purpose and never automatic: it is the thing to press
     * when a key has been on a stream, and the cost is walking round OBS.
     */
    case '/api/account/key':
      return handleWrite(res, async () => {
        await users.rotateSessionKey(user.id);
        // Worth a line at info: every OBS source and both webhooks for this
        // account have just stopped working, and somebody will ask why.
        log.info('account', `${user.username} made a new session key - their OBS and webhook URLs changed`);
        return { user: publicUser(users.byId(user.id), { includeKey: true }) };
      });

    case '/api/account/grant':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const granteeId = String(body?.userId ?? '');
        const level = String(body?.level ?? '');
        if (granteeId === user.id) throw new ProviderError(400, 'You already own this session.');
        if (!users.byId(granteeId)) throw new ProviderError(404, 'No such account.');

        // Held on the owner, so revoking is one write and deleting an account
        // cannot leave a grant pointing at nobody.
        const updated = await users.setGrant(user.id, granteeId, level);
        log.info(
          'account',
          level
            ? `${user.username} gave ${users.byId(granteeId)?.username} ${level} access to their graphics`
            : `${user.username} revoked ${users.byId(granteeId)?.username}'s access`,
        );
        return { user: publicUser(updated, { includeKey: true }), grantable: grantableUsers(updated) };
      });

    default:
      return unauthorised(res, 404, `No such route: ${pathname}`);
  }
}

/**
 * Administration.
 *
 * Making accounts, switching them off, and looking at what the server is doing.
 * Not included, deliberately: reading or writing anybody's graphics. An admin
 * who needs to operate a production is granted access to it the same way a
 * colleague would be, and that grant is visible to its owner.
 */
async function handleAdmin(pathname, req, res, ctx) {
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    return sendJson(res, 200, {
      users: users.list().map((user) => ({
        ...publicUser(user),
        live: sessions.has(user.id),
        logins: 0,
      })),
      passwordMin: PASSWORD_MIN,
    });
  }

  /*
   * The server switches.
   *
   * `available` is sent alongside each value because two of the three states an
   * operator can be in look identical from a boolean: off because somebody
   * turned it off, and off because this deployment cannot do it. The panel says
   * which, and only the first is a switch worth offering.
   */
  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    return sendJson(res, 200, {
      settings: settings.state,
      available: { tracker: TRACKER_AVAILABLE },
    });
  }

  if (pathname === '/api/admin/settings' && req.method === 'POST') {
    return handleWrite(res, async () => {
      const body = await readJsonBody(req);
      const before = settings.state;
      const state = settings.replace({ ...before, ...(body?.settings ?? body) });

      /*
       * The browser follows the switch immediately.
       *
       * Turning tracker off has to actually stop the Chromium - leaving it
       * running would make the switch a label rather than a control, and the
       * memory and the profile lock are half the reason to throw it. Turning it
       * on does not start one: `trackerBrowser` makes it on first use, and the
       * first use is a lookup that is about to warm it up anyway.
       */
      if (before.tracker && !state.tracker && browser) {
        const closing = browser;
        browser = null;
        // Not awaited: a Chromium that will not close must not hold up the
        // response to a switch that has, as far as this server is concerned,
        // already been thrown.
        void closing.close().catch(() => {});
        log.info('settings', 'tracker switched off - closing the browser', { by: ctx.user.username });
      }
      if (!before.tracker && state.tracker) log.info('settings', 'tracker switched on', { by: ctx.user.username });
      if (before.watch !== state.watch) {
        log.info('settings', `post-match watch switched ${state.watch ? 'on' : 'off'}`, { by: ctx.user.username });
      }

      // A solve in progress on a source that has just been switched off has
      // nothing left to earn clearance for.
      if (!state.tracker && trackerLogin.state.active) trackerLogin.cancel();

      await settings.flush();
      return { settings: state, available: { tracker: TRACKER_AVAILABLE } };
    });
  }

  /*
   * The log, for the Admin tab.
   *
   * Served from the ring buffer rather than a file, because the person who
   * needs it is standing at a desk with OBS open and cannot get to a shell.
   * `since` is a sequence number so the panel can poll for what it has not seen
   * instead of re-rendering the lot - two lines can share a millisecond, and a
   * clock can go backwards.
   */
  if (pathname === '/api/admin/logs' && req.method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    return sendJson(res, 200, {
      entries: log.recent({
        limit: Math.min(500, Math.max(1, Number(params.get('limit') ?? 200))),
        level: params.get('level') ?? 'debug',
        since: Number(params.get('since') ?? 0),
        tag: params.get('tag') ?? '',
      }),
      cursor: log.cursor,
      level: log.level,
      levels: LOG_LEVELS,
      held: log.size,
    });
  }

  /*
   * Turn verbose logging on without a restart.
   *
   * The moment you want debug output is the moment you cannot afford to bounce
   * the server - something is wrong during a broadcast, and restarting takes
   * every graphic off air to find out why.
   */
  if (pathname === '/api/admin/logs' && req.method === 'POST') {
    return handleWrite(res, async () => {
      const body = await readJsonBody(req);
      const wanted = String(body?.level ?? '');
      if (!LOG_LEVELS.includes(wanted)) throw new ProviderError(400, `Unknown log level: ${wanted || '(none)'}`);

      // Written before the change and at warn, so it is recorded under both the
      // old level and the new one. Logged at info, turning the log down to
      // `warn` would have erased the record of who turned it down.
      log.warn('admin', `${ctx.user.username} set the log level to ${wanted}`, { from: log.level });
      log.setLevel(wanted);
      return { level: log.level, levels: LOG_LEVELS };
    });
  }

  if (pathname === '/api/admin/health' && req.method === 'GET') {
    const memory = process.memoryUsage();
    return sendJson(res, 200, {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      accounts: users.count,
      logins: logins.count,
      openSessions: sessions.size,
      liveSessions: sessions.list(),
      streams: streamCount,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapMb: Math.round(memory.heapUsed / 1024 / 1024),
      tracker: {
        available: TRACKER_AVAILABLE,
        enabled: trackerOn(),
        loginActive: trackerLogin.state.active,
        loginPhase: trackerLogin.state.phase,
        startedBy: trackerLogin.state.startedBy,
        browserOpen: Boolean(browser),
      },
      watch: watchOn(),
      providers: {
        henrik: Boolean(HENRIK_API_KEY),
        riot: Boolean(RIOT_API_KEY),
      },
      host: HOST,
      port: PORT,
      cookieSecure: COOKIE_SECURE,
      logLevel: log.level,
      logHeld: log.size,
    });
  }

  if (pathname !== '/api/admin/users' || req.method !== 'POST') {
    return unauthorised(res, 404, `No such route: ${pathname}`);
  }

  return handleWrite(res, async () => {
    const body = await readJsonBody(req);
    const action = String(body?.action ?? '');
    const id = String(body?.id ?? '');
    const target = id ? users.byId(id) : null;
    if (id && !target) throw new ProviderError(404, 'No such account.');

    // The last administrator cannot be removed, demoted or switched off. Not a
    // policy so much as a locked door with the key inside: there is no route
    // that makes an admin except this one, so a server with none is a server
    // that has to be repaired from a shell.
    const lastAdmin =
      target?.role === 'admin' && users.list().filter((user) => user.role === 'admin' && !user.disabled).length <= 1;

    switch (action) {
      case 'create': {
        const created = await users.create({
          username: body?.username,
          password: body?.password,
          role: body?.role === 'admin' ? 'admin' : 'user',
        });
        log.info('admin', `${ctx.user.username} created the account "${created.username}"`, { role: created.role });
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })), created: publicUser(created) };
      }

      case 'update': {
        const changes = {};
        if (typeof body?.username === 'string') changes.username = body.username;
        if (typeof body?.password === 'string' && body.password) changes.password = body.password;
        if (body?.role === 'admin' || body?.role === 'user') changes.role = body.role;
        if (typeof body?.disabled === 'boolean') changes.disabled = body.disabled;
        if (typeof body?.trackerLogin === 'boolean') changes.trackerLogin = body.trackerLogin;

        if (lastAdmin && (changes.role === 'user' || changes.disabled === true)) {
          throw new ProviderError(400, 'This is the last administrator.');
        }

        await users.update(id, changes);
        // What changed, not the values - `changes` carries a password when one
        // was set, and the log is served to a browser.
        log.info('admin', `${ctx.user.username} changed the account "${target.username}"`, {
          changed: Object.keys(changes).join(', ') || '(nothing)',
        });

        // A disabled account's dashboards should stop working now, not when
        // their cookie happens to expire.
        if (changes.disabled === true || changes.password) logins.destroyFor(id);
        if (changes.disabled === true) sessions.dispose(id);
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      case 'delete': {
        if (lastAdmin) throw new ProviderError(400, 'This is the last administrator.');
        if (id === ctx.user.id) throw new ProviderError(400, 'Delete your own account from another administrator.');

        // At warn, not info: this deletes their graphics, presets, teams and
        // aliases with them, and it is the one action here that cannot be undone.
        log.warn('admin', `${ctx.user.username} deleted the account "${target.username}" and all of its state`);
        logins.destroyFor(id);
        await sessions.destroy(id);
        await users.remove(id);
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      /** Close every login for an account without touching the password. */
      case 'sign-out': {
        const removed = logins.destroyFor(id);
        log.info('admin', `${ctx.user.username} signed "${target.username}" out everywhere`, { logins: removed });
        return { removed, users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      default:
        throw new ProviderError(400, `Unknown user action: ${action || '(none)'}`);
    }
  });
}

/**
 * noVNC, served through this origin instead of its own port.
 *
 * websockify listens inside the container only. Publishing it would put the
 * viewer on a second port, and a second port is exactly what a Cloudflare
 * tunnel cannot carry - gfx.maahir.dev maps to this port and nothing else. So
 * the page and its websocket are proxied under /tracker-login/, which means
 * the viewer works over the tunnel, on the LAN, and on localhost without the
 * client having to know where it really lives.
 */
const TRACKER_LOGIN_PREFIX = '/tracker-login';

/**
 * What goes upstream to websockify.
 *
 * Everything except the login cookie. websockify has no use for it and no
 * concept of it, and forwarding a session token to a process whose whole job is
 * to hand a socket to a browser is the kind of thing that is fine right up
 * until websockify logs its request headers.
 */
const upstreamHeaders = (req) => {
  const headers = { ...req.headers, host: `127.0.0.1:${TRACKER_LOGIN_PORT}` };
  delete headers.cookie;
  delete headers.authorization;
  return headers;
};

function proxyTrackerLogin(req, res) {
  if (!trackerLogin.state.active) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No tracker login is running.');
    return;
  }

  // Trailing path only: websockify serves noVNC from its own root, and the
  // page's asset links are relative to wherever it was served from.
  const upstreamPath = req.url.slice(TRACKER_LOGIN_PREFIX.length) || '/';

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: TRACKER_LOGIN_PORT,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders(req),
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );

  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The login viewer is not reachable.');
  });

  req.pipe(upstream);
}

/**
 * The viewer's websocket, forwarded raw.
 *
 * Nothing here understands the VNC protocol - the handshake is replayed
 * upstream and the two sockets are then piped together, which is all a
 * websocket proxy has to be when both ends already agree on the protocol.
 */
function proxyTrackerLoginSocket(req, socket, head) {
  if (!trackerLogin.state.active) {
    socket.destroy();
    return;
  }

  const upstreamPath = req.url.slice(TRACKER_LOGIN_PREFIX.length) || '/';
  const upstream = netConnect(TRACKER_LOGIN_PORT, '127.0.0.1', () => {
    const headers = upstreamHeaders(req);
    const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
    upstream.write(`GET ${upstreamPath} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  socket.on('error', drop);
}

/**
 * One request.
 *
 * Split out of createServer so that every path through it, including the ones
 * that throw, ends up inside the one try below. An async handler that rejects
 * is an unhandled rejection, and an unhandled rejection under Node's default
 * settings is a process exit - which for this server means the graphics come
 * off air. There is no error worth that.
 */
async function route(req, res) {
  const url = safeUrl(req);
  if (!url) return unauthorised(res, 400, 'That URL is not valid.');

  const { pathname } = url;

  /*
   * The noVNC viewer. Behind the same permission that opens a solve, not merely
   * behind a login: what is on the other end is a real keyboard on a real
   * browser on this machine, not a picture of one.
   *
   * The password already stops anyone else connecting, so this is the second
   * lock rather than the first - but it makes the rule one rule, and it closes
   * the case of somebody who may not open a solve being handed a password by
   * somebody who may.
   */
  if (pathname === TRACKER_LOGIN_PREFIX || pathname.startsWith(`${TRACKER_LOGIN_PREFIX}/`)) {
    const user = userFor(req);
    if (!user) return unauthorised(res, 401, 'Sign in first.');
    if (!canOpenTrackerLogin(user)) return unauthorised(res, 403, TRACKER_LOGIN_DENIED);
    return proxyTrackerLogin(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    return unauthorised(res, 405, 'Only GET and POST are supported.');
  }

  // Uploads. Named after their own hash, so the name is the credential: 64 bits
  // of it, unguessable, and known already to anyone holding the same bytes.
  // Gating this would break every OBS source, which carries a session key and
  // no cookie, for no gain.
  if (pathname.startsWith('/media/')) {
    if (req.method === 'POST') return unauthorised(res, 405, 'Use POST /api/media to upload.');
    return serveMedia(pathname, res, req.method);
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'POST') return unauthorised(res, 405, 'Only GET is supported.');

    /*
     * The dashboard, for somebody who is not signed in.
     *
     * A redirect rather than a 403: this is the one page a person types in by
     * hand, and bouncing them to the login with their destination attached is
     * the difference between a tool that works and one that scolds. Nothing is
     * being protected here - index.html holds no data, and every route it calls
     * is checked on its own - so this is a courtesy, not the fence.
     */
    if ((pathname === '/' || pathname === '/index.html') && !userFor(req)) {
      const next = encodeURIComponent(pathname === '/' ? '/' : pathname);
      res.writeHead(302, { Location: `/login.html?next=${next}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    return serveStatic(pathname, res, req.method);
  }

  // Anything a page needs before it has an account: the login itself, the
  // server's own configuration, and the game's asset catalogue - which the
  // output pages fetch, and they have no account at all.
  if (pathname.startsWith('/api/auth/')) return handleAuth(pathname, req, res);

  /*
   * Liveness, for a container's HEALTHCHECK.
   *
   * Its own route rather than reusing /api/config, because a health check has no
   * cookie and no session key and never will - so it has to be something that is
   * deliberately outside the gate and safe to leave there. It answers three
   * facts, none of them a secret: the process is up, it can serve, and how long
   * it has been doing so. Nothing about accounts, nothing about what is on air.
   */
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), version: 1 });
  }

  if (pathname === '/api/config' || pathname === '/api/valorant-assets') {
    return sendJson(res, 200, await handleApi(pathname, url.searchParams, { bundle: null }));
  }

  // ------------------------------------------------------------- the gate ---

  const ctx = await contextFor(req, url);

  if (ctx.viaKey) {
    // A session key on a route that is not a browser source or a webhook. It
    // lives in OBS configuration and gets read out over screen shares, so it
    // opens exactly two doors and this is not one of them.
    if (!KEYED_ROUTES.has(pathname)) return unauthorised(res, 403, 'That key is only good for the output pages and the webhooks.');
    if (!ctx.bundle) return unauthorised(res, 404, 'No session has that key. It may have been rotated.');
  } else if (!ctx.user) {
    // A webhook says so plainly rather than talking about signing in - what is
    // reading the answer is a game client's log, not a person.
    return WEBHOOK_ROUTES.has(pathname)
      ? unauthorised(res, 401, 'Add ?key=<session key> to this URL. Copy it from the dashboard.')
      : unauthorised(res, 401, 'Sign in first.');
  }

  if (isAdminRoute(pathname)) {
    if (ctx.user?.role !== 'admin') return unauthorised(res, 403, 'Administrators only.');
    return handleAdmin(pathname, req, res, ctx);
  }

  if (pathname.startsWith('/api/account/')) {
    if (req.method === 'POST' && looksCrossSite(req)) return unauthorised(res, 415, 'Send JSON.');
    return handleAccount(pathname, req, res, ctx);
  }

  if (!ctx.bundle) {
    return unauthorised(res, 403, ctx.owner ? 'You do not have access to that session.' : 'No such session.');
  }

  if (req.method === 'POST') {
    // Two independent CSRF defences; see FORM_TYPES. The key path is exempt
    // because there is no cookie on it - nothing to ride.
    if (!ctx.viaKey && looksCrossSite(req)) return unauthorised(res, 415, 'Send JSON.');

    /*
     * Read-only means read-only.
     *
     * Checked here, once, rather than in each handler: a viewer who found the
     * URL of a save is exactly the case a per-handler check gets wrong by
     * omission when somebody adds the eleventh write route.
     */
    if (!canEdit(ctx.level)) return unauthorised(res, 403, 'You have view-only access to this session.');

    return handlePost(pathname, req, res, ctx);
  }

  if (req.method === 'GET' && (await handleStream(pathname, req, res, ctx))) return undefined;

  try {
    return sendJson(res, 200, await handleApi(pathname, url.searchParams, ctx));
  } catch (error) {
    const status = error instanceof ProviderError && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = error instanceof ProviderError ? error.message : `Unexpected server error: ${error.message}`;
    return sendJson(res, status, { error: { status, message, hint: error.hint ?? '' } });
  }
}

/** The SSE routes. Returns true if this request was one. */
async function handleStream(pathname, req, res, ctx) {
  const { graphics, winner, select, globals, lookups } = ctx.bundle;

  if (pathname === '/api/graphic/events') return streamState(graphics, 'graphic', req, res), true;
  if (pathname === '/api/winner/events') return streamState(winner, 'winner', req, res), true;
  if (pathname === '/api/select/events') return streamState(select, 'select', req, res), true;

  /*
   * Every graphic on one connection, for the dashboard.
   *
   * A browser allows six HTTP/1.1 connections to an origin, and a server-sent
   * event stream holds one open for as long as the page lives. The dashboard
   * has a module per graphic and a live preview of each, so one stream apiece
   * came to exactly six - at which point the seventh request, which is the POST
   * that saves what you just typed, queues behind connections that never
   * finish. The symptom is a dashboard stuck on "Saving..." for ever, with
   * nothing in the log to say why.
   *
   * The output pages keep their own single-store streams: each is a separate
   * browser source holding one connection, which was never the problem.
   */
  if (pathname === '/api/events') {
    streamStores(
      [
        ['graphic', graphics],
        ['winner', winner],
        ['select', select],
        ['global', globals],
        ['lookup', lookups],
        // The one entry that is not this session's: there is a single browser
        // on this machine, so a solve concerns everybody. Filtered so the
        // password reaches only whoever started it.
        ['trackerLogin', trackerLoginView(ctx)],
      ],
      req,
      res,
    );
    return true;
  }

  return false;
}

/** The write routes. `ctx.bundle` is the session, and it may be written to. */
async function handlePost(pathname, req, res, ctx) {
  const bundle = ctx.bundle;
  const { graphics, winner, select, globals, aliases } = bundle;

  switch (pathname) {
    // Starting a login is a POST because it launches a browser; the progress
    // comes back on the same event stream as everything else.
    case '/api/tracker/login':
      return handleWrite(res, async () => {
        if (!canSolveTracker(ctx)) throw new ProviderError(403, TRACKER_LOGIN_DENIED);
        return trackerLogin.start(ctx.user);
      });

    case '/api/tracker/login/cancel':
      return handleWrite(res, async () => {
        // Whoever started it, or an admin. Anyone else cancelling would be
        // taking a half-solved challenge away from the person solving it.
        if (!ctx.user || (ctx.user.role !== 'admin' && ctx.user.id !== trackerLogin.state.startedById)) {
          throw new ProviderError(403, 'Only the operator who started this login can close it.');
        }
        return trackerLogin.cancel();
      });

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

    /*
     * The production's own settings, and the push that keeps the graphics in
     * step with them.
     *
     * One way on purpose. The Global tab owns the value and the graphics follow
     * it while their sync is on; a graphic never pushes back. Two-way would mean
     * an operator correcting the winner sequence's map silently rewriting the
     * scoreboard that is on air behind it, and there would be no way to tell
     * which of the two had won.
     */
    case '/api/global':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const state = globals.replace(body?.state ?? body);
        return { revision: globals.revision, state, pushed: pushGlobal(bundle) };
      });

    case '/api/select':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const previous = select.state;
        const written = body?.reset === true ? select.reset() : select.replace(body?.state ?? body);

        /*
         * Settled after the write rather than before it, because the rule reads
         * the sanitised board: an operator locking the last card by hand has
         * finished agent select, and the clock should shut for that the same way
         * it does for the feed. Only ever a second write on the one save that
         * completes the lobby - once the bar is shut this is a no-op.
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
     * whatever a client in the lobby happens to send and folds it in, which is a
     * different contract and wants a different name in whatever is configured to
     * call it.
     *
     * Answers with what changed rather than with the whole state: the caller is
     * a game client, not a dashboard, and "applied: 1" is a far more useful
     * thing to find in its log than ten cards of JSON.
     */
    case '/api/roster':
      return handleWrite(res, async () => {
        const result = ingestRoster(select.state, await readJsonBody(req), (id, riotId) => aliases.aliasFor(id, riotId));

        // Recorded before the state goes out, so a player who has just been seen
        // is already in the library by the time the dashboard repaints.
        aliases.seen(result.seen);

        /*
         * Saved when the state actually moved, which is not the same question as
         * whether an event was accepted. A post can change nothing a seat can
         * see and still finish the lobby - shutting the clock because the last
         * card was already locked, or clearing for a new game - and keying this
         * on `applied` threw those away. Identity is the honest test:
         * ingestRoster only rebuilds what it touched.
         */
        if (result.state !== select.state) select.replace(result.state);

        // At debug: a lobby produces ten of these, and one line each is noise
        // right up until the moment you need every one of them.
        log.debug('feed', `roster: ${result.applied} applied`, {
          session: ctx.owner?.id,
          reset: result.reset,
          locked: select.state.slots.filter((slot) => slot.locked).length,
        });

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
        // The feed knowing the map is the whole reason to share one: the game
        // says it once and every graphic gets it.
        if (result.state.mapName && result.state.mapName !== select.state.mapName) {
          globals.patch({ mapName: result.state.mapName });
        }
        if (result.applied) select.replace(result.state);

        // A scene change is different from a roster event: it drives the
        // automation toggles, so it is worth a line at info even when the ten
        // events around it are not.
        if (result.entered || result.left) {
          log.info('feed', `agent select ${result.entered ? 'started' : 'ended'}`, {
            session: ctx.owner?.id,
            map: select.state.mapName || '-',
          });
        }

        pushGlobal(bundle);
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
      return handleWrite(res, async () => handleAliasAction(bundle, await readJsonBody(req)));

    case '/api/presets':
      return handleWrite(res, async () => handlePresetAction(bundle, await readJsonBody(req)));

    case '/api/teams':
      return handleWrite(res, async () => handleTeamAction(bundle, await readJsonBody(req)));

    // Raw bytes rather than multipart: there is exactly one file per request and
    // no other fields, so parsing a multipart envelope by hand would be work
    // with nothing to show for it. The declared type is ignored - the store
    // reads the format out of the bytes themselves.
    case '/api/media':
      return handleWrite(res, async () => {
        const saved = await media.save(await readBody(req, MEDIA_MAX_BYTES));
        // Recorded against the account that uploaded it so the media browser
        // shows your own files rather than the whole server's. The bytes stay
        // shared - see makeMediaOwners.
        await mediaOwners.claim(ctx.owner?.id ?? ctx.user?.id, saved.name);
        log.info('media', `${ctx.user?.username ?? 'somebody'} uploaded ${saved.name}`, { bytes: saved.bytes });
        return saved;
      });

    default:
      return unauthorised(res, 404, `No such route: ${pathname}`);
  }
}

/**
 * One line per request, once it has finished.
 *
 * On `finish` rather than at the start, so the line carries the status and how
 * long it took - which is the whole reason to have it. For an event stream that
 * means the line appears when the browser source disconnects, and the duration
 * is how long it was watching: exactly the question asked after a source drops
 * mid-show.
 *
 * The level is the status, because that is what makes a log skimmable: a 500 is
 * an error, a refusal is a warning, a write is worth seeing at info, and the
 * hundreds of ordinary reads belong at debug where they can be switched on.
 *
 * The health check is dropped entirely. Docker runs it every thirty seconds
 * forever, and a log whose bulk is "the server is still up" is a log nobody
 * reads the rest of.
 */
function logRequest(req, res, startedAt) {
  const path = safeLogUrl(req.url);
  if (path === '/api/health') return;

  const status = res.statusCode;
  const ms = Date.now() - startedAt;
  // Stamped on the request by userFor and contextFor as they resolve it, which
  // is the only place that knows. "(key)" marks a browser source or a game
  // client rather than a person at a dashboard.
  const who = req.rlUser ? `${req.rlUser}${req.rlViaKey ? ' (key)' : ''}` : req.rlViaKey ? 'unknown key' : '-';
  const meta = { status, ms, who };

  const line = `${req.method} ${path}`;
  if (status >= 500) log.error('request', line, meta);
  else if (status >= 400) log.warn('request', line, meta);
  else if (req.method === 'POST') log.info('request', line, meta);
  else log.debug('request', line, meta);
}

const server = createServer((req, res) => {
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));

  void route(req, res).catch((error) => {
    // Last resort. Everything below this has its own error shape; what reaches
    // here is a bug, and the only thing that must not happen is the process
    // going down with it.
    log.error('request', `${req.method} ${safeLogUrl(req.url)} threw`, { error: error?.stack ?? String(error) });
    if (res.headersSent) return res.destroy();
    sendJson(res, 500, { error: { status: 500, message: 'Unexpected server error.' } });
  });
});

// Don't leave a headless Chromium behind on Ctrl+C, and don't truncate an
// in-flight graphic save.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Every open session, not one - and the login table, whose lastSeen stamps
    // are held in memory between writes on purpose.
    logins.flush();
    void Promise.all(sessions.list().map((id) => flushSession(sessions.peek(id))))
      .catch(() => {})
      .then(() => browser?.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

server.on('upgrade', (req, socket, head) => {
  // The same check the HTTP side does. An upgrade that skipped it would be a way
  // to reach the VNC socket without one, which is the whole door - and the
  // websocket is the half that carries the keystrokes.
  if (req.url?.startsWith(`${TRACKER_LOGIN_PREFIX}/`) && canOpenTrackerLogin(userFor(req))) {
    return proxyTrackerLoginSocket(req, socket, head);
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  const line = '='.repeat(64);
  console.log(line);
  console.log('  Riotline Tool');
  console.log(line);
  console.log(`  UI              http://${shown}:${PORT}`);
  console.log(`  Listening on    ${HOST}:${PORT}${HOST === '0.0.0.0' ? '  (every interface - container mode)' : '  (this machine only)'}`);
  console.log('  OBS + webhooks  per account, with ?key= - copy them from the dashboard');
  console.log(`  Accounts        ${adminNote}`);
  console.log(`  Logins          ${logins.count} open`);
  if (legacyState) {
    console.log('  Note            .state/graphic.json is from before accounts and is NOT in use.');
    console.log('                  Each account now has its own under .state/users/<id>/.');
  }
  console.log(`  Default source  ${DEFAULT_PROVIDER}`);
  console.log(`  Riot region     ${DEFAULT_REGION} / routing ${DEFAULT_ROUTING}`);
  console.log(`  HenrikDev       ${HENRIK_API_KEY ? 'key loaded' : 'missing (HENRIK_API_KEY)'} | ${DEFAULT_AFFINITY}/${DEFAULT_PLATFORM}`);
  console.log(`  Riot key        ${RIOT_API_KEY ? 'loaded' : 'missing (RIOT_API_KEY)'}`);
  console.log(
    `  tracker.gg      ${
      !TRACKER_AVAILABLE
        ? 'unavailable (set TRACKER_ENABLED=true)'
        : trackerOn()
          ? `enabled (${TRACKER_HEADLESS ? 'headless' : 'headed'})`
          : 'switched off by an administrator'
    }`,
  );
  console.log(`  Post-match      ${watchOn() ? 'multi-account watch enabled' : 'multi-account watch switched off'}`);
  console.log(`  Logging         ${log.level}  (LOG_LEVEL; debug is verbose, and the Admin tab can change it live)`);
  console.log('  Ctrl+C to stop');
  console.log(line);

  // Launch the browser now rather than on the first lookup: it spends its first
  // page load warming up, and that is better spent before a show than during it.
  // Through trackerBrowser, so a server booted with the switch off starts no
  // Chromium at all - which is most of what the switch is for.
  const warm = trackerBrowser();
  if (warm) {
    void warm.prepare().then((ok) =>
      ok ? log.info('tracker', 'browser warmed') : log.warn('tracker', 'browser could not start'),
    );
  }
});
