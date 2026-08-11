/**
 * Map code names.
 *
 * The game feed reports maps by their internal name - "Duality", not "Bind" -
 * exactly as it reports agents by theirs. Unlike the agents, though, there is no
 * single field on the catalogue that hands the mapping over: it has to be read
 * out of `mapUrl`, whose last segment is the code name in every case, from
 * /Game/Maps/Duality/Duality down to /Game/Maps/HURM/HURM_HighTide/HURM_HighTide
 * and the odd one out, /Game/Maps/Poveglia/Range.
 *
 * So the catalogue builds the table once, at fetch, and everything downstream is
 * a lookup.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

/**
 * The same table, written down.
 *
 * Not the source of truth - the catalogue is, and it wins wherever both have an
 * answer. This exists for the one case the catalogue cannot cover: a first run
 * with no network and nothing cached to disk, where without it a map event would
 * put "Duality" on air.
 *
 * The two failure modes are opposites, which is why both are here. A written
 * table cannot be absent but goes stale the moment a map ships - this one was
 * already missing Summit when it was written. The catalogue cannot go stale but
 * can be missing. Each covers the other.
 */
export const MAP_CODE_NAMES = {
  ascent: 'Ascent',
  bonsai: 'Split',
  canyon: 'Fracture',
  duality: 'Bind',
  foxtrot: 'Breeze',
  infinity: 'Abyss',
  jam: 'Lotus',
  juliett: 'Sunset',
  pitt: 'Pearl',
  plummet: 'Summit',
  port: 'Icebox',
  rook: 'Corrode',
  triad: 'Haven',
  hurm_alley: 'District',
  hurm_bowl: 'Kasbah',
  hurm_helix: 'Drift',
  hurm_hightide: 'Glitch',
  hurm_yard: 'Piazza',
  // The catalogue's own wording for the practice range, kept verbatim so the
  // two sources can never disagree about it.
  range: 'The Range',
  rangev2: 'The Range',
};

/** The code name out of a valorant-api mapUrl - always its last segment. */
export const mapCodeFromUrl = (mapUrl) => String(mapUrl ?? '').split('/').filter(Boolean).pop() ?? '';

/**
 * Turn whatever arrived into the name on the box.
 *
 * Accepts a display name unchanged, so this is safe to run over a value an
 * operator typed or picked as well as one the feed sent - which matters because
 * the map is the one field both of them write.
 *
 * Falls back to the raw value rather than to nothing: "Duality" on air is wrong
 * but visible and fixable from the dropdown, where a blank map card looks like
 * the graphic failed.
 *
 * @param {{maps?: {name: string}[], mapCodes?: Record<string, string>}} catalogue
 */
export function mapDisplayName(catalogue, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const key = raw.toLowerCase();
  // Already the public name - checked first because a handful of maps use the
  // same word for both and there is no point resolving those twice.
  if ((catalogue?.maps ?? []).some((map) => String(map?.name ?? '').toLowerCase() === key)) return raw;

  return catalogue?.mapCodes?.[key] ?? MAP_CODE_NAMES[key] ?? raw;
}
