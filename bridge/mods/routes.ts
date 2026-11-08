import type { JsonValue } from "../json.ts";
import type { ModsSurface, TapAnswer } from "./service.ts";

// The two mods routes' request halves (M94 slice 01), kept out of server.ts so that file only
// dispatches. The gate, the watch stamp and the response are server.ts's.
//
//   GET  /api/mods?since=<rev>          → ModsReply (web/src/lib/mods/schema.ts)
//   POST /api/mods/<host>/<id>/tap      → ModTapReply, or 400 `tap-invalid` with the refusals,
//                                         404 `unknown-host` / `unknown-mod`, 409 `request-id-reused`
//
// Both are this bridge's own for now: a host that is not this one is 404, and the crew merge is a
// later slice.

/** `since` as a rev, or undefined (every part) when absent or not a whole number at or above 0. */
export function parseSince(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,16}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A path segment decoded, or null when it does not decode. */
function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Run a tap whose path matched server.ts's `MODS_TAP_ROUTE`: group 1 the host, group 2 the mod id. */
export async function modsTapRoute(mods: ModsSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<TapAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-mod" } };
  return await mods.tap(host, id, body);
}
