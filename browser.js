/**
 * Playwright driver for the tracker.gg source.
 *
 * tracker.gg loads its match list by XHR after the page renders, so a static
 * snapshot (curl, FlareSolverr) never sees it. Driving a real browser solves
 * two problems at once:
 *
 *   1. The Cloudflare challenge runs and passes, because this *is* a browser.
 *   2. We can intercept the JSON the page fetches for itself, which is far
 *      better than scraping the rendered DOM - it is the site's own structured
 *      payload, and it does not break when they restyle the page.
 *
 * Playwright is an optional dependency: it is imported lazily so the rest of
 * the app runs without it. Only the tracker.gg source needs it.
 *
 * The browser is launched once and reused. Startup is the expensive part, and
 * a persistent profile also keeps the Cloudflare clearance cookie between runs.
 */

import { readlink, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/*
 * Where Chromium keeps the profile that holds the Cloudflare clearance.
 *
 * Beside the code by default, which is right for a checkout. A container points
 * it into a volume instead, because the clearance is the whole reason the noVNC
 * login exists and losing it on every redeploy would make that feature pointless.
 *
 * Read here rather than passed in by server.js, so that `npm run tracker:login`
 * and the in-app solve write to the same place. Two callers with two profiles is
 * a solve that appears to work and then does nothing.
 *
 * One rule for whoever sets it: this directory is deleted and recreated by
 * `resetProfile()`, so it must be a subdirectory *inside* a mount and never the
 * mount point itself - removing a mount point returns EBUSY, and `force: true`
 * suppresses only ENOENT. The recovery from a poisoned clearance would fail
 * silently, which is the one failure this code cannot see.
 */
const PROFILE_DIR = path.resolve(ROOT, (process.env.PROFILE_DIR ?? '').trim() || '.playwright-profile');

// Channels tried in order when none is forced. Real Chrome first: it reports
// a "Google Chrome" brand in its client hints, which the bundled Chromium
// cannot. Falling back to null uses Playwright's own download.
const CHANNEL_ORDER = ['chrome', 'chromium', null];

export class BrowserError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.hint = hint;
  }
}

/**
 * Cloudflare's interstitial, as seen from inside the page.
 *
 * Note this runs in the browser, not in Node. It deliberately does not look at
 * "cdn-cgi/challenge-platform", which Cloudflare also injects into pages that
 * passed - matching on that reports a challenge on every successful load.
 */
/* c8 ignore next 8 */
function detectChallenge() {
  return (
    /just a moment|attention required|checking your browser|verifying you are human/i.test(document.title || '') ||
    Boolean(window._cf_chl_opt) ||
    Boolean(document.querySelector('#challenge-running, #challenge-form, #cf-chl-widget'))
  );
}

/** Find JSON embedded in the served HTML (__NEXT_DATA__ and friends). */
export function extractEmbeddedJson(html) {
  const found = [];
  if (!html) return found;

  const scriptTag = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html).matchAll(scriptTag)) {
    try {
      found.push(JSON.parse(match[1]));
    } catch {
      /* not JSON after all */
    }
  }

  const assigned = /window\.__(?:NUXT|NEXT_DATA|INITIAL_STATE)__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/gi;
  for (const match of String(html).matchAll(assigned)) {
    try {
      found.push(JSON.parse(match[1]));
    } catch {
      /* usually a JS expression rather than strict JSON */
    }
  }

  return found;
}

/**
 * A cheap page on the site, opened once per launch to absorb the cold start.
 * See warmUpContext below for why that is necessary.
 */
const WARM_UP_URL = 'https://tracker.gg/valorant';

/**
 * Clear a singleton lock left behind by a browser that is no longer running.
 *
 * Chromium marks a profile as in use with a SingletonLock symlink pointing at
 * "<hostname>-<pid>". A process killed hard never removes it, and a container
 * that gets recreated leaves one naming a host that no longer exists.
 *
 * That matters far more than it looks. Real Chrome refuses a profile locked by
 * someone else, so launchPersistentContext throws and the channel search falls
 * through to bundled Chromium - which reports a different user agent, which
 * invalidates every clearance a Chrome solve earned, which is a permanent 403
 * with nothing in any log to explain it. Measured against tracker.gg: one stale
 * lock is the difference between working and never working again.
 *
 * Only removed when it is provably stale - a different host, or a pid that is
 * gone. A live lock is left alone, because two browsers sharing one profile
 * corrupts it.
 */
export async function clearStaleSingletonLock(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock');

  let target;
  try {
    target = await readlink(lockPath);
  } catch {
    return; // no lock, or not a symlink - nothing to do either way
  }

  const at = target.lastIndexOf('-');
  const owner = at === -1 ? '' : target.slice(0, at);
  const pid = Number(target.slice(at + 1));

  if (owner === hostname() && Number.isFinite(pid) && pid > 0) {
    try {
      // Signal 0 tests for existence without touching the process.
      process.kill(pid, 0);
      return; // still running, and genuinely ours
    } catch {
      /* gone - fall through and clear it */
    }
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await rm(path.join(profileDir, name), { force: true }).catch(() => {});
  }
}

