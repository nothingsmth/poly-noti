/**
 * Turning a matched Gamma market into a feed card.
 *
 * Feed items carry a `kind`: `'trade'` for everything the activity poller
 * produces, `'market'` for these. Items written before this feature existed have
 * no `kind` at all and are read as `'trade'` — see `feedKind`. There is no
 * migration and no rewrite of stored cards, the same approach normalizeSettings
 * takes to retired settings keys.
 */

/**
 * A stored item's kind, with the absent case named.
 *
 * Every card in every existing install predates `kind`, so treating a missing
 * value as unknown would blank the whole feed on upgrade.
 *
 * @param {object} item
 * @returns {'trade'|'market'}
 */
export function feedKind(item) {
  return item?.kind === 'market' ? 'market' : 'trade';
}

/**
 * @param {object} event Gamma event
 * @param {object} market one entry of event.markets
 * @param {{kind: string, value: string}} reason from lib/watch.js matchReason
 * @param {{ unread?: boolean }} [opts]
 * @returns {object} feed item
 */
export function toMarketItem(event, market, reason, { unread = true } = {}) {
  // createdAt is an ISO string on both the event and the market. The market's own
  // is preferred: a market added to an event that already existed is new even
  // though its event is not, and that is precisely the case the card is for.
  const ts = Date.parse(market?.createdAt || event?.createdAt || '') || Date.now();

  return {
    // Stable and market-scoped, so a market re-seen on the first-page lookback
    // cannot produce a second card even if the id cursor somehow lets it through.
    id: `mkt:${market?.id ?? ''}`,
    kind: 'market',
    eventId: String(event?.id ?? ''),
    marketId: String(market?.id ?? ''),
    // The market's question is the headline — "Will XRP be up at 5pm ET?" — and
    // the event title is the context around it. On a single-market event the two
    // are often the same string, which the card handles by showing one.
    question: market?.question || event?.title || '',
    title: event?.title || '',
    slug: market?.slug || '',
    eventSlug: event?.slug || '',
    tags: (Array.isArray(event?.tags) ? event.tags : [])
      .map((t) => t?.label)
      .filter((l) => typeof l === 'string' && l),
    // Why this fired. Shown on the card rather than in the toast: you only ask
    // that question while tuning watches, which is something you do in the popup.
    reason,
    // No monetary value at all, which is the whole reason minUsdc had to become
    // trade-only — a market compared against a dollar threshold is always below
    // it, so any non-zero slider would have deleted this feature from the feed.
    firstTs: ts,
    lastTs: ts,
    unread,
  };
}
