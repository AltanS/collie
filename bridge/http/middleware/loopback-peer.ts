// The peer-address check: the first router middleware after the stripped URL is in place.
//
// It sits HERE — after the federated surface, which server.ts answers before the router is consulted,
// and before the front door — so that the exemption is granted by the surface that has its own
// admission rather than by a path literal this layer must never carry (solo-baseline.test.ts).
//
// Everything after it trusts headers a client writes (`Tailscale-User-Login`, COLLIE_DEVICE_HEADER,
// Origin/Host), which are only untamperable while the sole client is the local front door. A crew
// request is not that, and does not need to be: it was already admitted by pinned mutual TLS plus the
// crew secret and answered before this router ran (CREW_PROTOCOL.md §6, ADR 0013). A crew path the
// crew handler DECLINED reaches this router and is refused like any other remote caller.
// `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` turns the check off wholesale, which is what that flag has
// always meant.

import type { Middleware } from "remix/router";
import { isLoopbackPeer } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { text } from "../respond.ts";

export function loopbackPeer(deps: BridgeHttp): Middleware {
  const { cfg, requestIP } = deps;
  return (context, next) => {
    const req = context.request;
    if (!cfg.allowNonLoopbackBind && !isLoopbackPeer(requestIP(req)?.address)) {
      return text("non-loopback peer rejected", 403);
    }
    return next();
  };
}
