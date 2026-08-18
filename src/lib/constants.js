/**
 * Shared constants and defaults.
 */

export const DATA_API = 'https://data-api.polymarket.com';
/** Market and event metadata. A different host from the activity API. */
export const GAMMA_API = 'https://gamma-api.polymarket.com';
export const POLYMARKET_WEB = 'https://polymarket.com';

/**
 * Referral tag on every polymarket.com link this extension opens.
 *
 * One place rather than six string templates, because a link built without it is
 * indistinguishable from one built with it until someone reads the address bar —
 * so a missed call site would go unnoticed indefinitely. Every URL goes through
 * polymarketUrl() for that reason; nothing concatenates POLYMARKET_WEB directly.
 */
export const POLYMARKET_REF = 'via=poly_noti';

/**
 * A polymarket.com URL for `path`, carrying the referral tag.
 *
 * Appends with `?` or `&` by looking at the path rather than assuming: the paths
 * here are slug-based and query-free today, but a future one carrying its own
 * `?tab=` would otherwise produce a second `?` and a URL Chrome opens as junk.
 *
 * @param {string} [path] leading-slash path, e.g. `/event/foo`. Omit for the
 *   site root, which is the market toast's last resort when an event arrived with
 *   no slug at all.
 */
export function polymarketUrl(path = '') {
  const base = `${POLYMARKET_WEB}${path}`;
  return `${base}${base.includes('?') ? '&' : '?'}${POLYMARKET_REF}`;
}


/**
 * Poll interval. Not user-configurable: chrome.alarms refuses periods below
 * 30s, so this is simultaneously the fastest the browser allows and the
 * fastest Polymarket's public API tolerates.
 */
export const POLL_SECONDS = 30;

export const ALARM_POLL = 'poly-noti-poll';

/**
 * Fills of a single resting order arrive as separate TRADE rows. Rows sharing
 * wallet + market + asset + side inside this window collapse into one card.
 */
export const COLLAPSE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Rows older than this never raise a notification or enter the feed. Without
 * it, reopening the browser after a few hours would replay stale trades as if
 * they had just happened — they are unseen, but they are not news.
 */
export const MAX_ACTIVITY_AGE_MS = 60 * 60 * 1000;

/**
 * Activity types requested from the Data API.
 *
 * Trading and settlement only. The API also returns SPLIT, MERGE, CONVERSION and
 * the REWARD/REBATE family, which are position accounting rather than a trader
 * taking a view — so they are not requested by default. `settings.types` is what
 * actually goes on the wire, and Advanced Settings is where the rest are opted
 * into; this stays the default because widening it would drop months of
 * accounting rows into the feed of every install that never asked for them.
 */
export const DEFAULT_TYPES = ['TRADE', 'REDEEM'];

/**
 * Every type the app can render, in the order Advanced Settings lists them.
 *
 * The `type` values are the API's; the labels are the plural of what a card
 * actually says, so the checkbox and the card it governs use one vocabulary —
 * "Redeems" for the box, "Redeemed" on the card.
 *
 * Kept beside DEFAULT_TYPES, and asserted against format.js's VERBS table in
 * test-imports.mjs: a type offered here that VERBS cannot name would render as
 * its own raw constant, so the two lists agreeing is a real constraint rather
 * than tidiness. TRADE covers both directions — the API splits buy from sell
 * with a `side` field, not a second type, so there is one box for it.
 */
export const ACTIVITY_TYPES = [
  { type: 'TRADE', label: 'Trades' },
  { type: 'REDEEM', label: 'Redeems' },
  { type: 'SPLIT', label: 'Splits' },
  { type: 'MERGE', label: 'Merges' },
  { type: 'CONVERSION', label: 'Conversions' },
  { type: 'REWARD', label: 'Rewards' },
  { type: 'MAKER_REBATE', label: 'Maker rebates' },
  { type: 'TAKER_REBATE', label: 'Taker rebates' },
  { type: 'REFERRAL_REWARD', label: 'Referrals' },
];


/**
 * The one retired notification mode still worth naming. `MUTE` was a radio
 * beside a master switch that already did the same job; store.js migrates it
 * onto that switch, and this constant exists only so that migration has a name
 * to compare against. Nothing writes it any more.
 */
