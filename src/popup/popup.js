/**
 * Popup controller: renders the activity feed, the settings drawer, and the
 * add-trader / add-label modals. All persistence goes through lib/store.js.
 */

import { fetchProfile } from '../lib/api.js';
import {
  ACTIVITY_TYPES,
  DEFAULT_LABEL_EMOJI,
  EMOJI_CHOICES,
  MARKET_CATEGORIES,
  POLL_SECONDS,
  polymarketUrl,
  THRESHOLD_STEPS,
} from '../lib/constants.js';
import {
  formatPrice,
  formatShares,
  formatUsd,
  relativeTime,
  verbFor,
} from '../lib/format.js';
import { colorForEmoji } from '../lib/labelColor.js';
import { feedKind } from '../lib/market.js';
import { isWalletMuted, primaryLabel, walletLabels } from '../lib/mute.js';
import * as store from '../lib/store.js';

const $ = (id) => document.getElementById(id);

/** Everything the popup renders from. Refreshed via load(). */
let state = {
  wallets: [], labels: [], settings: {}, feed: [], watches: [],
  categories: [], topics: [], allMarkets: false,
};

/**
 * Which chip is selected. 'all', a label id, or MARKET_CHIP.
 *
 * Market cards belong to no trader and carry no label, so the label chips can
 * never reach them — hence a chip of their own rather than a filter on the
 * existing set.
 */
const MARKET_CHIP = 'kind:market';
let activeChip = 'all';

/* Draft state for the two modals. A wallet has no emoji of its own. */
let walletDraft = { labelIds: [] };
let labelDraft = { emoji: DEFAULT_LABEL_EMOJI };

/* Wallet id being edited, or null when the modal is creating a new one. */
let walletEditId = null;

/* Same for label groups, plus whether to hand control back to the trader form. */
let labelEditId = null;
let labelReturnsToWallet = false;

/**
 * The category picker's staged edit, or null while it is closed.
 *
 * Sets rather than arrays because every operation on them is membership: this
 * is the one place in the popup that adds, removes and tests the same
 * collection dozens of times per render.
 */
let marketDraft = null;

/** Which pane the picker shows: null for the category list, or a category slug. */
let pickerPane = null;

/* ------------------------------------------------------------------- boot */

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();

  await load();
  // Opening the popup counts as seeing the feed.
  await store.markFeedRead();
  chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
});

async function load() {
  state = await store.getAll();
  renderChips();
  renderFeed();
  renderDrawer();
  startTimeTick();
  // Deliberately not awaited by the callers above: the banner is advisory, and
  // a slow or missing notifications API must not hold up the feed render.
  void checkNotificationPermission();
}

/* ------------------------------------------------------------ modal keyboard */

/**
 * Escape closes, Tab cycles inside. Both are what `role="dialog"` +
 * `aria-modal="true"` promise, and the attributes alone do not implement.
 *
 * One document-level listener rather than one per modal: whichever modal is on
 * top answers the keystroke, so three listeners would mean three handlers racing
 * to close different things. Registered on the capture phase so it beats the
 * field-level Enter/Escape handlers on the rows inside.
 *
 * Listed in DOM order, which is also paint order: all three share z-index 20, so
 * when two are open the later one is the one on top.
 */
const MODALS = ['wallet-modal', 'label-modal', 'topics-modal'];

/**
 * The topmost open modal, or null.
 *
 * `findLast`, not `find`. Usually only one is open — but "new label group" from
 * inside the trader form deliberately stacks the label modal over the wallet
 * one, and taking the first match there would hand Escape and Tab to the form
 * underneath: Escape would close the wallet modal out from under an open label
 * form, and Tab would cycle through fields the user cannot see.
 */
function openModal() {
  return MODALS.map($).findLast((m) => m && !m.hidden) || null;
}

/**
 * What had the keyboard when each modal opened, so closing can hand it back.
 * Without this, Escape leaves focus on <body> and the next Tab restarts from the
 * top of the document — which, behind a drawer, is a long way from where you
 * were.
 *
 * Keyed by modal rather than held in one slot, because "new label group" stacks
 * the label form over the trader form: a single slot would be overwritten on the
 * way in and cleared on the way out, and the trader form underneath would lose
 * its own return target to a modal it opened.
 */
const modalReturnFocus = new Map();

/** Called by each open path just before it reveals its modal. */
function rememberFocus(id) {
  modalReturnFocus.set(id, document.activeElement);
}

/** Everything focusable and actually visible inside the open modal. */
function focusablesIn(root) {
  const sel = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll(sel)]
    // offsetParent is null for anything inside a [hidden] subtree — the emoji
    // grid spends most of its life closed, and tabbing into a collapsed grid
    // sends focus somewhere the eye cannot follow it.
    .filter((el) => el.offsetParent !== null);
}

function bindModalKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Tab') return;
    const modal = openModal();
    if (!modal) return;

    if (e.key === 'Escape') {
      // The emoji grid is a layer of its own inside the label modal, so Escape
      // closes that first. Closing the whole modal out from under an open
      // picker would throw away a name that was already typed.
      const grid = $('label-emoji-grid');
      if (modal.id === 'label-modal' && grid && !grid.hidden) {
        grid.hidden = true;
        $('label-emoji-btn').focus();
        return;
      }
      e.preventDefault();
      closeModal(modal);
      return;
    }

    const items = focusablesIn(modal);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    // Focus outside the modal entirely — clicked the backdrop, or the element
    // that had it was just disabled — so Tab has no edge to wrap and would
    // otherwise walk into the drawer behind.
    if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, true);
}

/**
 * Closing has side effects beyond `hidden`, and they differ per modal — the
 * label form can owe a return to the trader form, and the picker holds a staged
 * edit that has to be dropped rather than saved. Routed through the existing
 * close handlers rather than re-implemented, so Escape and ✕ can never diverge.
 */
function closeModal(modal) {
  if (modal.id === 'topics-modal') closePicker();
  else if (modal.id === 'label-modal') {
    modal.hidden = true;
    labelReturnsToWallet = false;
  } else modal.hidden = true;

  // Only if it is still there to return to: the trader row that opened the edit
  // form is re-rendered by load() while the modal closes, and focusing a
  // detached node silently sends focus to <body> instead.
  const back = modalReturnFocus.get(modal.id);
  modalReturnFocus.delete(modal.id);
  if (back?.isConnected) back.focus();
}

/* -------------------------------------------------------- relative time tick */

/**
 * Keeps the timestamps honest while the popup sits open.
 *
 * relativeTime() runs once per card at render, so without this a popup left
 * open reads "just now" for as long as you leave it — and "just now" is the one
 * value people act on. Re-stamping only the .card-time nodes rather than
 * calling renderFeed(): a re-render rebuilds every card, which throws away the
 * scroll position and the open ··· menu, and none of the rest of a card can
 * change without a poll anyway.
 *
 * The interval is the poll interval, so the clock in the popup and the data
 * behind it never disagree by more than one tick.
 */
let timeTick = null;

function startTimeTick() {
  // load() runs on open, on refresh, and after most mutations. Without this
  // guard each one leaves another interval behind, all writing the same nodes.
  if (timeTick !== null) return;
  timeTick = setInterval(() => {
    for (const el of document.querySelectorAll('.card-time[data-ts]')) {
      const ts = Number(el.dataset.ts);
      if (Number.isFinite(ts)) el.textContent = relativeTime(ts);
    }
  }, POLL_SECONDS * 1000);
}

/* --------------------------------------------------------------- poll status */

/**
 * The one line under the chips that says why a refresh came back with nothing.
 * Empty string hides it — every success path calls this, so a message never
 * outlives the failure that wrote it.
 */
