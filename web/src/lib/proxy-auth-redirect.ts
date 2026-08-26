import { PROXY_AUTH_PATH } from "./sw-routes";

// A fronting identity proxy can answer an expired API session with a 302 instead of a 401/403.
// Browser fetch follows that redirect by default; when the login flow leaves the app origin the
// result becomes an opaque CORS failure, so Collie's existing auth-error path cannot distinguish it
// from a dead bridge. Force API fetches into manual redirect mode, turn an intercepted redirect into
// the same readable 401 the rest of the client already understands, and promote the login flow to a
// top-level navigation where SSO is actually allowed to run.

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUTHENTIK_OUTPOST_PREFIX = "/outpost.goauthentik.io";
export const AUTHENTIK_PING_PATH = `${AUTHENTIK_OUTPOST_PREFIX}/ping`;
export const AUTHENTIK_START_PATH = `${AUTHENTIK_OUTPOST_PREFIX}/start`;
const AUTHENTIK_PROBE_TIMEOUT_MS = 1_500;

/** True only for same-origin Collie API requests. */
export function isCollieApiRequest(input: RequestInfo | URL, baseHref: string): boolean {
  try {
    const base = new URL(baseHref);
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(raw, base);
    return url.origin === base.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * `redirect: "manual"` produces an opaque-redirect filtered response in browsers (status 0). The
 * explicit status check keeps the helper deterministic in tests and in runtimes that expose the
 * original same-origin 3xx. 304 is intentionally absent: pane polling uses it as a normal cache hit.
 */
export function isProxyRedirectResponse(response: Response): boolean {
  return response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status);
}

/**
 * Wrap fetch without teaching the API client about any identity provider. A redirect can only come
 * from the front door because Collie's /api/* contract has no redirects of its own. Returning a
 * synthetic 401 feeds the existing ApiError -> authError -> Sign in banner path while `onRedirect`
 * starts the top-level recovery in parallel.
 */
export function proxyAwareFetch(
  nativeFetch: typeof fetch,
  onRedirect: () => void,
  currentHref: () => string,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isCollieApiRequest(input, currentHref())) return nativeFetch(input, init);

    const response = await nativeFetch(input, { ...init, redirect: "manual" });
    if (!isProxyRedirectResponse(response)) return response;

    onRedirect();
    return new Response("fronting identity proxy requires sign-in", {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Pick the top-level recovery URL. Authentik's single-application forward-auth contract exposes a
 * public same-origin `/outpost.goauthentik.io/ping` endpoint; when that exact fingerprint answers
 * 204 we can enter its fixed `/start` flow directly and preserve the current Collie URL in `rd`.
 * Otherwise stay vendor-neutral and fall back to Collie's operator-owned `/auth/` namespace.
 */
export async function resolveProxyAuthEntry(
  nativeFetch: typeof fetch,
  currentHref: string,
): Promise<string> {
  try {
    const ping = await nativeFetch(AUTHENTIK_PING_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      signal: timeoutSignal(AUTHENTIK_PROBE_TIMEOUT_MS),
    });
    if (ping.status === 204) {
      const start = new URL(AUTHENTIK_START_PATH, currentHref);
      start.searchParams.set("rd", currentHref);
      return `${start.pathname}${start.search}${start.hash}`;
    }
  } catch {
    // A missing, blocked or slow Authentik outpost is simply "not detected"; `/auth/` remains the
    // documented generic escape hatch and its placeholder explains a missing proxy rule.
  }
  return PROXY_AUTH_PATH;
}

let installed = false;
let recovery: Promise<void> | null = null;

/** Install the browser-only API redirect guard once, before React starts issuing loaders. */
export function installProxyAuthRedirectRecovery(): void {
  if (installed || typeof window === "undefined" || typeof globalThis.fetch !== "function") return;
  installed = true;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const beginRecovery = () => {
    if (recovery) return;
    recovery = (async () => {
      const href = window.location.href;
      const target = await resolveProxyAuthEntry(nativeFetch, href);
      window.location.assign(target);
    })();
  };

  globalThis.fetch = proxyAwareFetch(nativeFetch, beginRecovery, () => window.location.href);
}
