import type { RegistryStatus, ThemeRegistryStore } from "./registry.ts";

// ── THE COMMUNITY THEME REGISTRY'S ROUTES, AWAY FROM Bun.serve (M59 spec 06) ──────────────────
//
//   GET   /api/themes/registry   read   this host's copy and its age; fetches nothing
//   POST  /api/themes/registry   write  fetch the registry once, or join the fetch in flight
//
// Shaped like the math pack's routes (bridge/math/http.ts): server.ts does the gating and the audit
// line, and what the routes decide lives here so `bun test` can drive it. Neither is forwarded:
// neither is in the crew's FORWARDABLE list and neither reads `?host=`. The lead serves the phone,
// so the lead holds the copy.
//
// Both answer the status itself, so the Browse sheet reads one shape whatever happened: 200 after a
// good fetch or a join, 502 when the fetch failed (the old copy rides along, with `error` set).

/** What a registry route answered, and the words for its audit line. Never a body or a path. */
export interface RegistryRouteResult {
  response: Response;
  attempt: { status: number; outcome: string; themes: number; dropped: number };
}

function json(body: RegistryStatus, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** `GET /api/themes/registry`. */
export async function themeRegistryGet(store: ThemeRegistryStore): Promise<Response> {
  return json(await store.status(), 200);
}

/** `POST /api/themes/registry`. */
export async function themeRegistryRefresh(store: ThemeRegistryStore): Promise<RegistryRouteResult> {
  const { outcome, status } = await store.refresh();
  const code = outcome === "fetched" || outcome === "joined" ? 200 : 502;
  return {
    response: json(status, code),
    attempt: { status: code, outcome, themes: status.themes.length, dropped: status.dropped },
  };
}
