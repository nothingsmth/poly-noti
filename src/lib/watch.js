/**
 * Deciding whether a newly listed market is one the user asked to hear about.
 *
 * Four triggers, OR'd, and any one is enough: a **keyword watch** the user
 * typed, a **topic** under a category, a whole **category**, or **all markets**.
 * They are not the same kind of thing and none subsumes the others — a category
 * is broad and stays useful without maintenance ("every new election market"), a
 * topic narrows that to the part you actually follow ("Trump, not every election
 * on earth"), and a watch is precise about a subject Polymarket may not have
 * tagged at all ("MrBeast").
 *
 * The match runs against the market `question`, its event `title`, and the
 * event's tag labels. Tags are included because Polymarket's own titles are
 * often uninformative — "Up or Down" says nothing about XRP — and the tag is
 * where the subject actually lives.
 *
 * Nothing here touches storage or the network, so it is directly testable; see
 * test-watch.mjs.
 */

import { ROLLING_TAGS } from './constants.js';

/**
 * Word-boundary matching, not substring.
 *
 * This is the whole reason this module is not a `.includes()` call. Polymarket's
 * event list is dominated by sports, and a naive substring match on a watch like
 * `Fed` fires on every Federer match on the tennis calendar — dozens a day, none
 * of them about interest rates. Same for `Ada` in "Adam", or `AI` in "Said".
 *
 * `\b` is ASCII-only in JS, so the boundaries are spelled out as Unicode
 * property lookarounds instead: a market titled "¿Ganará Milei?" must still
 * match a `Milei` watch rather than failing on the accented neighbours.
 */
