import { extname } from "node:path";

import type { MathPackStatus, MathPackStore } from "./store.ts";
import { isPackPath } from "./tar.ts";

// ── THE MATH PACK'S ROUTES, AWAY FROM Bun.serve (ADR 0132) ─────────────────────────────────
//
//   GET    /api/math   read   the pack's state on this host; fetches nothing
//   POST   /api/math   write  start the download, or join the one in flight
//   DELETE /api/math   write  stop a download and remove every pack in the state dir
//   GET    /math/*            the engines' files, from the store, else from the source build
//
// Shaped like the Whistle routes (bridge/stt/whistle-http.ts): server.ts does the gating and the audit
// line, and everything the routes decide lives here so `bun test` can drive it. None is forwarded:
// none is in the crew's FORWARDABLE list and none reads `?host=`. The lead serves the web app, so the
// lead serves the engines; a crew member answers about its own store.
//
// Every answer to the three API routes is the status itself, so Settings reads one shape whatever
// happened: 202 while a download runs, 200 when it is done or removed, 409 when this build has no
// download to offer (a development build, or a release with no pack).

/** What a math route answered, and the words for its audit line. Never a path. */
export interface MathRouteResult {
  response: Response;
  attempt: { status: number; outcome: string };
}

function json(body: MathPackStatus, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** `GET /api/math`. */
export async function mathGet(store: MathPackStore): Promise<Response> {
  return json(await store.status(), 200);
}

/** `POST /api/math`. */
export async function mathStart(store: MathPackStore): Promise<MathRouteResult> {
  const { outcome, status } = await store.start();
  const code = outcome === "unavailable" ? 409 : outcome === "ready" ? 200 : 202;
  return { response: json(status, code), attempt: { status: code, outcome } };
}

/** `DELETE /api/math`. */
export async function mathRemove(store: MathPackStore): Promise<MathRouteResult> {
  return { response: json(await store.remove(), 200), attempt: { status: 200, outcome: "removed" } };
}

/**
 * The folder a `/math/*` request is served from, or null for a 404. `pathname` is the mount-stripped
 * request path. A path with no extension is never an engine file, and must not reach the static
 * server's app-shell fallback: a missing engine is an error the engine loader turns into source text.
 */
export function mathServeRoot(store: Pick<MathPackStore, "serveRoot">, pathname: string): string | null {
  // Held to the pack's own name rule, so a path that skipped the URL parser's dot folding (`..`), or
  // that names the store's `pack.json` beside `math/`, is a 404 before any file is looked at.
  if (!pathname.startsWith("/math/") || extname(pathname) === "" || !isPackPath(pathname.slice(1))) return null;
  return store.serveRoot();
}
