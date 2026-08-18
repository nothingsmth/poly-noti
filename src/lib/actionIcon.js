/**
 * The toolbar icon, with the unread count drawn into it.
 *
 * Chrome's own badge is a rounded rectangle pinned to the bottom-right corner of
 * the icon, with no control over its size, its radius or its position — which is
 * why "centre the counter" was impossible while the badge was doing the counting.
 * Drawing the number ourselves is what makes it answerable: the bubble is a real
 * circle, it sits where the logo's second version puts it, and it scales with the
 * tile instead of with Chrome's chrome.
 *
 * The cost is that the icon is now generated rather than a file, so it costs a
 * canvas per change of count. refreshBadge() runs every poll and the count is
 * usually the same as last time, so the result is cached per (count, size) and
 * the bell bitmap is decoded once for the life of the worker.
 */

/** Sizes Chrome asks for: 16 for the toolbar, 32 for hidpi and the menu. */
const SIZES = [16, 32];

/**
 * The bubble, and the number on it. Red because it means "unread", not "on".
 *
 * Darker than the logo's own red: the number is white type inside a 16px tile,
 * the smallest text this extension draws anywhere, and the logo's brighter red
 * puts it at 3.9:1 — under the 4.5:1 floor the rest of the palette holds to.
 * This one measures 5.1:1 and still reads as red rather than maroon.
 */
const BUBBLE = '#D3282E';
const BUBBLE_TEXT = '#FFFFFF';

/** Cache of rendered icon sets, keyed by the text on the bubble ('' for none). */
const cache = new Map();

/** @type {Promise<ImageBitmap>|null} */
let bellPromise = null;

function bell() {
  // 128 rather than 16/32: downscaling the big one at draw time keeps the Z's
  // thin gaps as grey pixels, where the 16px file has already thrown them away.
  bellPromise ||= fetch(chrome.runtime.getURL('icons/icon128.png'))
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b));
  return bellPromise;
}

/**
 * The label for `count`, or '' when there is nothing to say.
 *
 * Capped at 99+ because three glyphs is what fits in a circle inside a 32px
 * tile; a fourth would either shrink the type below legibility or push the
 * bubble off the edge.
 */
export function badgeLabel(count) {
  if (!count) return '';
  return count > 99 ? '99+' : String(count);
}

/**
 * Draw the bell at `size`, with `text` on a bubble if there is any.
 *
 * The bell is inset when the bubble is present. Overlapping them instead would
 * cover the Z, which is the half of the mark that says whose extension this is.
 */
async function render(text, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const art = await bell();

  if (!text) {
    ctx.drawImage(art, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size);
  }

  // Bubble diameter is a share of the tile rather than a function of the text:
  // '1' and '99+' get the same circle, so the icon doesn't visibly resize itself
  // as the count crosses 10. 0.62 is deliberately large — the toolbar icon is
  // ~16 device pixels of a busy strip, and a circle that keeps polite distance
  // from the bell is a circle nobody notices. The bell is inset to match, so the
  // bubble sits against the mark rather than on top of the Z.
  const d = Math.round(size * 0.7);
  const inset = Math.round(size * 0.12);
  ctx.drawImage(art, 0, 0, size - inset, size - inset);

  const cx = size - d / 2;
  const cy = size - d / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = BUBBLE;
  ctx.fill();

  // Two digits inside a 10px circle is not type, it is texture — at 16px anything
  // past a single glyph renders as a smear that reads as dirt on the icon. So the
  // small tile carries a plain dot for those counts: "there is something" is the
  // honest amount of information 10 pixels can hold, and Chrome asks for the 32px
  // tile on every hidpi screen, where the number itself is legible.
  if (size < 32 && text.length > 1) return ctx.getImageData(0, 0, size, size);

  // Condensed for '99+' so three glyphs fit the same circle two do. There is no
  // font stack in a worker worth naming, so this leans on the platform's
  // sans-serif and only controls the size.
  const px = text.length > 2 ? d * 0.52 : d * 0.74;
  ctx.fillStyle = BUBBLE_TEXT;
  ctx.font = `600 ${px}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // +0.5 on y: 'middle' sits cap-height-centred, which reads a hair high inside
  // a circle that has no cap height of its own.
  ctx.fillText(text, cx, cy + size * 0.02);

  return ctx.getImageData(0, 0, size, size);
}

/**
 * An `imageData` map for chrome.action.setIcon showing `count`.
 *
 * @param {number} count unread items; 0 gives the plain bell.
 */
export async function buildActionIcon(count) {
  const text = badgeLabel(count);
  if (cache.has(text)) return cache.get(text);
  const entries = await Promise.all(SIZES.map(async (s) => [s, await render(text, s)]));
  const imageData = Object.fromEntries(entries);
  cache.set(text, imageData);
  return imageData;
}
