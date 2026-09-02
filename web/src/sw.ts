/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import { decidePush, notificationPath, type NotifData, type PushPayload } from "./lib/push-decision";
import { FONT_URLS, NAVIGATION_NETWORK_ONLY } from "./lib/sw-routes";

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
// SPA fallback so deep links (/pane/:id) resolve offline too. The denylist is the set of paths this
// SW must never answer from the precache — the API, and the `/auth/` namespace reserved for a
// fronting proxy's sign-in page. Without that second entry an installed PWA, which has no address
// bar, has no reachable path to the proxy at all: every navigation, including a reload, is answered
// by the cached app shell. See lib/sw-routes for the contract.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [...NAVIGATION_NETWORK_ONLY],
  }),
);

// The bundled Nerd Font faces are out of the precache on purpose — `unicode-range` keeps them lazy,
// and ~1.1 MB is not something to charge an install for (vite.config.ts, index.css). Cache-first on
// first use gives them back offline. Hand-rolled rather than workbox-strategies: the SW bundle stays
// at one dependency. Entries are never revised — the version is in the filename, so a regenerated
// subset is a different URL and old entries are swept on activate, not overwritten.
//
// The cost, stated plainly: a device that installs the PWA and goes offline without ever painting a
// Nerd Font glyph shows tofu until it is online once. Precaching would fix that by charging EVERY
// install ~1.1 MB, including the installs that never need a glyph — the wrong way round.
const FONT_CACHE = "collie-fonts";

// WHAT MAY BE STORED. This cache is permanent, so a wrong entry is permanent too — the same shape as
// the 401ing proxy that once froze an installed SW, one layer down. A fronting proxy with an expired
// session answers a subresource with 302 → 200 sign-in HTML, and `response.ok` is true for that: the
// login page would be cached AS the font, tofu forever with no recovery but clearing site data. So a
// response must be an unredirected 200 that actually claims to be a font. (Bare `.ok` also admits
// 206, which `cache.put` rejects outright.)
const storable = (r: Response) =>
  r.status === 200 && !r.redirected && (r.headers.get("content-type") ?? "").includes("font");

registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/fonts/"),
  async ({ request }) => {
    const cache = await caches.open(FONT_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    // Writing is best-effort and off the response path: a full quota or a storage error costs the
    // glyphs on the next load, never this one.
    if (storable(response)) void cache.put(request, response.clone()).catch(() => null);
    return response;
  },
);

// A font version bump changes the filename, so the superseded entry would otherwise sit in storage
// forever. Sweep anything the current build doesn't name — the precache manifest is workbox's job,
// this cache is ours.
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(FONT_CACHE);
      const live = new Set<string>(FONT_URLS);
      for (const req of await cache.keys()) {
        if (!live.has(new URL(req.url).pathname)) await cache.delete(req);
      }
    })(),
  );
});

// `registerType: "autoUpdate"` means a fresh build should take over without a user gesture. With
// injectManifest we own that lifecycle: skip the waiting phase on install, claim open clients on
// activate. The message handler backs lib/pwa.ts's manual "tap to update" (postMessage SKIP_WAITING).
self.addEventListener("install", () => void self.skipWaiting());
clientsClaim();
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  // SAFETY: `ExtendableMessageEvent.data` is `any` — a structured clone from an arbitrary client.
  // Only the same-origin page can reach this worker, and lib/pwa.ts is the one thing that posts to
  // it; the optional chain means any other payload simply fails the comparison.
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
    // SAFETY: `PushMessageData.json()` is typed `any` — it is the bridge's own push body, which
    // bridge/push.ts builds as a `PushPayload`. A body that isn't JSON at all throws into the catch
    // below; every field read downstream is optional, so a JSON body of another shape degrades to
    // the plain-text fallback rather than crashing the worker.
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
    data: {
      paneId: decision.paneId,
      session: decision.session,
      host: decision.host,
      target: decision.target,
    } satisfies NotifData,
    icon: ICON,
    badge: ICON,
    tag: decision.tag,
    renotify: decision.renotify,
  };
  await self.registration.showNotification(decision.title, options);
}

// Tap a notification: an update push routes to Settings; everything else deep-links to the agent's
// pane on the machine and in the session it lives in (never act on it blind — the reply lives
// in-app; a cross-host blind action would be strictly worse than a same-host one). An old cached SW
// that predates `target` simply ignores it and takes the pane path, opening "/" for a pushed update
// — acceptable, and the same degradation `host` gets.
//
// The URL itself is built by lib/push-decision's notificationPath, on top of lib/scope's
// `scopeSearch`: the query this file used to hand-inline is now the app's own, so the string
// compared in openPath below is byte-identical to the one the router produces for that scope.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  // SAFETY: `Notification.data` is `any` — but it is OUR data: the only writer is `handlePush`
  // above, in this same file, which attaches a `NotifData`. Every field is optional and defaulted.
  const data = (event.notification.data as NotifData | null) ?? {};
  event.waitUntil(openPath(notificationPath(data)));
});

// Focus an existing Collie tab (navigating it to `path`) or open a new one. `path` is origin-relative.
async function openPath(path: string): Promise<void> {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Navigate BEFORE focusing, and treat a null result as "this client is no good". `navigate()`
  // resolves null when the client is a discarded tab — Firefox on Android throws background tabs
  // away eagerly — and the old code ignored that, focused the corpse and returned, so the tap
  // raised the browser onto a blank tab and `openWindow` below was never reached (#147).
  // Spec: https://w3c.github.io/ServiceWorker/#client-navigate
  for (const client of windows) {
    if (client.url !== url) {
      const navigated = await client.navigate(url).catch(() => null);
      if (!navigated) continue;
    }
    await client.focus();
    return;
  }
  await self.clients.openWindow(url);
}
