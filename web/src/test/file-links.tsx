import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";

import { FileLinksProvider, usePaneFileLinks, type FileLinkOpener } from "@/components/file-links";
import { resolveFilePathLink } from "@/lib/file-paths";
import { asJsonString, parseJsonObject } from "@/lib/json";
import { filesPath } from "@/lib/nav";

/**
 * An opener as the pane screen builds one (ADR 0088), for pane `w1:p1` with its root and cwd at
 * `root` and home at `/home/you`, that records each tap's address in `opened` instead of navigating.
 * Every path that resolves is taken to exist: the existence check is tested through
 * {@link PaneFileLinks}.
 */
export function testFileOpener(opened: string[], root = "/home/you/webapp"): FileLinkOpener {
  return ({ path, line }) => {
    const rel = resolveFilePathLink({ path, root, cwd: root, home: "/home/you" });
    if (rel === null) return null;
    const href = filesPath("w1:p1", undefined, line === undefined ? { path: rel } : { path: rel, line });
    return { href, onOpen: () => opened.push(href) };
  };
}

const PANE = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/you/webapp" };
const PANES = [PANE];
const WORKSPACES = [{ workspaceId: "w1" }];

/**
 * The pane screen's real opener, existence check included, for pane `w1:p1` in `/home/you/webapp`.
 * Needs a router around it (`useNav`) and {@link paneLinkHandlers} on the MSW server.
 */
export function PaneFileLinks({ children }: { children: ReactNode }) {
  const opener = usePaneFileLinks({ paneId: "w1:p1", pane: PANE, panes: PANES, workspaces: WORKSPACES });
  return <FileLinksProvider value={opener}>{children}</FileLinksProvider>;
}

/**
 * Home for the opener, and an existence route that says yes to `existing` and records each request's
 * `paths` in `asked`, one array per request.
 */
export function paneLinkHandlers(existing: readonly string[], asked: string[][]) {
  return [
    http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: "/home/you" })),
    http.post(/\/api\/pane\/[^/]+\/files\/exist$/, async ({ request }) => {
      const body = parseJsonObject(await request.text());
      const paths = Array.isArray(body?.paths) ? body.paths.map(asJsonString).filter((p): p is string => p !== undefined) : [];
      asked.push(paths);
      return HttpResponse.json({ exists: paths.filter((p) => existing.includes(p)) });
    }),
  ];
}
