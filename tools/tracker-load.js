/**
 * How many accounts can the watch check at once, and how often, before
 * tracker.gg starts refusing?
 *
 *   node tools/tracker-load.js --handles roster.txt
 *   node tools/tracker-load.js --handles roster.txt --levels 1,2,3,4 --rounds 2
 *
 * Drives the running server's own /api/matches, so what it measures is the real
 * pathway - Cloudflare clearance, the persistent browser profile, the lot - and
 * not an approximation of it.
 *
 * It escalates rather than starting hard: one account at a time first, then two,
 * and so on, stopping the moment a level starts failing. That ordering matters.
 * Opening with ten concurrent tabs would risk the ban it is meant to measure,
 * and a poisoned profile would then make every later reading meaningless.
 *
 * Rounds within a level run back to back with no gap, so a clean level answers
 * both questions at once: that many at a time is safe, and as often as a round
 * takes is safe.
 *
 * The handle list is a file argument rather than anything checked in - these are
 * real people's Riot IDs.
 */

import { readFile } from 'node:fs/promises';

// ------------------------------------------------------------- arguments ---

function parseArgs(argv) {
  const args = {
    base: 'http://127.0.0.1:8080',
    provider: 'tracker',
    type: 'custom',
    levels: '1,2,3,4',
    rounds: 2,
    maxRequests: 160,
    timeoutMs: 180_000,
    handles: null,
  };

  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in args)) throw new Error(`Unknown option: ${argv[i]}`);
    args[key] = argv[i + 1];
  }

  args.rounds = Number(args.rounds);
  args.maxRequests = Number(args.maxRequests);
  args.timeoutMs = Number(args.timeoutMs);
  args.levels = String(args.levels)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!args.handles) throw new Error('Pass --handles <file>, one Riot ID per line.');
  return args;
}

// --------------------------------------------------------------- helpers ---

async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** One check, timed. A non-2xx is data here, not a reason to stop. */
async function check(args, handle) {
  const url = new URL('/api/matches', args.base);
  url.searchParams.set('provider', args.provider);
  url.searchParams.set('handle', handle);
  url.searchParams.set('type', args.type);

  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(args.timeoutMs) });
    const body = await response.json().catch(() => ({}));
    const error = body?.error ?? null;

    return {
      handle,
      ms: Date.now() - startedAt,
      status: error?.status ?? response.status,
      ok: response.ok && !error,
      matches: body?.matches?.length ?? 0,
      message: error?.message ?? '',
    };
  } catch (error) {
    return { handle, ms: Date.now() - startedAt, status: 0, ok: false, matches: 0, message: error.message };
  }
}

// ------------------------------------------------------------------ main ---

const args = parseArgs(process.argv.slice(2));
const handles = (await readFile(args.handles, 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.includes('#'));

if (!handles.length) throw new Error(`No Riot IDs found in ${args.handles}`);

console.log('='.repeat(76));
console.log(`  tracker load sweep - ${handles.length} accounts, source ${args.provider}, type ${args.type}`);
console.log(`  levels ${args.levels.join(', ')} | ${args.rounds} round(s) each | cap ${args.maxRequests} requests`);
console.log('='.repeat(76));

let spent = 0;
const summary = [];
let stopped = null;

for (const level of args.levels) {
  const results = [];
  const roundTimes = [];

  for (let round = 1; round <= args.rounds; round += 1) {
    if (spent + handles.length > args.maxRequests) {
      stopped = `request cap (${args.maxRequests}) reached`;
      break;
    }

    const startedAt = Date.now();
    const batch = await mapLimit(handles, level, (handle) => check(args, handle));
    const elapsed = Date.now() - startedAt;

    spent += batch.length;
    results.push(...batch);
    roundTimes.push(elapsed);

    const failed = batch.filter((entry) => !entry.ok);
    console.log(
      `  x${level}  round ${round}  ${seconds(elapsed)}  ` +
        `${batch.length - failed.length}/${batch.length} ok  ` +
        `median ${seconds(percentile(batch.map((e) => e.ms), 50))}` +
        (failed.length ? `  FAILED: ${failed.map((e) => `${e.handle} ${e.status || 'net'}`).join(', ')}` : ''),
    );

    for (const entry of failed) {
      if (entry.message) console.log(`         ${entry.handle}: ${entry.status} ${entry.message.slice(0, 140)}`);
    }
  }

  if (!results.length) break;

  const failed = results.filter((entry) => !entry.ok);
  const failRate = failed.length / results.length;
  const latencies = results.map((entry) => entry.ms);
  const roundMs = Math.max(...roundTimes);

  summary.push({
    level,
    requests: results.length,
    failed: failed.length,
    failRate,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    roundMs,
    perMinute: (results.length / (roundTimes.reduce((a, b) => a + b, 0) / 60_000)),
    statuses: [...new Set(failed.map((entry) => entry.status))],
    emptyLists: results.filter((entry) => entry.ok && entry.matches === 0).length,
  });

  // Escalating into a level that is already refusing is how a profile gets
  // poisoned, so the sweep stops at the first sign rather than pushing on.
  const blocked = failed.some((entry) => entry.status === 403 || entry.status === 429);
  if (blocked || failRate > 0.2) {
    stopped = blocked ? 'the site started refusing (403/429)' : `failure rate ${(failRate * 100).toFixed(0)}%`;
    break;
  }
  if (stopped) break;
}

// -------------------------------------------------------------- verdict ---

console.log('\n' + '='.repeat(76));
console.log('  level  requests  failed  median    p95       round     req/min  notes');
for (const row of summary) {
  console.log(
    `  x${String(row.level).padEnd(5)} ${String(row.requests).padStart(8)}  ${String(row.failed).padStart(6)}  ` +
      `${seconds(row.p50).padEnd(9)} ${seconds(row.p95).padEnd(9)} ${seconds(row.roundMs).padEnd(9)} ` +
      `${row.perMinute.toFixed(1).padStart(7)}  ` +
      `${row.statuses.length ? `statuses ${row.statuses.join('/')}` : ''}${row.emptyLists ? ` ${row.emptyLists} empty` : ''}`,
  );
}

const clean = summary.filter((row) => row.failed === 0);
const best = clean.at(-1);

console.log('='.repeat(76));
if (stopped) console.log(`  Sweep stopped: ${stopped}`);

if (best) {
  console.log(`  Fastest clean level: ${best.level} at a time, a full round of ${handles.length} in ${seconds(best.roundMs)}.`);
  console.log(`  Suggested watch tuning: concurrency ${best.level}, gapMs ${Math.max(0, Math.round(best.roundMs / 4 / 1000) * 1000)}`);
  console.log('  (the gap is a quarter of a round - the round itself is already most of the spacing)');
} else {
  console.log('  No level completed without failures. Check the log above before raising concurrency.');
}
console.log('='.repeat(76));