export function makeTrackerBrowser(options = {}) {
  const {
    headless = true,
    timeoutMs = 45_000,
    challengeMs = headless ? 25_000 : 5 * 60 * 1000,
    idleCloseMs = 5 * 60 * 1000,
    profileDir = PROFILE_DIR,
    channel = 'auto',
    userAgent = null,
    warmUpOnLaunch = true,
  } = options;

  let contextPromise = null;
  let idleTimer = null;

  // Resolved on first launch and reused, so the relaunch below happens once
  // per process rather than once per lookup.
  let resolvedUserAgent = userAgent;
  let resolvedChannel = null;
  let profileReset = false;

  async function open(chromium, useChannel, ua) {
    return chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      args: ['--disable-blink-features=AutomationControlled'],
      ...(useChannel ? { channel: useChannel } : {}),
      ...(ua ? { userAgent: ua } : {}),
    });
  }

  async function launch() {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new BrowserError(
        'Playwright is not installed.',
        'Run: npm install playwright && npx playwright install chromium',
      );
    }

    // Before the channel search, or a lock from a dead browser silently costs
    // us real Chrome - see clearStaleSingletonLock.
    await clearStaleSingletonLock(profileDir);

    // Persistent so the Cloudflare clearance cookie survives between lookups.
    const candidates = channel === 'auto' ? CHANNEL_ORDER : [channel, null];
    let context = null;
    let lastError = null;

    for (const candidate of candidates) {
      try {
        context = await open(chromium, candidate, resolvedUserAgent);
        resolvedChannel = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!context) {
      throw new BrowserError(
        `Could not launch a browser: ${lastError?.message ?? 'unknown error'}`,
        'Install a browser for Playwright: npx playwright install chromium (or install Google Chrome).',
      );
    }

    // Headless Chrome says "HeadlessChrome" in its user agent, which Cloudflare
    // reads as a bot outright. Correct it - but derive the replacement from the
    // real one rather than hardcoding a version, because navigator.userAgentData
    // and the Sec-CH-UA request headers keep reporting the true version no
    // matter what we claim here. A UA that disagrees with those client hints is
    // a stronger bot signal than the word "Headless" ever was, and it also
    // invalidates a clearance cookie earned by a headed solve.
    if (!resolvedUserAgent) {
      const probe = await context.newPage();
      const actual = await probe.evaluate(() => navigator.userAgent).catch(() => '');
      await probe.close().catch(() => {});

      if (/Headless/i.test(actual)) {
        resolvedUserAgent = actual.replace(/HeadlessChrome/gi, 'Chrome');
        await context.close().catch(() => {});
        context = await open(chromium, resolvedChannel, resolvedUserAgent);
      }
    }

    if (warmUpOnLaunch) await warmUpContext(context);
    return context;
  }

  function context() {
    if (!contextPromise) contextPromise = launch();
    return contextPromise;
  }

  /** Close the browser after a spell of inactivity so it is not resident forever. */
  function touchIdleTimer() {
    clearTimeout(idleTimer);
    if (!idleCloseMs) return;
    idleTimer = setTimeout(() => void close(), idleCloseMs);
    idleTimer.unref?.();
  }

  async function close() {
    clearTimeout(idleTimer);
    const pending = contextPromise;
    contextPromise = null;
    if (!pending) return;
    try {
      await (await pending).close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Throw the browser profile away and start clean.
   *
   * A Cloudflare clearance cookie is bound to the fingerprint that earned it,
   * so one saved under an older configuration is worse than none at all: the
   * site keeps re-challenging a cookie it will never accept, and the profile
   * stays poisoned until it is deleted. Measured against tracker.gg, a stale
   * profile 403s indefinitely where a fresh one passes first time.
   */
  async function resetProfile() {
    await close();
    try {
      await rm(profileDir, { recursive: true, force: true });
      return true;
    } catch {
      // Windows can hold the directory briefly after the browser exits.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      try {
        await rm(profileDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }
  }

  async function runCapture(url, wanted, captureOptions = {}) {
    const { minimum = 1, settleMs = 2_000 } = captureOptions;
    const ctx = await context();
    const page = await ctx.newPage();
    const captured = [];

    let resolveFirst;
    const gotEnough = new Promise((resolve) => (resolveFirst = resolve));

    page.on('response', async (response) => {
      if (!wanted(response.url())) return;
      try {
        const type = response.headers()['content-type'] ?? '';
        if (!type.includes('json')) return;
        captured.push({ url: response.url(), status: response.status(), body: await response.json() });
        if (captured.length >= minimum) resolveFirst();
      } catch {
        // Body already consumed or not JSON after all - ignore this one.
      }
    });

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const status = response?.status() ?? null;

      // domcontentloaded fires on the interstitial too, so the challenge has
      // to be waited out before the page has even begun fetching its data.
      const challenge = await settleChallenge(page, challengeMs);

      // Give the page's own fetches a chance to land.
      await Promise.race([gotEnough, page.waitForTimeout(timeoutMs)]);
      if (captured.length) await page.waitForTimeout(settleMs).catch(() => {});
      else await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => {});

      const html = await page.content();
      return { captured, html, status, finalUrl: page.url(), challenge };
    } catch (error) {
      throw new BrowserError(`Navigation to ${url} failed: ${error.message}`);
    } finally {
      await page.close().catch(() => {});
      touchIdleTimer();
    }
  }

  return {
    /**
     * Visit a page and collect every JSON response whose URL matches `wanted`.
     * Resolves as soon as `minimum` payloads arrive, or when the page goes idle.
     *
     * If a challenge will not clear, the profile is discarded and the visit is
     * retried once - stale clearance is the usual cause, and it cannot be
     * recovered from any other way.
     */
    async capture(url, wanted, captureOptions = {}) {
      const result = await runCapture(url, wanted, captureOptions);
      if (result.challenge?.cleared !== false || profileReset) return result;

      profileReset = true; // Once per process, so this can never become a loop.
      if (!(await resetProfile())) return result;
      return runCapture(url, wanted, captureOptions);
    },

    /**
     * Launch now instead of on the first lookup, so the warm-up above is paid
     * while nobody is waiting. Safe to call more than once - the context is
     * created once and reused.
     */
    prepare() {
      return context().then(
        () => true,
        () => false,
      );
    },

    /** Discard the saved browser profile, including any Cloudflare clearance. */
    resetProfile,

    /**
     * Ask the site's own API for something, from inside one of its pages.
     *
     * Fetched from the page rather than from Node so the request carries the
     * clearance cookies, the browser's TLS fingerprint and a real Origin and
     * Referer - the same call from Node is answered with a block page. This is
     * still the public website's own endpoint, so no API key is involved.
     */
    async fetchJson(pageUrl, apiUrl) {
      const ctx = await context();
      const page = await ctx.newPage();
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const challenge = await settleChallenge(page, challengeMs);

        const result = await page.evaluate(async (url) => {
          try {
            const response = await fetch(url, { credentials: 'include' });
            const text = await response.text();
            try {
              return { status: response.status, body: JSON.parse(text) };
            } catch {
              return { status: response.status, body: null, text: text.slice(0, 300) };
            }
          } catch (error) {
            return { status: 0, body: null, text: String(error?.message ?? error) };
          }
        }, apiUrl);

        return { ...result, challenge };
      } finally {
        await page.close().catch(() => {});
        touchIdleTimer();
      }
    },

    /**
     * Open a page and wait for any Cloudflare challenge to clear, leaving the
     * resulting cookies in the persistent profile. Used by the headed warm-up
     * so a human can solve the challenge once and headless runs inherit it.
     */
    async warmUp(url, warmUpOptions = {}) {
      const { waitMs = challengeMs } = warmUpOptions;
      const ctx = await context();
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const challenge = await settleChallenge(page, waitMs);
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        const cookies = await ctx.cookies(url);
        return {
          challenge,
          finalUrl: page.url(),
          userAgent: await page.evaluate(() => navigator.userAgent).catch(() => resolvedUserAgent),
          clearance: cookies.find((cookie) => cookie.name === 'cf_clearance') ?? null,
        };
      } finally {
        await page.close().catch(() => {});
      }
    },

    close,
    get profileDir() {
      return profileDir;
    },
    get channel() {
      return resolvedChannel;
    },
    get userAgent() {
      return resolvedUserAgent;
    },
  };
}

