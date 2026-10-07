import { act, render, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { __resetConnectionHealth, latchLost } from "@/lib/connection-health";
import { paneLinkHandlers, PaneFileLinks } from "@/test/file-links";
import { server } from "@/test/setup";

import { FILE_EXIST_DEBOUNCE_MS, usePaneFileLinks } from "./file-links";
import { MarkdownText } from "./markdown-text";

// The pane screen's opener (ADR 0088): the root from the snapshot, home from the launchers answer,
// and a link only for a path the bridge said exists.

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/you/webapp/src" };
const other = { paneId: "w1:p2", workspaceId: "w1", cwd: "/home/you/webapp/docs" };
const panes = [pane, other];
const workspaces = [{ workspaceId: "w1" }];

/** Long enough for the debounce to fire and a request to come back. */
const settle = () => act(() => new Promise((r) => setTimeout(r, FILE_EXIST_DEBOUNCE_MS + 100)));

afterEach(() => __resetConnectionHealth());

describe("usePaneFileLinks", () => {
  it("is null until home is known, then opens a path under the root at its line once it exists", async () => {
    const asked: string[][] = [];
    server.use(...paneLinkHandlers(["src/lib/cart.ts", "README.md"], asked));
    const { result } = renderHook(() => usePaneFileLinks({ paneId: "w1:p1", pane, panes, workspaces }), { wrapper });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    // Not known yet: text, and the path is queued.
    expect(result.current!({ path: "lib/cart.ts", line: 7 })).toBeNull();
    expect(result.current!({ path: "~/webapp/README.md" })).toBeNull();
    expect(result.current!({ path: "/etc/hosts" })).toBeNull();
    await waitFor(() => expect(result.current!({ path: "lib/cart.ts", line: 7 })).not.toBeNull());
    const open = result.current!;
    expect(open({ path: "lib/cart.ts", line: 7 })?.href).toBe("/pane/w1%3Ap1/changes/files?path=src%2Flib%2Fcart.ts&line=7");
    expect(open({ path: "~/webapp/README.md" })?.href).toBe("/pane/w1%3Ap1/changes/files?path=README.md");
    // One request, each path once; a path outside the root is never asked.
    expect(asked).toEqual([["src/lib/cart.ts", "README.md"]]);
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

  it("an absent answer is kept: the same path is not asked again, a new one is", async () => {
    const asked: string[][] = [];
    server.use(...paneLinkHandlers([], asked));
    const { result } = renderHook(() => usePaneFileLinks({ paneId: "w1:p1", pane, panes, workspaces }), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    result.current!({ path: "lib/gone.ts" });
    await settle();
    result.current!({ path: "lib/gone.ts" });
    result.current!({ path: "lib/new.ts" });
    await settle();
    expect(asked).toEqual([["src/lib/gone.ts"], ["src/lib/new.ts"]]);
  });

  it("a route the bridge does not have (an older member) stops the asking, and nothing links", async () => {
    let calls = 0;
    server.use(
      http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: "/home/you" })),
      http.post(/\/files\/exist$/, () => {
        calls++;
        return HttpResponse.json({ error: "route_not_federated" }, { status: 501 });
      }),
    );
    const { result } = renderHook(() => usePaneFileLinks({ paneId: "w1:p1", pane, panes, workspaces }), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!({ path: "lib/a.ts" })).toBeNull();
    await settle();
    expect(result.current!({ path: "lib/b.ts" })).toBeNull();
    await settle();
    expect(calls).toBe(1);
  });
});

// The rendering rule, end to end through the real opener: plain text until the answer, then a link.
describe("chat prose with the existence check", () => {
  const chat = (text: string) =>
    render(
      <MemoryRouter>
        <PaneFileLinks>
          <MarkdownText text={text} />
        </PaneFileLinks>
      </MemoryRouter>,
    );

  it("three paths, two exist: two links and one plain chip; the request holds the three once", async () => {
    const asked: string[][] = [];
    server.use(...paneLinkHandlers(["src/cart.ts", "docs/guide.md"], asked));
    const { container } = chat("see `src/cart.ts`, `docs/guide.md` and `languages.ts`, then `src/cart.ts` again");
    // Before the answer every path is text.
    expect(container.querySelector("a")).toBeNull();
    await waitFor(() => expect(container.querySelectorAll("a")).toHaveLength(3));
    expect([...container.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["src/cart.ts", "docs/guide.md", "src/cart.ts"]);
    const plain = [...container.querySelectorAll("code")].filter((c) => c.closest("a") === null);
    expect(plain.map((c) => c.textContent)).toEqual(["languages.ts"]);
    expect(asked).toEqual([["src/cart.ts", "docs/guide.md", "languages.ts"]]);
  });

  it("offline (the connection-lost latch is set): no request, and every path stays text", async () => {
    const asked: string[][] = [];
    server.use(...paneLinkHandlers(["src/cart.ts"], asked));
    latchLost();
    const { container } = chat("see `src/cart.ts`");
    await settle();
    await settle();
    expect(container.querySelector("a")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("a failed request draws text and asks nothing more for a while", async () => {
    let calls = 0;
    server.use(
      http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: "/home/you" })),
      http.post(/\/files\/exist$/, () => {
        calls++;
        return HttpResponse.text("bad gateway", { status: 502 });
      }),
    );
    const { container, rerender } = chat("see `src/cart.ts`");
    await waitFor(() => expect(calls).toBe(1));
    rerender(
      <MemoryRouter>
        <PaneFileLinks>
          <MarkdownText text="see `src/cart.ts` and `src/other.ts`" />
        </PaneFileLinks>
      </MemoryRouter>,
    );
    await settle();
    expect(calls).toBe(1);
    expect(container.querySelector("a")).toBeNull();
  });
});
