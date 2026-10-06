// The Crew overview and every machine's load (ADR 0084). Front-door routes, never forwarded: a peer
// is not a front door (ADR 0013), and the lead keeps every machine's history and rules itself.

import { createController, type RequestContext } from "remix/router";
import { apiError } from "../../error-codes.ts";
import { guard, serveMachinesRoute } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { gate } from "../middleware/guard.ts";
import { json, jsonError } from "../respond.ts";
import { routes } from "../routes.ts";

export function crewController(
  deps: BridgeHttp,
  fallThrough: (context: RequestContext) => Response | Promise<Response>,
) {
  const { cfg, pairing, audit, whois, crewStatus, machines } = deps;
  /**
   * The three machine routes, through `serveMachinesRoute`, which answers a wrong method itself. It
   * answers every path these routes match, so the fall-through below is never taken; it is there
   * because the helper's type says "not mine" is possible.
   */
  const machinesRoute = async (context: RequestContext): Promise<Response> => {
    const req = context.request;
    const { pathname } = context.url;
    // ── Machines: every machine's load, kept by the lead (ADR 0084) ──────
    // Global routes, never forwardable: see `serveMachinesRoute`.
    const machinesAnswer = await serveMachinesRoute(
      req,
      pathname,
      {
        gate: (level) => guard(req, cfg, level, pairing),
        device: () => whois(req).device,
        audit: (entry) => audit.record(entry),
      },
      machines,
    );
    return machinesAnswer ?? fallThrough(context);
  };
  return createController(routes.crew, {
    actions: {
      status: {
        middleware: [gate(deps, "read")],
        handler({ request: req }) {
          // Read-level, exactly like `/api/devices` and `/api/config`: this is a report about machines
          // the operator already owns, and it drives nothing. Every field is a fact this process was
          // already holding — the route reads no disk, dials no member, and cannot start a call.
          // 404 for a solo instance AND for a peer, from one closure. A peer is not a front door
          // (ADR 0013), and a solo instance has no crew to describe — the phone's move is the same in
          // both cases, so the refusal is too. Not a 403: nothing was withheld, there is nothing here.
          const body = crewStatus?.() ?? null;
          if (body === null) {
            return jsonError(apiError("crew.not_lead"), 404, req.headers.get("accept-encoding"));
          }
          return json(body, req.headers.get("accept-encoding"));
        },
      },
      machines: machinesRoute,
      machineHistory: machinesRoute,
      machineAlerts: machinesRoute,
    },
  });
}
