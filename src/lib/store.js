/**
 * chrome.storage.local wrapper with the app's schema.
 *
 * wallets  Wallet[]   { id, address, name, labelIds[], muted, addedAt, seeded }
 * labels   Label[]    { id, name, emoji, muted }
 * settings Settings   see DEFAULT_SETTINGS
 * cursors  { [address]: { lastTs, seen: string[] } }
 * feed     FeedItem[] newest first, capped at FEED_LIMIT by the worker. Mixed:
 *                     kind 'trade' cards from the activity poll and kind
 *                     'market' cards from the new-market sweep. Cards written
 *                     before `kind` existed have none; see lib/market.js.
 * watches  string[]   new-market keywords, matched with word boundaries
 * categories string[] Gamma tag slugs subscribed to whole; see MARKET_CATEGORIES
 * topics   string[]   Gamma tag slugs for individual topics under a category.
 *                     A separate key rather than merged into `categories` so the
 *                     picker can tell "all of Politics" from "Trump only" —
 *                     matching treats them alike, since an event carries its
 *                     parent and child tags together.
 * allMarkets boolean  every genuine new listing, whatever it is tagged
 * marketCursor { lastEventId, seenMarketIds[], seeded }
 * unread   number
 *
 * A wallet has no emoji of its own — the emoji belongs to its label, and the
 * label's accent colour is derived from that emoji rather than stored.
 */

import {
  ACTIVITY_TYPES,
  DEFAULT_LABEL_EMOJI,
  DEFAULT_SETTINGS,
  DEFAULT_TYPES,
  MODE_MUTE,
  SEEN_KEYS_LIMIT,
  SEEN_MARKETS_LIMIT,
  WATCH_LIMIT,
} from './constants.js';

const DEFAULTS = {
  wallets: [],
  labels: [],
  settings: DEFAULT_SETTINGS,
  cursors: {},
  feed: [],
  watches: [],
  /** Empty, not every category: a fresh install must not start announcing
   *  markets nobody asked for. The feature is inert until something is added.
   *  The same goes for `topics` and `allMarkets` below — nothing is subscribed
   *  until the user says so, which is also why the sweep never calls Gamma on a
   *  fresh install. */
  categories: [],
  topics: [],
  allMarkets: false,
  marketCursor: { lastEventId: 0, seenMarketIds: [], seeded: false, key: '' },
  unread: 0,
};


/**
 * Settings gain and lose keys across versions, so every read passes through
 * here. Three removals need handling rather than just a default merge:
 * `pollSeconds` (the interval is fixed now), and `mode` — both the long-gone
 * `IMPORTANT` and the `ALL`/`MUTE` pair that replaced it.
 *
 * `mode` is dropped because it never described anything the master switch did
 * not: both `MUTE` and `notificationsEnabled: false` ended at the same two
 * lines in notifyForTouched, so the drawer offered a switch and a radio pair
 * for one decision. Worse, they could disagree — switch on, mode MUTE — and
 * the result was silence that read as a broken install.
 *
 * So a stored `MUTE` migrates onto the switch instead of being discarded.
 * Dropping it outright would leave anyone who had chosen "Mute everything"
 * permanently silent with no control left to undo it.
 */
function normalizeSettings(raw) {
  const { pollSeconds, mode, ...rest } = { ...DEFAULT_SETTINGS, ...raw };
  return {
    ...rest,
    notificationsEnabled: rest.notificationsEnabled !== false && mode !== MODE_MUTE,
    types: normalizeTypes(rest.types),
  };
}

/**
 * Keep `settings.types` to types the app can actually name.
 *
 * This value goes straight onto the Data API's `type=` param, so anything
 * unrecognised in storage — a type dropped from a later build, a hand-edited
 * key — would either be rejected by the API or come back as rows the feed
 * renders with a raw constant for a verb. Filtering against ACTIVITY_TYPES is
 * also what lets the checkbox grid treat storage as the whole truth: whatever
 * survives here is exactly what the boxes show.
 *
 * A non-array falls back to the default rather than to empty, because empty is
 * a real choice now — "fetch nothing" — and a corrupt key must not be read as
 * the user having made it.
 */
function normalizeTypes(types) {
  if (!Array.isArray(types)) return [...DEFAULT_TYPES];
  const known = new Set(ACTIVITY_TYPES.map((t) => t.type));
  return ACTIVITY_TYPES
    .map((t) => t.type)
    .filter((t) => types.includes(t) && known.has(t));
}

