// Tabs: create (a fresh shell pane in a new tab), rename and close. Session-scoped, answered for a
// browser and for a crew lead by these same actions (CREW_PROTOCOL.md §5).

import { createController, type RequestContext } from "remix/router";
import { closeTab, createTab, renameTab, type RouteCaller } from "../../server.ts";
import { routes } from "../routes.ts";
import type { SessionWiring } from "../scope.ts";

/** ── Tab actions: rename (set its label) / close (kill it + every pane in it) ── */
async function tabRoute(
  caller: RouteCaller,
  req: Request,
  rawTabId: string,
  tabAction: "rename" | "close",
): Promise<Response> {
  const denied = caller.gate("write");
  if (denied) return denied;
  const rt = await caller.resolve();
  if (rt instanceof Response) return rt;
  const tabId = decodeURIComponent(rawTabId);
  const action = tabAction;
  const device = caller.device();
  if (action === "close") return closeTab(rt.herdr, rt.engine, tabId, req, caller.audit, device, rt.name);
  return renameTab(rt.herdr, rt.engine, tabId, req, caller.audit, device, rt.name);
}

export function tabController(wiring: SessionWiring) {
  const tab =
    (tabAction: "rename" | "close") =>
    (context: RequestContext<{ tabId: string }>): Promise<Response> =>
      tabRoute(wiring.callerOf(context), context.request, context.params.tabId, tabAction);

  return createController(routes.tab, {
    actions: {
      // ── Structural creates: new tab (opens a fresh shell pane) ──
      async create(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const denied = caller.gate("write");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        return createTab(rt.herdr, rt.engine, req, caller.audit, caller.device(), rt.name);
      },
      rename: tab("rename"),
      close: tab("close"),
    },
  });
}
