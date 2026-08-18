/**
 * Display formatting shared by the popup and the notification builder.
 */

const VERBS = {
  TRADE_BUY: 'Bought',
  TRADE_SELL: 'Sold',
  REDEEM: 'Redeemed',
  SPLIT: 'Split',
  MERGE: 'Merged',
  CONVERSION: 'Converted',
  REWARD: 'Reward',
  MAKER_REBATE: 'Maker rebate',
  TAKER_REBATE: 'Taker rebate',
  REFERRAL_REWARD: 'Referral reward',
};

export function verbFor(type, side) {
  if (type === 'TRADE') return VERBS[`TRADE_${side}`] || 'Traded';
  return VERBS[type] || type;
}

export function formatUsd(value) {
  const n = Number(value) || 0;
  return `US$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact dollars for notification bodies: $1.2k, $713.37. */
export function formatUsdShort(value) {
  const n = Number(value) || 0;
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatShares(value) {
  const n = Number(value) || 0;
  // Whole share counts read better without a trailing .00.
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  });
}

/** Prices are 0–1 probabilities; Polymarket quotes them as dollars: $0.63. */
export function formatPrice(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

export function relativeTime(ms) {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
