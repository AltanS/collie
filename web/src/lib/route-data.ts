// The one place that knows which route id carries which loader's data.
//
// React Router's data mode addresses a parent route's data by a runtime STRING id, so
// `useRouteLoaderData` can only be typed `unknown` — the id and the loader's return type have no
// compile-time relationship. Every consumer used to close that gap with its own assertion, which
// meant the pairing (`ROOT_ROUTE_ID` ↔ `rootLoader` ↔ `HomeData`) was restated at each call site and
// could drift silently at any one of them. It is stated here instead, once.

import { useRouteLoaderData } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "./loaders";

/**
 * The root route's data, for a component that only renders as its descendant — so the loader has
 * always resolved by the time it runs.
 */
export function useRootData(): HomeData {
  // SAFETY: `ROOT_ROUTE_ID` is the id `router.tsx` gives the route whose `loader` is `rootLoader`,
  // and `rootLoader` returns `HomeData`. Callers of this overload render inside that route, whose
  // element does not mount until its loader has resolved.
  return useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
}

/**
 * The root route's data where it may not be there yet — a component that can also render during the
 * first resolution, or outside the route tree entirely (a footer, a settings card).
 */
export function useOptionalRootData(): HomeData | undefined {
  // SAFETY: as above; `undefined` is what `useRouteLoaderData` itself returns for a route whose
  // data is not loaded, which is precisely the case this overload exists for.
  return useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
}
