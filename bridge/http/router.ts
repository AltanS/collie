// The two routers the bridge dispatches through, built once per `startServer`.
//
// THE FRONT DOOR (`createBridgeRouter`). Every request the crew surface did not answer. Its
// middleware runs in the order the old `fetch` closure ran its checks, before any route:
//
//   1. routedUrl     the URL server.ts already stripped of the mount (ADR 0052)
//   2. loopbackPeer  the peer-address check (ADR 0013)
//   3. accessJwt     the Access gate (ADR 0081)
//   4. deposedPage   a deposed collie's one page (CREW_PROTOCOL.md §18.12)
//   5. methodParity  HEAD on a GET-only route goes to the app shell, as it always did
//
// Then exactly one route answers (./routes.ts). The app shell matches every path and every method, so
// the router's own 404 and 405 are never produced.
//
// THE CREW'S SESSION ROUTER (`createSessionRouter`). Only the four session-scoped families, for a lead
// admitted through `/crew/v1/*`. None of the front door's middleware applies: the crew surface did its
// own admission, and the caller's gate is the peer's (`bridge/crew/peer-gate.ts`). A request none of
// its routes answers is "not a session route", which the crew dispatch turns into its own 404.

import type { RequestContext, Router } from "remix/router";
import { createRouter } from "remix/router";
import type { RouteCaller } from "../server.ts";
import { appController, appShell } from "./controllers/static.ts";
import { configController } from "./controllers/config.ts";
import { crewController } from "./controllers/crew-and-machines.ts";
import { healthAction } from "./controllers/health.ts";
import { launchController } from "./controllers/launch.ts";
import { notificationsController } from "./controllers/notifications.ts";
import { pairingController } from "./controllers/pairing.ts";
import { paneController } from "./controllers/pane.ts";
import { snapshotAction } from "./controllers/snapshot.ts";
import { sttAction } from "./controllers/stt.ts";
import { tabController } from "./controllers/tab.ts";
import { updateController } from "./controllers/update.ts";
import { workspaceController } from "./controllers/workspace.ts";
import type { BridgeHttp } from "./deps.ts";
import { accessJwt } from "./middleware/access.ts";
import { deposedPage } from "./middleware/deposed.ts";
import { loopbackPeer } from "./middleware/loopback-peer.ts";
import { methodParity } from "./middleware/method-parity.ts";
import { dispatchRouted, rawPathMatcher, routedUrl } from "./middleware/raw-path.ts";
import { routes, sessionRoutes } from "./routes.ts";
import { browserCaller, type SessionWiring } from "./scope.ts";

/** Map the four session-scoped families onto `router`, wired to one kind of caller. */
function mapSessionRoutes(router: Router, deps: BridgeHttp, wiring: SessionWiring): void {
  router.map(routes.pane, paneController(deps, wiring));
  router.map(routes.tab, tabController(wiring));
  router.map(routes.workspace, workspaceController(deps, wiring));
  router.map(routes.launch, launchController(deps, wiring));
}

export function createBridgeRouter(deps: BridgeHttp): Router {
  const shell = appShell(deps);
  const router = createRouter({
    matcher: rawPathMatcher(),
    defaultHandler: shell,
    middleware: [
      routedUrl(),
      loopbackPeer(deps),
      accessJwt(deps),
      deposedPage(deps.opts),
      methodParity(routes, shell),
    ],
  });
  router.map(routes.health, healthAction(deps));
  router.map(routes.snapshot, snapshotAction(deps));
  mapSessionRoutes(router, deps, {
    callerOf: (context) => browserCaller(deps, context.request, context.url),
    fallThrough: shell,
  });
  router.map(routes.config, configController(deps));
  router.map(routes.notifications, notificationsController(deps));
  router.map(routes.update, updateController(deps));
  router.map(routes.stt, sttAction(deps));
  router.map(routes.pairing, pairingController(deps));
  router.map(routes.crew, crewController(deps, shell));
  router.map(routes.app, appController(deps));
  return router;
}

/** What the crew's session router answers for a request that is not a session route. */
const NOT_A_SESSION_ROUTE = new Response(null, { status: 404 });
const crewCallers = new WeakMap<Request, RouteCaller>();

/** The session-scoped families alone, for the crew dispatch. See {@link serveSession}. */
export function createSessionRouter(deps: BridgeHttp): Router {
  const notMine = (_context: RequestContext): Response => NOT_A_SESSION_ROUTE;
  const router = createRouter({
    matcher: rawPathMatcher(),
    defaultHandler: notMine,
    middleware: [routedUrl(), methodParity(sessionRoutes, notMine)],
  });
  mapSessionRoutes(router, deps, {
    callerOf: (context) => {
      const caller = crewCallers.get(context.request);
      // `serveSession` sets the caller before it dispatches; a request without one never reaches here.
      if (caller === undefined) throw new Error("session route dispatched without a caller");
      return caller;
    },
    fallThrough: notMine,
  });
  router.route("ANY", "/*path", notMine);
  return router;
}

/**
 * Answer a session-scoped request for `caller`, or `null` when `url` is not a session route — the
 * contract `serveSessionRoute` has always had (server.ts).
 */
export async function serveSession(
  router: Router,
  req: Request,
  url: URL,
  caller: RouteCaller,
): Promise<Response | null> {
  crewCallers.set(req, caller);
  const answer = await dispatchRouted(router, req, url);
  return answer === NOT_A_SESSION_ROUTE ? null : answer;
}
