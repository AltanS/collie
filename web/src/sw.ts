/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import {
  buildNotificationActions,
  decidePush,
  parseReplyAction,
  type PushAction,
  type PushPayload,
} from "./lib/push-decision";

// Custom service worker (vite-plugin-pwa `injectManifest`). It does everything the old generated
// Workbox SW did — precache the app shell + SPA-fallback navigations — PLUS the two handlers a
// generated SW can't give us: `push` (render the bridge's notification) and `notificationclick`
// (deep-link to the agent). Without a `push` listener the browser, forced to show *something* for a
// `userVisibleOnly` subscription, falls back to a generic "site updated in the background" — which
// was exactly the bug this file fixes.
//
// In module scope a `declare const self` shadows the global, giving us the service-worker type (the
// documented vite-plugin-pwa pattern). `__WB_MANIFEST` is the injection point workbox-build fills in
// at build time — it must appear verbatim, exactly once, or the build fails.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

// ── App-shell caching (parity with the previous generateSW config) ──────────────────────────────
precacheAndRoute(self.__WB_MANIFEST);
// SPA fallback so deep links (/pane/:id) resolve offline too; never intercept the API.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//] }));

// `registerType: "autoUpdate"` means a fresh build should take over without a user gesture. With
// injectManifest we own that lifecycle: skip the waiting phase on install, claim open clients on
// activate. The message handler backs lib/pwa.ts's manual "tap to update" (postMessage SKIP_WAITING).
self.addEventListener("install", () => void self.skipWaiting());
clientsClaim();
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

// ── Web Push ────────────────────────────────────────────────────────────────────────────────────
// The branching (suppress vs show vs clear, tag/title/renotify) lives in lib/push-decision so it's
// unit-tested; here we only parse the event, read client visibility, and run the side effect.
const ICON = "/web-app-manifest-192x192.png";

self.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(handlePush(event));
});

async function anyVisibleClient(): Promise<boolean> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((c) => c.visibilityState === "visible");
}

async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    // Non-JSON / empty push — fall back to a plain-text body so we never silently drop it.
    payload = { body: event.data?.text() };
  }

  const decision = decidePush(payload, await anyVisibleClient());
  if (decision.kind === "suppress") return; // a visible Collie tab already surfaces it in-app
  if (decision.kind === "clear") {
    // Retraction: close the slot and show nothing. Chrome's silent-push budget tolerates this.
    const stale = await self.registration.getNotifications({ tag: decision.tag });
    for (const n of stale) n.close();
    return;
  }
  // One-tap reply buttons ("yes"/"continue"/…): only offered when there's a real pane to reply to.
  // The button texts ride along in notification.data so notificationclick can look them up by index.
  const { actions, quickReplies } = buildNotificationActions(payload.quickReplies, decision.paneId);
  // `renotify` and `actions` aren't in this TS lib's NotificationOptions yet, though both are
  // honoured by browsers that support notification action buttons (and both need a tag).
  const options: NotificationOptions & { renotify?: boolean; actions?: PushAction[] } = {
    body: decision.body,
    data: { paneId: decision.paneId, quickReplies },
    icon: ICON,
    badge: ICON,
    tag: decision.tag,
    renotify: decision.renotify,
    actions,
  };
  await self.registration.showNotification(decision.title, options);
}

interface NotifData {
  paneId?: string;
  quickReplies?: string[];
}

// Tap a notification. A reply action button POSTs the reply straight from the SW (no app needed) and
// swaps in a brief "Sent ✓" confirmation; a plain body tap keeps the old deep-link-to-the-agent path.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data as NotifData | null) ?? {};
  const replyIndex = event.action ? parseReplyAction(event.action) : null;

  if (replyIndex !== null && data.paneId) {
    const text = data.quickReplies?.[replyIndex];
    if (text) {
      event.waitUntil(sendQuickReply(data.paneId, text, event.notification.tag));
      return;
    }
    // The reply text vanished (shouldn't happen) — fall through to the deep-link.
  }
  event.waitUntil(openPane(data.paneId));
});

// POST a quick reply to the same endpoint the app uses (POST /api/pane/:id/reply {text, submit}).
// Same-origin, so credentials/the trusted-user header ride along automatically. Confirm on success;
// on failure raise an error notification whose tap opens the pane so the user can retry by hand.
async function sendQuickReply(paneId: string, text: string, tag: string): Promise<void> {
  try {
    const res = await fetch(`/api/pane/${encodeURIComponent(paneId)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit: true }),
    });
    // The bridge answers 200 with { ok: boolean }; a non-2xx OR an { ok: false } body is a failure.
    let ok = res.ok;
    if (ok) {
      try {
        const json = (await res.json()) as { ok?: boolean } | null;
        if (json?.ok === false) ok = false;
      } catch {
        // 2xx with no/invalid JSON body — trust the status code.
      }
    }
    if (!ok) {
      await showReplyError(paneId, tag);
      return;
    }
    // Silent confirmation reusing the slot (same tag) so it replaces the original alert, not stacks.
    await self.registration.showNotification("Sent ✓", {
      body: text,
      icon: ICON,
      badge: ICON,
      tag,
      silent: true,
      data: { paneId },
    });
  } catch {
    await showReplyError(paneId, tag);
  }
}

async function showReplyError(paneId: string, tag: string): Promise<void> {
  await self.registration.showNotification("Reply failed — tap to open", {
    body: "Couldn't send. Open the pane to retry.",
    icon: ICON,
    badge: ICON,
    tag,
    data: { paneId },
  });
}

// Focus an existing Collie tab (navigating it to the agent) or open a new one — the body-tap path.
async function openPane(paneId: string | undefined): Promise<void> {
  const path = paneId && paneId !== "test" ? `/pane/${encodeURIComponent(paneId)}` : "/";
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    await client.focus();
    if (client.url !== url) await client.navigate(url).catch(() => null);
    return;
  }
  await self.clients.openWindow(url);
}
