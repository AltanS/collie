// Which server-rendered route a URL is (S1): `/` or `/pane/:paneId`, through the router's own patterns.
// Its own module so the islands boot (islands/seed.ts) can ask without importing the routes' screens.
import { createMultiMatcher } from "remix/route-pattern/match";

import { routes } from "../routes";

/** The routes a server document exists for. Every other path gets the static shell. */
export type AppRoute = { kind: "home" } | { kind: "pane"; paneId: string };

const matcher = createMultiMatcher<"home" | "pane">();
matcher.add(routes.home.pattern, "home");
matcher.add(routes.pane.pattern, "pane");

/** Which server-rendered route `url` (mount off) is, or null. The router's own matcher and patterns. */
export function matchAppRoute(url: URL): AppRoute | null {
  const match = matcher.match(url);
  if (match === null) return null;
  if (match.data === "home") return { kind: "home" };
  const paneId = match.params.paneId;
  return paneId === undefined ? null : { kind: "pane", paneId };
}
