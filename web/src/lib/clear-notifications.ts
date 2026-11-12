// ── CLEAR ALL: WHAT THE PAGE DOES ON ITS OWN DEVICE ──────────────────────────────────────────────
//
// `POST /api/notifications/clear` is what opening every pane does on the bridge, as one request
// (bridge/server.ts § serveNotificationsClear). This file is what a pane read does on the page
// (lib/pane-notifications.ts), for every slot the bridge says it cleared, with no push at all:
//
//   · it closes the notifications this device's service worker shows. All of them, whatever their
//     tag: a pane still blocked on you keeps its question on the dashboard and its count in the icon,
//     and only its banner goes.
//   · it sets each cleared slot's share of the icon's count to zero and shows the new total, the way
//     `zeroPaneSlotIn` does for one pane read, in one write as the sweep does for several
//     (lib/notification-sweep.ts). A slot still blocked is not in the list, so it keeps counting.
//
// The bridge counts on the first, as after a pane read: it calls the asker's cleared slots shut and
// skips their clears there (bridge/push.ts, rule 2). Other devices drop theirs through the clear the
// bridge sends them, or their own sweep the next time Collie is opened there.
//
// So each half answers how it went. A capability this browser simply lacks (no service worker, no
// Cache Storage) is fine: nothing of this page's can be on screen or counted. One that is there and
// refused is not, because no clear will come to close what is left: the control says which.

import { recordSlots, showBadge } from "./app-badge";
import { basePath } from "./base-path";
import { cacheStorage } from "./env";
import type { BadgeHome } from "./pane-notifications";

/** How one half of this device's clear went: done, not possible in this browser, or refused. */
export type CleanupStep = "done" | "absent" | "failed";

/**
 * How this device's clear went. `countStore` is the icon count's slot store (lib/app-badge.ts):
 * `done` means the cleared slots are at zero there, which is what the next push adds up. Whether the
 * icon itself was redrawn is the browser's: the shared `showBadge` swallows a refused Badging API call,
 * as it does for every pane read, so a refusal there is not seen here.
 */
export interface DeviceCleanup {
  notifications: CleanupStep;
  countStore: CleanupStep;
}

/** The slice of a service worker registration this needs, so a test can hand in a fake. */
export interface ShownSource {
  getNotifications(): Promise<readonly Pick<Notification, "close">[]>;
}

/** Close every notification `source` shows, whatever its tag. Never throws. */
export async function closeAllNotificationsIn(source: ShownSource): Promise<"done" | "failed"> {
  try {
    for (const n of await source.getNotifications()) n.close();
    return "done";
  } catch {
    return "failed"; // The list refused: what this page shows stays on screen.
  }
}

/**
 * Set each of `tags`' share of the icon's count to zero in the slot store, then ask the browser to
 * show the new total. `done` is the store's answer; the browser's is not seen (see {@link DeviceCleanup}).
 * Never throws.
 */
export async function zeroSlotsIn(home: BadgeHome, tags: readonly string[]): Promise<"done" | "failed"> {
  try {
    const zeros = tags.map((tag): [string, number] => [tag, 0]);
    await showBadge(home.target, await recordSlots(home.caches, home.origin, home.mount, zeros));
    return "done";
  } catch {
    return "failed"; // Cache Storage refused: the count stays as the worker last left it.
  }
}

/** The slot store half. Reaching Cache Storage can itself throw; that is this half's failure alone. */
async function clearCountStore(clearedSlots: readonly string[]): Promise<CleanupStep> {
  try {
    const caches = cacheStorage();
    if (caches === null) return "absent";
    return await zeroSlotsIn({ caches, origin: location.origin, mount: basePath(), target: navigator }, clearedSlots);
  } catch {
    return "failed";
  }
}

/** The notifications half. Reaching the service worker can itself throw; that is this half's failure alone. */
async function clearShown(): Promise<CleanupStep> {
  try {
    if (!("serviceWorker" in navigator)) return "absent";
    const registration = await navigator.serviceWorker.getRegistration();
    return registration === undefined ? "absent" : await closeAllNotificationsIn(registration);
  } catch {
    return "failed";
  }
}

/**
 * Do on this device what a read of each cleared pane would, for the slots the bridge answered. Each
 * half runs whatever the other did, and the whole never throws.
 */
export async function clearDeviceNotifications(clearedSlots: readonly string[]): Promise<DeviceCleanup> {
  const countStore = await clearCountStore(clearedSlots);
  const notifications = await clearShown();
  return { notifications, countStore };
}
