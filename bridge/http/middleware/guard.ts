// The browser's gate, as a function a caller holds and as an action middleware.
//
// `guard()` (server.ts) is the browser's whole authorisation story: `checkAccess` (host allowlist,
// same-origin, Tailscale identity) plus, for a write, the device header AND the pairing credential.
// It is CALLED here, never re-spelled: {@link browserGate} is the one expression, and both the
// session-scoped routes (through `browserCaller` in ../scope.ts) and every route below that is gated
// as its first act (through {@link gate}) reach it.

import type { Middleware } from "remix/router";
import type { Config } from "../../config.ts";
import type { GateLevel } from "../../crew/peer-gate.ts";
import { guard, type PairingGate } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";

/** The browser's gate for one request, at whichever level a route asks. */
export function browserGate(
  req: Request,
  cfg: Config,
  pairing: PairingGate | undefined,
): (level: GateLevel) => Response | null {
  return (level: GateLevel): Response | null => guard(req, cfg, level, pairing);
}

/**
 * Gate an action at `level` before it runs. Only for a route whose old handler opened with exactly
 * this gate; a route that answers something first (a 503 when pairing is off, a 405 for a wrong
 * method) keeps its gate inline, in the order it always had.
 */
export function gate(deps: BridgeHttp, level: GateLevel): Middleware {
  return (context, next) => browserGate(context.request, deps.cfg, deps.pairing)(level) ?? next();
}