function setPollStatus(message) {
  const el = $('poll-status');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

/* ------------------------------------------------- notification permission */

/**
 * chrome.notifications.create() resolves normally when notifications are
 * blocked — it reports that the request was accepted, not that anything was
 * shown. So a blocked install looks identical to a quiet one: no toasts, no
 * error, and the settings toggle still reads "on". This is the only signal
 * that tells them apart.
 *
 * Scope worth being honest about: this reflects Chrome's own permission for
 * the extension. If Chrome is muted at the OS level instead — the system's own
 * notification settings, or Focus/Do Not Disturb — it still reports 'granted'
 * and the toasts still go nowhere. The steps cover both because we cannot tell
 * which.
 */
async function checkNotificationPermission() {
  const notice = $('perm-notice');
  if (!notice) return;

  // An API we can't query should read as "fine", never as "blocked" — a banner
  // shown on a working install is worse than no banner at all.
  const api = chrome.notifications;
  if (typeof api?.getPermissionLevel !== 'function') return;

  let level;
  try {
    level = await new Promise((resolve, reject) => {
      // Pass a callback and also honour a returned promise, so both signatures
      // work. Probing with a no-argument call instead does not: a callback-only
      // build invokes cb() unconditionally, throws on the missing function, and
      // the catch below would silently read that as "can't tell".
      const maybe = api.getPermissionLevel(resolve);
      if (typeof maybe?.then === 'function') maybe.then(resolve, reject);
    });
  } catch {
    return;
  }

  notice.hidden = level !== 'denied';
}

/**
 * The OS half of the "how to fix" steps, per platform.
 *
 * Chrome's own permission is only one of the two layers that can swallow a
 * toast; the other lives in the OS, and each one names it differently. These
 * steps used to say "macOS: System Settings → Notifications" unconditionally,
 * which sent a Windows or Linux user looking for a settings app they do not
 * have — on the one screen they reach precisely because nothing is arriving.
 *
 * Each entry also carries its platform's name for Do Not Disturb, since that
 * silences Chrome while the permission still reads 'granted'.
 */
const OS_NOTIFICATION_STEPS = {
  mac: [
    'macOS: System Settings → Notifications → Google Chrome → Allow notifications.',
    'Check Do Not Disturb / Focus is off.',
  ],
  win: [
    'Windows: Settings → System → Notifications → Google Chrome → turn on.',
    'Check Focus assist / Do not disturb is off.',
  ],
  linux: [
    'Linux: your desktop’s notification settings → allow Google Chrome.',
    'Check Do Not Disturb is off.',
  ],
};

/** Every path at once. Longer, but it never names the wrong settings app. */
const GENERIC_OS_STEPS = [
  'Your system’s notification settings → allow Google Chrome.',
  'Check Do Not Disturb / Focus is off.',
];

/** Memoised: the platform cannot change while the popup is open. */
let osStepsPromise = null;

/**
 * `getPlatformInfo` needs no permission and is the only way to know which OS
 * we are on — `navigator.platform` is deprecated and lies under Chrome's
 * user-agent reduction. If it is missing or rejects we fall back to the generic
 * list rather than guessing, because a wrong path is worse than a vague one.
 */
function osNotificationSteps() {
  osStepsPromise ??= (async () => {
    try {
      // Callback and promise signatures both honoured, as with
      // getPermissionLevel above.
      const info = await new Promise((resolve, reject) => {
        const maybe = chrome.runtime.getPlatformInfo(resolve);
        if (typeof maybe?.then === 'function') maybe.then(resolve, reject);
      });
      return OS_NOTIFICATION_STEPS[info?.os] || GENERIC_OS_STEPS;
    } catch {
      return GENERIC_OS_STEPS;
    }
  })();
  return osStepsPromise;
}

/* ----------------------------------------------------------------- events */

function bindEvents() {
  bindModalKeys();
  $('settings-btn').addEventListener('click', () => { $('drawer').hidden = false; });
  $('drawer-close').addEventListener('click', () => { $('drawer').hidden = true; });

  // Steps are built on demand rather than sitting in popup.html, so the markup
  // carries no instructions for a state most installs never reach. Toggles, so
  // the banner can go back to one line once you have read them.
  $('perm-notice-fix').addEventListener('click', async () => {
    const notice = $('perm-notice');
    const open = notice.querySelector('.notice-steps');
    if (open) {
      open.remove();
      $('perm-notice-fix').textContent = 'How to fix';
      return;
    }
    const steps = document.createElement('ol');
    steps.className = 'notice-steps';
    // Chrome's own page is one of the two places to check, but an extension
    // cannot open chrome://settings with tabs.create — the browser blocks it.
    // So these are instructions, not links, and they name both layers because
    // getPermissionLevel() cannot tell us which one is muting us. The OS half is
    // platform-specific; see osNotificationSteps.
    for (const text of await osNotificationSteps()) {
      const li = document.createElement('li');
      li.textContent = text;
      steps.appendChild(li);
    }
    const chromeStep = document.createElement('li');
    chromeStep.append('Chrome: paste ');
    const code = document.createElement('code');
    code.textContent = 'chrome://settings/content/notifications';
    chromeStep.append(code, " in the address bar and make sure sites aren't blocked.");
    steps.appendChild(chromeStep);

    // Awaiting above means a second click could have re-opened the list; the
    // early return only saw the state from before the await.
    if (notice.querySelector('.notice-steps')) return;
    notice.querySelector('.notice-text').appendChild(steps);
    $('perm-notice-fix').textContent = 'Hide';
  });

  $('refresh-btn').addEventListener('click', async () => {
    const btn = $('refresh-btn');
    btn.disabled = true;
    // The class rather than an inline opacity: dimming reads as "disabled", and
    // the spinner is the only thing here that says "working". Also lets the
    // reduced-motion block stop it, which an inline style could not.
    btn.classList.add('is-loading');
    try {
      // sendMessage rejects when the worker is asleep or restarting, and the
      // worker itself answers { ok: false } when Polymarket is unreachable.
      // Both mean the same thing to the person looking at the popup: the feed
      // below is what it was, not what it is.
      const res = await chrome.runtime.sendMessage({ type: 'POLL_NOW' });
      if (res && res.ok === false) throw new Error(res.error || 'poll failed');
      await load();
      await store.markFeedRead();
      setPollStatus('');
    } catch (err) {
      // load() is deliberately still called on the failure path: whatever is in
      // storage is still worth showing, and a failed refresh should not blank
      // the screen. If that throws too there is nothing left to salvage.
      try { await load(); } catch { /* storage is gone; the message stands */ }
      setPollStatus(`Couldn't refresh — ${err?.message || 'Polymarket is unreachable'}. Retrying in the background.`);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  });

  // --- add trader modal
  // Wrapped: the listener's Event argument must not be read as a wallet.
  $('add-trader-btn').addEventListener('click', () => openWalletModal());
  // Through closeModal() rather than setting .hidden here, so ✕ and Escape run
  // the same teardown — including handing focus back to whatever opened it.
  $('wallet-modal-close').addEventListener('click', () => closeModal($('wallet-modal')));
  $('wallet-address').addEventListener('input', onAddressInput);
  $('wallet-name').addEventListener('input', validateWalletForm);
  $('wallet-submit').addEventListener('click', submitWallet);

  // --- add label modal
  $('add-label-btn').addEventListener('click', () => openLabelModal());
  $('wallet-add-label').addEventListener('click', () => openLabelModal(null, true));
  $('label-modal-close').addEventListener('click', () => closeModal($('label-modal')));
  $('label-emoji-btn').addEventListener('click', () => {
    const grid = $('label-emoji-grid');
    grid.hidden = !grid.hidden;
  });
  $('label-name').addEventListener('input', () => {
    $('label-submit').disabled = !$('label-name').value.trim();
  });
  $('label-submit').addEventListener('click', submitLabel);

  // --- settings
  // None of these three call renderDrawer(), for the reason spelled out on the
  // trader rows: it runs renderTraders() and renderLabels(), both of which open
  // with innerHTML = '', so flipping a switch up here would destroy the eight
  // row switches below it — mid-transition — on every tap. Each handler redraws
  // only what its own setting actually changes. The switch's own .checked needs
  // no help: the browser has already set it by the time change fires.
  $('notif-toggle').addEventListener('change', async (e) => {
    await saveSettings({ notificationsEnabled: e.target.checked });
    renderThresholdHint();
  });
  // renderFeed too, unlike the switch above: this one changes who belongs in the
  // unfiltered feed, so the list behind the drawer is stale the moment it flips.
  $('trader-notif-toggle').addEventListener('change', async (e) => {
    await saveSettings({ traderNotificationsEnabled: e.target.checked });
    applyBulkMuted();
    renderChips();
    renderFeed();
  });
  // --- new markets
  // A submit handler on the form, not a click on the +, so Enter in the field
  // works. Without preventDefault the popup navigates to itself and blanks.
  $('watch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await addWatchFromInput();
  });
  // renderFeed for the same reason as the trader switch above: this one now
  // decides whether market cards belong in the unfiltered feed, so the list
  // behind the drawer is stale the moment it flips. No applyBulkMuted — that
  // rewrites per-wallet mute flags, and a market card belongs to no wallet.
  $('market-notif-toggle').addEventListener('change', async (e) => {
    await saveSettings({ newMarketsEnabled: e.target.checked });
    renderFeed();
  });

  // --- category / topic picker
  $('categories-open').addEventListener('click', openPicker);
  // Closing is an abandon, not a save: the draft is dropped and storage was
  // never touched. Same for the backdrop, which is the click people reach for.
  $('topics-modal-close').addEventListener('click', () => closeModal($('topics-modal')));
  $('topics-modal').addEventListener('click', (e) => {
    if (e.target === $('topics-modal')) closeModal($('topics-modal'));
  });
  $('topics-back').addEventListener('click', () => {
    pickerPane = null;
    renderPicker();
  });
  $('topics-reset').addEventListener('click', resetPickerPane);
  $('topics-save').addEventListener('click', savePicker);

  // Two handlers: `input` gives live feedback while dragging (the feed
  // re-filters under the drawer), `change` commits once the thumb is released.
  $('threshold').addEventListener('input', (e) => {
    const value = THRESHOLD_STEPS[e.target.value];
    $('threshold-value').textContent = `$${value.toLocaleString()}`;
    state.settings.minUsdc = value;
    renderFeed();
  });
  $('threshold').addEventListener('change', async (e) => {
    await saveSettings({ minUsdc: THRESHOLD_STEPS[e.target.value] });
  });

  // --- advanced settings disclosure
  //
  // The open state is deliberately not persisted. It is a fold, not a
  // preference: the panel's whole point is that the drawer reads as five plain
  // settings until you ask, and remembering that you once asked would undo that
  // for every future open.
  $('advanced-open').addEventListener('click', () => {
    const row = $('advanced-open');
    const open = row.getAttribute('aria-expanded') === 'true';
    row.setAttribute('aria-expanded', String(!open));
    $('advanced-panel').hidden = open;
  });

  // Dismiss the emoji picker on an outside click. The grid sits outside
  // .emoji-select so it can flow inline, so both must count as "inside".
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.emoji-select') && !e.target.closest('.emoji-grid')) {
      $('label-emoji-grid').hidden = true;
    }
  });
}

