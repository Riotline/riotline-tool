/**
 * The colour of a logo.
 *
 * Browser-only, no dependencies - a canvas is already in every browser and this
 * project does not take on a package to do arithmetic. Node never imports this
 * file, the way it never imports fields.js or media-field.js.
 *
 * Uploaded logos are served by this same process from /media/<hash>.<ext>, so
 * they are same-origin and the canvas can be read. A logo pasted in as a URL to
 * somebody else's CDN is a different matter: unless that host sends CORS
 * headers the canvas is tainted and reading it throws. That is a browser
 * security rule, not something to work around, so it is caught and reported.
 */

/**
 * Pixels that could not be part of a team's colour.
 *
 * Org logos are overwhelmingly a mark on transparency, in white, black or a
 * silver-grey. Averaging all of that in is exactly how a picker returns mud -
 * and mud is the one answer worse than no answer, because it looks deliberate.
 * So the field, the greys and the extremes are dropped and only the colour that
 * is actually there gets a vote.
 */
const CLEAR = 128; // alpha below this is the transparent field around the mark
const GREY = 24; // chroma below this is a grey, not a colour
const DARK = 24; // luma outside this range is the black or the white of a mark
const LIGHT = 232;

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

const hex = (r, g, b) =>
  `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

/**
 * Load and draw the logo, small.
 *
 * 64x64 is 4096 samples, which is plenty for a modal colour and quick enough to
 * run on a click. `crossOrigin` has to be set before `src` or it does nothing;
 * it is harmless for our own /media files and is the only thing that makes a
 * CORS-enabled remote logo readable at all.
 */
async function samples(src, size) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = src;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, size, size);

  // Throws SecurityError on a tainted canvas. Left to the caller: "that logo is
  // on another site" is a different message from "that logo has no colour in
  // it", and an operator can act on the first one.
  return context.getImageData(0, 0, size, size).data;
}

/** Everything opaque enough to count, optionally with the colour filters on. */
function usable(data, strict) {
  const kept = [];
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b, a] = [data[index], data[index + 1], data[index + 2], data[index + 3]];
    if (a < CLEAR) continue;
    if (strict) {
      if (chroma(r, g, b) < GREY) continue;
      const light = luma(r, g, b);
      if (light < DARK || light > LIGHT) continue;
    }
    kept.push([r, g, b]);
  }
  return kept;
}

const average = (pixels) => {
  const total = pixels.reduce((sum, [r, g, b]) => [sum[0] + r, sum[1] + g, sum[2] + b], [0, 0, 0]);
  return hex(total[0] / pixels.length, total[1] / pixels.length, total[2] / pixels.length);
};

/**
 * The most common colour, rather than the mean of all of them.
 *
 * A mean is the wrong answer for a two-colour crest: red and blue in equal parts
 * average to a grey nobody chose. Pixels are bucketed four bits to a channel and
 * the biggest bucket wins - then averaged within that bucket only, so the answer
 * is a colour that is really in the image rather than the centre of a box.
 */
function modal(pixels) {
  const buckets = new Map();
  for (const pixel of pixels) {
    const key = ((pixel[0] >> 4) << 8) | ((pixel[1] >> 4) << 4) | (pixel[2] >> 4);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(pixel);
    else buckets.set(key, [pixel]);
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.length > best.length) best = bucket;
  }
  return best ? average(best) : null;
}

/**
 * @returns {Promise<{hex: string} | {error: 'blocked' | 'empty' | 'unreadable'}>}
 *   `blocked` - the image is on another site that will not let us read it.
 *   `empty`   - nothing in it that could be called a colour.
 *   `unreadable` - it did not load at all.
 */
export async function logoColour(src, { mode = 'dominant', size = 64 } = {}) {
  const url = String(src ?? '').trim();
  if (!url) return { error: 'unreadable' };

  let data;
  try {
    data = await samples(url, size);
  } catch (error) {
    return { error: error?.name === 'SecurityError' ? 'blocked' : 'unreadable' };
  }

  // Strict first. A white-on-transparent wordmark filters down to nothing, and
  // for that the honest answer is the white it actually is, so the filters come
  // off for a second pass rather than the whole thing failing.
  let pixels = usable(data, true);
  if (!pixels.length) pixels = usable(data, false);
  if (!pixels.length) return { error: 'empty' };

  const colour = mode === 'average' ? average(pixels) : modal(pixels);
  return colour ? { hex: colour } : { error: 'empty' };
}
