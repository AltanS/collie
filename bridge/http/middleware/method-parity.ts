// HEAD on a GET-only route goes where the old dispatch sent it: to the app shell.
//
// fetch-router answers HEAD from a matching GET route and strips the body. The old `fetch` closure
// compared `req.method === "GET"` exactly, so a HEAD on a GET-only path missed that branch and, like
// any other method mismatch, fell through to the SPA fallback. The routes that took HEAD themselves
// (`/api/health`, and the any-method routes) are plain-string routes in ../routes.ts and are left to
// the router.
//
// The other half of the same quirk needs no code: a wrong method on a known path makes the router
// fall through to a less specific route that takes the method before it would answer 405, and the
// app shell (`/*path`) takes every method. So no router 405 is ever produced; every 405 a client
// sees is one an old handler wrote itself.

import type { Middleware, RequestContext } from "remix/router";
import { Route, type RouteMap } from "remix/routes";
import { rawPathMatcher } from "./raw-path.ts";

/** Every route in a (nested) route map. */
function routesOf(map: RouteMap): Route[] {
  const out: Route[] = [];
  for (const value of Object.values(map)) {
    if (value instanceof Route) out.push(value);
    else out.push(...routesOf(value));
  }
  return out;
}

export function methodParity(
  map: RouteMap,
  fallThrough: (context: RequestContext) => Response | Promise<Response>,
): Middleware {
  const methods = rawPathMatcher<Route["method"]>();
  for (const route of routesOf(map)) methods.add(route.pattern, route.method);
  return (context, next) => {
    if (context.method !== "HEAD") return next();
    // Most specific first, as the router walks them. A POST-only match is skipped by the router
    // for a HEAD too, so it is skipped here.
    for (const match of methods.matchAll(context.url)) {
      if (match.data === "GET") return fallThrough(context);
      if (match.data === "ANY" || match.data === "HEAD") return next();
    }
    return next();
  };
}