async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await store.set({ settings: state.settings });
}

/* -------------------------------------------------------------- feed view */

function renderChips() {
  const chips = $('chips');
  chips.innerHTML = '';

  const make = (id, label, emoji) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(activeChip === id));
    b.textContent = emoji ? `${emoji} ${label}` : label;
    // "All" is not a label and gets no accent, so it falls back to the plain
    // white pill in CSS.
    if (emoji) b.style.setProperty('--accent', colorForEmoji(emoji));
    b.addEventListener('click', () => {
      activeChip = id;
      renderChips();
      renderFeed();
    });
    chips.appendChild(b);
    return b;
  };

  make('all', 'All');
  // Second, ahead of the labels: it is the only other chip that is not a label,
  // and burying it after ten label groups would put it off the end of a
  // horizontally scrolling row. Shown once something is subscribed — otherwise
  // it is a filter onto a view that explains it is empty.
  //
  // The `some` is for after you unsubscribe: the cards already collected stay in
  // the feed, and keying the chip on the subscription alone left them reachable
  // only by scrolling "All". Dropping a keyword stops future alerts; it is not a
  // retroactive delete, so the filter has to outlive the subscription.
  if (state.watches.length || state.categories.length || state.topics.length
      || state.allMarkets
      || state.feed.some((item) => feedKind(item) === 'market')) {
    const b = make(MARKET_CHIP, 'New markets', '✦');
    // Not a label emoji, so colorForEmoji has no entry for it. Lavender is the
    // market channel's own colour, and marks this out as a different kind of
    // chip. Deferred to the stylesheet's --lav rather than repeating the hex:
    // custom properties resolve at use, so the cascade still owns the value.
    b.style.setProperty('--accent', 'var(--lav)');
  }
  for (const label of state.labels) make(label.id, label.name, label.emoji);
}

/**
 * Cards the feed should show right now. Both filters here are view filters,
 * not deletes: everything stays in storage, so lowering the slider or unmuting
 * a trader brings the hidden cards straight back.
 */
function visibleFeed() {
  const minUsdc = Number(state.settings.minUsdc) || 0;
  return state.feed.filter((item) => {
    // A new-market card belongs to no trader, so neither the threshold nor any
    // mute rule below has anything to say about it. The threshold in particular
    // is a dollar amount and a market has no dollars — comparing them would put
    // every market card below any non-zero slider setting and silently delete
    // the feature from the feed the first time the slider moved.
    //
    // The switch mirrors the trader master switch: off hides the cards from the
    // unfiltered feed so they don't interrupt, but picking the market chip
    // itself still shows them — muting says "stop interrupting me", not
    // "forget what happened".
    if (feedKind(item) === 'market') {
      if (activeChip === MARKET_CHIP) return true;
      if (state.settings.newMarketsEnabled === false) return false;
      return activeChip === 'all';
    }
    if (activeChip === MARKET_CHIP) return false;

    if ((item.value || 0) < minUsdc) return false;
    const wallet = state.wallets.find((w) => w.id === item.walletId);
    // A muted trader stays out of the unfiltered feed but remains reachable by
    // picking their label — muting says "stop interrupting me", not "forget
    // what they did".
    if (activeChip === 'all') return !isWalletMuted(wallet, state.labels, state.settings);
    return wallet?.labelIds?.includes(activeChip);
  });
}

function renderFeed() {
  const root = $('feed');
  root.innerHTML = '';
  const items = visibleFeed();

  if (!items.length) {
    root.appendChild(emptyState());
    return;
  }
  for (const item of items) {
    root.appendChild(feedKind(item) === 'market' ? marketCard(item) : card(item));
  }
}