export const MODE_MUTE = 'MUTE';

/** Minimum-trade-size slider stops, in USDC. */
export const THRESHOLD_STEPS = [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export const DEFAULT_SETTINGS = {
  /** The switch on the toast channel. The feed and badge keep recording either
   *  way — turning alerts off is not the same as not watching. */
  notificationsEnabled: true,
  /** Every watched trader at once, in the same sense each row's own switch means
   *  it: no toast, no badge, out of the unfiltered feed. Distinct from the line
   *  above, which is about being interrupted rather than about the traders. Rows
   *  keep their individual state while this is off, so turning it back on
   *  restores exactly who was audible before. See lib/mute.js. */
  traderNotificationsEnabled: true,
  /** Trades below this raise no toast and are hidden from the feed. */
  minUsdc: 0,
  types: DEFAULT_TYPES,
  /** Cap on toasts per wallet per poll so one trader's burst can't bury the
   *  rest. Suppressed events still land in the feed. */
  maxPerWalletPerPoll: 3,
  /** The new-market channel, independent of the two switches above: it is not a
   *  trader, so `traderNotificationsEnabled` must not touch it, and it can be
   *  switched off while trader alerts stay on. Ships on, but inert until a watch
   *  or a category is added — there is nothing subscribed to on a fresh install. */
  newMarketsEnabled: true,
};

/**
 * Label emoji. Each one maps to an accent colour in lib/labelColor.js, so the
 * emoji is the only choice a label needs — and since an emoji can belong to
 * only one label, the length of this list is also the maximum number of labels.
 *
 * 18 fills the picker's 6-column grid exactly. Keeping it short is the point:
 * every entry has to stay visibly distinct from every other, and that gets
 * harder with each one added. lib/labelColor.js must gain a colour for anything
 * added here — test-palette.mjs fails otherwise.
 *
 * Dropped along the way: 🦈 🐺 🦍 🦅 🎲 🦢, whose artwork is grey or white so
 * they had no colour to stand for, then ⚡ 🪐 🛰️ 🧿 🦊 🐙 by preference.
 */
export const EMOJI_CHOICES = [
  '🔥', '💎', '🐳', '🚀', '🎯', '🧠',
  '👑', '🌊', '🤖', '📈', '💰', '🏆',
  '🔮', '✨', '🧪', '🍀', '🥇', '🌶️',
];

/** Pre-selected emoji in the label form, and the fallback when none is set. */
export const DEFAULT_LABEL_EMOJI = EMOJI_CHOICES[0];

export const FEED_LIMIT = 250;

/** Dedupe keys retained per wallet. Must comfortably exceed the rows one poll
 *  can return so a replayed row can't slip through as new. */
export const SEEN_KEYS_LIMIT = 400;

/** Rows requested per wallet per poll. */
export const ACTIVITY_PAGE_SIZE = 40;

/* ---------------------------------------------------- new-market discovery */

/**
 * Events requested per page when scanning for newly listed markets.
 *
 * The endpoint has no created-after filter, so the only way to find new events
 * is to sort newest-first and stop at the last id we already saw. Bigger pages
 * mean fewer round trips to reach that id.
 */
export const EVENT_PAGE_SIZE = 100;

/**
 * Pages walked per sweep before giving up and taking the newest id anyway.
 *
 * Without it, a first run — or a browser closed for a week — would page the
 * entire event history looking for a cursor it will never reach, on a 30-second
 * alarm. Hitting the cap means some middle band of events is skipped, which is
 * the right trade: this feature answers "what just appeared", and a market that
 * needed 500 newer events to bury it is not that.
 */
export const EVENT_PAGE_LIMIT = 5;

/**
 * Toast cap per event per sweep. Mirrors maxPerWalletPerPoll, and for the same
 * reason: one Gamma event can hold dozens of markets — a single soccer fixture
 * arrives with 25 — and a fixture is not worth 25 toasts. The suppressed ones
 * still land in the feed.
 */
export const MAX_PER_EVENT_PER_POLL = 3;

/**
 * Markets the new-market sweep will toast in one pass, across all events.
 *
 * The per-event cap does nothing about breadth: switch on a busy category and a
 * single sweep can match twenty unrelated events at three toasts each. This is
 * the backstop on the whole sweep.
 */
export const MAX_MARKET_TOASTS_PER_POLL = 8;

/**
 * Market ids retained on the new-market cursor.
 *
 * The event-id cursor alone is not enough: a market added to an *existing* event
 * sorts under that event's old id and would never be seen. So each sweep also
 * re-checks the newest events for market ids it has not recorded, and this is how
 * many of those ids it remembers. Must comfortably exceed the markets one sweep
 * can return, or a market would be re-announced as new after falling off the end.
 */
export const SEEN_MARKETS_LIMIT = 1500;

/**
 * Categories offered in the drawer, as Gamma tag slugs, each with the topics
 * that sit under it.
 *
 * A fixed list rather than one derived from live tags: Polymarket carries
 * hundreds of tags, most of them one fixture deep ("carrarese-calcio") or
 * outright junk ("product marekt fit", "virgins"), so a live list would be a
 * scrolling wall that is mostly noise. These are the top-level ones the site
 * itself navigates by.
 *
 * The `topics` are Polymarket's own children for each category, taken from
 * `/tags/{id}/related-tags` in the rank order that endpoint returns and cut to
 * roughly ten. Hardcoding them is a deliberate trade: the picker paints
 * instantly, works offline, and costs no requests, at the price of going stale
 * as Polymarket adds tags. Refreshing the list is a code edit — re-run
 * `/tags/{id}/related-tags` for each id below and paste the new labels.
 *
 * An event carries its parent tag *and* its child tags together — a Dogecoin
 * market arrives tagged `crypto`, `dogecoin`, `15M` — so subscribing to a
 * category and subscribing to one of its topics are the same kind of match
 * against the same field. That is why topics need no separate matching path.
 *
 * Slugs are Polymarket's, verbatim, and some ship mixed-case (`EPL`,
 * `Global-Rates`). Every comparison against them is case-folded — see
 * tagSlugs() in lib/watch.js — so do not "fix" the casing here.
 *
 * `sports` ships off by default, as does everything else: it is by far the
 * highest-volume tag, and switched on it would drown the feed.
 */
export const MARKET_CATEGORIES = [
  {
    slug: 'politics',
    label: 'Politics',
    emoji: '🏛️',
    topics: [
      { slug: 'trump', label: 'Trump' },
      { slug: 'midterms', label: 'Midterms' },
      { slug: 'global-elections', label: 'Global Elections' },
      { slug: 'primaries', label: 'Primaries' },
      { slug: 'congress', label: 'Congress' },
      { slug: 'courts', label: 'Courts' },
      { slug: 'us-election', label: 'US Election' },
      { slug: 'gov-shutdown', label: 'Gov Shutdown' },
      { slug: 'epstein', label: 'Epstein' },
      { slug: 'trump-cabinet', label: 'Trump Cabinet' },
    ],
  },
  {
    slug: 'crypto',
    label: 'Crypto',
    emoji: '🪙',
    // The only hand-picked list here. Crypto's own related-tags are the
    // scaffolding for the rolling price markets — `1H`, `Today 🚀`, `June 27`,
    // `weekly-tuesday` — which are timing buckets, not subjects, and would make
    // a picker nobody could read. These are the coins and themes instead; each
    // slug was checked against /tags/slug/{slug} and resolves.
    topics: [
      { slug: 'bitcoin', label: 'Bitcoin' },
      { slug: 'ethereum', label: 'Ethereum' },
      { slug: 'solana', label: 'Solana' },
      { slug: 'xrp', label: 'XRP' },
      { slug: 'dogecoin', label: 'Dogecoin' },
      { slug: 'stablecoins', label: 'Stablecoins' },
      { slug: 'airdrops', label: 'Airdrops' },
      { slug: 'microstrategy', label: 'MicroStrategy' },
    ],
  },
  {
    slug: 'economy',
    label: 'Economy',
    emoji: '📉',
    topics: [
      { slug: 'fed-rates', label: 'Fed Rates' },
      { slug: 'inflation', label: 'Inflation' },
      { slug: 'trade-war', label: 'Trade War' },
      { slug: 'macro-indicators', label: 'Macro Indicators' },
      { slug: 'gdp', label: 'GDP' },
      { slug: 'Global-Rates', label: 'Global Rates' },
      { slug: 'taxes', label: 'Taxes' },
      { slug: 'housing', label: 'Housing' },
      { slug: 'labor', label: 'Labor' },
      { slug: 'consumer', label: 'Consumer' },
    ],
  },
  {
    slug: 'tech',
    label: 'Tech',
    emoji: '💻',
    topics: [
      { slug: 'ai', label: 'AI' },
      { slug: 'openai', label: 'OpenAI' },
      { slug: 'elon-musk', label: 'Elon Musk' },
      { slug: 'spacex', label: 'SpaceX' },
      { slug: 'apple', label: 'Apple' },
      { slug: 'big-tech', label: 'Big Tech' },
      { slug: 'tiktok', label: 'TikTok' },
      { slug: 'science', label: 'Science' },
      { slug: 'app-store', label: 'App Store' },
    ],
  },
  {
    slug: 'culture',
    label: 'Culture',
    emoji: '🎬',
    topics: [
      { slug: 'celebrities', label: 'Celebrities' },
      { slug: 'movies', label: 'Movies' },
      { slug: 'music', label: 'Music' },
      { slug: 'awards', label: 'Awards' },
      { slug: 'box-office', label: 'Box Office' },
      { slug: 'mrbeast', label: 'MrBeast' },
      { slug: 'taylor-swift', label: 'Taylor Swift' },
      { slug: 'gta-vi', label: 'GTA VI' },
      { slug: 'art', label: 'Art' },
    ],
  },
  {
    slug: 'geopolitics',
    label: 'Geopolitics',
    emoji: '🌍',
    topics: [
      { slug: 'ukraine', label: 'Ukraine' },
      { slug: 'middle-east', label: 'Middle East' },
      { slug: 'israel', label: 'Israel' },
      { slug: 'gaza', label: 'Gaza' },
      { slug: 'iran', label: 'Iran' },
      { slug: 'venezuela', label: 'Venezuela' },
      { slug: 'oil', label: 'Oil' },
      { slug: 'syria', label: 'Syria' },
      { slug: 'lebanon', label: 'Lebanon' },
    ],
  },
  {
    slug: 'sports',
    label: 'Sports',
    emoji: '🏟️',
    topics: [
      { slug: 'nfl', label: 'NFL' },
      { slug: 'soccer', label: 'Soccer' },
      { slug: 'EPL', label: 'EPL' },
      { slug: 'mlb', label: 'MLB' },
      { slug: 'champions-league', label: 'Champions League' },
      { slug: 'cfb', label: 'CFB' },
      { slug: 'wnba', label: 'WNBA' },
      { slug: 'ufc', label: 'UFC' },
      { slug: 'golf', label: 'Golf' },
      { slug: 'esports', label: 'Esports' },
    ],
  },
];

/**
 * Tags marking an event as machine-generated on a timer rather than newly
 * listed.
 *
 * Polymarket mints rolling crypto price markets continuously — "Solana Up or
 * Down, 5:45PM-5:50PM ET", one per coin per window length — at roughly 4,000
 * events a day. Measured against live Gamma, 90 of the newest 100 events were
 * these and only 10 were genuine listings.
 *
 * `hide-from-new` is Polymarket's own instruction that they do not belong on its
 * New page, so this is their signal rather than a guess of ours; every such
 * event also carries `recurring`, and no genuine event carried either. Both are
 * listed because they are maintained separately and either one drifting alone
 * should not reopen the flood.
 *
 * Not filtered on `seriesSlug`, which looks like the obvious test and is wrong:
 * every event has one, including real fixtures (`bel1-games`).
 */
export const ROLLING_TAGS = ['hide-from-new', 'recurring'];

/** Watch keywords a user may store. A cap so the poll's matching stays cheap. */
export const WATCH_LIMIT = 40;


/**
 * Click targets retained for raised notifications, in session storage.
 *
 * A toast has to remember which market to open, and the worker can die before
 * the click arrives — so the mapping outlives it in chrome.storage.session.
 * Entries are removed when clicked, which means ignored toasts are what
 * accumulate; this bounds them. Generous on purpose: the cost of forgetting a
 * link is a click that opens nothing, so the cap only needs to sit well above
 * the number of toasts that could still plausibly be on screen.
 */
export const LINKS_LIMIT = 200;
