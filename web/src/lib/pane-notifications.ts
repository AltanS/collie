// ── A PANE YOU ARE READING NEEDS NO NOTIFICATION ON THIS DEVICE ─────────────────────────────────
//
// Every read the page marks as seen (`fetchPane`, the `x-collie-seen` header) first does on this
// device what the pane's clear would do there: it closes the pane's own notification, and it sets
// the pane's slot in the icon's count to zero (lib/app-badge.ts) and shows the new total. The bridge
// counts on it: after such a read it skips the pane's clear to this device (bridge/push.ts, rule 2),
// because a clear that leaves nothing on screen is a silent push, and Chrome shows "This site has
// been updated in the background" once a site has sent too many. The page says it does this when it
// subscribes (`closesOwn` in lib/push.ts), so a page that predates this file keeps getting the clear.
//
// So the close must cover at least the slot the bridge then calls closed: the pane's own
// notification, on the machine and in the session the read named. It matches on the notification's
// `data`, which the bridge stamped (bridge/notifications.ts), by the same normalised scope the read
// put on the wire. A notification it cannot match it leaves alone; the bridge's clear still covers
// those. The slot it zeroes is named the way the bridge names it (`seenSlotTag`, bridge/server.ts).
// A pane that is still blocked comes back into the count with its next push; the page that is open
// shows its own count meanwhile (routes/home.tsx).

import { recordSlot, showBadge, type BadgeCaches, type BadgeTarget } from "./app-badge";
import { basePath } from "./base-path";
import { cacheStorage } from "./env";
import { hostSlot, type NotifData } from "./push-decision";
import { normalizeScope, type Scope } from "./scope";

/** Whether a shown notification's data is this pane's own, on this machine and in this session. */
export function isPaneNotification(data: NotifData | null | undefined, paneId: string, scope?: Scope): boolean {
  if (data === null || data === undefined || data.paneId !== paneId) return false;
  // A machine or update alert carries a target, never a pane of its own.
  if (data.target !== undefined) return false;
  const want = normalizeScope(scope);
  const got = normalizeScope({ host: data.host, session: data.session });
  return want.host === got.host && want.session === got.session;
}

/**
 * The pane's own notification slot, as the bridge's sink names it: `paneTag` of the session's herd
 * tag (bridge/notifications.ts, bridge/sessions.ts, bridge/crew/tags.ts). A member's pane is alerted
 * from its primary session only, so a member's named session names no slot.
 */
export function paneSlotTag(paneId: string, scope?: Scope): string | null {
  const herd = herdSlotTag(scope);
  return herd === null ? null : `${herd}:${paneId}`;
}

/**
 * The session's herd slot itself, the summary's tag when one notification stands for every alert
 * (`herdTagFor` in bridge/sessions.ts, host-qualified as bridge/crew/tags.ts does). A member's named
 * session names no slot, as in {@link paneSlotTag}.
 */
export function herdSlotTag(scope?: Scope): string | null {
  const { host, session } = normalizeScope(scope);
  if (host !== undefined) return session === undefined ? hostSlot(HERD_SLOT, host) : null;
  return session === undefined ? HERD_SLOT : `${HERD_SLOT}:${session}`;
}

/** The base of every herd slot, `herdTagFor`'s in bridge/sessions.ts. */
const HERD_SLOT = "collie:herd";

/** The slice of a service worker registration this needs, so a test can hand in a fake. */
export interface NotificationSource {
  getNotifications(): Promise<readonly Pick<Notification, "data" | "close">[]>;
}

/** Close every notification of `source` that is this pane's own. Never throws. */
export async function closePaneNotificationsIn(
  source: NotificationSource,
  paneId: string,
  scope?: Scope,
): Promise<void> {
  try {
    for (const shown of await source.getNotifications()) {
      // SAFETY: `Notification.data` is `any`, but every notification of this registration is one the
      // service worker built from a `NotifData` (web/src/sw.ts); every field is optional and checked.
      if (isPaneNotification(shown.data as NotifData | null, paneId, scope)) shown.close();
    }
  } catch {
    // The list refused: the bridge did not learn anything from this, its clear still arrives.
  }
}

/** Where the icon's count lives and is shown, so a test can hand in fakes. */
export interface BadgeHome {
  caches: BadgeCaches;
  origin: string;
  mount: string;
  target: BadgeTarget;
}

/** Set the pane's slot in the icon's count to zero and show the new total. Never throws. */
export async function zeroPaneSlotIn(home: BadgeHome, paneId: string, scope?: Scope): Promise<void> {
  const tag = paneSlotTag(paneId, scope);
  if (tag === null) return;
  try {
    await showBadge(home.target, await recordSlot(home.caches, home.origin, home.mount, tag, 0));
  } catch {
    // Cache Storage refused: the count stays as the worker last left it.
  }
}

/** Do on this device what the pane's clear would: close its notification and zero its count. */
export async function closePaneNotifications(paneId: string, scope?: Scope): Promise<void> {
  const caches = cacheStorage();
  if (caches !== null) await zeroPaneSlotIn({ caches, origin: location.origin, mount: basePath(), target: navigator }, paneId, scope);
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration !== undefined) await closePaneNotificationsIn(registration, paneId, scope);
  } catch {
    // No registration to ask: nothing of this page's is on screen.
  }
}
