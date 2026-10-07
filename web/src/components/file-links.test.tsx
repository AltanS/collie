import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";

import { usePaneFileLinks } from "./file-links";

// The pane screen's opener (ADR 0088): the root from the snapshot, home from the launchers answer.

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/you/webapp/src" };
const other = { paneId: "w1:p2", workspaceId: "w1", cwd: "/home/you/webapp/docs" };

describe("usePaneFileLinks", () => {
  it("is null until home is known, then opens a path under the root at its line", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: "/home/you" })));
    const { result } = renderHook(
      () => usePaneFileLinks({ paneId: "w1:p1", pane, panes: [pane, other], workspaces: [{ workspaceId: "w1" }] }),
      { wrapper },
    );
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    const open = result.current!;
    expect(open({ path: "lib/cart.ts", line: 7 })?.href).toBe("/pane/w1%3Ap1/changes/files?path=src%2Flib%2Fcart.ts&line=7");
    expect(open({ path: "~/webapp/README.md" })?.href).toBe("/pane/w1%3Ap1/changes/files?path=README.md");
    expect(open({ path: "/etc/hosts" })).toBeNull();
  });

  it("a pane whose root would be home gets no opener", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: "/home/you" })));
    const parked = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/you" };
    const { result } = renderHook(
      () => usePaneFileLinks({ paneId: "w1:p1", pane: parked, panes: [parked], workspaces: [] }),
      { wrapper },
    );
    // Give the launchers read time to land; the answer stays null.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
});
