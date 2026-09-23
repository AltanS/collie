import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHANGES_POLL_MS } from "@/hooks/use-visible-interval";
import { resetChangeCountCache } from "@/hooks/use-workspace-change-counts";
import { resetChangesListCache } from "@/lib/changes-list-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ChangeCommitResponse, PaneChangesResponse } from "@/lib/types";
import { fixtureAgents, fixtureChanges, fixtureCleanChanges, fixtureCommit } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { ChangesRoute } from "./changes";

// THE COMMIT VIEW (ADR 0065). A clean repo offers its last commit from the empty list; the commit
// screen names it and lists its files; a newer HEAD waits behind a quiet line and never replaces
// what is on screen.

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

/** The app's own route shape: `changes/*`, so the commit view is the same mounted component. */
function renderAt(url: string) {
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
          { path: "pane/:paneId/changes/*", element: <ChangesRoute /> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Answer the list with `list()` and the commit with `commit()`, each read at call time. */
function answer(list: () => PaneChangesResponse, commit: () => ChangeCommitResponse = () => fixtureCommit) {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
      const q = new URL(request.url).searchParams;
      if (q.get("view") === "commit") return q.has("path") ? undefined : HttpResponse.json(commit());
      if (q.has("path")) return undefined;
      return HttpResponse.json(list());
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  // The route keeps its last list and count for the page session; each case starts cold.
  resetChangesListCache();
  resetChangeCountCache();
});

describe("ChangesRoute — Show last commit", () => {
  it("offers one button under the empty sentence, and it opens the commit a level down", async () => {
    answer(() => fixtureCleanChanges);
    const router = renderAt("/pane/w1%3Ap1/changes");
    expect(await screen.findByText(en["changes.empty"])).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en["changes.commit.show"] }));
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1/changes/commit");
    expect(router.state.location.search).toBe("?repo=.");
    // A down move records where it came from (ADR 0067).
    expect(router.state.location.state).toMatchObject({ from: "/pane/w1%3Ap1/changes" });
    expect(await screen.findByRole("heading", { name: en["changes.commit.title"] })).toBeTruthy();
  });

  it("lists several clean repos compactly, each button named for its repo", async () => {
    answer(() => ({
      ...fixtureCleanChanges,
      clean: [
        { relPath: ".", name: "webapp" },
        { relPath: "packages/api", name: "api" },
      ],
    }));
    const router = renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText(en["changes.empty"]);
    expect(screen.getByRole("button", { name: "Show last commit of webapp" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show last commit of api" }));
    expect(router.state.location.search).toBe("?repo=packages%2Fapi");
  });

  it("offers nothing when no repo has a commit, and names clean repos under a list of changes", async () => {
    answer(() => ({ ...fixtureCleanChanges, clean: undefined }));
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText(en["changes.empty"]);
    expect(screen.queryByRole("button", { name: en["changes.commit.show"] })).toBeNull();
  });

  it("names a clean repo beside another repo's changes", async () => {
    answer(() => ({ ...fixtureChanges, clean: [{ relPath: "docs", name: "docs" }] }));
    renderAt("/pane/w1%3Ap1/changes");
    await screen.findByText("checkout.tsx");
    const section = screen.getByRole("region", { name: en["changes.commit.cleanHeading"] });
    expect(section.textContent).toContain("docs");
    expect(screen.getByRole("button", { name: "Show last commit of docs" })).toBeTruthy();
  });
});

describe("ChangesRoute — the commit screen", () => {
  it("heads the files with the subject, short hash, author and a relative time", async () => {
    answer(() => fixtureCleanChanges);
    renderAt("/pane/w1%3Ap1/changes/commit?repo=.");
    if (!fixtureCommit.available) throw new Error("fixture");
    const subject = await screen.findByText(fixtureCommit.commit.subject);
    expect(subject.className).toContain("line-clamp-2");
    expect(screen.getByText("3f2a9c1")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    const time = document.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(new Date(fixtureCommit.commit.time * 1000).toISOString());
    // One repo: the files without a heading, like the Changes list.
    expect(screen.getByText("checkout.tsx")).toBeTruthy();
    expect(screen.getByText("cart.ts")).toBeTruthy();
    expect(screen.queryByText(en["changes.commit.newer"])).toBeNull();
  });

  it("opens a file of the commit and comes back to the commit", async () => {
    answer(() => fixtureCleanChanges);
    const router = renderAt("/pane/w1%3Ap1/changes/commit?repo=.");
    await userEvent.click(await screen.findByRole("button", { name: /checkout\.tsx/ }));
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1/changes/commit");
    expect(router.state.location.search).toBe("?repo=.&path=src%2Froutes%2Fcheckout.tsx");
    expect(await screen.findByText("const total = cartTotal(cart.items);")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en["changes.commit.backAria"] }));
    expect(await screen.findByText("cart.ts")).toBeTruthy();
    expect(router.state.location.search).toBe("?repo=.");
  });

  it("a newer commit waits behind a quiet line, and a tap loads it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    if (!fixtureCommit.available) throw new Error("fixture");
    let commit: ChangeCommitResponse = fixtureCommit;
    let list: PaneChangesResponse = fixtureCleanChanges;
    answer(
      () => list,
      () => commit,
    );
    renderAt("/pane/w1%3Ap1/changes/commit?repo=.");
    await screen.findByText(fixtureCommit.commit.subject);

    commit = {
      ...fixtureCommit,
      commit: { ...fixtureCommit.commit, hash: "9".repeat(40), shortHash: "9999999", subject: "A later commit" },
    };
    act(() => {
      vi.advanceTimersByTime(CHANGES_POLL_MS);
    });
    const line = await screen.findByRole("button", { name: en["changes.commit.newer"] });
    // The commit on screen stays put under the reader.
    expect(screen.getByText(fixtureCommit.commit.subject)).toBeTruthy();
    expect(screen.queryByText("A later commit")).toBeNull();

    // Uncommitted work in the same repo gets its own line back to the list.
    if (!fixtureChanges.available) throw new Error("fixture");
    list = { ...fixtureChanges, repos: [fixtureChanges.repos[0]!] };
    act(() => {
      vi.advanceTimersByTime(CHANGES_POLL_MS);
    });
    expect(await screen.findByRole("button", { name: en["changes.commit.uncommitted"] })).toBeTruthy();

    await userEvent.click(line);
    expect(await screen.findByText("A later commit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["changes.commit.newer"] })).toBeNull();
  });

  it("says so for a repo with no commits", async () => {
    answer(
      () => fixtureCleanChanges,
      () => ({ available: false, reason: "no-commit" }),
    );
    renderAt("/pane/w1%3Ap1/changes/commit?repo=.");
    expect(await screen.findByText(en["changes.commit.noCommit"])).toBeTruthy();
  });
});
