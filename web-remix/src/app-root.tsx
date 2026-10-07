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

import { paneScopeKey } from "@web/lib/scope";

import { address } from "./lib/data";
import { matchAppRoute, type AppRoute } from "./lib/app-route";
import type { DocumentProps } from "./lib/document-props";
import { documentSeed } from "./lib/identity-seed";
import { onServer } from "./lib/server-render";
import { scheduleUpdate } from "./lib/store";
import { HomeRoute } from "./routes/home/home";
import { PaneRoute } from "./routes/pane/pane";
import { Shell } from "./shell";

export const APP_ROOT_ENTRY = "collie:app#AppRoot";

export { matchAppRoute };

export type AppRootProps = DocumentProps;

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
  let checkedPath = handle.props.path;
  return () => {
    // IDENTITY GUARD (lib/identity-seed.ts). This instance keeps its setup when the runtime hands it
    // the props of another pane; the stores must follow the identity, not the first page. Checked
    // after commit (a render never writes a store), and only when the path moved: the boot seeded the
    // first one (main.tsx). Not on the server, which primes its own stores per request.
    const path = handle.props.path;
    if (path !== checkedPath && !onServer()) {
      checkedPath = path;
      handle.queueTask(() => {
        if (documentSeed.ensure(handle.props)) scheduleUpdate(handle);
      });
    }
    const url = appUrl(handle.props);
    const route = matchAppRoute(url);
    return <Shell url={url}>{route === null ? null : appRouteNode(route)}</Shell>;
  };
});
