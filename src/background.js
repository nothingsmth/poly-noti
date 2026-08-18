/**
 * Poly Noti service worker: polls the Polymarket Data API for each watched
 * wallet, folds new rows into the feed, and raises notifications.
 *
 * MV3 terminates this worker aggressively, so every listener is registered
 * synchronously at the top level and all state lives in chrome.storage.
 */

import { fetchActivity, fetchNewEvents } from './lib/api.js';
import { buildActionIcon } from './lib/actionIcon.js';
import { foldRows, rowKey } from './lib/aggregate.js';
import {
  ALARM_POLL,
  FEED_LIMIT,
  LINKS_LIMIT,
  MAX_ACTIVITY_AGE_MS,
  MAX_MARKET_TOASTS_PER_POLL,
  MAX_PER_EVENT_PER_POLL,
  POLL_SECONDS,
  polymarketUrl,
  SEEN_KEYS_LIMIT,
} from './lib/constants.js';
import { formatPrice, formatShares, formatUsdShort, truncate, verbFor } from './lib/format.js';
import { buildNotificationIcon, defaultIconUrl } from './lib/icon.js';
import { feedKind, toMarketItem } from './lib/market.js';
import { isWalletMuted, primaryLabel } from './lib/mute.js';
import * as store from './lib/store.js';
import { matchMarkets } from './lib/watch.js';

/** Guards against overlapping polls within one worker lifetime. */
let polling = false;

/* -------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(() => {
  void scheduleAlarm();
  void refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleAlarm();
  void refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_POLL) void pollAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async reply
});

chrome.notifications.onClicked.addListener((id) => {
  void openFromNotification(id);
});

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'POLL_NOW':
      return { polled: await pollAll({ force: true }) };
    case 'RESCHEDULE':
      await scheduleAlarm();
      return {};
    case 'REFRESH_BADGE':
      await refreshBadge();
      return {};
    default:
      return {};
  }
}

async function scheduleAlarm() {
  await chrome.alarms.clear(ALARM_POLL);
  await chrome.alarms.create(ALARM_POLL, {
    periodInMinutes: POLL_SECONDS / 60,
    delayInMinutes: POLL_SECONDS / 60,
  });
}

/* ------------------------------------------------------------------- poll */

async function pollAll({ force = false } = {}) {
  if (polling && !force) return 0;
  polling = true;
  try {
    const { wallets, labels, settings, feed } = await store.getAll();

    let workingFeed = feed;
    let notified = 0;

    for (const wallet of wallets) {
      try {
        const result = await pollWallet(wallet, {
          labels,
          settings,
          feed: workingFeed,
        });
        workingFeed = result.feed;
        notified += result.notified;
      } catch (err) {
        // One bad wallet must not stall the rest of the sweep.
        console.warn(`[Poly Noti] poll failed for ${wallet.address}:`, err);
      }
    }

    // Once per sweep, not once per wallet: the market list is the same for
    // everyone, so it has nothing to do with how many traders are watched. It
    // runs on an install with no wallets at all for the same reason — new-market
    // alerts are a subscription of their own, and the old `!wallets.length` bail
    // above would have made them depend on tracking someone.
    try {
      const result = await pollNewMarkets({ settings, feed: workingFeed });
      workingFeed = result.feed;
      notified += result.notified;
    } catch (err) {
      console.warn('[Poly Noti] new-market sweep failed:', err);
    }

    await store.set({ feed: workingFeed.slice(0, FEED_LIMIT) });
    await refreshBadge();
    return notified;
  } finally {
    polling = false;
  }
}

