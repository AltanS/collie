// The Access gate (#341, ADR 0081): after the crew surface (its own admission) and the peer check,
// before the deposed page and every route. `/api/health` and local callers are exempt inside it.
//
// ADR 0081 says the gate checks every request, including each poll, because the bridge holds no
// stream open. A WebSocket upgrade or an event stream would be checked once, at connect, and keep
// running past the token's expiry: adding one must revisit the ADR.

import type { Middleware } from "remix/router";
import type { BridgeHttp } from "../deps.ts";

export function accessJwt(deps: BridgeHttp): Middleware {
  const { accessGate } = deps;
  return async (context, next) => {
    const req = context.request;
    const { pathname } = context.url;
    if (accessGate) {
      const denied = await accessGate.admit(req, pathname);
      if (denied) return denied;
    }
    return next();
  };
}
