// The app: the path reserved for a fronting proxy's sign-in page, then the PWA with its SPA fallback.
// One action for all three routes, and the catch-all for every request no other route took — which
// includes every wrong method on a known path, as in the old dispatch.

import type { RequestContext } from "remix/router";
import { createController } from "remix/router";
import { buildId, isReservedAuthPath, reservedAuthPlaceholder, serveStatic, WEB_DIR } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { routes } from "../routes.ts";
import { documentDeps, loadShellRenderer, serveDocument } from "./document.ts";
import { frameDeps, serveFrame } from "./frames.ts";

/** The catch-all: the reserved `/auth/` placeholder, or a file out of `web/dist`, or the app shell. */
export function appShell(deps: BridgeHttp): (context: RequestContext) => Promise<Response> {
  const { cfg } = deps;
  const documents = documentDeps(deps);
  const frames = frameDeps(deps, () => loadShellRenderer(), buildId);
  return async ({ request: req, url }) => {
    const { pathname } = url;
    // ── Reserved for a fronting proxy's sign-in page ─────────────────────
    // `/auth/` is the one path the service worker always passes to the network (web/src/lib/
    // sw-routes.ts), so it is the only address an installed PWA can reach when a proxy in front of
    // the bridge refuses a stale session. Collie never routes it. If a request gets this far, no
    // proxy claimed it — say so, instead of letting the SPA fallback answer with the app shell and
    // leave the operator staring at the UI they were trying to escape.
    if (isReservedAuthPath(pathname)) return reservedAuthPlaceholder();

    // ── The pane's server frames (S2): a named-frame request on `/pane/:paneId` ──
    // Answered here and never by the document or the static shell below (./frames.ts).
    const frame = await serveFrame(frames, req, url);
    if (frame !== null) return frame;

    // ── The server document (S1): `/` and `/pane/:paneId` for a request that may read the snapshot ──
    // Null for everything else, and then the static shell answers exactly as before (./document.ts).
    const document = await serveDocument(documents, req, url);
    if (document !== null) return document;

    // ── Static PWA (with SPA fallback) ───────────────────────────────────
    return serveStatic(pathname, req.headers.get("accept-encoding"), WEB_DIR, cfg.basePath);
  };
}

export function appController(deps: BridgeHttp) {
  const shell = appShell(deps);
  return createController(routes.app, {
    actions: { auth: shell, authBelow: shell, shell },
  });
}
