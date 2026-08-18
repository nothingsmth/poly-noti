/**
 * Collapsing raw activity rows into feed cards.
 *
 * Polymarket fills a resting limit order in pieces, and each piece arrives as
 * its own TRADE row. Rows that share wallet + market + asset + side inside
 * COLLAPSE_WINDOW_MS are therefore treated as one order and merged into a
 * single card carrying summed shares, summed value and a weighted average
 * price. This is the closest we can get to order-level context without the
 * authenticated CLOB channel.
 */

import { COLLAPSE_WINDOW_MS } from './constants.js';

/**
 * Stable identity for one raw activity row, used to avoid re-processing rows
 * that a later poll returns again.
 *
 * Two fills of identical size in the same transaction on the same asset and
 * side would collide, which is rare enough to accept: the cost is one missed
 * card, not a duplicate notification.
 */
export function rowKey(row) {
  return [
    row.transactionHash || '',
    row.asset || '',
    row.side || '',
    row.size ?? '',
    row.timestamp ?? '',
  ].join('|');
}

/** Rows sharing this key are candidates for collapsing. */
export function groupKey(address, row) {
  return [address, row.conditionId || '', row.asset || '', row.side || '', row.type].join('|');
}

function toItem(wallet, row, tsMs, unread) {
  return {
    id: `${groupKey(wallet.address, row)}|${tsMs}`,
    groupKey: groupKey(wallet.address, row),
    walletId: wallet.id,
    address: wallet.address,
    type: row.type,
    conditionId: row.conditionId || '',
    asset: row.asset || '',
    side: row.side || '',
    outcome: row.outcome || '',
    outcomeIndex: row.outcomeIndex ?? null,
    title: row.title || '',
    slug: row.slug || '',
    eventSlug: row.eventSlug || '',
    icon: row.icon || '',
    shares: Number(row.size) || 0,
    value: Number(row.usdcSize) || 0,
    price: Number(row.price) || 0,
    fills: 1,
    firstTs: tsMs,
    lastTs: tsMs,
    txHashes: row.transactionHash ? [row.transactionHash] : [],
    unread,
  };
}

function mergeRow(item, row, tsMs, unread) {
  const shares = item.shares + (Number(row.size) || 0);
  const value = item.value + (Number(row.usdcSize) || 0);
  return {
    ...item,
    shares,
    value,
    // Weighted average: total dollars over total shares.
    price: shares > 0 ? value / shares : item.price,
    fills: item.fills + 1,
    firstTs: Math.min(item.firstTs, tsMs),
    lastTs: Math.max(item.lastTs, tsMs),
    txHashes: row.transactionHash && !item.txHashes.includes(row.transactionHash)
      ? [...item.txHashes, row.transactionHash]
      : item.txHashes,
    // A silenced fill must not *clear* an existing unread flag: the card may
    // predate the mute, in which case there is still something you haven't seen.
    // Silence only means "don't newly light it up".
    unread: unread || item.unread,
  };
}

/**
 * Fold new rows into the existing feed.
 *
 * @param {object} wallet
 * @param {object[]} rows fresh activity rows (any order)
 * @param {object[]} feed current feed, newest first
 * @param {{ unread?: boolean }} [opts] `unread: false` records the rows without
 *   lighting up the badge or the card — how a muted trader's activity arrives.
 * @returns {{ feed: object[], touched: Map<string, {item: object, addedValue: number, addedShares: number, addedFills: number, isNew: boolean}> }}
 */
export function foldRows(wallet, rows, feed, { unread = true } = {}) {
  // Oldest first so merges accumulate in chronological order.
  const ordered = [...rows].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const byId = new Map(feed.map((item) => [item.id, item]));
  const order = feed.map((item) => item.id);
  const touched = new Map();

  for (const row of ordered) {
    const tsMs = (Number(row.timestamp) || 0) * 1000;
    const key = groupKey(wallet.address, row);

    // Newest existing card in this group, if it's still inside the window.
    let target = null;
    for (const id of order) {
      const candidate = byId.get(id);
      if (candidate?.groupKey !== key) continue;
      if (Math.abs(tsMs - candidate.lastTs) <= COLLAPSE_WINDOW_MS) target = candidate;
      break; // `order` is newest-first, so the first match is the newest card
    }

    if (target) {
      const merged = mergeRow(target, row, tsMs, unread);
      byId.set(merged.id, merged);
      const prev = touched.get(merged.id);
      touched.set(merged.id, {
        item: merged,
        addedValue: (prev?.addedValue || 0) + (Number(row.usdcSize) || 0),
        addedShares: (prev?.addedShares || 0) + (Number(row.size) || 0),
        addedFills: (prev?.addedFills || 0) + 1,
        isNew: prev?.isNew || false,
      });
    } else {
      const item = toItem(wallet, row, tsMs, unread);
      byId.set(item.id, item);
      order.unshift(item.id);
      touched.set(item.id, {
        item,
        addedValue: item.value,
        addedShares: item.shares,
        addedFills: 1,
        isNew: true,
      });
    }
  }

  // Rebuild newest-first; merged cards float up to their new lastTs.
  const next = order.map((id) => byId.get(id)).filter(Boolean);
  next.sort((a, b) => b.lastTs - a.lastTs);

  // touched holds stale item snapshots after later merges; refresh them.
  for (const [id, info] of touched) {
    const current = byId.get(id);
    if (current) touched.set(id, { ...info, item: current });
  }

  return { feed: next, touched };
}
