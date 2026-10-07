/// <reference lib="webworker" />
// The server document in the service worker (S1, `experiments/remix-v3/ACTION-PLAN.md` B).
//
// web/'s worker answers EVERY navigation from the precached shell (its `NavigationRoute`, and the
// precache route before it, which maps `/` to `/index.html`). An installed app would then never see
// the bridge's rendered `/` or `/pane/:paneId`. So those two navigations go to the network first,
// and fall back to the precached shell when the network fails, answers with something that is not
// the bridge's own document, or takes longer than DOCUMENT_TIMEOUT_MS. Every other navigation and
// every API request stays exactly as web/'s worker routes it.
//
// WHY A PLAIN LISTENER, REGISTERED FIRST. Workbox's router answers the first route that matches, and
// web/'s precache route is registered when web/src/sw.ts evaluates; this module is imported before
// it (sw.ts), so its listener runs first and stops the event from reaching Workbox's. It uses no
// Workbox module on purpose: web/ and web-remix/ each have their own copy, and a second copy's
// `matchPrecache` would ask an empty controller. The precached shell is read straight from Cache
// Storage instead, where Workbox keeps it under `index.html?__WB_REVISION__=…`.
//
// WHY 2 SECONDS. Offline, `fetch` rejects at once and the shell answers at once: the timeout is only
// for lie-fi, a connection that is up but stalls. The bridge renders a document in a few
// milliseconds and a tailnet round trip on a phone is well under a second, so 2 s leaves room for a
// slow cellular link while capping the worst case at 2 s of blank screen before the shell, which then
// polls as before. Workbox's `NetworkFirst` examples use 3 s, which is long to stare at a blank
// screen; under 1.5 s a phone radio waking from idle can miss it and fall back for no reason.

declare const self: ServiceWorkerGlobalScope;

const DOCUMENT_TIMEOUT_MS = 2000;

const MOUNT = new URL("./", self.location.href).pathname;

/** `/` or `/pane/<one segment>`, under the mount. */
function isDocumentPath(pathname: string): boolean {
  if (!pathname.startsWith(MOUNT)) return false;
  const rest = pathname.slice(MOUNT.length);
  return rest === "" || /^pane\/[^/]+\/?$/.test(rest);
}

/** The bridge's own document: a same-origin, unredirected 200 HTML answer. */
function usable(response: Response): boolean {
  return (
    response.status === 200 &&
    response.type === "basic" &&
    !response.redirected &&
    (response.headers.get("content-type") ?? "").startsWith("text/html")
  );
}

/** The shell Workbox precached, or undefined before the first install finished. */
function precachedShell(): Promise<Response | undefined> {
  return caches.match(new URL("index.html", self.location.href).href, { ignoreSearch: true });
}

async function documentFirst(request: Request): Promise<Response> {
  const network = fetch(request).then(
    (response) => (usable(response) ? response : null),
    () => null,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), DOCUMENT_TIMEOUT_MS);
  });
  const first = await Promise.race([network, late]);
  clearTimeout(timer);
  if (first instanceof Response) return first;
  const shell = await precachedShell();
  if (shell !== undefined) return shell;
  // Nothing precached yet (the first visit, before the install): the network is all there is.
  return (await network) ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !isDocumentPath(url.pathname)) return;
  event.stopImmediatePropagation();
  event.respondWith(documentFirst(request));
});
