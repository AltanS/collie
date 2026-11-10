import { asJsonBoolean, asJsonObject } from "../../web/src/lib/json.ts";
import type { GateLevel } from "../crew/peer-gate.ts";
import type { JsonValue } from "../json.ts";
import type { TricksSurface, SwitchAnswer, TapAnswer } from "./service.ts";

// The tricks routes' request halves (M94 slices 01 and 04), kept out of server.ts so that file only
// dispatches. The gate, the watch stamp and the response are server.ts's.
//
//   GET  /api/tricks?since=<rev>          → TricksReply (web/src/lib/tricks/schema.ts)
//   POST /api/tricks/<host>/<id>/tap      → TrickTapReply (`rid`, a tree receipt code), or 400 `tap-invalid`,
//                                         404 `unknown-host` / `unknown-trick`, 409 `request-id-reused`
//   POST /api/tricks/<host>/<id>/switch   → body `{ "on": boolean }`; the trick's WireTrickInfo as it now
//                                         reads, or 400 `switch-invalid`, 404 `unknown-host` / `unknown-trick`
//
// Both are this bridge's own for now: a host that is not this one is 404, and the crew merge is a
// later slice.

/**
 * The right each tricks route needs. Every intent (a tap, a decision's answer) and the switch need a
 * device key with the write right: a tap runs the program, and the switch changes what runs. The
 * list is read only. server.ts gates each route at its level here, so the requirement has one home.
 */
export const TRICKS_ROUTE_RIGHTS = {
  reply: "read",
  tap: "write",
  switch: "write",
} as const satisfies Readonly<Record<"reply" | "tap" | "switch", GateLevel>>;

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

/** Run a tap whose path matched server.ts's `TRICKS_TAP_ROUTE`: group 1 the host, group 2 the trick id. */
export async function tricksTapRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<TapAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  return await tricks.tap(host, id, body);
}

/** Run a switch whose path matched server.ts's `TRICKS_SWITCH_ROUTE`; the body is `{ "on": boolean }` and nothing else. */
export async function tricksSwitchRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<SwitchAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  const doc = asJsonObject(body);
  const on = asJsonBoolean(doc?.on);
  if (doc === undefined || on === undefined || Object.keys(doc).length !== 1) return { status: 400, body: { error: "switch-invalid" } };
  return await tricks.setSwitch(host, id, on);
}