function emptyState() {
  const div = document.createElement('div');
  div.className = 'empty';

  // The market chip has its own story: nothing here means nothing is subscribed
  // to, or nothing has been listed yet, and neither the threshold nor mute has
  // anything to do with it.
  if (activeChip === MARKET_CHIP) {
    const subscribed = state.allMarkets
      || state.watches.length + state.categories.length + state.topics.length > 0;
    div.innerHTML = subscribed
      ? `
      <div class="big">✦</div>
      <h3>No new markets yet</h3>
      <p>Watching for markets matching your ${state.watches.length ? 'keywords' : 'categories'}. Polymarket lists them all day, so this fills up on its own.</p>`
      : `
      <div class="big">✦</div>
      <h3>Nothing watched yet</h3>
      <p>Open quick settings and add a keyword or choose a category to hear about new markets.</p>`;
    return div;
  }

  // A feed that isn't empty but shows nothing means a filter ate it — say
  // which one, or the control that did it reads as broken rather than as
  // working. Mute is checked first: those cards are hidden whatever the
  // slider says, so blaming the threshold for them would be a lie.
  const minUsdc = Number(state.settings.minUsdc) || 0;

  // The market switch off hides market cards from the unfiltered feed but keeps
  // them reachable under the market chip. If the feed has trade cards we don't
  // need to explain it, but if markets are the *only* thing here, a blank
  // screen with a non-empty storage reads as a bug.
  if (activeChip === 'all' && state.settings.newMarketsEnabled === false) {
    const markets = state.feed.filter((item) => feedKind(item) === 'market');
    const anyTrades = state.feed.some((item) => feedKind(item) === 'trade');
    if (markets.length > 0 && !anyTrades) {
      div.innerHTML = `
        <div class="big">✦</div>
        <h3>New market alerts are off</h3>
        <p>New market cards are still being recorded. Turn <strong>New market alerts</strong> back on in quick settings, or pick the <strong>✦ New markets</strong> chip above to see them.</p>`;
      return div;
    }
  }

  // Trades only, in both places below. A market card is never what the slider
  // hid, so counting one here would produce "Nothing this big yet" over a feed
  // whose only cards the threshold does not apply to.
  const trades = state.feed.filter((item) => feedKind(item) === 'trade');
  const aboveThreshold = trades.filter((item) => (item.value || 0) >= minUsdc);
  const hasWallets = state.wallets.length > 0;

  if (aboveThreshold.length > 0) {
    const owner = (item) => state.wallets.find((w) => w.id === item.walletId);
    const allMuted = aboveThreshold.every(
      (item) => isWalletMuted(owner(item), state.labels, state.settings),
    );
    if (allMuted) {
      // Two different causes reach this branch and they need different advice:
      // telling someone to unmute rows that are individually unmuted sends them
      // hunting for a switch that is already on.
      const byMaster = state.settings.traderNotificationsEnabled === false;
      div.innerHTML = byMaster
        ? `
        <div class="big">🔕</div>
        <h3>Trader notifications are off</h3>
        <p>Activity is still being recorded. Turn <strong>Show trader notifications</strong> back on in quick settings to bring it back — each trader keeps the setting you gave them.</p>`
        : `
        <div class="big">🔕</div>
        <h3>Only muted traders here</h3>
        <p>Their activity is still being recorded. Pick a label above to see it, or unmute them in quick settings.</p>`;
      return div;
    }
  }

  if (trades.length > 0) {
    div.innerHTML = `
      <div class="big">🔍</div>
      <h3>Nothing this big yet</h3>
      <p>Hidden by the $${minUsdc.toLocaleString()} minimum trade size. Lower it in quick settings to see the rest.</p>`;
    return div;
  }

  div.innerHTML = `
    <div class="big">${hasWallets ? '👀' : '📡'}</div>
    <h3>${hasWallets ? 'Nothing yet' : 'No traders tracked'}</h3>
    <p>${hasWallets
      ? 'Watching for activity. New fills will land here.'
      : 'Open quick settings and add a wallet address to start.'}</p>`;
  return div;
}

function card(item) {
  const wallet = state.wallets.find((w) => w.id === item.walletId);
  // The same label the toast for this trade named. Taking the first match in
  // state.labels order instead — which this used to do — meant a trader tagged
  // both 🐳 whale (live) and 🤖 BOT (muted) toasted as a whale and then landed
  // in the feed as a BOT, in the wrong colour, wearing the tag that argued for
  // hiding the card.
  const label = primaryLabel(wallet, state.labels);

  const el = document.createElement('article');
  el.className = `card${item.unread ? ' unread' : ''}`;
  // Same reachability as .row-item.clickable in the drawer: a click handler
  // on a plain element is otherwise invisible to the keyboard. Labelled
  // explicitly because role="button" would otherwise flatten the card's whole
  // text into one announced string that never says what activating it does.
  // No title attribute: the cursor and hover already signal the click, and a
  // card-sized tooltip lands on top of the amount.
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Open market on Polymarket: ${item.title || 'Unknown market'}`);
  // Drives both the left stripe and the label text. Left unset when unlabelled
  // so the CSS falls back to no stripe rather than implying a group.
  if (label) el.style.setProperty('--accent', colorForEmoji(label.emoji));

  const verb = verbFor(item.type, item.side);
  const dir = item.type === 'TRADE' ? (item.side === 'BUY' ? ' buy' : ' sell') : '';

  // The same sentence the notification body builds, and the same reason for the
  // branch: only a trade has a price. A redemption settles winning shares, so
  // there is no "@" clause — which a three-column grid had no way to express,
  // and so printed a fabricated $0.00 instead.
  const outcome = item.outcome ? ` ${escape(item.outcome)}` : '';
  const detail = `${formatShares(item.shares)}${outcome}`;
  // Its own span rather than part of `detail`, so it can't be what truncates:
  // .detail is the only shrinking child, and an outcome long enough to clip
  // ("Amelie Justine Hejtmanek") would otherwise take the price with it. On a
  // merged card the price is a weighted average that the fills badge exists to
  // qualify, which makes it the last thing that should drop.
  const at = item.type === 'TRADE' ? `@ ${formatPrice(item.price)}` : '';

  // Name, then the label as emoji + name. An unlabelled trader shows the
  // name alone — the emoji belongs to the label, not to the trader.
  el.innerHTML = `
    <div class="card-top">
      <span class="who">${escape(wallet?.name || store.shortAddress(item.address))}</span>
      ${label ? `<span class="label-chip">${escape(label.emoji)} ${escape(label.name)}</span>` : ''}
      <span class="card-time" data-ts="${item.lastTs}">${relativeTime(item.lastTs)}</span>
      <button class="dots" title="Actions">···</button>
    </div>
    <div class="card-title">${escape(item.title || 'Unknown market')}</div>
    <div class="card-line">
      <span class="verb${dir}">${escape(verb)}</span>
      <span class="detail">${detail}</span>
      ${at ? `<span class="at">${at}</span>` : ''}
      <span class="sep">·</span>
      <span class="total">${formatUsd(item.value)}</span>
      ${item.fills > 1 ? `<span class="fills" title="${item.fills} separate fills of one order, merged into this card">⟳ ${item.fills} fills</span>` : ''}
    </div>`;

  el.querySelector('.dots').addEventListener('click', (e) => {
    e.stopPropagation();
    void cardMenu(item, wallet);
  });
  el.addEventListener('click', () => openMarket(item));
  el.addEventListener('keydown', (e) => {
    // Space scrolls the feed by default, so both keys need preventDefault.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMarket(item);
    }
  });
  return el;
}

/**
 * A newly listed market. Structurally the same card as a trade — stripe, title,
 * one detail line — so the two mix in one chronological feed without either
 * looking like an error, but with nothing borrowed that doesn't apply: no
 * trader, no side, no amount.
 */
function marketCard(item) {
  const el = document.createElement('article');
  el.className = `card market${item.unread ? ' unread' : ''}`;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Open new market on Polymarket: ${item.question || item.title}`);
  // The market channel's own lavender rather than a label colour: these cards
  // belong to no label, and the stripe is what says so at a glance in a mixed
  // feed. Not the app green either — that is the "switched on" colour
  // everywhere else in the UI, so a card wearing it read as a state.
  el.style.setProperty('--accent', 'var(--lav)');

  // Why it fired, which the toast deliberately doesn't carry.
  // "In X" needs an X that is a place. A watch is the user's own string, so it
  // is quoted; a category or topic is a Polymarket name and reads as one; `all`
  // names no tag at all — its value is already the sentence, so prefixing it
  // would produce "In New listing".
  const kind = item.reason?.kind;
  const reason = kind === 'watch'
    ? `Matched “${escape(item.reason.value)}”`
    : kind && kind !== 'all' && item.reason?.value
      ? `In ${escape(item.reason.value)}`
      : 'New listing';

  // On a single-market event the question and the event title are usually the
  // same sentence; showing both would read as a rendering bug.
  const context = item.title && item.title !== item.question ? item.title : '';
  // Tags carry the market's subject where the title often doesn't ("Up or Down"
  // names no asset). Capped at three — the row is one line and must not wrap.
  const tags = (item.tags || []).slice(0, 3);

  el.innerHTML = `
    <div class="card-top">
      <span class="who">✦ New market</span>
      <span class="card-time" data-ts="${item.lastTs}">${relativeTime(item.lastTs)}</span>
      <button class="dots" title="Actions">···</button>
    </div>
    <div class="card-title">${escape(item.question || item.title || 'New market')}</div>
    <div class="card-line">
      <span class="verb reason">${reason}</span>
      ${context ? `<span class="sep">·</span><span class="detail">${escape(context)}</span>` : ''}
      ${tags.length ? `<span class="tags">${tags.map((t) => escape(t)).join(' · ')}</span>` : ''}
    </div>`;

  el.querySelector('.dots').addEventListener('click', (e) => {
    e.stopPropagation();
    marketMenu(item);
  });
  el.addEventListener('click', () => openMarket(item));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMarket(item);
    }
  });
  return el;
}

