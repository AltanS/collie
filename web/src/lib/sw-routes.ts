/**
 * Which navigations the service worker must NEVER answer from the precache.
 *
 * The SW's NavigationRoute serves the precached app shell for every navigation it handles, without
 * touching the network. That is what makes deep links work offline — and it is also why an installed
 * PWA, which has no address bar to fall back on, cannot reach anything a fronting reverse proxy
 * serves at a path Collie doesn't own. A proxy that authenticates devices ahead of the bridge
 * (README Variant C/E) has a sign-in or enrolment page, and before this list existed there was no
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
 * can serve its page at either.
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
  // Cloudflare Access serves its login and callback under `/cdn-cgi/access/` and the path is NOT
  // relocatable, so pointing the operator at `/auth/` cannot help them — the flow would break on a
  // callback the precache swallowed. `/cdn-cgi/` is Cloudflare-reserved; Collie will never route it.
  // Proxies whose prefix IS movable (oauth2-proxy's `--proxy-prefix`, Authelia) are documented in
  // the README instead of listed here — this list stays for paths nobody can move.
  /^\/cdn-cgi\//,
] as const;

/**
 * The bundled Nerd Font faces (index.css). The SW caches these on first use rather than precaching
 * them — `unicode-range` keeps them lazy and ~1.1 MB is not something to charge an install for — and
 * sweeps anything else out of that cache on activate, which is why the live set has to be a value
 * both sides can read. The version is part of the filename: `public/` assets are unhashed, so a
 * regenerated subset must be a new URL or the permanent cache would serve the old one forever.
 * `fonts.test.ts` pins this list against the stylesheet and the files on disk.
 */
export const FONT_URLS = [
  "/fonts/nerd-symbols-3.5.0-pua.woff2",
  "/fonts/nerd-symbols-3.5.0-spua.woff2",
] as const;

/**
 * True when the SW must not answer this navigation from the precache. Takes `pathname + search`,
 * matching what workbox feeds the denylist — pass the query string if there is one.
 */
export function isNetworkOnlyNavigation(pathnameAndSearch: string): boolean {
  return NAVIGATION_NETWORK_ONLY.some((re) => re.test(pathnameAndSearch));
}
