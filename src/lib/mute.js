/**
 * One definition of "this trader is silenced", and one of "this is the label
 * that speaks for them" — both shared by the worker and the popup.
 *
 * They live here because the two sides act on them at different moments and
 * must not drift: the worker consults them while folding rows, to decide whether
 * a card arrives read and which label fronts the toast; the popup consults them
 * while rendering, to decide whether the card belongs in the unfiltered feed and
 * which label fronts it. Two copies of either rule eventually disagree — a muted
 * trader half-silenced, or one trade wearing two different labels.
 *
 * Of the two global settings, exactly one belongs here, and the difference is
 * what each one claims to be about:
 *
 * `notificationsEnabled` is about the *toast channel* — "stop interrupting me".
 * It says nothing about any particular trader, so it is deliberately absent:
 * folding it in would blank the whole feed the moment you asked for quiet.
 *
 * `traderNotificationsEnabled` is about the *traders* — "mute all of them at
 * once". That is the same statement each row's own switch makes, only in bulk,
 * so it has to mean the same thing the row does, right down to taking the cards
 * out of the unfiltered feed. Leaving it out would make it a second toast-only
 * switch beside the first, which is the duplicate-control problem the drawer
 * just lost.
 */

/**
 * Whether a wallet's activity should be silenced end to end: no toast, no
 * badge, and out of the unfiltered feed.
 *
 * A label mutes the traders carrying it, but only when *every* label on a
 * trader is muted. One unmuted label is enough to let the activity through —
 * a trader tagged both `BOT` (muted) and `whale` (live) is still a whale, and
 * the more permissive tag wins.
 *
 * The trader master switch is the one thing that outranks that permissiveness:
 * it is not another tag to weigh up, it is the user saying "all of them, off".
 *
 * @param {object|undefined} wallet
 * @param {object[]} labels all known labels, for resolving the wallet's ids
 * @param {object} [settings] read for `traderNotificationsEnabled`; omitted by
 *   callers that only care about a trader's own state, and absent means on, so
 *   an old settings blob keeps everyone audible
 * @returns {boolean}
 */
export function isWalletMuted(wallet, labels = [], settings = undefined) {
  if (!wallet) return false;
  if (settings?.traderNotificationsEnabled === false) return true;
  if (wallet.muted) return true;

  const own = walletLabels(wallet, labels);

  // A trader whose only labels were deleted is unlabelled, not muted, so the
  // emptiness check runs against the resolved list rather than labelIds.
  return own.length > 0 && own.every((l) => l.muted);
}

/**
 * A wallet's labels, resolved and in the order the user applied them.
 *
 * `wallet.labelIds` order, not `labels` order: the ids are appended as you tick
 * them in the picker, so it records your choice, whereas the label list is in
 * creation order and knows nothing about this trader. Dangling ids — labels
 * deleted while still tagged — drop out.
 *
 * @param {object|undefined} wallet
 * @param {object[]} labels all known labels
 * @returns {object[]}
 */
export function walletLabels(wallet, labels = []) {
  return (wallet?.labelIds || [])
    .map((id) => labels.find((l) => l.id === id))
    .filter(Boolean);
}

/**
 * The one label that speaks for a trader: fronts their toast, their feed card,
 * and supplies the accent colour both are drawn in.
 *
 * Unmuted first, for the same reason isWalletMuted lets one live label through:
 * a trader tagged both `BOT` (muted) and `whale` (live) is audible *because* of
 * whale, so whale is what should name them. Picking the muted tag instead would
 * front a card with the very label that argued for hiding it.
 *
 * This exists as one function because it was previously two. The worker
 * preferred an unmuted label while the popup took the first match in label
 * creation order, so a trader carrying both tags arrived as a cyan 🐳 whale
 * toast and then sat in the feed as a grey 🤖 BOT card — one trade wearing two
 * identities, and the colours disagreed too, since the accent derives from
 * whichever emoji won.
 *
 * @param {object|undefined} wallet
 * @param {object[]} labels all known labels
 * @returns {object|null} null when the trader has no surviving label
 */
export function primaryLabel(wallet, labels = []) {
  const own = walletLabels(wallet, labels);
  return own.find((l) => !l.muted) || own[0] || null;
}