async function pollWallet(wallet, { labels, settings, feed }) {
  const cursor = (await store.getCursor(wallet.address)) || { lastTs: 0, seen: [] };
  const seen = new Set(cursor.seen);

  const rows = await fetchActivity(wallet.address, { types: settings.types });
  const cutoff = Date.now() - MAX_ACTIVITY_AGE_MS;
  const fresh = rows.filter(
    (row) => !seen.has(rowKey(row)) && (Number(row.timestamp) || 0) * 1000 >= cutoff,
  );

  // Record every row the API returned, not just the recent ones, so rows aged
  // out by the cutoff are never reconsidered on a later poll.
  if (rows.length) {
    for (const row of rows) seen.add(rowKey(row));
    await store.setCursor(wallet.address, {
      lastTs: Math.max(cursor.lastTs, ...fresh.map((r) => (Number(r.timestamp) || 0) * 1000)),
      seen: [...seen].slice(-SEEN_KEYS_LIMIT),
    });
  }

  // A newly added wallet's first *completed* poll is a backfill, not news. What
  // that has to suppress is the interruption — a whale added mid-session would
  // otherwise fire a toast per fill the instant you finished typing their
  // address — and the badge, which answers "what arrived while you were away".
  //
  // It does *not* have to suppress the feed, and discarding `fresh` here is what
  // made the extension read as broken: someone who adds their own wallet right
  // after trading is doing it *because* they just traded, and the panel opened
  // empty. `fresh` is already bounded to MAX_ACTIVITY_AGE_MS, so this is at most
  // the last hour — a handful of rows, and the same hour the poll would have
  // shown them had they added the wallet sixty seconds earlier.
  //
  // Seeding is also decided before the empty-fresh bail below, not after. A
  // trader who happened to be quiet during their first hour of tracking returns
  // no fresh rows at all, so bailing first left them permanently unseeded — and
  // the seeding step then swallowed their first *real* trade instead of the
  // backfill it exists to absorb.
  if (!wallet.seeded) {
    await store.updateWallet(wallet.id, { seeded: true });
    if (!fresh.length) return { feed, notified: 0 };
    // Already-read, the same way a muted trader's cards arrive: recorded and
    // visible, but not lighting anything up.
    const { feed: seededFeed } = foldRows(wallet, fresh, feed, { unread: false });
    return { feed: seededFeed, notified: 0 };
  }

  if (!fresh.length) return { feed, notified: 0 };

  // Muting a trader silences them end to end, not just the toast. Writing the
  // cards already-read is what keeps them out of the badge — refreshBadge
  // counts unread cards, so there is nothing for it to find.
  const muted = isWalletMuted(wallet, labels, settings);
  const { feed: nextFeed, touched } = foldRows(wallet, fresh, feed, { unread: !muted });
  const notified = muted ? 0 : await notifyForTouched(wallet, touched, { labels, settings });
  return { feed: nextFeed, notified };
}

/* ----------------------------------------------------------- new markets */

/**
 * Find markets listed since the last sweep that match a watch or a category.
 *
 * Two things bound what this can announce, and they are separate on purpose:
 *
 * `lastEventId` is the paging cursor — how far back fetchNewEvents walks. It
 * only moves when whole events are created, so on its own it would step straight
 * over a market added to an event that already existed.
 *
 * `seenMarketIds` is what decides *newness*. Every matched market is checked
 * against it, which is why the first page is re-scanned in full each sweep: that
 * is the bounded lookback where a market on an older event can still be noticed.
 */
async function pollNewMarkets({ settings, feed }) {
  const subs = await store.getSubscriptions();
  const { watches, categories, topics, allMarkets } = subs;

  // Nothing subscribed means nothing to look for, and the fetch itself is what
  // we are avoiding: a fresh install should not be hitting Gamma every 30
  // seconds to compare against an empty watch list.
  if (!watches.length && !categories.length && !topics.length && !allMarkets) {
    return { feed, notified: 0 };
  }

  const cursor = await store.getMarketCursor();
  const events = await fetchNewEvents({ sinceId: cursor.lastEventId });
  if (!events.length) return { feed, notified: 0 };

  const newestId = events.reduce((max, e) => Math.max(max, Number(e?.id) || 0), cursor.lastEventId);
  const matched = matchMarkets(events, subs);
  const seen = new Set(cursor.seenMarketIds);
  const unseen = matched.filter((m) => !seen.has(String(m.market?.id ?? '')));

  // Record every matched id, not just the announced ones. The suppressed and the
  // announced are equally "already handled", and leaving the suppressed out would
  // re-announce them on the very next sweep — the cap would then be a delay
  // rather than a cap.
  for (const m of matched) seen.add(String(m.market?.id ?? ''));

  // The first sweep after subscribing exists only to establish the cursor, the
  // same bargain the per-wallet seeding gate strikes: everything Gamma returns
  // was listed before you asked, so it is not news. Without this, switching on
  // Crypto would dump 500 existing markets into the feed as if they had all just
  // appeared. It gates *per subscription set* rather than globally — see
  // subscriptionKey — because adding a watch later is its own "start from now".
  const key = subscriptionKey(subs);
  const seededFor = cursor.seeded === true && cursor.key === key;
  await store.setMarketCursor({
    lastEventId: newestId,
    seenMarketIds: [...seen],
    seeded: true,
    key,
  });
  if (!seededFor) return { feed, notified: 0 };

  const items = unseen.map(({ event, market, reason }) => toMarketItem(event, market, reason, {
    // Same rule as a muted trader's cards: recorded, but not lighting anything
    // up. The switch is about being interrupted, so the cards still arrive.
    unread: settings.newMarketsEnabled !== false,
  }));
  if (!items.length) return { feed, notified: 0 };

  // Newest first overall; a market's ts is its listing time.
  const nextFeed = [...items, ...feed].sort((a, b) => b.lastTs - a.lastTs);

  const notified = await notifyForMarkets(unseen, { settings });
  return { feed: nextFeed, notified };
}

