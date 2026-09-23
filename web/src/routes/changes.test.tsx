import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHANGES_POLL_MS } from "@/hooks/use-visible-interval";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { PaneChangesResponse } from "@/lib/types";
import { fixtureAgents, fixtureChangeDiff, fixtureChanges } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { ChangesRoute } from "./changes";

const connected = (): HomeData => ({
  bridge: "connected",
  agents: fixtureAgents,
  shellPanes: [],
  workspaces: [],
  tabs: [],
  device: undefined,
  sessions: [],
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function renderAt(url: string, onCommit?: () => void) {
  const view = onCommit ? (
    <Profiler id="changes" onRender={onCommit}>
      <ChangesRoute />
    </Profiler>
  ) : (
    <ChangesRoute />
  );
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => connected(),
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div /> },
          { path: "pane/:paneId", element: <div>pane screen</div> },
          { path: "pane/:paneId/changes", element: view },
          { path: "space/:spaceId", element: <div>space screen</div> },
          { path: "space/:spaceId/changes", element: <ChangesRoute /> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => localStorage.clear());

describe("ChangesRoute — the list", () => {
  it("groups files by repo and names each repo when there are two", async () => {
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(screen.getByText("api · 2 files")).toBeTruthy();
    const api = screen.getByRole("region", { name: "api" });
    expect(within(api).getByText("orders.ts")).toBeTruthy();
    expect(within(api).getByText("server/handlers/")).toBeTruthy();
    expect(within(api).getByText(en["changes.status.untracked"])).toBeTruthy();
    expect(screen.getByText(en["changes.binaryShort"])).toBeTruthy();
  });

  it("names the workspace and its folder in the header", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ ...fixtureChanges, workspaceLabel: "collie-workspace", root: "/home/you/projects/collie-workspace" }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("collie-workspace")).toBeTruthy();
    const folder = screen.getByText("…/projects/collie-workspace");
    expect(folder.getAttribute("title")).toBe("/home/you/projects/collie-workspace");
  });

  it("the space form asks by workspace, shows the same list, and goes back to the space", async () => {
    const asked: string[] = [];
    server.use(
      // Records the ask and falls through to the shared handler, which answers list and diff.
      http.get(/\/api\/workspace\/[^/]+\/changes/, ({ request }) => {
        asked.push(new URL(request.url).pathname);
      }),
    );
    const router = renderAt("/space/w1/changes");
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(asked[0]).toBe("/api/workspace/w1/changes");
    await userEvent.click(await screen.findByRole("button", { name: /checkout\.tsx/ }));
    expect(router.state.location.pathname).toBe("/space/w1/changes");
    expect(router.state.location.search).toBe("?repo=.&path=src%2Froutes%2Fcheckout.tsx");
    // `find`, not `get`: the router commits a navigation as a transition, which a busy run can
    // still be rendering when the click resolves.
    await userEvent.click(await screen.findByRole("button", { name: en["changes.listBackAria"] }));
    await userEvent.click(await screen.findByRole("button", { name: en["changes.backSpaceAria"] }));
    expect(await screen.findByText("space screen")).toBeTruthy();
  });

  it("explains a workspace that is gone", async () => {
    server.use(
      http.get(/\/api\/workspace\/[^/]+\/changes/, () =>
        HttpResponse.json({ workspaceId: "w9", available: false, reason: "no-workspace" }),
      ),
    );
    renderAt("/space/w9/changes");
    expect(await screen.findByText(en["changes.unavailable.noWorkspace"])).toBeTruthy();
  });

  it("hides the repo heading when only one repo has changes", async () => {
    const one: PaneChangesResponse = fixtureChanges.available
      ? { ...fixtureChanges, repos: fixtureChanges.repos.slice(0, 1) }
      : fixtureChanges;
    server.use(http.get(/\/api\/pane\/[^/]+\/changes/, () => HttpResponse.json(one)));
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("checkout.tsx")).toBeTruthy();
    expect(screen.queryByText(/webapp ·/)).toBeNull();
  });

  it("says so when nothing changed, and when the pane has no folder", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: true, root: "/x", repos: [], truncated: false }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(en["changes.empty"])).toBeTruthy();
  });

  it("explains a pane with no folder", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-folder" }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(en["changes.unavailable.noFolder"])).toBeTruthy();
  });

  it("sends the depth and nested choices from Settings, and refetches on refresh", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesNested: false, changesDepth: 3 }));
    const seen: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(fixtureChanges);
      }),
    );
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    expect(seen).toEqual(["?depth=3&nested=0"]);
    await userEvent.click(screen.getByRole("button", { name: en["changes.refreshAria"] }));
    await waitFor(() => expect(seen).toHaveLength(2));
  });
});