/**
 * A market card's actions. Removing the watch from here is the point: the card is
 * where you find out a keyword is too broad, so that is where turning it off
 * belongs rather than three clicks away in the drawer.
 */
function marketMenu(item) {
  const actions = [['Open on Polymarket', () => openMarket(item)]];
  const kind = item.reason?.kind;
  if (kind === 'watch') {
    actions.push([
      `Stop watching “${item.reason.value}”`,
      async () => {
        await store.removeWatch(item.reason.value);
        await load();
      },
    ]);
  } else if (kind === 'category' || kind === 'topic') {
    // matchReason names the tag, which is its label where Gamma supplied one and
    // its slug otherwise — so both are tried. Nothing is offered when neither
    // resolves against something actually subscribed: an action that silently
    // unsubscribed the wrong thing is worse than one that isn't there.
    const slug = resolveSubscription(kind, item.reason.value);
    if (slug) {
      actions.push([
        `Turn off ${item.reason.value} markets`,
        async () => {
          await store.setSubscriptions({
            allMarkets: false,
            categories: kind === 'category'
              ? state.categories.filter((c) => c !== slug) : state.categories,
            topics: kind === 'topic'
              ? state.topics.filter((t) => t !== slug) : state.topics,
          });
          await load();
          // Re-key the sweep now, so the cursor stops naming something you just
          // dropped — the same reason saving the picker sends one.
          chrome.runtime.sendMessage({ type: 'POLL_NOW' });
        },
      ]);
    }
  }
  showSheet(actions);
}

/** The subscribed slug a card's reason names, or undefined. */
function resolveSubscription(kind, value) {
  const want = String(value).toLowerCase();
  const hit = (e) => e.label.toLowerCase() === want || e.slug.toLowerCase() === want;
  if (kind === 'category') {
    return MARKET_CATEGORIES.find((c) => hit(c) && state.categories.includes(c.slug))?.slug;
  }
  return MARKET_CATEGORIES
    .flatMap((c) => c.topics)
    .find((t) => hit(t) && state.topics.includes(t.slug))?.slug;
}

function openMarket(item) {
  const url = item.eventSlug
    ? polymarketUrl(`/event/${item.eventSlug}`)
    : item.slug
      ? polymarketUrl(`/market/${item.slug}`)
      : polymarketUrl(`/profile/${item.address}`);
  chrome.tabs.create({ url });
}

/**
 * The trader's own Polymarket page.
 *
 * Separate from openMarket because a trade card names two things — the market,
 * and whoever traded in it — and the menu had a row for only one of them. The
 * profile URL was reachable before, but only as openMarket's last-resort
 * fallback for a card with no market at all, which is not a way to ask for it.
 */
function openTrader(address) {
  chrome.tabs.create({ url: polymarketUrl(`/profile/${address}`) });
}

/**
 * Lightweight action menu. window.confirm/prompt are unavailable in popups,
 * so this is a purpose-built sheet rather than a native dialog.
 */
async function cardMenu(item, wallet) {
  const actions = [];
  // Two "open" rows now, so each has to say what it opens — "Open on Polymarket"
  // was unambiguous only while it was the only one. The market wording matches
  // the card's own aria-label rather than inventing a second phrasing.
  //
  // Gated on a slug instead of leaning on openMarket's profile fallback: that
  // fallback existed so a card with no market still reached somewhere, and with
  // a trader row underneath it would put one URL behind two rows that read as
  // different things.
  if (item.eventSlug || item.slug) {
    actions.push(['Open market on Polymarket', () => openMarket(item)]);
  }
  if (item.address) {
    actions.push(['Open trader on Polymarket', () => openTrader(item.address)]);
    actions.push(['Copy wallet address', () => navigator.clipboard.writeText(item.address)]);
  }
  if (wallet) {
    actions.push(['Edit trader', () => openWalletModal(wallet)]);
    actions.push([
      wallet.muted ? 'Unmute this trader' : 'Mute this trader',
      async () => {
        await store.updateWallet(wallet.id, { muted: !wallet.muted });
        await load();
      },
    ]);
    actions.push([
      'Delete trader',
      async () => {
        await store.removeWallet(wallet.id);
        await load();
      },
    ]);
  }
  showSheet(actions);
}

function showSheet(actions) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  // `sheet` only centres the labels — .pick is shared with the label and topic
  // pickers, whose rows carry a swatch, a tick and a sub line and must stay
  // left-aligned. See .modal.sheet .pick .name in popup.css.
  modal.className = 'modal sheet';
  // No heading. Every row is a verb, so a word reading "Actions" above them told
  // you nothing the list wasn't already saying. It carried the sheet's
  // accessible name, though, which is why that moved onto aria-label rather than
  // leaving with it — role and aria-modal match the three markup dialogs in
  // popup.html, which all name themselves via their visible title.
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Actions');

  for (const [i, [text, fn]] of actions.entries()) {
    const b = document.createElement('button');
    b.className = 'pick';
    b.style.width = '100%';
    // Gaps between rows, not after the last one. The heading used to hold 23px
    // above the first row against the 25px this left below the last, so the
    // trailing margin passed for symmetry; with the heading gone it is 18px
    // against 25px and the sheet sits visibly low in its own box.
    if (i < actions.length - 1) b.style.marginBottom = '7px';
    b.innerHTML = `<span class="name">${escape(text)}</span>`;
    b.addEventListener('click', async () => {
      backdrop.remove();
      await fn();
    });
    modal.appendChild(b);
  }
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

/* ---------------------------------------------------------------- drawer  */

function renderDrawer() {
  const s = state.settings;

  $('notif-toggle').checked = s.notificationsEnabled !== false;
  $('trader-notif-toggle').checked = s.traderNotificationsEnabled !== false;

  const tIndex = Math.max(0, THRESHOLD_STEPS.indexOf(Number(s.minUsdc) || 0));
  $('threshold').value = String(tIndex);
  $('threshold-value').textContent = `$${THRESHOLD_STEPS[tIndex].toLocaleString()}`;
  renderThresholdHint();

  $('trader-count').textContent = String(state.wallets.length);
  renderTraders();
  renderMarkets();
  renderLabels();
  renderTypes();
}

/**
 * The activity-type checkboxes, built from ACTIVITY_TYPES.
 *
 * Rebuilt from scratch on every drawer render rather than kept and re-checked,
 * because the list it is built from is a constant — nine rows that never gain or
 * lose a member while the popup is open — so there is no stale-row problem of
 * the kind that made the trader rows worth preserving.
 *
 * store.js has already filtered the stored value down to types this build knows,
 * so `includes` here is the whole truth: a box is checked exactly when the type
 * is going on the wire.
 */
function renderTypes() {
  const chosen = state.settings.types || [];
  const grid = $('type-grid');
  grid.textContent = '';

  for (const { type, label } of ACTIVITY_TYPES) {
    const box = document.createElement('label');
    box.className = 'type-box';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = chosen.includes(type);
    input.addEventListener('change', async () => {
      // Rebuilt from the boxes in ACTIVITY_TYPES order, not pushed and spliced:
      // the order is what the checkbox grid shows and what store.js writes back,
      // and a list that drifted out of it would make two renders of the same
      // storage disagree.
      const next = ACTIVITY_TYPES
        .map((t) => t.type)
        .filter((t) => grid.querySelector(`input[data-type="${t}"]`)?.checked);
      await saveSettings({ types: next });
      renderTypeHint();
    });
    input.dataset.type = type;
    const text = document.createElement('span');
    text.textContent = label;
    box.append(input, text);
    grid.appendChild(box);
  }
  renderTypeHint();
}

/**
 * The line under the grid. Two states, because unchecking everything is a real
 * choice with a consequence worth naming: no request is made for any wallet at
 * all, so the feed stops gaining trader cards entirely — not just the ones you
 * unticked. New-market cards keep arriving, which is why the sentence says
 * "trader activity" rather than "nothing".
 */
