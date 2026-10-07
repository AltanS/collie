// The one island of a server document (S1, `experiments/remix-v3/ACTION-PLAN.md` B): the Shell and
// the route under it, for the two routes the bridge renders, `/` and `/pane/:paneId`.
//
// THE SAME TREE IN THREE PLACES. The bridge renders `AppRoot` into the document; the browser
// hydrates it in place (main.tsx, `run({ loadModule })` from remix/component); and the router's
// home and pane actions (router.tsx) draw `appRouteNode` under the same Shell for every routed
// navigation. One function builds the route node for all three, so the server markup, the hydrated
// tree and the first routed render have the same component at every position.
//
// Props are the island's only server-to-browser channel (JSON in `rmx-data`, C/src/server/stream.ts).
// The browser primes its stores from them before `run()` (main.tsx `primeFromDocument`), so the
// hydrating tree reads exactly what the server rendered from.
//
// The entry id is explicit, never `import.meta.url`: under `bun build --compile` that is no file URL
// (research note 08, trap 10.4). main.tsx maps it to this module through a registry.
import { clientEntry, type Handle, type RemixNode } from "remix/component";
import { createMultiMatcher } from "remix/route-pattern/match";

import { paneScopeKey } from "@web/lib/scope";
import type { BridgeConfig, PaneReadResponse, SnapshotResponse } from "@web/lib/types";

import { address } from "./lib/data";
import { HomeRoute } from "./routes/home/home";
import { PaneRoute } from "./routes/pane/pane";
import { routes } from "./routes";
import { Shell } from "./shell";

export const APP_ROOT_ENTRY = "collie:app#AppRoot";

export interface AppRootProps {
  /** The page's path and query, mount taken off (the router's `context.url`). */
  path: string;
  /** The origin the server saw; the browser builds its URL on its own origin instead. */
  origin: string;
  /** The `/api/snapshot` body for this page's scope, as the poll would have read it. */
  snapshot: SnapshotResponse;
  /** When the bridge built that body (epoch ms): the freshness readers' `snapshotAt`. */
  snapshotAt: number;
  /** The `/api/config` body. */
  config: BridgeConfig;
  /**
   * A pane document's pane read and its ETag (S2): the frames are drawn from it, and the browser primes
   * the pane's store and the frames' ETag from it, so the first beat answers 304 when nothing moved.
   */
  pane?: { read: PaneReadResponse; etag: string | null; frames: boolean };
}

/** The routes a server document exists for. Every other path gets the static shell. */
type AppRoute = { kind: "home" } | { kind: "pane"; paneId: string };

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

/** The home route's node. router.tsx's home action draws this. */
export function homeNode(): RemixNode {
  return <HomeRoute />;
}

/**
 * The pane route's node, keyed by its entity (REMIX3.md rule 3). The scope is the one `noteAddress`
 * read off this URL (the router's first middleware; on the server, the priming).
 */
export function paneNode(paneId: string): RemixNode {
  return <PaneRoute key={paneScopeKey(address.get().scope, paneId)} paneId={paneId} />;
}

/** The route node for a server-rendered route. */
export function appRouteNode(route: AppRoute): RemixNode {
  return route.kind === "home" ? homeNode() : paneNode(route.paneId);
}

/** The page's URL: the path the server rendered, on the origin this code runs on. */
export function appUrl(props: Pick<AppRootProps, "path" | "origin">): URL {
  const origin = "location" in globalThis ? globalThis.location.origin : props.origin;
  return new URL(props.path, origin);
}

export const AppRoot = clientEntry(APP_ROOT_ENTRY, function AppRoot(handle: Handle<AppRootProps>) {
  return () => {
    const url = appUrl(handle.props);
    const route = matchAppRoute(url);
    return <Shell url={url}>{route === null ? null : appRouteNode(route)}</Shell>;
  };
});
