// ── A PANE YOU ARE READING NEEDS NO NOTIFICATION ON THIS DEVICE ─────────────────────────────────
//
// Every read the page marks as seen (`fetchPane`, the `x-collie-seen` header) closes this device's
// own notification for that pane first. The bridge counts on it: after such a read it skips the
// pane's clear to this device (bridge/push.ts, rule 2), because a clear that leaves nothing on screen
// is a silent push, and Chrome shows "This site has been updated in the background" once a site has
// sent too many. The page says it does this when it subscribes (`closesOwn` in lib/push.ts), so a
// page that predates this file keeps getting the clear.
//
// So the close must cover at least the slot the bridge then calls closed: the pane's own
// notification, on the machine and in the session the read named. It matches on the notification's
// `data`, which the bridge stamped (bridge/notifications.ts), by the same normalised scope the read
// put on the wire. A notification it cannot match it leaves alone; the bridge's clear still covers
// those.

import type { NotifData } from "./push-decision";
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

/** Close this device's notification for a pane, through the page's service worker registration. */
export async function closePaneNotifications(paneId: string, scope?: Scope): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration !== undefined) await closePaneNotificationsIn(registration, paneId, scope);
  } catch {
    // No registration to ask: nothing of this page's is on screen.
  }
}