function renderTypeHint() {
  const chosen = state.settings.types || [];
  const hint = $('type-hint');
  hint.classList.toggle('warn', chosen.length === 0);
  hint.textContent = chosen.length === 0
    ? 'Nothing selected, so no trader activity is fetched at all. New market alerts are unaffected.'
    : 'Unticked types are never requested from Polymarket, so they raise no notification and never reach the feed.';
}

/**
 * The one line under the slider that the notifications switch changes. Split out
 * of renderDrawer() because that switch no longer redraws the drawer — rebuilding
 * every row to re-word one sentence is what made those flips feel heavier than
 * the per-row ones — and the wording has to stay identical on both paths.
 */
function renderThresholdHint() {
  // The threshold gates the feed as well as the toast, so with alerts off it
  // still does half its job — saying "raises no notification" there would name
  // the one effect that is already switched off.
  $('threshold-hint').textContent = state.settings.notificationsEnabled !== false
    ? 'Trades below this value raise no notification and stay out of the feed.'
    : 'Notifications are off. The feed still hides trades below this value.';
}

/**
 * Re-states the master switch across the trader rows without rebuilding them:
 * the dimming class on the list, and the "· all muted" suffix on each name.
 *
 * The suffix is why this can't just be a class. It is text inside the row, and
 * the row is no longer thrown away when the master switch moves, so something
 * has to go and re-write it. Reads each wallet's own muted flag from live state
 * rather than a captured value — the rows outlive the flip now, so anything
 * closed over at build time is a stale answer waiting to be shown.
 */
function applyBulkMuted() {
  const root = $('trader-list');
  const bulkMuted = state.settings.traderNotificationsEnabled === false;
  root.classList.toggle('bulk-muted', bulkMuted);

  for (const row of root.querySelectorAll('.row-item')) {
    const wallet = state.wallets.find((w) => w.id === row.dataset.id);
    if (!wallet) continue;
    row.querySelector('.name').textContent = rowName(wallet.name, wallet.muted, bulkMuted);
  }
}

/**
 * The discovery card: the switch, the keyword pills, and the one-line summary of
 * whatever the category picker holds.
 *
 * The categories themselves are not rendered here. Seven of them at up to ten
 * topics each is eighty rows, which is a drawer nobody scrolls to the bottom of
 * — so the card carries the summary and the picker carries the list.
 */
function renderMarkets() {
  const s = state.settings;
  $('market-notif-toggle').checked = s.newMarketsEnabled !== false;

  const list = $('watch-list');
  list.innerHTML = '';
  if (!state.watches.length) {
    list.innerHTML = '<p class="muted-note">No keywords yet. A keyword matches whole words only, so “Fed” won’t fire on “Federer”.</p>';
  }
  for (const watch of state.watches) {
    const tag = document.createElement('span');
    tag.className = 'watch-tag';
    tag.innerHTML = `<span class="name">${escape(watch)}</span>`;
    const x = document.createElement('button');
    x.className = 'x-btn';
    x.title = `Stop watching ${watch}`;
    x.setAttribute('aria-label', `Stop watching ${watch}`);
    x.textContent = '✕';
    x.addEventListener('click', async () => {
      await store.removeWatch(watch);
      await load();
    });
    tag.appendChild(x);
    list.appendChild(tag);
  }

  const row = $('categories-open');
  const chosen = state.allMarkets || state.categories.length > 0 || state.topics.length > 0;
  row.classList.toggle('chosen', chosen);
  $('category-summary').textContent = subscriptionSummary(state);
}

/**
 * The category subscription in one line, for the card row.
 *
 * Names what it can and counts the rest: "Politics, Crypto +2" is readable at a
 * glance where four full names are not, and topics are counted rather than named
 * because they are the long tail — someone with one topic under each of six
 * categories would otherwise get a sentence nothing can truncate usefully.
 */
function subscriptionSummary({ allMarkets, categories = [], topics = [] }) {
  if (allMarkets) return 'All categories';

  const names = MARKET_CATEGORIES
    .filter((c) => categories.includes(c.slug))
    .map((c) => c.label);
  const parts = [];
  if (names.length) {
    parts.push(names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : ''));
  }
  if (topics.length) parts.push(`${topics.length} topic${topics.length === 1 ? '' : 's'}`);
  // The row now reads "Categories" on the left, so this side is free to be the
  // state rather than a second copy of the label. Empty is a real answer here —
  // nothing is watched on a fresh install — and saying so beats a blank.
  return parts.length ? parts.join(' · ') : 'None yet';
}

/* ------------------------------------------------- category/topic picker */

function openPicker() {
  marketDraft = {
    categories: new Set(state.categories),
    topics: new Set(state.topics),
    allMarkets: state.allMarkets === true,
  };
  pickerPane = null;
  renderPicker();
  rememberFocus('topics-modal');
  $('topics-modal').hidden = false;
}

function closePicker() {
  $('topics-modal').hidden = true;
  marketDraft = null;
  pickerPane = null;
}

/**
 * "All" is exclusive, in both directions.
 *
 * Holding it alongside a category would be a subscription that changes nothing
 * if you removed it, and a picker showing "All categories" *and* "Politics"
 * ticked is a state nobody can read. Enforced here as well as in
 * store.setSubscriptions so the tick you see is the tick that gets saved.
 */
function draftToggleAll() {
  const on = !marketDraft.allMarkets;
  marketDraft.allMarkets = on;
  if (on) {
    marketDraft.categories.clear();
    marketDraft.topics.clear();
  }
}

/** The topics of `slug` currently ticked. */
function draftTopicsIn(cat) {
  return cat.topics.filter((t) => marketDraft.topics.has(t.slug));
}

/**
 * A whole category, which is the same exclusivity rule one level down: the
 * event carries its parent tag *and* its child tags, so "all of Politics" makes
 * "Trump" redundant rather than additional.
 */
function draftToggleCategory(cat) {
  const on = !marketDraft.categories.has(cat.slug);
  if (on) {
    marketDraft.categories.add(cat.slug);
    for (const t of cat.topics) marketDraft.topics.delete(t.slug);
    marketDraft.allMarkets = false;
  } else {
    marketDraft.categories.delete(cat.slug);
  }
}

function draftToggleTopic(cat, topic) {
  if (marketDraft.topics.has(topic.slug)) {
    marketDraft.topics.delete(topic.slug);
    return;
  }
  marketDraft.topics.add(topic.slug);
  // Narrowing: picking one topic out of a category you had whole is a
  // statement about the rest of it, so the parent gives way.
  marketDraft.categories.delete(cat.slug);
  marketDraft.allMarkets = false;
}

/**
 * Reset clears the pane you are looking at, not the whole subscription — the
 * footer belongs to the pane above it, and inside Politics a button that
 * silently dropped Crypto too would be a trap.
 */
function resetPickerPane() {
  const cat = MARKET_CATEGORIES.find((c) => c.slug === pickerPane);
  if (cat) {
    marketDraft.categories.delete(cat.slug);
    for (const t of cat.topics) marketDraft.topics.delete(t.slug);
  } else {
    marketDraft.allMarkets = false;
    marketDraft.categories.clear();
    marketDraft.topics.clear();
  }
  renderPicker();
}

async function savePicker() {
  await store.setSubscriptions({
    categories: [...marketDraft.categories],
    topics: [...marketDraft.topics],
    allMarkets: marketDraft.allMarkets,
  });
  closeModal($('topics-modal'));
  await load();
  // Once, on save, rather than on each tap: the sweep's first run under a new
  // subscription only seeds the cursor — see subscriptionKey — so re-keying it
  // eight times while someone browses the picker would burn eight sweeps and
  // swallow whatever was listed in between.
  chrome.runtime.sendMessage({ type: 'POLL_NOW' });
}

