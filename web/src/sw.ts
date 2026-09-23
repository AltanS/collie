/// <reference lib="webworker" />
import { addPlugins, precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";

import { decidePush, notificationPath, type NotifData, type PushPayload } from "./lib/push-decision";
import { askInApp, openNotificationTarget, type OpenOutcome, type OpenTargetClient } from "./lib/notification-open";
import { FONT_URLS, navigationNetworkOnlyUnder } from "./lib/sw-routes";

// Where this worker is mounted (ADR 0052): the directory it was fetched from, which is the mount
// the app registered it under (lib/pwa.ts) — `/` at the origin root, `/collie/` behind a proxy that
// gives Collie a path. One build serves any mount, so nothing here is a build-time constant: every
// root-absolute path this file names is put under the mount with `under()`.
const MOUNT = new URL("./", self.location.href).pathname;
const under = (path: string): string => (MOUNT === "/" ? path : `${MOUNT.slice(0, -1)}${path}`);

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
//
// ── PROGRESS IS COUNTED IN FILES, AND THAT IS THE ONLY HONEST UNIT (M28/01) ──
// `fetchDidSucceed` fires once per COMPLETED precache asset and carries no byte count. So the worker
// posts "n of N files" to every open client and the update screen draws its bar from that. A bar
// weighted by bytes would need a build-time size stamp, a fetch to read it and a fallback for when it
// is missing — and it would still move in file-sized jumps, because this is the only hook there is.
// `total` is the manifest's own length, which is exact.
//
// Best-effort, and off the response path: the asset is returned whatever the postMessage does. A
// client list that cannot be read costs the bar, never the install.
const PRECACHE_MANIFEST = self.__WB_MANIFEST;
let precached = 0;

addPlugins([
  {
    fetchDidSucceed: async ({ request, response }) => {
      precached += 1;
      const message = {
        type: "precache-progress",
        done: precached,
        total: PRECACHE_MANIFEST.length,
        url: request.url,
      };
      try {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        // `Client.postMessage(message, transfer)` — the second argument is a TRANSFER LIST, not a
        // target origin: the recipient is a client of this worker's own scope, reached by reference,
        // so there is no cross-origin window to address. Spelled out as empty, exactly as
        // `lib/pwa.ts` spells its own post to the worker, because nothing is transferred.
        for (const client of windows) client.postMessage(message, []);
      } catch {
        /* no clients to tell, or the list refused — the install is what matters */
      }
      return response;
    },
  },
]);

precacheAndRoute(PRECACHE_MANIFEST);
// SPA fallback so deep links (/pane/:id) resolve offline too. The denylist is the set of paths this
// SW must never answer from the precache — the API, and the `/auth/` namespace reserved for a
// fronting proxy's sign-in page. Without that second entry an installed PWA, which has no address
// bar, has no reachable path to the proxy at all: every navigation, including a reload, is answered
// by the cached app shell. See lib/sw-routes for the contract.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(under("/index.html")), {
    denylist: navigationNetworkOnlyUnder(MOUNT),
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
// Named per mount: two collies mounted at two paths on one origin share one Cache Storage, and
// each one's sweep below would otherwise empty the other's fonts.
const FONT_CACHE = MOUNT === "/" ? "collie-fonts" : `collie-fonts:${MOUNT}`;

// WHAT MAY BE STORED. This cache is permanent, so a wrong entry is permanent too — the same shape as
// the 401ing proxy that once froze an installed SW, one layer down. A fronting proxy with an expired
// session answers a subresource with 302 → 200 sign-in HTML, and `response.ok` is true for that: the
// login page would be cached AS the font, tofu forever with no recovery but clearing site data. So a
// response must be an unredirected 200 that actually claims to be a font. (Bare `.ok` also admits
// 206, which `cache.put` rejects outright.)
const storable = (r: Response) =>
  r.status === 200 && !r.redirected && (r.headers.get("content-type") ?? "").includes("font");

registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith(under("/fonts/")),
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
      const live = new Set<string>(FONT_URLS.map(under));
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
// Two different assets on purpose. `icon` is the large art: the mark on its tile, WITHOUT the
// maskable safe-zone padding, so it fills the notification slot instead of floating in a frame.
// `badge` is the small status-bar glyph: Android derives its SHAPE FROM THE ALPHA CHANNEL and tints
// the result, so it must be a monochrome silhouette on transparency. The maskable home-screen tile
// (`/web-app-manifest-192x192.png`) must never be used for either — it is opaque with no alpha, so
// Android stamps it on the icon's corner as a solid grey block.
const ICON = under("/notification-icon-192x192.png");
const BADGE = under("/badge-96x96.png");

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
    badge: BADGE,
    tag: decision.tag,
    renotify: decision.renotify,
  };
  await self.registration.showNotification(decision.title, options);
}

// Tap a notification: an update push routes to the Updates page under Settings; everything else deep-links to the agent's
// pane on the machine and in the session it lives in (never act on it blind — the reply lives
// in-app; a cross-host blind action would be strictly worse than a same-host one). An old cached SW
// that predates `target` simply ignores it and takes the pane path, opening "/" for a pushed update
// — acceptable, and the same degradation `host` gets.
//
// The URL itself is built by lib/push-decision's notificationPath, on top of lib/scope's
// `scopeSearch`: the query this file used to hand-inline is now the app's own, so the string
// compared in openPath below is byte-identical to the one the router produces for that scope.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  // The notification is closed AFTER the open attempt, and only when it worked. Closing first is
  // what made the 1.2.0 regression silent: the notification vanished, `openWindow` was then refused
  // for want of user activation, and the tap left the user with nothing to tap again. `close()`
  // neither grants nor consumes activation, so deferring it costs nothing, and on a failure the
  // notification stays on the shade as a second chance.
  //
  // SAFETY: `Notification.data` is `any` — but it is OUR data: the only writer is `handlePush`
  // above, in this same file, which attaches a `NotifData`. Every field is optional and defaulted.
  const data = (event.notification.data as NotifData | null) ?? {};
  event.waitUntil(
    (async () => {
      const outcome = await openPath(notificationPath(data));
      if (outcome !== "failed") event.notification.close();
    })(),
  );
});

// A window as lib/notification-open sees it: the WindowClient itself, plus `openInApp`, which asks
// the running app to push the URL in its own router (ADR 0067) and waits briefly for its answer.
function asTarget(client: WindowClient): OpenTargetClient {
  return {
    url: client.url,
    visibilityState: client.visibilityState,
    focused: client.focused,
    navigate: (target) => client.navigate(target),
    focus: () => client.focus(),
    openInApp: (target) => askInApp(client, target),
  };
}

// Focus an existing Collie tab (navigating it to `path`) or open a new one. `path` is
// origin-relative. The choice lives in lib/notification-open, which also documents why a window is
// opened before any discarded client is navigated (#147, and the Android regression that fix grew).
// The `matchAll` below is deliberately the ONLY awaited call between the tap and `openWindow`.
async function openPath(path: string): Promise<OpenOutcome> {
  // Resolved against the mount, not the origin: under `/collie/` an origin-relative target lands
  // outside the manifest scope, Chrome matches no installed client and opens a browser tab at the
  // root. At the root the two are the same address.
  const url = new URL(path.replace(/^\/+/, ""), new URL("./", self.location.href)).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return openNotificationTarget({
    url,
    clients: windows.map(asTarget),
    openWindow: (target) => self.clients.openWindow(target),
  });
}
