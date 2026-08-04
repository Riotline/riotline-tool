/**
 * The stats a scoreboard row can display.
 *
 * One definition list, imported by all three consumers: the server sanitises
 * against it, the dashboard builds its dropdowns from it, and the output page
 * formats with it. Adding a stat here is the only edit needed to offer it.
 *
 * Deliberately dependency-free and DOM-free so the Node server can import the
 * same module the browser does.
 */

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export const STATS = [
  { key: 'kda', label: 'K/D/A', format: (p) => `${n(p.kills)}/${n(p.deaths)}/${n(p.assists)}` },
  { key: 'kd', label: 'K/D', format: (p) => `${n(p.kills)}/${n(p.deaths)}` },
  { key: 'kills', label: 'Kills', format: (p) => String(n(p.kills)) },
  { key: 'deaths', label: 'Deaths', format: (p) => String(n(p.deaths)) },
  { key: 'assists', label: 'Assists', format: (p) => String(n(p.assists)) },
  { key: 'acs', label: 'ACS', format: (p) => String(n(p.acs)) },
  { key: 'adr', label: 'ADR', format: (p) => String(n(p.adr)) },
  { key: 'firstKills', label: 'First Kills', format: (p) => String(n(p.firstKills)) },
  { key: 'hsPct', label: 'HS%', format: (p) => `${n(p.hsPct)}%` },
  { key: 'kast', label: 'KAST', format: (p) => `${n(p.kast)}%` },
];

export const STAT_KEYS = STATS.map((stat) => stat.key);

const BY_KEY = new Map(STATS.map((stat) => [stat.key, stat]));

export const statDef = (key) => BY_KEY.get(key) ?? STATS[0];

/** The three slots the layout has room for: two on roster rows, three on the MVP panel. */
export const STAT_SLOTS = 3;

/** Per-player numbers a stat can be built from - the editable fields. */
export const STAT_FIELDS = [
  { key: 'kills', label: 'Kills', max: 999 },
  { key: 'deaths', label: 'Deaths', max: 999 },
  { key: 'assists', label: 'Assists', max: 999 },
  { key: 'acs', label: 'ACS', max: 9999 },
  { key: 'adr', label: 'ADR', max: 9999 },
  { key: 'firstKills', label: 'First kills', max: 999 },
  { key: 'hsPct', label: 'HS %', max: 100 },
  { key: 'kast', label: 'KAST %', max: 100 },
];