/**
 * Spend the first page load on something nobody is waiting for.
 *
 * Measured against tracker.gg: the first navigation after a launch comes back
 * as a normal 200 with the data the page fetches for itself simply missing, and
 * it burns the whole timeout getting there. Since the browser also closes itself
 * after a spell of inactivity, that cost is not paid once at startup - it is
 * paid again by the first lookup after every idle period, which for a broadcast
 * is the one at the top of the show.
 *
 * Doing it here rather than in the server means every launch absorbs it,
 * including the relaunch after an idle close, and no caller has to know.
 *
 * Failure is ignored on purpose: this is a warm-up, and a launch that cannot
 * reach the site should be reported by the real request, with its own hints,
 * rather than by this.
 */
async function warmUpContext(context) {
  const page = await context.newPage().catch(() => null);
  if (!page) return;

  try {
    await page.goto(WARM_UP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settleChallenge(page, 20_000);
  } catch {
    /* the real request will report anything that matters */
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Poll until the Cloudflare interstitial goes away.
 *
 * Returns { seen, cleared }: `seen` says a challenge was actually presented,
 * `cleared` says the page moved past it. Evaluation throws while a navigation
 * is in flight, which is itself a sign the challenge is redirecting onwards -
 * so that case keeps waiting rather than declaring either outcome.
 */
async function settleChallenge(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let seen = false;

  while (Date.now() < deadline) {
    const state = await page.evaluate(detectChallenge).catch(() => 'navigating');
    if (state === false) return { seen, cleared: true };
    if (state === true) seen = true;
    await page.waitForTimeout(500).catch(() => {});
  }

  return { seen, cleared: !seen };
}