/**
 * Identity of the current subscription set, so the seeding gate can tell "first
 * sweep ever" from "first sweep since you added Bitcoin".
 *
 * Order-insensitive and case-folded, because neither changes what is subscribed;
 * without that, reordering the list in the drawer would silently re-seed and
 * swallow the next matching market.
 *
 * Every axis is in it, including `allMarkets`, and the parts are separated so
 * they cannot be confused for one another: a category named `trump` and a topic
 * named `trump` are different subscriptions, and joining the lists without a
 * separator would make swapping one for the other look like no change at all.
 */
function subscriptionKey({ watches = [], categories = [], topics = [], allMarkets = false }) {
  const norm = (list) => [...list].map((s) => String(s).toLowerCase()).sort().join(',');
  return `${norm(watches)}|${norm(categories)}|${norm(topics)}|${allMarkets ? 'all' : ''}`;
}

/**
 * Toast the matched markets, capped twice.
 *
 * Per event, because one Gamma event holds many markets — a soccer fixture
 * arrives with 25, and a fixture is not worth 25 toasts. Then across the whole
 * sweep, because the per-event cap does nothing about breadth: a busy category
 * can match twenty unrelated events at three each. Suppressed markets are
 * already in the feed by the time this runs.
 */
async function notifyForMarkets(matched, { settings }) {
  if (settings.notificationsEnabled === false) return 0;
  if (settings.newMarketsEnabled === false) return 0;

  const perEvent = new Map();
  const candidates = [];
  for (const entry of matched) {
    const id = String(entry.event?.id ?? '');
    const used = perEvent.get(id) || 0;
    if (used >= MAX_PER_EVENT_PER_POLL) continue;
    perEvent.set(id, used + 1);
    candidates.push(entry);
    if (candidates.length >= MAX_MARKET_TOASTS_PER_POLL) break;
  }

  let count = 0;
  for (const entry of candidates) {
    try {
      await raiseMarketNotification(entry);
      count += 1;
    } catch (err) {
      console.warn('[Poly Noti] market notification failed:', err);
    }
  }
  return count;
}

async function raiseMarketNotification({ event, market }) {
  // Two slots only: the title says what kind of thing this is, the message says
  // which market. No contextMessage — the tag line it would carry was the widest
  // part of the toast and the least informative, the question already identifies
  // the market, and dropping it sidesteps the untagged-event case entirely
  // rather than printing "Uncategorized" filler.
  const notificationId = `pnm:${market?.id ?? ''}`;
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    // The packaged bell, the same icon an unlabelled trader toast carries. It
    // used to be ⚡ drawn on a tile, which made the market channel the only place
    // the extension announced itself as something other than itself — at the size
    // Chrome renders this, an icon's one job is "who is talking", and the ⚡ in
    // the title is already doing "about what".
    iconUrl: defaultIconUrl(),
    title: '⚡ New Market',
    // Truncated at the same 80 as a trade's market title. Chrome clips a long
    // message itself, but mid-word and without an ellipsis.
    message: truncate(market?.question || event?.title || 'New market listed', 80),
    priority: 1,
    silent: false,
  });

  await rememberLink(
    notificationId,
    event?.slug
      ? polymarketUrl(`/event/${event.slug}`)
      : market?.slug
        ? polymarketUrl(`/market/${market.slug}`)
        : polymarketUrl(),
  );
}

/* ---------------------------------------------------------- notifications */

/**
 * Decide which touched cards deserve a toast.
 *
 * Per-trader silence is the caller's business — by the time we get here the
 * wallet is known to be audible (see isWalletMuted). What is left is the global
 * switch, and picking which label fronts the toast.
 *
 * A card that merged a follow-up fill is judged on the *increment*, not its
 * running total, so a slowly filling order can't re-toast on every poll.
 */
async function notifyForTouched(wallet, touched, { labels, settings }) {
  // Turning alerts off stops toasts only. The fold above has already written
  // the cards, and refreshBadge still counts them — muting a *trader* hides
  // their activity, but the master switch is about interruption, not tracking.
  if (!settings.notificationsEnabled) return 0;

  // Shared with the popup so a toast and its feed card name the same label; see
  // primaryLabel for what "most permissive" means and why it is not two rules.
  const primary = primaryLabel(wallet, labels);
  // Applies unconditionally. It used to be gated on an "important trades only"
  // mode that no longer exists, which left the slider inert on every install.
  const threshold = Number(settings.minUsdc) || 0;

  const candidates = [...touched.values()]
    .filter((t) => t.addedValue >= threshold)
    .sort((a, b) => b.addedValue - a.addedValue)
    .slice(0, Math.max(1, settings.maxPerWalletPerPoll));

  let count = 0;
  for (const entry of candidates) {
    try {
      await raiseNotification(wallet, primary, entry);
      count += 1;
    } catch (err) {
      console.warn('[Poly Noti] notification failed:', err);
    }
  }
  return count;
}