function watchPattern(watch) {
  const escaped = watch
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // A multi-word watch is matched loosely on its spacing: "United States"
    // should hit "United  States" and a newline-wrapped title alike.
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Compiling the same regex on every market of every poll is the wasteful path. */
const patternCache = new Map();

function patternFor(watch) {
  let re = patternCache.get(watch);
  if (!re) {
    re = watchPattern(watch);
    patternCache.set(watch, re);
  }
  return re;
}

/**
 * @param {string} text
 * @param {string} watch
 * @returns {boolean}
 */
export function matchesWatch(text, watch) {
  // An empty watch would compile to a pattern matching every position in every
  // string, so it is refused here rather than trusted to be filtered upstream —
  // one blank row in `watches` would otherwise alert on the entire market list.
  const term = String(watch ?? '').trim();
  if (!term) return false;
  return patternFor(term).test(String(text ?? ''));
}

/**
 * The text a market is matched against: its own question, its event's title,
 * and the event's tag labels.
 *
 * @param {object} event Gamma event
 * @param {object} market one entry of event.markets
 * @returns {string[]}
 */
export function haystack(event, market) {
  return [
    market?.question,
    event?.title,
    // Live events genuinely arrive with no tags array at all — event 824346
    // ("Carrarese Calcio vs. Mantova 1911") carries 25 markets and no tags — so
    // this cannot assume the field exists.
    ...(Array.isArray(event?.tags) ? event.tags.map((t) => t?.label) : []),
  ].filter((s) => typeof s === 'string' && s);
}

/**
 * Tag slugs on an event, lowercased. These are what a category subscription is
 * keyed on: the docs list a `category` field on events, but no such field exists
 * in real responses — the tags array is what the category actually is.
 *
 * @param {object} event
 * @returns {string[]}
 */
export function tagSlugs(event) {
  return (Array.isArray(event?.tags) ? event.tags : [])
    .map((t) => String(t?.slug || '').toLowerCase())
    .filter(Boolean);
}

/**
 * Why this market should alert, or null if it shouldn't.
 *
 * A single reason is returned rather than every one that applied: it exists to
 * be shown on the feed card ("Matched “MrBeast”"), and a card listing three
 * overlapping causes answers a question nobody asked.
 *
 * The order is specific-to-broad, because the more specific answer is the more
 * useful one. A watch is the exact string the user typed, so it wins outright. A
 * topic beats its own parent category: an event tagged both `politics` and
 * `trump` reads better as "In Trump" than "In Politics", and if the user
 * subscribed to the topic rather than the category, naming the category would be
 * telling them about a subscription they don't have. `allMarkets` is last
 * because it explains nothing — it is the reason only when nothing else is.
 *
 * @param {object} event Gamma event
 * @param {object} market one entry of event.markets
 * @param {{ watches?: string[], categories?: string[], topics?: string[],
 *           allMarkets?: boolean }} subs
 * @returns {{ kind: 'watch'|'topic'|'category'|'all', value: string } | null}
 */
export function matchReason(event, market, {
  watches = [], categories = [], topics = [], allMarkets = false,
} = {}) {
  const fields = haystack(event, market);
  for (const watch of watches) {
    if (fields.some((text) => matchesWatch(text, watch))) {
      return { kind: 'watch', value: String(watch).trim() };
    }
  }

  // Topics and categories are both plain tag slugs on the same event — a
  // Dogecoin market arrives tagged `crypto`, `dogecoin`, `15M` — so they share
  // one lookup and differ only in which set is consulted first.
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const named = (set, kind) => {
    const enabled = new Set([...set].map((c) => String(c || '').toLowerCase()).filter(Boolean));
    if (!enabled.size) return null;
    // The tag order is Polymarket's, and the first enabled one wins. Which of
    // several enabled entries gets named is arbitrary either way, so this stays
    // deterministic rather than trying to rank them.
    const tag = tags.find((t) => enabled.has(String(t?.slug || '').toLowerCase()));
    if (tag) return { kind, value: tag.label || tag.slug };
    // Defensive: an event whose tags carry a slug but no label object shape we
    // recognise still matched, and dropping it would silently under-alert.
    const slug = tagSlugs(event).find((s) => enabled.has(s));
    return slug ? { kind, value: slug } : null;
  };

  return named(topics, 'topic')
    || named(categories, 'category')
    // Everything, deliberately chosen. The sweep has already dropped the
    // machine-generated rolling markets by this point (see ROLLING_TAGS), so
    // this means every genuine new listing rather than the full firehose.
    || (allMarkets ? { kind: 'all', value: 'New listing' } : null);
}

/**
 * Every market across `events` that should alert, newest event first.
 *
 * Flattens deliberately: one Gamma event can hold many markets — a single soccer
 * fixture arrived with 25 — and the user's own reference for this feature showed
 * three separate toasts for three near-identical MrBeast markets, so the market,
 * not the event, is the unit. Capping the *toasts* per event is the caller's job;
 * every match still belongs in the feed.
 *
 * @param {object[]} events
 * @param {{ watches?: string[], categories?: string[] }} subs
 * @returns {{ event: object, market: object, reason: {kind: string, value: string} }[]}
 */
/**
 *
 * See ROLLING_TAGS. Checked on the event, not the market, because the tags live
 * at the event level — and it is checked before matching rather than after, so a
 * subscription can never be the thing that lets 4,000 of these a day through.
 *
 * @param {object} event
 * @returns {boolean}
 */
export function isRollingEvent(event) {
  const slugs = new Set(tagSlugs(event));
  return ROLLING_TAGS.some((t) => slugs.has(t.toLowerCase()));
}

/**
 * Every market across `events` that should alert, newest event first.
 *
 * Flattens deliberately: one Gamma event can hold many markets — a single soccer
 * fixture arrived with 25 — and the user's own reference for this feature showed
 * three separate toasts for three near-identical MrBeast markets, so the market,
 * not the event, is the unit. Capping the *toasts* per event is the caller's job;
 * every match still belongs in the feed.
 *
 * @param {object[]} events
 * @param {{ watches?: string[], categories?: string[], topics?: string[],
 *           allMarkets?: boolean }} subs
 * @returns {{ event: object, market: object, reason: {kind: string, value: string} }[]}
 */
export function matchMarkets(events, subs) {
  const out = [];
  for (const event of events || []) {
    // Dropped here rather than in the caller so that every path into matching —
    // the sweep, the tests, anything later — gets the same protection.
    if (isRollingEvent(event)) continue;
    for (const market of Array.isArray(event?.markets) ? event.markets : []) {
      const reason = matchReason(event, market, subs);
      if (reason) out.push({ event, market, reason });
    }
  }
  return out;
}
