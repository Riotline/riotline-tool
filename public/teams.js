/**
 * The team library - orgs an operator works with, saved once and reused.
 *
 * A team is a small record rather than a free-text name because the same org
 * turns up on the scoreboard, on the winner graphic and on whatever comes next,
 * and retyping a name and re-pasting a logo URL for each of them is exactly the
 * kind of thing that goes wrong ninety seconds before a show.
 *
 * Picking a team *copies* its fields into the graphic rather than storing a
 * pointer to it. Same reasoning as presets: the graphic on air is the truth, so
 * editing the library later cannot silently rewrite something already live, and
 * the output pages never need the library at all. `teamId` is kept alongside
 * purely so the dashboard can show which entry a side came from.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

/**
 * Broadcast regions, roughly the VCT ones plus the catch-alls a local event
 * actually needs. Free text would be a typo waiting to happen on a lower third,
 * but an unknown value is still preserved on the way in rather than blanked -
 * an operator running a region this list has never heard of should not lose it.
 */
export const TEAM_REGIONS = [
  'Americas',
  'EMEA',
  'Pacific',
  'China',
  'NA',
  'LATAM',
  'BR',
  'EU',
  'KR',
  'JP',
  'SEA',
  'OCE',
  'SA',
  'MENA',
];

/**
 * type: text   - plain string, `max` characters
 *       image  - a logo: an uploaded /logos/... path or a pasted http(s) URL
 *       choice - one of `options`, but unknown values are kept
 *       hex    - a colour
 */
export const TEAM_FIELDS = [
  { key: 'name', type: 'text', max: 32, label: 'Team name', placeholder: 'Sentinels' },
  // What the scoreboard header and the score line use when the full name will
  // not fit. Blank falls back to the full name rather than to an abbreviation
  // this file invented.
  { key: 'shortName', type: 'text', max: 8, label: 'Short name / tricode', placeholder: 'SEN' },
  { key: 'region', type: 'choice', options: TEAM_REGIONS, max: 24, label: 'Region', placeholder: 'Americas' },
  { key: 'logo', type: 'image', max: 500, label: 'Logo' },
  // Used for the accent bar behind the winning team, so a graphic can carry the
  // org's colour without the operator restyling the whole look per match.
  { key: 'colour', type: 'hex', label: 'Team colour', default: '#ff4655' },
];

export const TEAM_KEYS = TEAM_FIELDS.map((field) => field.key);

export const EMPTY_TEAM = Object.fromEntries(
  TEAM_FIELDS.map((field) => [field.key, field.default ?? '']),
);

/** What gets copied onto a graphic when a team is picked. Never the id. */
export const teamContent = (team) => ({
  name: team?.name ?? '',
  shortName: team?.shortName ?? '',
  region: team?.region ?? '',
  logo: team?.logo ?? '',
  colour: team?.colour || EMPTY_TEAM.colour,
});

/** Tricode if there is one, full name otherwise - never an empty label. */
export const teamLabel = (team) => (team?.shortName || team?.name || '').trim();

/**
 * `Team Liquid` -> `team-liquid`, so ids stay readable in the saved file and a
 * hand-edited teams.json is still something a person can follow.
 */
export const teamSlug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'team';
