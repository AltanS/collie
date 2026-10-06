// Spaces: create, the Changes and Files views asked by workspace (ADR 0065, ADR 0083), worktrees
// (ADR 0032), and this machine's folder list for the new-space sheet (#289). Session-scoped, answered
// for a browser and for a crew lead by these same actions (CREW_PROTOCOL.md §5).

import { createController, type RequestContext } from "remix/router";
import {
  createWorkspace,
  createWorktree,
  filesPrivateFolders,
  listWorktrees,
  openWorktree,
  serveFolderRoute,
  workspaceChanges,
  workspaceFiles,
  type RouteCaller,
} from "../../server.ts";
import type { BridgeHttp } from "../deps.ts";
import { text } from "../respond.ts";
import { routes } from "../routes.ts";
import type { SessionWiring } from "../scope.ts";

/** ── Worktrees: create / open, scoped to a space (ADR 0032) ── */
async function worktreeRoute(
  caller: RouteCaller,
  req: Request,
  rawWorkspaceId: string,
  worktreeAction: "open" | undefined,
): Promise<Response> {
  const denied = caller.gate("write");
  if (denied) return denied;
  const rt = await caller.resolve();
  if (rt instanceof Response) return rt;
  const spaceId = decodeURIComponent(rawWorkspaceId);
  const action = worktreeAction;
  const device = caller.device();
  if (action === "open") {
    return openWorktree(rt.herdr, rt.engine, spaceId, req, caller.audit, device, rt.name);
  }
  return createWorktree(rt.herdr, rt.engine, spaceId, req, caller.audit, device, rt.name);
}

export function workspaceController(deps: BridgeHttp, wiring: SessionWiring) {
  const { cfg, folders } = deps;

  const worktree =
    (worktreeAction?: "open") =>
    (context: RequestContext<{ workspaceId: string }>): Promise<Response> =>
      worktreeRoute(wiring.callerOf(context), context.request, context.params.workspaceId, worktreeAction);

  /**
   * The folder list and a star on one of its folders, through `serveFolderRoute`. It answers both
   * paths these routes match, so the fall-through is never taken; the helper's type allows "not mine".
   */
  const folderRoute = async (context: RequestContext): Promise<Response> => {
    const caller = wiring.callerOf(context);
    const req = context.request;
    const { pathname } = context.url;
    const folderAnswer = await serveFolderRoute(req, pathname, caller, folders);
    return folderAnswer ?? wiring.fallThrough(context);
  };

  return createController(routes.workspace, {
    actions: {
      // ── Structural creates: new space (opens a fresh shell pane) ──
      async create(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const denied = caller.gate("write");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        return createWorkspace(rt.herdr, rt.engine, req, caller.audit, caller.device(), rt.name, folders);
      },
      // ── Changes, asked by workspace (ADR 0065): the list every pane of the space shows ──
      async changes(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const url = context.url;
        const denied = caller.gate("read");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(context.params.workspaceId);
        } catch {
          return text("malformed URL", 400);
        }
        return workspaceChanges(rt.engine, workspaceId, url, req);
      },
      // ── Files, asked by workspace (ADR 0083): one folder or one file under the same root ──
      async files(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const url = context.url;
        const denied = caller.gate("device-read");
        if (denied) return denied;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(context.params.workspaceId);
        } catch {
          return text("malformed URL", 400);
        }
        return workspaceFiles(rt.engine, workspaceId, url, req, filesPrivateFolders(cfg));
      },
      // ── Worktrees: the listing ──
      async worktrees(context) {
        const caller = wiring.callerOf(context);
        const req = context.request;
        const rt = await caller.resolve();
        if (rt instanceof Response) return rt;
        return listWorktrees(rt.herdr, rt.engine, decodeURIComponent(context.params.workspaceId), req);
      },
      worktree: worktree(),
      worktreeOpen: worktree("open"),
      folders: folderRoute,
      folderStar: folderRoute,
    },
  });
}