async function raiseNotification(wallet, label, { item, addedShares, addedValue, isNew }) {
  // The emoji is the label's, not the wallet's — an unlabelled trader falls
  // back to the packaged action icon.
  const iconUrl = label ? await buildNotificationIcon(label.emoji) : defaultIconUrl();

  const who = label ? `${wallet.name} · ${label.emoji} ${label.name}` : wallet.name;

  // Report the increment for merges, the whole card for a first sighting.
  const shares = isNew ? item.shares : addedShares;
  const value = isNew ? item.value : addedValue;
  const verb = verbFor(item.type, item.side);
  const outcome = item.outcome ? ` ${item.outcome.toUpperCase()}` : '';
  const body = item.type === 'TRADE'
    ? `${verb} ${formatShares(shares)}${outcome} @ ${formatPrice(item.price)} · ${formatUsdShort(value)}`
    : `${verb} ${formatShares(shares)}${outcome} · ${formatUsdShort(value)}`;

  const notificationId = `pn:${item.id}:${item.lastTs}`;
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl,
    title: who,
    message: body,
    contextMessage: truncate(item.title, 80),
    priority: 1,
    silent: false,
  });

  await rememberLink(notificationId, marketUrl(item));
}

/**
 * Remember where a click on this toast should land; the worker may die before
 * that click arrives, so the mapping lives in session storage rather than here.
 *
 * Only clicks delete from this map, so ignored toasts would otherwise pile up for
 * the whole browser session — the common case, since most toasts are read and
 * left alone. Capped by insertion order, oldest dropped first: a toast old enough
 * to fall off the end is long gone from the tray, and its entry only matters
 * while it is still clickable.
 */
async function rememberLink(notificationId, url) {
  const links = (await chrome.storage.session.get({ links: {} })).links;
  links[notificationId] = url;
  const ids = Object.keys(links);
  for (const stale of ids.slice(0, Math.max(0, ids.length - LINKS_LIMIT))) {
    delete links[stale];
  }
  await chrome.storage.session.set({ links });
}

function marketUrl(item) {
  if (item.eventSlug) return polymarketUrl(`/event/${item.eventSlug}`);
  if (item.slug) return polymarketUrl(`/market/${item.slug}`);
  return polymarketUrl(`/profile/${item.address}`);
}

async function openFromNotification(notificationId) {
  const { links } = await chrome.storage.session.get({ links: {} });
  const url = links[notificationId];
  if (url) await chrome.tabs.create({ url });
  delete links[notificationId];
  await chrome.storage.session.set({ links });
  chrome.notifications.clear(notificationId);
}

/* ------------------------------------------------------------------ badge */

async function refreshBadge() {
  const [feed, settings] = await Promise.all([store.get('feed'), store.get('settings')]);
  // Count only what the popup will actually display, or a below-threshold
  // trade would show a badge over an empty feed. Both of these gates are
  // trade-only, and both used to apply to the whole feed:
  //
  // `minUsdc` is a dollar amount, and a new-market card has no dollars — a
  // market compared against any non-zero threshold is always below it, so
  // touching the slider would have silently deleted every market card from the
  // count while they sat visible in the feed.
  //
  // `traderNotificationsEnabled` is about the traders. A market is not one, so
  // zeroing the whole badge on it would let a traders switch swallow a channel it
  // says nothing about.
  const minUsdc = Number(settings.minUsdc) || 0;
  const tradersOff = settings.traderNotificationsEnabled === false;
  const marketsOff = settings.newMarketsEnabled === false;
  const unread = feed.filter((item) => {
    if (!item.unread) return false;
    if (feedKind(item) === 'market') {
      // The market switch mirrors the trader switch: cards banked unread before
      // the flip must stop counting, or the badge shows numbers over a feed
      // that no longer displays them.
      if (marketsOff) return false;
      return true;
    }
    // Checked here rather than relying on new cards arriving already-read: cards
    // left unread from before the switch was flipped would otherwise keep their
    // count, putting a number on the icon above a feed that says trader
    // notifications are off.
    if (tradersOff) return false;
    return (item.value || 0) >= minUsdc;
  }).length;
  // Drawn into the icon rather than handed to Chrome's own badge API.
  // That badge is a corner-pinned rounded rectangle with no control over its
  // size or position, so the count could never be centred in the mark; the logo
  // has a second version with the number in a circle, and this is how that gets
  // rendered. setTitle carries the same number for anyone reading the tooltip or
  // using a screen reader, which the badge used to do for free.
  await chrome.action.setIcon({ imageData: await buildActionIcon(unread) });
  await chrome.action.setTitle({
    title: unread ? `Poly Noti — ${unread} unread` : 'Poly Noti',
  });
  await store.set({ unread });
}
