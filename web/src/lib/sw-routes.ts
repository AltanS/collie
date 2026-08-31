/**
 * Which navigations the service worker must NEVER answer from the precache.
 *
 * The SW's NavigationRoute serves the precached app shell for every navigation it handles, without
 * touching the network. That is what makes deep links work offline — and it is also why an installed
 * PWA, which has no address bar to fall back on, cannot reach anything a fronting reverse proxy
 * serves at a path Collie doesn't own. A proxy that authenticates devices ahead of the bridge
 * (DEPLOYMENT.md, Variant C/E) has a sign-in or enrolment page, and before this list existed there was no
 * legitimate place to put it: the `/api/` denylist was the only crack in the precache, so operators
 * squatted a page inside the namespace the API owns.
 *
 * `/auth/` is therefore RESERVED. Collie routes nothing there, precaches nothing there, and will
 * never claim it for a UI route — it exists so the operator's front door has an address. The bridge
 * answers it with a placeholder explaining that nothing is configured, so an operator without a
 * proxy finds out immediately instead of silently getting the app shell.
 *
 * Kept in its own module, free of workbox imports, so the contract is unit-testable and so the app
 * and the service worker can't drift on what the reserved path is.
 */

/** The reserved prefix a fronting proxy owns. Trailing slash: it's a namespace, not one page. */
export const PROXY_AUTH_PATH = "/auth/";

/**
 * Navigation paths the SW passes straight to the network. `/api/` was always here (the API must
 * never be answered from a cache); `/auth` joins it, with or without the trailing slash, so a proxy
 * can serve its page at either; `/pack/v1/` joins it because a browser must never be able to cache
 * a collie-to-collie response (PACK_PROTOCOL.md §5).
 *
 * This list is the SW's *only* caching decision that isn't the precache: sw.ts registers no runtime
 * caching route, so denying a path here is denying it from the SW entirely.
 *
 * These are matched against `pathname + search`, NOT pathname alone — verified in the vendored
 * workbox-routing/NavigationRoute.js (`_match` builds `url.pathname + url.search` and tests the
 * denylist against that). Hence `[/?]` rather than a bare `/`: a proxy that bounces you to
 * `/auth?rd=%2Fpane%2Fw1` — the shape Authelia and oauth2-proxy both use — produces the string
 * "/auth?rd=%2Fpane%2Fw1", and a rule anchored on a trailing slash would miss it and hand the
 * operator the precached app shell. That is this whole bug, in its most likely real-world form.
 */
export const NAVIGATION_NETWORK_ONLY = [
  /^\/api\//,
  /^\/auth(?:[/?]|$)/,
  // Authentik forward-auth exposes a fixed same-origin outpost namespace for its start/callback
  // flow. Operators can point Collie's `/auth/` escape hatch there; after the operator taps Sign in,
  // the installed PWA must pass that navigation through instead of replacing it with the cached app
  // shell. The path is non-relocatable in Authentik's standard integration.
  /^\/outpost\.goauthentik\.io(?:[/?]|$)/,
  // Cloudflare Access serves its login and callback under `/cdn-cgi/access/` and the path is NOT
  // relocatable, so pointing the operator at `/auth/` cannot help them — the flow would break on a
  // callback the precache swallowed. `/cdn-cgi/` is Cloudflare-reserved; Collie will never route it.
  // Proxies whose prefix IS movable (oauth2-proxy's `--proxy-prefix`, Authelia) are documented in
  // the README instead of listed here — this list stays for paths nobody can move.
  /^\/cdn-cgi\//,
  // The pack surface (PACK_PROTOCOL.md §5). A browser NEVER issues a `/pack/v1/*` request — it is
  // collie-to-collie, admitted only by the two pack factors — so a browser must never be able to
  // cache one either. Denylisted for the same reason `/api/` is, and then some: these responses
  // carry another machine's panes, and the precached app shell is not a plausible answer to any of
  // them. Query-tolerant (`[/?]`) like `/auth` because workbox matches pathname+search.
  //
  // Scoped to `v1` rather than all of `/pack/`: the protocol reserves the versioned prefix, and a
  // future `/pack/v2/` arrives with a bridge that can add its own line here.
  /^\/pack\/v1(?:[/?]|$)/,
  // The standby door (PACK_PROTOCOL.md §18.15, RFC §6.2). In the same-origin failover deployment the
  // phone's FIRST hit on the bad day is an installed service worker minted from the LEAD's origin —
  // so without this line the takeover page is answered from the precache with the app shell of the
  // very collie that just died, and the door is unreachable by the one device that needs it. This is
  // not hygiene; it is the difference between reaching the door and staring at a cached UI.
  //
  // The whole `/standby` namespace, query-tolerant like the two above: `/standby/health` is a proxy's
  // health check, `/standby` is the page, `/standby/takeover` is the confirm, and Collie will never
  // route a UI page under that prefix.
  /^\/standby(?:[/?]|$)/,
] as const;

