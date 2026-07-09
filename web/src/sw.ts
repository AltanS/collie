/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import { decidePush, type PushPayload } from "./lib/push-decision";

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
  // `renotify` isn't in this TS lib's NotificationOptions yet, though it's honoured by browsers that
  // support it (and it needs a tag).
  const options: NotificationOptions & { renotify?: boolean } = {
    body: decision.body,
    data: { paneId: decision.paneId, session: decision.session },
    icon: ICON,
    badge: ICON,
    tag: decision.tag,
    renotify: decision.renotify,
  };
  await self.registration.showNotification(decision.title, options);
}

interface NotifData {
  paneId?: string;
  /** Registry name of the pane's session (undefined = primary) — the deep-link scopes to it. */
  session?: string;
}

// Session query builder, inlined so the SW bundle stays dependency-free (it imports only
// push-decision). The browser URL uses `?s=`. Primary → no param.
function sessionSearchParam(session?: string): string {
  return session ? `?s=${encodeURIComponent(session)}` : "";
}

// Tap a notification: deep-link to the agent's pane (never act on it blind — the reply lives in-app).
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data as NotifData | null) ?? {};
  event.waitUntil(openPane(data.paneId, data.session));
});

// Focus an existing Collie tab (navigating it to the agent) or open a new one — the body-tap path.
// The session rides along as `?s=` so the deep-link lands in the right herd (omitted for primary).
async function openPane(paneId: string | undefined, session?: string): Promise<void> {
  const base = paneId && paneId !== "test" ? `/pane/${encodeURIComponent(paneId)}` : "/";
  const path = `${base}${sessionSearchParam(session)}`;
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    await client.focus();
    if (client.url !== url) await client.navigate(url).catch(() => null);
    return;
  }
  await self.clients.openWindow(url);
}