function renderPicker() {
  const cat = MARKET_CATEGORIES.find((c) => c.slug === pickerPane);
  $('topics-modal-title').textContent = cat ? cat.label : 'All categories';
  $('topics-back').hidden = !cat;
  $('topics-reset').title = cat
    ? `Clear everything selected under ${cat.label}`
    : 'Clear every category and topic';

  const root = $('topics-picker');
  root.innerHTML = '';
  root.scrollTop = 0;

  const row = ({ name, sub, subOn, pressed, chevron, onClick }) => {
    const b = document.createElement('button');
    b.className = 'pick';
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    b.innerHTML = `
      <span class="text">
        <span class="name">${escape(name)}</span>
        ${sub ? `<span class="sub${subOn ? ' on' : ''}">${escape(sub)}</span>` : ''}
      </span>
      ${chevron
        ? '<svg viewBox="0 0 24 24" class="chev" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
        : '<span class="tick"></span>'}`;
    b.addEventListener('click', () => {
      onClick();
      renderPicker();
    });
    root.appendChild(b);
    return b;
  };

  if (cat) {
    row({
      name: `All ${cat.label}`,
      sub: 'Every new market tagged with it',
      pressed: marketDraft.categories.has(cat.slug),
      onClick: () => draftToggleCategory(cat),
    });
    for (const [i, topic] of cat.topics.entries()) {
      const b = row({
        name: topic.label,
        pressed: marketDraft.topics.has(topic.slug),
        onClick: () => draftToggleTopic(cat, topic),
      });
      // Separates the whole-category row above from the topics under it.
      if (i === 0) b.classList.add('divide');
    }
    return;
  }

  row({
    name: 'All categories',
    sub: 'Every new listing, whatever it is tagged',
    pressed: marketDraft.allMarkets,
    onClick: draftToggleAll,
  });
  for (const [i, c] of MARKET_CATEGORIES.entries()) {
    const whole = marketDraft.categories.has(c.slug);
    const picked = draftTopicsIn(c).length;
    const b = row({
      name: c.label,
      // Three states, and the count is the one that has to be unambiguous:
      // "3 of 10 topics" says which and how many are left, where a bare "3"
      // would read as the size of the category.
      sub: whole ? 'All'
        : picked ? `${picked} of ${c.topics.length} topics`
          : `${c.topics.length} topics`,
      subOn: whole || picked > 0,
      chevron: true,
      onClick: () => { pickerPane = c.slug; },
    });
    if (i === 0) b.classList.add('divide');
  }
}

/**
 * Add the typed keyword. store.addWatch owns every rule (blank, duplicate,
 * limit) and throws a sentence written for this spot, so there is nothing to
 * re-check here — the same split submitWallet uses.
 */
async function addWatchFromInput() {
  const input = $('watch-input');
  const err = $('watch-error');
  try {
    await store.addWatch(input.value);
    input.value = '';
    err.hidden = true;
    await load();
    // A new subscription changes what the worker looks for, so the sweep should
    // not wait up to 30s. Its first run under the new key only seeds the cursor —
    // see subscriptionKey — which is exactly the point: from now, not from the
    // whole backlog.
    chrome.runtime.sendMessage({ type: 'POLL_NOW' });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

/**
 * The trader row's first line. Split out because the mute switch now patches it
 * in place instead of rebuilding the row, so the string has two callers and they
 * have to agree — a suffix that only the build path knew about would reappear on
 * the next full render and look like the toggle had been ignored.
 *
 * Returns plain text. The build path escapes it on the way into innerHTML; the
 * patch path assigns it to textContent, which needs no escaping.
 */
function rowName(name, muted, bulkMuted) {
  if (bulkMuted) return `${name} · all muted`;
  return muted ? `${name} · muted` : name;
}

function renderTraders() {
  const root = $('trader-list');
  root.innerHTML = '';
  if (!state.wallets.length) {
    root.innerHTML = '<p class="muted-note">Add traders to begin receiving their activity here.</p>';
    return;
  }
  // With the master switch off every row is silenced regardless of its own
  // state, so the rows say so rather than showing a live-looking green switch
  // that is doing nothing. They stay editable: the point of the master switch is
  // that it does not touch what each row remembers.
  const bulkMuted = state.settings.traderNotificationsEnabled === false;
  root.classList.toggle('bulk-muted', bulkMuted);

  for (const wallet of state.wallets) {
    // Every label, not just the primary one: this row is where you check what a
    // trader is tagged with, so it lists them all.
    const labels = walletLabels(wallet, state.labels);

    const row = document.createElement('div');
    row.className = 'row-item clickable';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = 'Edit trader';
    // How applyBulkMuted() finds this row's wallet in live state. The rows now
    // survive a master-switch flip, so it needs a handle that does not depend on
    // a closure captured when the row was built.
    row.dataset.id = wallet.id;
    row.innerHTML = `
      <div class="grow">
        <div class="name">${escape(rowName(wallet.name, wallet.muted, bulkMuted))}</div>
        <div class="sub">${escape(store.shortAddress(wallet.address))}${
          labels.length
            ? ` · ${labels.map((l) => `${escape(l.emoji)} ${escape(l.name)}`).join(', ')}`
            : ''
        }</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${wallet.muted ? '' : 'checked'}>
        <span class="track"></span>
      </label>
      <button class="row-btn x-btn" title="Delete trader" aria-label="Delete trader">✕</button>`;

    // The row opens the editor; its controls act on their own.
    row.addEventListener('click', () => openWalletModal(wallet));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openWalletModal(wallet);
      }
    });
    row.querySelector('.switch').addEventListener('click', (e) => e.stopPropagation());
    // Deliberately not load(). renderTraders() opens with innerHTML = '', which
    // replaces the switch you just tapped with a fresh node already sitting at
    // its end state — the 180ms knob travel is destroyed before it can run, and
    // the row reads as abrupt next to the drawer's static switches, which only
    // have .checked re-assigned and so survive. Everything load() would refresh
    // is done here by hand instead: the row's own name line, and the feed, which
    // muting genuinely changes (a muted trader leaves the unfiltered list).
    row.querySelector('input').addEventListener('change', async (e) => {
      const muted = !e.target.checked;
      await store.updateWallet(wallet.id, { muted });
      state = await store.getAll();
      wallet.muted = muted;
      // The row outlives this flip, so live state, not the bulkMuted captured at
      // build time: the master switch may have moved since, and the suffix has
      // to say what is true now.
      const bulk = state.settings.traderNotificationsEnabled === false;
      row.querySelector('.name').textContent = rowName(wallet.name, muted, bulk);
      renderChips();
      renderFeed();
    });
    row.querySelector('.x-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await store.removeWallet(wallet.id);
      await load();
    });
    root.appendChild(row);
  }
}

function renderLabels() {
  const root = $('label-list');
  root.innerHTML = '';

  // One emoji per label makes the emoji list the label limit. Disable the
  // button rather than letting the form open and fail at submit — there is
  // nothing you could type that would make it work. Both entry points to the
  // label form are covered: the drawer's Add label and the + inside the trader
  // form. Add label carries its own words, so its enabled title is empty — a
  // tooltip restating the button is noise; the bare + still needs one.
  const full = state.labels.length >= EMOJI_CHOICES.length;
  for (const [id, label] of [['add-label-btn', ''], ['wallet-add-label', 'New label group']]) {
    const btn = $(id);
    btn.disabled = full;
    btn.title = full
      ? `All ${EMOJI_CHOICES.length} emoji are in use — delete a label to free one`
      : label;
  }

  if (!state.labels.length) {
    root.innerHTML = '<p class="muted-note">No label groups yet. Create one to tag traders and their notifications.</p>';
    return;
  }
  for (const label of state.labels) {
    const row = document.createElement('div');
    row.className = 'row-item clickable';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = 'Edit label group';
    row.innerHTML = `
      <span class="emoji">${escape(label.emoji)}</span>
      <div class="grow"><div class="name">${escape(label.name)}</div></div>
      <label class="switch">
        <input type="checkbox" ${label.muted ? '' : 'checked'}>
        <span class="track"></span>
      </label>
      <button class="row-btn x-btn" title="Delete label" aria-label="Delete label">✕</button>`;

    row.addEventListener('click', () => openLabelModal(label));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openLabelModal(label);
      }
    });
    row.querySelector('.switch').addEventListener('click', (e) => e.stopPropagation());
    // Same shape as the trader rows, and for the same reason: load() →
    // renderLabels() would rebuild this switch mid-transition, and the knob would
    // snap rather than travel. Nothing on this row reads the mute state — a
    // label's name carries no "· muted" suffix the way a trader's does — so the
    // feed is the only thing that has to be redrawn, and muting a label does
    // change it: every trader carrying only muted labels leaves the unfiltered
    // list.
    row.querySelector('input').addEventListener('change', async (e) => {
      const muted = !e.target.checked;
      await store.updateLabel(label.id, { muted });
      state = await store.getAll();
      label.muted = muted;
      renderChips();
      renderFeed();
    });
    row.querySelector('.x-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await store.removeLabel(label.id);
      await load();
    });
    root.appendChild(row);
  }
}