/**
 * Every webfont the app ships (index.css). The SW caches these on first use rather than precaching
 * them, and sweeps anything else out of that cache on activate, which is why the live set has to be
 * a value both sides can read. The version is part of every filename: `public/` assets are unhashed,
 * so a regenerated subset must be a new URL or the permanent cache would serve the old one forever.
 * `fonts.test.ts` pins this list against the stylesheet and the files on disk.
 *
 * Two kinds of entry, cached the same way for different reasons:
 *
 *  - The Nerd Font symbol faces are LAZY. `unicode-range` means a herd whose agents print no Nerd
 *    Font glyph never fetches them, and ~1.1 MB is not something to charge an install for.
 *  - The DEFAULT UI typeface is on the critical path — it dresses every label — so it is fetched on
 *    the first load and served from this cache on every load after, online or not. It is out of the
 *    precache anyway because that install has to fetch it during the same first paint regardless,
 *    and putting it in `globPatterns` would only make the install pay for it twice. 27 KB. The other
 *    shipped face (Aldrich, 8 KB) is only ever fetched by a device whose reader chose it, and is
 *    cached the same way from that moment on — including offline, which is the point of listing it.
 *
 * Runtime caching is cache-first (src/sw.ts), so an update that renames the file re-fetches once
 * and the sweep drops the superseded entry. Offline after any prior visit is covered by the cache;
 * offline on a device that has never loaded the app is not a font problem.
 */
/**
 * The UI face a device gets when it has never touched the Typeface setting — Aldrich.
 *
 * Named separately because it is the one URL that is on the CRITICAL PATH: index.html preloads it,
 * the boot splash re-declares it, and `fonts.test.ts` holds it to the ~60 KB budget. The other
 * shipped faces are opt-in, so they are fetched when a reader picks one and never before.
 */
export const DEFAULT_UI_FONT_URL = "/fonts/ui-aldrich-1.002-latin.woff2";

/**
 * Every SHIPPED UI face — the ones the Typeface setting can be set to (ADR 0033). In the order
 * index.css declares them, because `fonts.test.ts` compares the two lists element by element.
 *
 * An OPERATOR's face is not here and must never be: those live behind `/api/fonts/`, are fetched
 * from the network like any other API call, and are neither precached nor swept. A URL added here
 * that does not sit under `/fonts/` would be swept out of the font cache on every activate.
 */
export const UI_FONT_URLS = ["/fonts/ui-space-grotesk-2.000-latin.woff2", DEFAULT_UI_FONT_URL] as const;

export const FONT_URLS = [
  "/fonts/nerd-symbols-3.5.0-pua.woff2",
  "/fonts/nerd-symbols-3.5.0-spua.woff2",
  ...UI_FONT_URLS,
] as const;

/**
 * True when the SW must not answer this navigation from the precache. Takes `pathname + search`,
 * matching what workbox feeds the denylist — pass the query string if there is one.
 */
export function isNetworkOnlyNavigation(pathnameAndSearch: string): boolean {
  return NAVIGATION_NETWORK_ONLY.some((re) => re.test(pathnameAndSearch));
}
