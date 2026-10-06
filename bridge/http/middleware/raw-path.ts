// Route matching on the raw path, and the stripped URL handed from server.ts to the router.
//
// THE RAW PATH. route-pattern decodes every param, and a malformed percent-escape makes a pattern
// match nothing at all, not even the app shell. The old dispatch matched `url.pathname` with
// `([^/]+)` regexes and decoded inside each handler, where a bad escape became that handler's own
// 400 ("malformed URL") or an uncaught 500. So the matcher is shown the path with every `%` escaped
// once more: its decode then yields exactly the segment the old regex captured, and the handler
// decodes it as it always did. Every `.` is escaped too, because route-pattern reads a raw dot as a
// delimiter and `:paneId` must take `w1.p1` whole, as `[^/]+` did (../routes.ts).
//
// THE STRIPPED URL. A mounted collie (`COLLIE_BASE_PATH`, ADR 0052) reads `/collie/api/health` as
// `/api/health`. server.ts strips the mount once, before the crew surface, and the router must route
// on that same URL rather than strip again (`stripMount` twice is not `stripMount` once). The router
// builds its own `context.url` from `request.url`, so the stripped URL travels beside the request in
// a WeakMap and {@link routedUrl} puts it in place before anything else reads it.

import type { Match, MatchOptions, MultiMatcher } from "remix/route-pattern/match";
import { createMultiMatcher } from "remix/route-pattern/match";
import type { Middleware, Router } from "remix/router";

/** `url` with its path escaped so that a decode gives back the raw path, dots included. */
export function rawPath(url: URL): URL {
  const raw = new URL(url);
  raw.pathname = url.pathname.replaceAll("%", "%25").replaceAll(".", "%2E");
  return raw;
}

/** A route-pattern multi-matcher that matches {@link rawPath} of every URL it is asked about. */
export function rawPathMatcher<T>(): MultiMatcher<T> {
  const inner = createMultiMatcher<T>();
  const resolve = (url: string | URL, options?: MatchOptions): URL =>
    rawPath(url instanceof URL ? url : new URL(url, options?.baseURL));
  return {
    get ignoreCase(): boolean {
      return inner.ignoreCase;
    },
    add: (pattern, data) => inner.add(pattern, data),
    match: (url, options): Match<string, T> | null => inner.match(resolve(url, options)),
    matchAll: (url, options): Match<string, T>[] => inner.matchAll(resolve(url, options)),
  };
}

const routedUrls = new WeakMap<Request, URL>();

/** Router middleware, always first: route on the URL the caller handed over. */
export function routedUrl(): Middleware {
  return (context, next) => {
    const url = routedUrls.get(context.request);
    if (url !== undefined) context.url = url;
    return next();
  };
}

/**
 * Run `req` through `router` as `url`.
 *
 * The router races every handler against `req.signal`, and rejects when the client goes away. The
 * old dispatch did not: the handler ran on and its answer went to a closed socket. The handler still
 * runs on here (the race does not cancel it), and the rejection is turned into an answer nobody will
 * read, so a dropped phone fetch is not logged as a server error. Any other throw is rethrown, so
 * Bun answers it exactly as it answered an uncaught throw from the old closure.
 */
export async function dispatchRouted(router: Router, req: Request, url: URL): Promise<Response> {
  routedUrls.set(req, url);
  try {
    return await router.fetch(req);
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    throw err;
  }
}
