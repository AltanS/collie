import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHANGES_POLL_MS } from "@/hooks/use-visible-interval";
import { keepChangeCount, resetChangeCountCache } from "@/hooks/use-workspace-change-counts";
import { resetChangesListCache } from "@/lib/changes-list-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { NavState } from "@/lib/nav";
import type { PaneChangesResponse } from "@/lib/types";
import { summarizeChanges } from "@/lib/workspace-changes";
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

/** `state` seeds the entry's `location.state` — e.g. `{ from: "/" }`, as ADR 0067's `down()` would
 *  have written it — so a route test can pin what the back arrow's accessible name resolves to
 *  without driving a whole navigation to get there. */
function renderAt(url: string, onCommit?: () => void, state?: NavState) {
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
    { initialEntries: [state === undefined ? url : { pathname: url, state }] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  localStorage.clear();
  resetChangesListCache();
  resetChangeCountCache();
});

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
    await userEvent.click(await screen.findByRole("button", { name: en["changes.backAria.workspace"] }));
    expect(await screen.findByText("space screen")).toBeTruthy();
  });

  // ADR 0067: the header back arrow's accessible name says where it actually lands, computed by
  // the same parent resolution `nav.up()` itself runs — never a fixed guess per route form.
  describe("the back arrow names where it actually goes", () => {
    it("says pane when a pane opened it", async () => {
      renderAt("/pane/w1%3Ap1/changes", undefined, { from: "/pane/w1:p1" });
      expect(await screen.findByRole("button", { name: en["changes.backAria.pane"] })).toBeTruthy();
    });

    it("says dashboard when the dashboard's Changes tab opened it", async () => {
      renderAt("/space/w1/changes", undefined, { from: "/" });
      expect(await screen.findByRole("button", { name: en["changes.backAria.dashboard"] })).toBeTruthy();
    });

    it("says workspace with no dashboard behind it (a cold link, or the space itself)", async () => {
      renderAt("/space/w1/changes");
      expect(await screen.findByRole("button", { name: en["changes.backAria.workspace"] })).toBeTruthy();
    });
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

  it("marks the pane's own repo and scrolls it into view on the first answer only", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () => HttpResponse.json({ ...fixtureChanges, paneRepo: "packages/api" })),
    );
    renderAt("/pane/w1%3Ap1/changes");
    const api = await screen.findByRole("region", { name: "api" });
    expect(within(api).getByText(en["changes.thisPane"])).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "webapp" })).queryByText(en["changes.thisPane"])).toBeNull();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(api);
    // A re-read keeps the mark and moves nothing.
    await userEvent.click(screen.getByRole("button", { name: en["changes.refreshAria"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: en["changes.refreshAria"] }).hasAttribute("disabled")).toBe(false));
    expect(within(screen.getByRole("region", { name: "api" })).getByText(en["changes.thisPane"])).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
    scroll.mockRestore();
  });

  it("ends the list with one quiet note when a repo sits past the depth, linking to Settings", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () => HttpResponse.json({ ...fixtureChanges, depthLimited: true })),
    );
    const router = renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(/Stopped at 2 levels, with repos further down\./)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en["changes.bound.settings"] }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(router.state.location.hash).toBe("#changes");
  });

  it("shows the limit note instead of the depth note when the list was cut", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, () =>
        HttpResponse.json({ ...fixtureChanges, truncated: true, depthLimited: true }),
      ),
    );
    renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(en["changes.truncated"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["changes.bound.settings"] })).toBeNull();
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

// The first frame (the operator's ask, 2026-09-23): the header carries the tab's count line, seeded
// from the tab's kept answer, and the list waits on skeleton rows only when nothing is kept.
describe("ChangesRoute — the first frame", () => {
  const LOOKUP = { depth: 2, nested: true };
  const fixtureCount = summarizeChanges(fixtureChanges);

  /** Hold every list read of the space form until `release()`; diff reads fall through. */
  function holdLists() {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(/\/api\/workspace\/[^/]+\/changes/, async ({ request }) => {
        if (new URL(request.url).searchParams.has("path")) return undefined;
        await gate;
        return HttpResponse.json(fixtureChanges);
      }),
    );
    return () => act(() => release());
  }

  const headerLine = () => {
    const line = document.querySelector<HTMLElement>('[data-slot="header-row"] [data-slot="count-line"]');
    expect(line).not.toBeNull();
    return line!;
  };

  it("shows the tab's kept count in the header before the list answers, and keeps it when the answer agrees", async () => {
    expect(fixtureCount.kind).toBe("changed");
    keepChangeCount({ scope: {}, workspaceId: "w1" }, LOOKUP, fixtureCount);
    const release = holdLists();
    renderAt("/space/w1/changes");
    // The list is still on its skeleton.
    await waitFor(() => expect(document.querySelector('[data-slot="changes-skeleton"]')).not.toBeNull());
    expect(headerLine().dataset.state).toBe("still");
    expect(headerLine().textContent).toContain("5 files");
    const before = headerLine().innerHTML;
    await release();
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(document.querySelector('[data-slot="changes-skeleton"]')).toBeNull();
    expect(headerLine().innerHTML).toBe(before);
  });

  it("changes the seeded count in place when the list sums to another one", async () => {
    keepChangeCount({ scope: {}, workspaceId: "w1" }, LOOKUP, { kind: "changed", files: 9, added: 1, removed: 1 });
    const release = holdLists();
    renderAt("/space/w1/changes");
    await waitFor(() => expect(headerLine().textContent).toContain("9 files"));
    await release();
    await waitFor(() => expect(headerLine().textContent).toContain("5 files"));
    expect(headerLine().dataset.state).toBe("update");
  });

  it("with nothing kept, holds skeletons in header and list, then fades the answer in", async () => {
    const release = holdLists();
    renderAt("/space/w1/changes");
    await waitFor(() => expect(document.querySelector('[data-slot="changes-skeleton"]')).not.toBeNull());
    expect(headerLine().dataset.state).toBe("loading");
    expect(screen.getByText(en["changes.loading"])).toBeTruthy();
    await release();
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(headerLine().dataset.state).toBe("arrive");
    expect(document.querySelector('[data-slot="changes-skeleton"]')).toBeNull();
    expect(document.querySelector("main .count-arrive")).not.toBeNull();
  });

  it("a second visit opens on the kept list, with no skeleton and no fade", async () => {
    const first = renderAt("/space/w1/changes");
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    first.dispose();
    cleanup();
    const release = holdLists();
    renderAt("/space/w1/changes");
    // Before any read answers: the kept list, and the header's count from it.
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    expect(document.querySelector('[data-slot="changes-skeleton"]')).toBeNull();
    expect(document.querySelector("main .count-arrive")).toBeNull();
    expect(headerLine().dataset.state).toBe("still");
    await release();
  });
});

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