/* ----------------------------------------------------------------- modals */

/**
 * Doubles as the create and edit form. Passing a wallet switches to edit mode;
 * the address is then fixed, because it keys both the poll cursor and the
 * wallet's existing feed items — to watch a different one, add it separately.
 */
function openWalletModal(wallet = null) {
  walletEditId = wallet?.id || null;
  walletDraft = { labelIds: [...(wallet?.labelIds || [])] };

  const address = $('wallet-address');
  address.value = wallet?.address || '';
  address.readOnly = Boolean(wallet);
  $('wallet-name').value = wallet?.name || '';
  $('wallet-error').hidden = true;
  $('wallet-modal-title').textContent = wallet ? 'Edit trader' : 'Track new wallet';
  $('wallet-submit').textContent = wallet ? 'Save changes' : 'Track Wallet';
  $('wallet-submit').disabled = !wallet;

  renderLabelPicker();
  rememberFocus('wallet-modal');
  $('wallet-modal').hidden = false;
  (wallet ? $('wallet-name') : address).focus();
}

function renderLabelPicker() {
  const root = $('wallet-label-picker');
  root.innerHTML = '';
  if (!state.labels.length) {
    root.innerHTML = '<p class="muted-note">No labels yet — create one with + above.</p>';
    return;
  }
  for (const label of state.labels) {
    const b = document.createElement('button');
    b.className = 'pick';
    b.setAttribute('aria-pressed', String(walletDraft.labelIds.includes(label.id)));
    b.innerHTML = `
      <span class="swatch-dot">${escape(label.emoji)}</span>
      <span class="name">${escape(label.name)}</span>
      <span class="tick"></span>`;
    b.addEventListener('click', () => {
      walletDraft.labelIds = walletDraft.labelIds.includes(label.id)
        ? walletDraft.labelIds.filter((id) => id !== label.id)
        : [...walletDraft.labelIds, label.id];
      renderLabelPicker();
    });
    root.appendChild(b);
  }
}

let profileLookup = 0;

async function onAddressInput() {
  validateWalletForm();
  const address = $('wallet-address').value.trim();
  if (!store.isValidAddress(address) || $('wallet-name').value.trim()) return;

  // Prefill the nickname from the public Polymarket profile when there is one.
  const token = ++profileLookup;
  const profile = await fetchProfile(store.normalizeAddress(address));
  if (token !== profileLookup) return; // a newer keystroke won
  const suggested = profile?.name || profile?.pseudonym;
  if (suggested && !$('wallet-name').value.trim()) {
    $('wallet-name').value = suggested;
    validateWalletForm();
  }
}

function validateWalletForm() {
  const ok = store.isValidAddress($('wallet-address').value);
  $('wallet-submit').disabled = !ok;
  const err = $('wallet-error');
  const raw = $('wallet-address').value.trim();
  if (raw && !ok) {
    err.textContent = 'Enter a valid 0x wallet address (42 characters).';
    err.hidden = false;
  } else {
    err.hidden = true;
  }
}

async function submitWallet() {
  const address = $('wallet-address').value;
  const patch = {
    // No name is a real answer: the address is what identifies the trader, and
    // showing it beats inventing a nickname the user then has to recognise.
    name: $('wallet-name').value.trim() || store.shortAddress(address),
    labelIds: walletDraft.labelIds,
  };
  try {
    if (walletEditId) {
      await store.updateWallet(walletEditId, patch);
      closeModal($('wallet-modal'));
      await load();
      return;
    }
    await store.addWallet({ address, ...patch });
    closeModal($('wallet-modal'));
    await load();
    // Establish the new wallet's cursor immediately so tracking starts now.
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }, () => void load());
  } catch (err) {
    const el = $('wallet-error');
    el.textContent = String(err?.message || err);
    el.hidden = false;
  }
}

/**
 * Doubles as the create and edit form for label groups. When opened from the
 * trader form, returnToWallet keeps that form underneath and hands the new
 * label straight back to it.
 */
function openLabelModal(label = null, returnToWallet = false) {
  labelEditId = label?.id || null;
  labelReturnsToWallet = returnToWallet;

  // A new label opens on the first *free* emoji. Handing every new label the
  // same constant is how duplicates got made in the first place — you never had
  // to open the picker to end up sharing an emoji with three other labels.
  const taken = emojiOwners(labelEditId);
  const firstFree = EMOJI_CHOICES.find((e) => !taken.has(e));
  labelDraft = { emoji: label?.emoji || firstFree || DEFAULT_LABEL_EMOJI };

  buildEmojiGrid($('label-emoji-grid'), taken, (e) => {
    labelDraft.emoji = e;
    $('label-emoji').textContent = e;
    $('label-emoji-grid').hidden = true;
  });

  $('label-name').value = label?.name || '';
  $('label-emoji').textContent = labelDraft.emoji;
  $('label-emoji-grid').hidden = true;
  $('label-error').hidden = true;
  $('label-modal-title').textContent = label ? 'Edit label group' : 'New label group';
  $('label-submit').textContent = label ? 'Save changes' : 'Create label';
  $('label-submit').disabled = !label;
  rememberFocus('label-modal');
  $('label-modal').hidden = false;
  $('label-name').focus();
}

async function submitLabel() {
  const patch = {
    name: $('label-name').value.trim() || 'Untitled',
    emoji: labelDraft.emoji,
  };

  // The picker only offers free emoji, so a clash here means the store caught
  // something the form could not — a label added in another window, say.
  try {
    if (labelEditId) {
      await store.updateLabel(labelEditId, patch);
      const returning = labelReturnsToWallet;
      closeModal($('label-modal'));
      await load();
      if (returning) renderLabelPicker();
      return;
    }

    const label = await store.addLabel(patch);
    // Captured before closeModal(), which clears the flag as part of the same
    // teardown Escape and ✕ run.
    const returning = labelReturnsToWallet;
    closeModal($('label-modal'));
    await load();
    if (returning) {
      // Created mid-flow from the trader form: apply it without a second step.
      walletDraft.labelIds = [...walletDraft.labelIds, label.id];
      renderLabelPicker();
    }
  } catch (err) {
    const el = $('label-error');
    el.textContent = String(err?.message || err);
    el.hidden = false;
  }
}

/* ------------------------------------------------------------------ bits */

/**
 * Emoji already spoken for, mapped to the label holding each one.
 *
 * `exceptId` is the label being edited: its own emoji is not a clash with
 * itself, and excluding it keeps that emoji selectable in its own form.
 */
function emojiOwners(exceptId = null) {
  return new Map(
    state.labels.filter((l) => l.id !== exceptId).map((l) => [l.emoji, l.name]),
  );
}

/**
 * @param {Map<string,string>} taken emoji -> the label already using it
 */
function buildEmojiGrid(root, taken, onPick) {
  root.innerHTML = '';
  for (const emoji of EMOJI_CHOICES) {
    const b = document.createElement('button');
    b.textContent = emoji;
    const owner = taken.get(emoji);
    if (owner) {
      // Disabled rather than absent: a grid that changes shape per label is
      // harder to navigate than one where the gaps are visible and explained.
      b.disabled = true;
      b.title = `Already used by ${owner}`;
    } else {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(emoji);
      });
    }
    root.appendChild(b);
  }
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
