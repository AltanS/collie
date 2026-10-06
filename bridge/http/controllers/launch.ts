// Launchers: a launch is a `/api/workspace` create the operator pre-declared in `launchers.toml`,
// and the rows themselves come from the host that runs them. Session-scoped, so the same `?host=`
// forward (§5) reaches the peer's own file rather than the lead's.

import { createController } from "remix/router";
import { launch, launchersRoute } from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { routes } from "../routes.ts";
import type { SessionWiring } from "../scope.ts";

export function launchController(deps: BridgeHttp, wiring: SessionWiring) {
  const { operatorLaunchers } = deps;
  return createController(routes.launch, {
    actions: {
      async launch(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const denied = caller.gate("write");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        return launch(rt.herdr, rt.engine, req, caller.audit, caller.device(), rt.name, operatorLaunchers);
      },
      async launchers(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const denied = caller.gate("read");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        return launchersRoute(operatorLaunchers, req.headers.get("accept-encoding"));
      },
    },
  });
}
