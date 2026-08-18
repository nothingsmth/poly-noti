/**
 * Polymarket Data API client. Public endpoints only — no auth, no signing.
 * @see https://docs.polymarket.com/api-reference/core/get-user-activity
 */

import {
  ACTIVITY_PAGE_SIZE,
  DATA_API,
  EVENT_PAGE_LIMIT,
  EVENT_PAGE_SIZE,
  GAMMA_API,
} from './constants.js';

/**
 * Fetch recent activity for one wallet, newest first.
 *
 * @param {string} address 0x-prefixed wallet address
 * @param {{ limit?: number, types?: string[], start?: number }} opts
 *   `types` omitted means "whatever the API sends". `types: []` means the user
 *   has unchecked every box in Advanced Settings and wants nothing.
 * @returns {Promise<object[]>} raw Activity rows
 */
export async function fetchActivity(address, opts = {}) {
  // An empty list is a request for nothing, and it has to be answered here.
  // The param is only set when there is something to put in it, so an empty
  // array would otherwise fall through as no filter at all — and the API's
  // unfiltered response is *every* type. Unchecking all nine would have
  // widened the feed rather than emptied it, which is the opposite of what the
  // boxes say. No request is made: there is nothing to ask for.
  if (Array.isArray(opts.types) && opts.types.length === 0) return [];

  const params = new URLSearchParams({
    user: address,
    limit: String(opts.limit ?? ACTIVITY_PAGE_SIZE),
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });
  if (opts.types?.length) params.set('type', opts.types.join(','));
  if (opts.start) params.set('start', String(opts.start));

  const res = await fetch(`${DATA_API}/activity?${params}`, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    // Cloudflare throttles rather than rejects, but surface real failures.
    let detail = '';
    try {
      detail = (await res.json())?.error || '';
    } catch {
      /* body wasn't JSON */
    }
    throw new Error(`Data API ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) return [];

  // A silently-renamed field would otherwise surface as blank $0 cards rather
  // than an error, so check the shape once per response and say so loudly.
  const sample = rows.find((r) => r?.type === 'TRADE');
  if (sample) {
    const missing = ['timestamp', 'size', 'usdcSize', 'price', 'side']
      .filter((k) => sample[k] === undefined);
    if (missing.length) {
      throw new Error(`Data API shape changed — missing ${missing.join(', ')}`);
    }
  }
  return rows;
}

/**
 * Public profile lookup, used to prefill a nickname when adding a wallet.
 * Failure is non-fatal — an unnamed trader is shown by their address.
 *
 * @param {string} address
 * @returns {Promise<{name?: string, pseudonym?: string} | null>}
 */
export async function fetchProfile(address) {
  try {
    const res = await fetch(`${DATA_API}/profiles/${address}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- market discovery */

/**
 * Newly listed events, newest first, stopping once `sinceId` is reached.
 *
 * Sort-and-stop rather than a date filter, because Gamma has no created-after
 * parameter on this endpoint. Ids are numeric and monotonic, and `order=id&
 * ascending=false` is honoured — verified against the live API, not just the
 * docs — so the newest ids are the newest events and the cursor is a single
 * number.
 *
 * Paging stops at whichever comes first: an event id at or below `sinceId`, a
 * short page (the end of the list), or EVENT_PAGE_LIMIT. The cap is what keeps a
 * first run, or a browser reopened after a week, from walking the entire event
 * history on a 30-second alarm.
 *
 * The **first page is always returned in full**, cursor or not. An event id only
 * moves when a whole event is created, so a market added to an event that already
 * exists sorts under that old id and the cursor would step straight over it. The
 * first page is a bounded lookback that gives the caller a chance to notice such
 * a market by id; deduping those ids is the caller's job, since this function
 * knows nothing about what has already been announced.
 *
 * @param {{ sinceId?: number, pageLimit?: number }} opts
 * @returns {Promise<object[]>} raw Gamma events, newest first, each with .markets
 */
export async function fetchNewEvents({ sinceId = 0, pageLimit = EVENT_PAGE_LIMIT } = {}) {
  const events = [];
  const since = Number(sinceId) || 0;

  for (let page = 0; page < pageLimit; page += 1) {
    const params = new URLSearchParams({
      closed: 'false',
      archived: 'false',
      order: 'id',
      ascending: 'false',
      limit: String(EVENT_PAGE_SIZE),
      offset: String(page * EVENT_PAGE_SIZE),
    });

    const res = await fetch(`${GAMMA_API}/events?${params}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);

    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;

    // Same reasoning as fetchActivity's check: a renamed field would otherwise
    // surface as a feed of blank cards rather than as an error. `markets` and
    // `title` are what the card is built from; `tags` is deliberately absent
    // from this list because live events legitimately arrive without it.
    if (page === 0) {
      const missing = ['id', 'title', 'markets'].filter((k) => rows[0]?.[k] === undefined);
      if (missing.length) {
        throw new Error(`Gamma API shape changed — missing ${missing.join(', ')}`);
      }
    }

    let reachedCursor = false;
    for (const event of rows) {
      if ((Number(event?.id) || 0) <= since) {
        reachedCursor = true;
        // Page 0 keeps going: it is the lookback window described above, and
        // stopping here would hide a new market on an older event.
        if (page > 0) break;
        events.push(event);
        continue;
      }
      events.push(event);
    }

    // A short page is the end of the list, so there is nothing behind it.
    if (reachedCursor || rows.length < EVENT_PAGE_SIZE) break;
  }

  return events;
}