export async function getAll() {
  const data = await chrome.storage.local.get(DEFAULTS);
  data.settings = normalizeSettings(data.settings);
  return data;
}

export async function get(key) {
  const data = await chrome.storage.local.get({ [key]: DEFAULTS[key] });
  return key === 'settings' ? normalizeSettings(data[key]) : data[key];
}

export async function set(patch) {
  await chrome.storage.local.set(patch);
}

export function newId() {
  return crypto.randomUUID();
}

export function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase();
}

export function isValidAddress(address) {
  return /^0x[a-f0-9]{40}$/.test(normalizeAddress(address));
}

export function shortAddress(address) {
  const a = normalizeAddress(address);
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

/* ---------------------------------------------------------------- wallets */

export async function addWallet({ address, name, labelIds }) {
  const wallets = await get('wallets');
  const addr = normalizeAddress(address);
  if (wallets.some((w) => w.address === addr)) {
    throw new Error('That wallet is already being tracked.');
  }
  const wallet = {
    id: newId(),
    address: addr,
    // Unnamed traders are identified by their address, here and in the feed.
    name: name?.trim() || shortAddress(addr),
    labelIds: labelIds || [],
    muted: false,
    addedAt: Date.now(),
    // First poll backfills the last hour into the feed, already-read: what you
    // just did is worth seeing, but it is not worth interrupting you over.
    seeded: false,
  };
  await set({ wallets: [...wallets, wallet] });
  return wallet;
}

export async function updateWallet(id, patch) {
  const wallets = await get('wallets');
  await set({ wallets: wallets.map((w) => (w.id === id ? { ...w, ...patch } : w)) });
}

export async function removeWallet(id) {
  const [wallets, cursors, feed] = await Promise.all([
    get('wallets'),
    get('cursors'),
    get('feed'),
  ]);
  const target = wallets.find((w) => w.id === id);
  if (!target) return;
  const next = wallets.filter((w) => w.id !== id);
  // Drop the cursor only when no other entry watches the same address.
  if (!next.some((w) => w.address === target.address)) {
    delete cursors[target.address];
  }
  await set({
    wallets: next,
    cursors,
    feed: feed.filter((item) => item.walletId !== id),
  });
}

/* ----------------------------------------------------------------- labels */

/**
 * An emoji belongs to exactly one label.
 *
 * The emoji is a label's entire visual identity — it picks the accent colour,
 * fronts every card, and becomes the notification icon — so two labels sharing
 * one are indistinguishable in the feed. Enforced here rather than only in the
 * picker so the rule survives any caller, the same way addWallet guards against
 * a duplicate address.
 *
 * @throws {Error} naming the label already holding it
 */
function assertEmojiFree(labels, emoji, exceptId = null) {
  const clash = labels.find((l) => l.id !== exceptId && l.emoji === emoji);
  if (clash) throw new Error(`${emoji} is already used by “${clash.name}”.`);
}

export async function addLabel({ name, emoji }) {
  const labels = await get('labels');
  const chosen = emoji || DEFAULT_LABEL_EMOJI;
  assertEmojiFree(labels, chosen);
  const label = {
    id: newId(),
    name: name?.trim() || 'Untitled',
    emoji: chosen,
    muted: false,
  };
  await set({ labels: [...labels, label] });
  return label;
}

export async function updateLabel(id, patch) {
  const labels = await get('labels');
  // Only a *change* of emoji is checked. Labels created before the rule existed
  // may already share one; blocking on the unchanged value would trap them in a
  // form that can never be saved, so their name stays editable and only moving
  // onto someone else's emoji is refused.
  const current = labels.find((l) => l.id === id);
  if (patch.emoji && patch.emoji !== current?.emoji) {
    assertEmojiFree(labels, patch.emoji, id);
  }
  await set({ labels: labels.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
}

export async function removeLabel(id) {
  const [labels, wallets] = await Promise.all([get('labels'), get('wallets')]);
  await set({
    labels: labels.filter((l) => l.id !== id),
    wallets: wallets.map((w) => ({
      ...w,
      labelIds: (w.labelIds || []).filter((lid) => lid !== id),
    })),
  });
}

/* ---------------------------------------------------------------- cursors */

export async function getCursor(address) {
  const cursors = await get('cursors');
  return cursors[normalizeAddress(address)] || null;
}

export async function setCursor(address, cursor) {
  const cursors = await get('cursors');
  cursors[normalizeAddress(address)] = {
    lastTs: cursor.lastTs || 0,
    seen: (cursor.seen || []).slice(-SEEN_KEYS_LIMIT),
  };
  await set({ cursors });
}

/* ---------------------------------------------------------- new markets */

/**
 * Add a keyword watch. Case-insensitively deduped, since matching is
 * case-insensitive too — storing both "Trump" and "trump" would double every
 * match against the same word.
 *
 * @throws {Error} when blank, already present, or the list is full
 */
export async function addWatch(term) {
  const watch = String(term || '').trim();
  // A blank watch would match every market on Polymarket, which is why
  // matchesWatch refuses one too. Two guards, because either alone is one
  // refactor away from being the only thing standing between a stray empty row
  // and the entire event list.
  if (!watch) throw new Error('Enter a keyword to watch for.');

  const watches = await get('watches');
  if (watches.some((w) => w.toLowerCase() === watch.toLowerCase())) {
    throw new Error(`You're already watching “${watch}”.`);
  }
  if (watches.length >= WATCH_LIMIT) {
    throw new Error(`That's the limit of ${WATCH_LIMIT} keywords — remove one first.`);
  }
  await set({ watches: [...watches, watch] });
  return watch;
}

export async function removeWatch(term) {
  const watches = await get('watches');
  await set({ watches: watches.filter((w) => w !== term) });
}

/**
 * Write the whole market subscription in one go, with "All" kept exclusive.
 *
 * The picker stages its edits and saves once, so this takes the finished state
 * rather than offering a toggle per row. That also gives the exclusivity rule a
 * single home: `allMarkets` already means every genuine listing, so holding
 * categories or topics alongside it would be a subscription that changes nothing
 * if you removed it — and a picker showing "All categories" *and* "Politics"
 * ticked is a state nobody can read. Whichever the user chose last wins, which
 * the caller expresses by clearing the other side before calling.
 *
 * Slugs are deduped but not lowercased: they are Polymarket's own, some are
 * legitimately mixed-case (`EPL`, `Global-Rates`), and every comparison against
 * them is case-folded at the point of use.
 *
 * @param {{ categories?: string[], topics?: string[], allMarkets?: boolean }} next
 */
export async function setSubscriptions({ categories = [], topics = [], allMarkets = false }) {
  const all = allMarkets === true;
  await set({
    allMarkets: all,
    categories: all ? [] : [...new Set(categories.filter(Boolean))],
    topics: all ? [] : [...new Set(topics.filter(Boolean))],
  });
}

/**
 * Every market subscription at once, for the sweep and for the picker's opening
 * state. One read rather than four, so the two can't disagree mid-flight.
 */
export async function getSubscriptions() {
  const [watches, categories, topics, allMarkets] = await Promise.all([
    get('watches'), get('categories'), get('topics'), get('allMarkets'),
  ]);
  return {
    watches: Array.isArray(watches) ? watches : [],
    categories: Array.isArray(categories) ? categories : [],
    topics: Array.isArray(topics) ? topics : [],
    allMarkets: allMarkets === true,
  };
}

export async function getMarketCursor() {
  const cursor = await get('marketCursor');
  return {
    lastEventId: Number(cursor?.lastEventId) || 0,
    seenMarketIds: Array.isArray(cursor?.seenMarketIds) ? cursor.seenMarketIds : [],
    seeded: cursor?.seeded === true,
    /** The subscription set the `seeded` flag was earned against; see
     *  subscriptionKey in background.js. */
    key: typeof cursor?.key === 'string' ? cursor.key : '',
  };
}

export async function setMarketCursor({ lastEventId, seenMarketIds, seeded, key }) {
  await set({
    marketCursor: {
      lastEventId: Number(lastEventId) || 0,
      // Oldest ids drop off the front, so a market can only be re-announced once
      // it is far enough back that a fresh listing is the likelier reading.
      seenMarketIds: (seenMarketIds || []).slice(-SEEN_MARKETS_LIMIT),
      seeded: seeded === true,
      key: String(key || ''),
    },
  });
}

/* ------------------------------------------------------------------- feed */

/**
 * Mark every feed card as read; called when the popup opens.
 *
 * The only feed writer here. The worker writes the feed itself, because folding
 * rows needs the whole list in hand to merge into and it caps the result on the
 * way out — so a push helper on this side would be a second, divergent path to
 * the same key.
 */
export async function markFeedRead() {
  const feed = await get('feed');
  await set({ feed: feed.map((item) => ({ ...item, unread: false })), unread: 0 });
}