/**
 * A diff line by its text, plain or coloured. A coloured line is several token spans, so the text is
 * no single node's own: match the innermost element that reads the whole line, minus the sign a
 * screen reader hears and the indent.
 */
const diffLine = (text: string) => {
  const reads = (el: Element) => (el.textContent ?? "").replace(/^[+−] /, "").trim() === text;
  return (_: string, el: Element | null) => el !== null && reads(el) && ![...el.children].some(reads);
};

describe("ChangesRoute — one file", () => {
  it("opens a file's diff, walks Next across repos, and goes back to the list", async () => {
    const router = renderAt("/pane/w1%3Ap1/changes");
    await userEvent.click(await screen.findByRole("button", { name: /checkout\.tsx/ }));
    expect(await screen.findByText(diffLine("const total = cartTotal(cart.items);"))).toBeTruthy();
    expect(router.state.location.search).toBe("?repo=.&path=src%2Froutes%2Fcheckout.tsx");
    // First file: Previous is disabled, never hidden.
    expect(screen.getByRole("button", { name: /Previous file/ }).hasAttribute("disabled")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /Next file/ }));
    expect(await screen.findByText(diffLine("export function cartTotal(items: { price: number }[]): number {"))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next file/ }));
    expect(await screen.findByText(en["changes.file.binary"])).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Next file/ }));
    // Across the repo boundary, into `packages/api`, and the rename names where it came from.
    expect(await screen.findByText("Renamed from server/orders.ts")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: en["changes.listBackAria"] }));
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(router.state.location.search).toBe("");
  });

  it("a deep link to a file still gets Previous / Next once the list lands", async () => {
    renderAt("/pane/w1%3Ap1/changes?repo=packages%2Fapi&path=notes.md");
    expect(await screen.findByText(diffLine("Orders moved under handlers/."))).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Previous file/ }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("button", { name: /Next file/ }).hasAttribute("disabled")).toBe(true);
  });
});

