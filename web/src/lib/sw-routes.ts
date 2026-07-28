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
 */
export const NAVIGATION_NETWORK_ONLY = [/^\/api\//, /^\/auth(?:\/|$)/] as const;

/** True when the SW must not answer this pathname from the precache. Mirrors the denylist above. */
export function isNetworkOnlyNavigation(pathname: string): boolean {
  return NAVIGATION_NETWORK_ONLY.some((re) => re.test(pathname));
}
