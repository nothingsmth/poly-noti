/**
 * Runtime notification icons.
 *
 * chrome.notifications exposes no styling options — the only visual lever is
 * iconUrl, which accepts a data: URL. So we draw the label's emoji onto a
 * neutral tile and hand that over, which is how a toast ends up carrying the
 * label it belongs to.
 *
 * Service workers have no DOM, hence OffscreenCanvas rather than <canvas>.
 */

const SIZE = 128;

/** Dark enough to sit quietly in both light and dark OS notification trays. */
const TILE = 'rgb(42, 45, 49)';

/** Generated icons are stable per emoji, so cache them. */
const cache = new Map();

async function blobToDataUrl(blob) {
  // FileReader exists in workers, but the buffer route avoids its event dance.
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // keep the spread under the argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/**
 * Draw the notification icon.
 *
 * @param {string} emoji label emoji, e.g. '🐋'
 * @returns {Promise<string>} data: URL suitable for notifications.iconUrl
 */
export async function buildNotificationIcon(emoji) {
  const key = String(emoji || '');
  if (cache.has(key)) return cache.get(key);

  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = TILE;
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 28);
  ctx.fill();

  // Soft top-light so the tile doesn't look flat at small sizes.
  const sheen = ctx.createLinearGradient(0, 0, 0, SIZE);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.14)');
  sheen.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 28);
  ctx.fill();

  ctx.font = '74px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Nudged down a touch: emoji glyphs sit high in their em box.
  ctx.fillText(emoji || '🔔', SIZE / 2, SIZE / 2 + 4);

  const url = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  cache.set(key, url);
  return url;
}

/** Fallback for wallets with no label: the packaged action icon. */
export function defaultIconUrl() {
  return chrome.runtime.getURL('icons/icon128.png');
}