// ADR 0065 rule 8, the operator's ask (2026-09-23): while a Changes screen is open and the page is
// visible, it re-reads every CHANGES_POLL_MS on its own. Only the interval is faked, so MSW and
// Testing Library keep their real timeouts.
describe("ChangesRoute — re-reading while open", () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };
  const tick = () =>
    act(() => {
      vi.advanceTimersByTime(CHANGES_POLL_MS);
    });
  const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

  /** Counts list reads (not diff reads) and answers each with whatever `answer()` returns now. */
  function countLists(answer: () => Response | Promise<Response> = () => HttpResponse.json(fixtureChanges)) {
    const reads = { list: 0, diff: 0 };
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        const q = new URL(request.url).searchParams;
        if (q.has("path")) {
          reads.diff++;
          return undefined;
        }
        reads.list++;
        return answer();
      }),
    );
    return reads;
  }

  afterEach(() => {
    vi.useRealTimers();
    visibility = "visible";
  });

  it("re-reads the list every 5 s without a tap", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reads = countLists();
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    expect(reads.list).toBe(1);
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(2));
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(3));
  });

  it("never stacks a read on one still in flight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release!: () => void;
    let held = false;
    const reads = countLists(() => {
      if (!held) return HttpResponse.json(fixtureChanges);
      return new Promise<Response>((resolve) => {
        release = () => resolve(HttpResponse.json(fixtureChanges));
      });
    });
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    held = true;
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(2));
    tick();
    tick();
    await settle();
    expect(reads.list).toBe(2);
    release();
    await settle();
    held = false;
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(3));
  });

  it("stops while the page is hidden and reads once at once when it comes back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reads = countLists();
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    setVisibility("hidden");
    tick();
    tick();
    tick();
    await settle();
    expect(reads.list).toBe(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(reads.list).toBe(2));
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(3));
  });

  it("a re-read with the same answer commits nothing; a changed one shows without a tap", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let answer: PaneChangesResponse = fixtureChanges;
    const reads = countLists(() => HttpResponse.json(answer));
    let commits = 0;
    renderAt("/pane/w1%3Ap1/changes", () => commits++);
    await screen.findByText("checkout.tsx");
    await settle();
    const before = commits;
    const row = screen.getByRole("button", { name: /checkout\.tsx/ });
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(2));
    await settle();
    expect(commits).toBe(before);
    expect(screen.getByRole("button", { name: /checkout\.tsx/ })).toBe(row);

    answer = fixtureChanges.available
      ? { ...fixtureChanges, repos: fixtureChanges.repos.slice(0, 1) }
      : fixtureChanges;
    tick();
    await vi.waitFor(() => expect(screen.queryByText(/api · 2 files/)).toBeNull());
    expect(commits).toBeGreaterThan(before);
  });

  it("a file that stops being changed says so in place and keeps its diff", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let gone = false;
    const reads = { diff: 0 };
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        const q = new URL(request.url).searchParams;
        const repo = q.get("repo");
        const path = q.get("path");
        const without: PaneChangesResponse = fixtureChanges.available
          ? {
              ...fixtureChanges,
              repos: fixtureChanges.repos.map((r) => ({ ...r, files: r.files.filter((f) => f.path !== "src/lib/cart.ts") })),
            }
          : fixtureChanges;
        if (repo === null || path === null) return HttpResponse.json(gone ? without : fixtureChanges);
        reads.diff++;
        if (gone) return HttpResponse.json({ paneId: "w1:p1", available: false, reason: "unknown-path" });
        return HttpResponse.json(fixtureChangeDiff(repo, path));
      }),
    );
    const router = renderAt("/pane/w1%3Ap1/changes?repo=.&path=src%2Flib%2Fcart.ts");
    const line = "export function cartTotal(items: { price: number }[]): number {";
    // Read off the diff's text, not one node: syntax colour may split the line into spans.
    const diffText = () => document.querySelector('[data-slot="diff"]')?.textContent ?? "";
    await vi.waitFor(() => expect(diffText()).toContain(line));
    // Wait for the list too, so Previous / Next know where the file sits.
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /Previous file/ }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByText(en["changes.file.gone"])).toBeNull();

    gone = true;
    tick();
    expect(await screen.findByText(en["changes.file.gone"])).toBeTruthy();
    expect(reads.diff).toBe(2);
    // Still here, on the same file, with the diff it had and both neighbours.
    expect(diffText()).toContain(line);
    expect(router.state.location.search).toBe("?repo=.&path=src%2Flib%2Fcart.ts");
    expect(screen.getByRole("button", { name: /Previous file/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: /Next file/ }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps the last list through failed re-reads, and says so only after two in a row", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let failing = false;
    const reads = countLists(() =>
      failing ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(fixtureChanges),
    );
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    failing = true;
    tick();
    await vi.waitFor(() => expect(reads.list).toBe(2));
    await settle();
    expect(screen.queryByText(en["changes.stale"])).toBeNull();
    expect(screen.getByText("checkout.tsx")).toBeTruthy();
    tick();
    expect(await screen.findByText(en["changes.stale"])).toBeTruthy();
    expect(screen.getByText("checkout.tsx")).toBeTruthy();
    expect(screen.queryByText(en["changes.error"])).toBeNull();
    failing = false;
    tick();
    await vi.waitFor(() => expect(screen.queryByText(en["changes.stale"])).toBeNull());
  });
});
