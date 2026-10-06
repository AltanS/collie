import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { asJsonBoolean, asJsonObject } from "@/lib/json";
import { resetChangesListCache } from "@/lib/changes-list-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearNotPaired, isNotPaired } from "@/lib/pairing";
import { fixtureAgents, fixtureChanges, fixtureFileRead, fixtureFilesDir } from "@/test/handlers";
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

// THE CHANGES SCREEN'S FOLDER TREE (ADR 0083, merged 2026-10-06). The root is the Changes screen
// itself (`CHANGES`); a folder or a file sits one segment below it (`FILES?dir=`, `FILES?path=`), and
// `FILES` alone is the root under its address from before the merge.
const CHANGES = "/pane/w1%3Ap1/changes";
const FILES = "/pane/w1%3Ap1/changes/files";

/** The Changes route at `entries`, the last one current. Settings and the pane are stand-in screens. */
function renderAt(entries: (string | { pathname: string; search?: string; state: object })[], index?: number) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => connected(),
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div>dashboard screen</div> },
          { path: "pane/:paneId", element: <div>pane screen</div> },
          { path: "pane/:paneId/changes/*", element: <ChangesRoute /> },
          { path: "space/:spaceId", element: <div>space screen</div> },
          { path: "space/:spaceId/changes/*", element: <ChangesRoute /> },
          { path: "settings/:section", element: <div>settings screen</div> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: index ?? entries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** One device pref as stored, or undefined when nothing wrote it. */
function storedPref(key: string): boolean | undefined {
  return asJsonBoolean(asJsonObject(JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}"))?.[key]);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetChangesListCache();
  clearNotPaired();
});

describe("Changes: the folder tree is the default body", () => {
  it("lists the root, folders first, with a size for files, the kind and the changes below for a reader", async () => {
    renderAt([CHANGES]);
    const first = await screen.findByRole("button", { name: /^src, folder, 2 changed files/ });
    const rows = first.closest("ul");
    if (rows === null) throw new Error("the rows are not in a list");
    const names = within(rows)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "docs, folder",
      "packages, folder, 2 changed files",
      "public, folder, 1 changed file",
      "src, folder, 2 changed files",
      "README.md, file, 1.2 KB",
      "index.html, file, 468 B",
      "logo.png, file, 20 KB",
      "package.json, file, 312 B",
      "current, link",
    ]);
    // There is no Changes | Files switch any more: one screen, titled Files.
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("is also the body of the root's address from before the merge", async () => {
    renderAt([FILES]);
    expect(await screen.findByRole("button", { name: /^docs, folder/ })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(en["files.title"]);
  });

  it("asks the pane route for the root, then for a folder with ?dir=", async () => {
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
        asked.push(new URL(request.url).pathname + new URL(request.url).search);
      }),
    );
    renderAt([CHANGES]);
    await userEvent.click(await screen.findByRole("button", { name: /^src, folder/ }));
    expect(await screen.findByRole("button", { name: /^cart\.ts/ })).toBeTruthy();
    expect(asked).toEqual(["/api/pane/w1%3Ap1/files", "/api/pane/w1%3Ap1/files?dir=src"]);
  });

  it("asks by workspace on the space route", async () => {
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/workspace\/[^/]+\/files/, ({ request }) => {
        asked.push(new URL(request.url).pathname);
      }),
    );
    renderAt(["/space/w1/changes"]);
    expect(await screen.findByRole("button", { name: /^docs, folder/ })).toBeTruthy();
    expect(asked).toEqual(["/api/workspace/w1/files"]);
  });

  it("names the path as a breadcrumb whose crumbs are links", async () => {
    const router = renderAt([`${FILES}?dir=src%2Froutes`]);
    const nav = await screen.findByRole("navigation", { name: en["files.breadcrumb.aria"] });
    expect(within(nav).getByText("src/routes".split("/")[1]!).getAttribute("aria-current")).toBe("page");
    const src = within(nav).getByRole("link", { name: "src" });
    expect(src.getAttribute("href")).toBe("/pane/w1%3Ap1/changes/files?dir=src");
    await userEvent.click(src);
    expect(router.state.location.search).toBe("?dir=src");
    expect(await screen.findByRole("button", { name: /^cart\.ts/ })).toBeTruthy();
  });

  it("says a folder is empty", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () =>
        HttpResponse.json({ ...fixtureFilesDir("")!, entries: [] }),
      ),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["files.empty"])).toBeTruthy();
  });

  it("shows a plain line when the listing hit its cap", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ ...fixtureFilesDir("")!, truncated: true })));
    renderAt([FILES]);
    expect(await screen.findByText(en["files.truncated"])).toBeTruthy();
  });

  it("reads no-folder the way Changes reads it when the list has no folder either", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ available: false, reason: "no-folder" })),
      http.get(/\/api\/pane\/[^/]+\/changes/, () => HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-folder" })),
    );
    renderAt([CHANGES]);
    expect(await screen.findByText(en["changes.unavailable.noFolder"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["files.showChangesOnly"] })).toBeNull();
  });

  // Files is bounded tighter than Changes: a pane parked in the home folder lists its changes and
  // cannot browse. The tree says so in its own words and offers the half that works.
  it("says Files cannot open the folder when the list can, and offers Changes only", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ available: false, reason: "no-folder" })),
    );
    renderAt([CHANGES]);
    expect(await screen.findByText(en["files.noFolder"])).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en["files.showChangesOnly"] }));
    expect(await screen.findByRole("button", { name: /checkout\.tsx/ })).toBeTruthy();
    expect(storedPref("changesOnly")).toBe(true);
  });

  it("asks again on the refresh button, never on a timer, and refresh reads the list too", async () => {
    let asks = 0;
    let lists = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => {
        asks++;
      }),
      http.get(/\/api\/pane\/[^/]+\/changes/, () => {
        lists++;
      }),
    );
    renderAt([CHANGES]);
    await screen.findByRole("button", { name: /^docs, folder/ });
    await waitFor(() => expect(lists).toBe(1));
    expect(asks).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: en["changes.refreshAria"] }));
    await waitFor(() => expect(asks).toBe(2));
    await waitFor(() => expect(lists).toBe(2));
  });
});

describe("Changes: the marks on the tree", () => {
  const row = (name: RegExp) => screen.findByRole("button", { name });

  it("a changed file wears its status letter and an icon in the list's colour for that status", async () => {
    renderAt([`${FILES}?dir=src%2Froutes`]);
    const changed = await row(/^checkout\.tsx, file, 388 B, Modified$/);
    expect(changed.querySelector("svg")?.getAttribute("class")).toContain("text-status-working");
    // The icon switches shape too: a pen for a modified file, not the plain file glyph.
    expect(changed.querySelector("svg")?.getAttribute("class")).toContain("lucide-file-pen");
    const letter = [...changed.querySelectorAll("span")].find((el) => el.textContent === "M");
    expect(letter?.className).toContain("text-status-working");
  });

  it("an untracked file counts as new: U in the untracked ink", async () => {
    renderAt([`${FILES}?dir=packages%2Fapi`]);
    const note = await row(/^notes\.md, file, 38 B, Untracked$/);
    const letter = [...note.querySelectorAll("span")].find((el) => el.textContent === "U");
    // Not the list's quiet grey: a file the agent just wrote takes the added ink, letter and icon.
    expect(letter?.className).toContain("text-status-done");
    expect(note.querySelector("svg")?.getAttribute("class")).toContain("text-status-done");
    expect(note.querySelector("svg")?.getAttribute("class")).toContain("lucide-file-plus");
    expect(await row(/^server, folder, 1 changed file$/)).toBeTruthy();
  });

  it("a folder with changes below it shows a dot and their count; one without shows nothing", async () => {
    renderAt([CHANGES]);
    const src = await row(/^src, folder, 2 changed files$/);
    expect(src.querySelector('[data-slot="folder-mark"]')?.textContent).toBe("2");
    const docs = await row(/^docs, folder$/);
    expect(docs.querySelector('[data-slot="folder-mark"]')).toBeNull();
  });

  it("adds a deleted file to its folder from the change set, struck through, and opens it on its Diff", async () => {
    const withDeleted = {
      ...fixtureChanges,
      repos: fixtureChanges.available
        ? [{ ...fixtureChanges.repos[0]!, files: [...fixtureChanges.repos[0]!.files, { path: "CHANGELOG.md", status: "D", added: 0, removed: 1, binary: false }] }, ...fixtureChanges.repos.slice(1)]
        : [],
    };
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        const q = new URL(request.url).searchParams;
        if (q.get("path") === "CHANGELOG.md") {
          return HttpResponse.json({ available: true, repo: ".", path: "CHANGELOG.md", status: "D", binary: false, directory: false, truncated: false, diff: "@@ -1 +0,0 @@\n-# Changelog\n" });
        }
        return q.get("path") === null ? HttpResponse.json(withDeleted) : undefined;
      }),
      http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
        asked.push(new URL(request.url).search);
      }),
    );
    const router = renderAt([CHANGES]);
    const gone = await row(/^CHANGELOG\.md, file, Deleted$/);
    expect(gone.querySelector(".line-through")?.textContent).toBe("CHANGELOG.md");
    await userEvent.click(gone);
    expect(router.state.location.search).toBe("?path=CHANGELOG.md");
    expect(await screen.findByText("# Changelog")).toBeTruthy();
    // On disk no more, so it has no Source to read and no switch to show.
    expect(screen.queryByRole("radiogroup", { name: en["files.view.aria"] })).toBeNull();
    expect(asked).toEqual([""]);
  });

  it("a folder outside any repo has no marks", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) =>
        new URL(request.url).searchParams.get("path") === null ? HttpResponse.json({ ...fixtureChanges, repos: [] }) : undefined,
      ),
    );
    renderAt([CHANGES]);
    await row(/^src, folder$/);
    expect(document.querySelector('[data-slot="folder-mark"]')).toBeNull();
  });
});

describe("Files: the All files | Changes control", () => {
  const changesSegment = () => screen.findByRole("radio", { name: new RegExp(`^${en["files.mode.changes"]}`) });
  const allSegment = () => screen.findByRole("radio", { name: en["files.mode.all"] });

  it("carries the changed-file count on Changes, is on All files by default, and swaps the tree for the list", async () => {
    renderAt([CHANGES]);
    const only = await changesSegment();
    await waitFor(() => expect(only.getAttribute("aria-label")).toBe(`${en["files.mode.changes"]}, ${en["files.changed.other"].replace("{count}", "5")}`));
    expect(only.getAttribute("aria-checked")).toBe("false");
    expect(only.querySelector('[data-slot="segmented-badge"]')?.textContent).toBe("5");
    expect((await allSegment()).getAttribute("aria-checked")).toBe("true");
    await screen.findByRole("button", { name: /^docs, folder/ });

    await userEvent.click(only);
    expect(only.getAttribute("aria-checked")).toBe("true");
    // Today's list, exactly: grouped by repo, with its layout toggle and filter.
    expect(await screen.findByRole("button", { name: /checkout\.tsx/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^docs, folder/ })).toBeNull();
    expect(screen.getByRole("button", { name: en["changes.layout.tree"] })).toBeTruthy();
    expect(storedPref("changesOnly")).toBe(true);
  });

  it("heads the list with the root's name and the totals, and no longer the header", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    renderAt([CHANGES]);
    const head = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="changes-head"]');
      expect(el).not.toBeNull();
      expect(el!.querySelector('[data-slot="changes-totals"]')).not.toBeNull();
      return el!;
    });
    expect(head.textContent).toBe("webapp+10 −2");
    expect(screen.getByRole("heading", { level: 1 }).closest("header")?.textContent).not.toContain("+10");
  });

  it("draws no badge when nothing changed", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) =>
        new URL(request.url).searchParams.get("path") === null ? HttpResponse.json({ ...fixtureChanges, repos: [] }) : undefined,
      ),
    );
    renderAt([CHANGES]);
    const only = await changesSegment();
    await screen.findByRole("button", { name: /^docs, folder/ });
    expect(only.querySelector('[data-slot="segmented-badge"]')).toBeNull();
    expect(only.getAttribute("aria-label")).toBeNull();
  });

  it("is remembered per device: a device that chose it opens on the list", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    renderAt([CHANGES]);
    expect(await screen.findByRole("button", { name: /checkout\.tsx/ })).toBeTruthy();
    expect((await changesSegment()).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(await allSegment());
    expect(await screen.findByRole("button", { name: /^docs, folder/ })).toBeTruthy();
    expect(storedPref("changesOnly")).toBe(false);
  });

  // Review 2026-10-06: one header on every level, never a control dropped by depth. The Ignored eye
  // and Changes-only toggle left it that day; the segment control sits under it.
  it("is under every folder's header, whose buttons are Filter and Refresh, and turning it on there goes up to the list", async () => {
    const router = renderAt([CHANGES, { pathname: FILES, search: "?dir=src", state: { from: CHANGES } }]);
    await screen.findByRole("button", { name: /^cart\.ts/ });
    const header = screen.getByRole("heading", { level: 1 }).closest("header");
    if (header === null) throw new Error("no header");
    const squares = within(header)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "")
      .slice(1);
    expect(squares).toEqual([en["changes.filter.button"], en["changes.refreshAria"]]);
    expect(within(header).queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: en["files.mode.aria"] })).toBeTruthy();
    await userEvent.click(await changesSegment());
    expect(storedPref("changesOnly")).toBe(true);
    await waitFor(() => expect(router.state.location.pathname).toBe(CHANGES));
    expect(router.state.location.search).toBe("");
    expect(await screen.findByRole("button", { name: /checkout\.tsx/ })).toBeTruthy();
  });

  it("is on a file of the tree too, with Refresh", async () => {
    renderAt([`${FILES}?path=README.md`]);
    expect(await screen.findByText("Run it")).toBeTruthy();
    expect(await changesSegment()).toBeTruthy();
    expect(screen.getByRole("button", { name: en["changes.refreshAria"] })).toBeTruthy();
  });
});

describe("Changes: back goes up one level through the tree", () => {
  it("steps up through the file, its folders and the root, then leaves to where Changes goes", async () => {
    const router = renderAt([
      "/pane/w1%3Ap1",
      { pathname: CHANGES, state: { from: "/pane/w1%3Ap1" } },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /^src, folder/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^routes, folder/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^checkout\.tsx/ }));
    expect(router.state.location.pathname).toBe(FILES);
    expect(router.state.location.search).toBe("?path=src%2Froutes%2Fcheckout.tsx");
    expect(await screen.findByText("Checkout", { exact: false })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: en["files.backAria.folder"] }));
    await waitFor(() => expect(router.state.location.search).toBe("?dir=src%2Froutes"));
    await userEvent.click(await screen.findByRole("button", { name: en["files.backAria.parent"] }));
    await waitFor(() => expect(router.state.location.search).toBe("?dir=src"));
    await userEvent.click(await screen.findByRole("button", { name: en["files.backAria.parent"] }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    // The root of the tree is the Changes screen itself, reached by a step back, not a push.
    expect(router.state.location.pathname).toBe(CHANGES);
    expect(router.state.historyAction).toBe("POP");
    // At the root the arrow names where Changes goes today.
    await userEvent.click(await screen.findByRole("button", { name: en["changes.backAria.pane"] }));
    expect(await screen.findByText("pane screen")).toBeTruthy();
  });

  it("steps BACK onto the parent folder instead of stacking another entry", async () => {
    const router = renderAt([
      "/pane/w1%3Ap1",
      { pathname: CHANGES, state: { from: "/pane/w1%3Ap1" } },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /^src, folder/ }));
    await screen.findByRole("button", { name: /^cart\.ts/ });
    const before = router.state.historyAction;
    expect(before).toBe("PUSH");
    await userEvent.click(screen.getByRole("button", { name: en["files.backAria.parent"] }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    // A step back is a POP; a replace onto the parent would have been REPLACE.
    expect(router.state.historyAction).toBe("POP");
  });

  it("replaces onto the parent folder when the entry behind is not that folder (a cold deep link)", async () => {
    const router = renderAt([`${FILES}?dir=src%2Froutes`]);
    await screen.findByRole("button", { name: /^checkout\.tsx/ });
    await userEvent.click(screen.getByRole("button", { name: en["files.backAria.parent"] }));
    await waitFor(() => expect(router.state.location.search).toBe("?dir=src"));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("names a file's way up as the folder", async () => {
    renderAt([`${FILES}?path=README.md`]);
    expect(await screen.findByRole("button", { name: en["files.backAria.folder"] })).toBeTruthy();
  });
});

describe("Changes: one file of the tree", () => {
  it("opens a changed file on its Diff, with Source one tap away", async () => {
    renderAt([`${FILES}?path=src%2Froutes%2Fcheckout.tsx`]);
    // The diff's own lines, which the fixture's source does not have.
    expect((await screen.findAllByText("cartTotal", { exact: false })).length).toBeGreaterThan(0);
    const diff = screen.getByRole("radio", { name: en["files.view.diff"] });
    expect(diff.getAttribute("aria-checked")).toBe("true");
    // A TypeScript file has no Preview: Diff | Source.
    expect(within(screen.getByRole("radiogroup", { name: en["files.view.aria"] })).getAllByRole("radio").map((r) => r.textContent)).toEqual([en["files.view.diff"], en["files.view.source"]]);
    await userEvent.click(screen.getByRole("radio", { name: en["files.view.source"] }));
    await waitFor(() => expect(screen.queryAllByText("cartTotal", { exact: false })).toHaveLength(0));
    expect(screen.getAllByText("Checkout", { exact: false }).length).toBeGreaterThan(0);
  });

  it("asks the diff of the change set's repo, with the path inside that repo", async () => {
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        const q = new URL(request.url).searchParams;
        if (q.get("path") !== null) asked.push(`${q.get("repo")}|${q.get("path")}`);
      }),
    );
    renderAt([`${FILES}?path=packages%2Fapi%2Fserver%2Fhandlers%2Forders.ts`]);
    expect(await screen.findByText(en["changes.file.renamedFrom"].replace("{path}", "server/orders.ts"))).toBeTruthy();
    await waitFor(() => expect(asked).toEqual(["packages/api|server/handlers/orders.ts"]));
  });

  // The operator's case: an agent wrote a new Markdown file. Its Diff is every line added, and one tap
  // draws it as a page.
  it("a new Markdown file opens on Diff, all added, and Preview is one tap away", async () => {
    renderAt([`${FILES}?path=packages%2Fapi%2Fnotes.md`]);
    expect(await screen.findByText("Orders moved under handlers/.")).toBeTruthy();
    expect(within(screen.getByRole("radiogroup", { name: en["files.view.aria"] })).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      en["files.view.diff"],
      en["files.view.source"],
      en["files.view.preview"],
    ]);
    await userEvent.click(screen.getByRole("radio", { name: en["files.view.preview"] }));
    await waitFor(() => expect(document.querySelector('[data-heading-level="1"]')?.textContent).toBe("Notes"));
  });

  it("an unchanged file keeps Source | Preview, and no Diff", async () => {
    renderAt([`${FILES}?path=README.md`]);
    expect(await screen.findByText("Run it")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: en["files.view.diff"] })).toBeNull();
  });

  it("opens Markdown on its Preview, and Source is one tap away", async () => {
    renderAt([`${FILES}?path=README.md`]);
    expect(await screen.findByText("Run it")).toBeTruthy();
    const preview = screen.getByRole("radio", { name: en["files.view.preview"] });
    expect(preview.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: en["files.view.source"] }));
    expect(screen.queryByText("Run it")).toBeNull();
    expect(screen.getByText(/# Webapp/)).toBeTruthy();
  });

  it("shows the size beside the path", async () => {
    renderAt([`${FILES}?path=package.json`]);
    expect(await screen.findByText(/^\d+ B$/)).toBeTruthy();
  });

  it("offers no Preview control for a type with none, and opens on Source", async () => {
    renderAt([`${FILES}?path=src%2Fcart.ts`]);
    expect(await screen.findByText(/cartTotal/)).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: en["files.view.aria"] })).toBeNull();
  });

  it("shows a binary file as its size and nothing else", async () => {
    renderAt([`${FILES}?path=logo.png`]);
    expect(await screen.findByText("Binary file, 20 KB")).toBeTruthy();
  });

  it("opens a link row like a file", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
        const path = new URL(request.url).searchParams.get("path");
        if (path === "current") return HttpResponse.json({ ...fixtureFilesDir("")!, path, size: 3, binary: false, truncated: false, text: "hey", entries: undefined });
        return undefined;
      }),
    );
    const router = renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: /^current, link/ }));
    expect(router.state.location.search).toBe("?path=current");
    expect(await screen.findByText("hey")).toBeTruthy();
  });
});

describe("Changes tree: what a refusal reads as", () => {
  it("reads a 404 unknown-path as a file that is not available", async () => {
    renderAt([`${FILES}?path=gone.md`]);
    expect(await screen.findByText(en["files.unknown.file"])).toBeTruthy();
  });

  it("reads an unknown folder as a folder that is not available", async () => {
    renderAt([`${FILES}?dir=nowhere`]);
    expect(await screen.findByText(en["files.unknown.folder"])).toBeTruthy();
  });

  it("an older member's 404 reads as update this machine", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ error: "not found" }, { status: 404 })),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["files.stale.member"])).toBeTruthy();
    expect(screen.queryByText(en["files.unknown.folder"])).toBeNull();
  });

  it("tells the two 404s apart by the error value, not the status", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse("not found", { status: 404 })),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["files.stale.member"])).toBeTruthy();
  });

  it("an unpaired device is refused with the same body a write gets, and is shown the way to pair", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse("device not paired", { status: 403 })),
    );
    const router = renderAt([CHANGES]);
    expect(await screen.findByText(en["files.notPaired"])).toBeTruthy();
    // The list needs no pairing, so the root offers it in the tree's place.
    expect(screen.getByRole("button", { name: en["files.showChangesOnly"] })).toBeTruthy();
    // The read latches the same refusal a write does, so the app's read-only strip names the remedy.
    expect(isNotPaired()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: en["files.pairLink"] }));
    expect(router.state.location.pathname).toBe("/settings/system");
    expect(router.state.location.hash).toBe("#paired-devices");
  });

  it("a device the proxy does not list is told it is not authorised, with no pairing button", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse("device not authorised", { status: 403 })),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["files.notAuthorised"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["files.pairLink"] })).toBeNull();
    expect(isNotPaired()).toBe(false);
  });

  // A crew member relays its own refusal, with a clause after the lead's two plain bodies.
  it("an unpaired device is recognised by the start of the body, so a member's longer words count", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse("device not paired on this host", { status: 403 })),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["files.notPaired"])).toBeTruthy();
    expect(isNotPaired()).toBe(true);
    expect(screen.getByRole("button", { name: en["files.pairLink"] })).toBeTruthy();
  });

  it("an unlisted device is recognised by the start of the body, too", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => new HttpResponse("device not authorised on this host\n", { status: 403 })),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["files.notAuthorised"])).toBeTruthy();
    expect(isNotPaired()).toBe(false);
  });

  it("a failed read says so and offers refresh", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ error: "boom" }, { status: 500 })));
    renderAt([FILES]);
    expect(await screen.findByText(en["files.error"])).toBeTruthy();
  });
});

describe("Files: a link row that points at a folder", () => {
  const LINK_DIR = [
    { name: "releases", kind: "dir" },
    { name: "app.ts", kind: "file", size: 9 },
  ];
  const answerFor = (folder: boolean) =>
    http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
      const q = new URL(request.url).searchParams;
      if (q.get("path") === "current") return HttpResponse.json({ error: "unknown-path" }, { status: 404 });
      if (q.get("dir") === "current" && folder) {
        return HttpResponse.json({
          paneId: "w1:p1",
          workspaceId: "w1",
          workspaceLabel: "webapp",
          available: true,
          root: "/home/you/webapp",
          dir: "current",
          entries: LINK_DIR,
          truncated: false,
        });
      }
      if (q.get("dir") === "current") return HttpResponse.json({ error: "unknown-path" }, { status: 404 });
      const answer = q.get("path") !== null ? null : fixtureFilesDir(q.get("dir") ?? "");
      return answer === null ? HttpResponse.json({ error: "unknown-path" }, { status: 404 }) : HttpResponse.json(answer);
    });

  it("opens the folder when the file read says unknown-path and a folder read lists", async () => {
    server.use(answerFor(true));
    const router = renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: /^current/ }));
    expect(await screen.findByRole("button", { name: /^releases, folder/ })).toBeTruthy();
    expect(screen.queryByText(en["files.unknown.file"])).toBeNull();
    // The entry was replaced by the folder's own address, so a reload shows the same screen.
    await waitFor(() => expect(router.state.location.search).toBe("?dir=current"));
  });

  it("says the file is not available when the folder read fails too", async () => {
    server.use(answerFor(false));
    const router = renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: /^current/ }));
    expect(await screen.findByText(en["files.unknown.file"])).toBeTruthy();
    expect(router.state.location.search).toBe("?path=current");
  });

  it("does not try a folder for a path that did not come from a link row", async () => {
    let dirAsked = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
        if (new URL(request.url).searchParams.get("dir") === "current") dirAsked = true;
        return HttpResponse.json({ error: "unknown-path" }, { status: 404 });
      }),
    );
    renderAt([`${FILES}?path=current`]);
    expect(await screen.findByText(en["files.unknown.file"])).toBeTruthy();
    expect(dirAsked).toBe(false);
  });
});

describe("Changes only → the file screen: Preview from a diff", () => {
  it("offers Preview for a changed Markdown file and opens its file screen on Preview, from the root", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    const router = renderAt([
      "/pane/w1%3Ap1",
      { pathname: "/pane/w1%3Ap1/changes", state: { from: "/pane/w1%3Ap1" } },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /notes\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: en["changes.file.previewAria"] }));
    expect(router.state.location.pathname).toBe(FILES);
    expect(router.state.location.search).toBe("?path=packages%2Fapi%2Fnotes.md");
    // The same file screen a tree row opens, on Preview this time, with the Diff one tap back.
    await waitFor(() => expect(document.querySelector('[data-heading-level="1"]')?.textContent).toBe("Notes"));
    expect(screen.getByRole("radio", { name: en["files.view.preview"] }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: en["files.view.diff"] }));
    expect(await screen.findByText("Orders moved under handlers/.")).toBeTruthy();
  });

  // A pane opened in a folder INSIDE a repo: the root is `proj/web`, the repo is `..`, and its paths
  // start with `web/`. The Preview path is the one from the root, not `../web/…`, which Files refuses.
  it("opens a file of a repo above the root at its path from the root", async () => {
    const above = {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "web",
      available: true,
      root: "/home/you/proj/web",
      truncated: false,
      repos: [{ relPath: "..", name: "proj", files: [{ path: "web/docs/guide.md", status: "M", added: 1, removed: 0, binary: false }] }],
    };
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) =>
        new URL(request.url).searchParams.get("path") === null ? HttpResponse.json(above) : undefined,
      ),
    );
    const router = renderAt(["/pane/w1%3Ap1/changes?repo=..&path=web%2Fdocs%2Fguide.md"]);
    await userEvent.click(await screen.findByRole("button", { name: en["changes.file.previewAria"] }));
    expect(router.state.location.pathname).toBe(FILES);
    expect(router.state.location.search).toBe("?path=docs%2Fguide.md");
  });

  it("offers no Preview for a file of a repo above the root that lies outside the root", async () => {
    const above = {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "web",
      available: true,
      root: "/home/you/proj/web",
      truncated: false,
      repos: [{ relPath: "..", name: "proj", files: [{ path: "api/notes.md", status: "M", added: 1, removed: 0, binary: false }] }],
    };
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) =>
        new URL(request.url).searchParams.get("path") === null ? HttpResponse.json(above) : HttpResponse.json({ ...above, available: false, reason: "unknown-path" }),
      ),
    );
    renderAt(["/pane/w1%3Ap1/changes?repo=..&path=api%2Fnotes.md"]);
    await screen.findByText(en["changes.file.unknown"]);
    expect(screen.queryByRole("button", { name: en["changes.file.previewAria"] })).toBeNull();
  });

  it("offers no Preview for a file with none", async () => {
    renderAt(["/pane/w1%3Ap1/changes?repo=.&path=src%2Flib%2Fcart.ts"]);
    await screen.findByText("cartTotal", { exact: false });
    expect(screen.queryByRole("button", { name: en["changes.file.previewAria"] })).toBeNull();
  });

  it("offers no Preview for a deleted file", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/changes/, ({ request }) => {
        const q = new URL(request.url).searchParams;
        if (q.get("path") === null) return undefined;
        return HttpResponse.json({
          available: true,
          repo: ".",
          path: "gone.md",
          status: "D",
          binary: false,
          directory: false,
          truncated: false,
          diff: "@@ -1 +0,0 @@\n-# gone\n",
        });
      }),
    );
    renderAt(["/pane/w1%3Ap1/changes?repo=.&path=gone.md"]);
    await screen.findByText("# gone");
    expect(screen.queryByRole("button", { name: en["changes.file.previewAria"] })).toBeNull();
  });
});

// A link in a Markdown file opens the other file in Files: one level down, in this machine's scope,
// so Back keeps the reader where they were.
describe("Files: a link in a Markdown file", () => {
  const guide = (text: string) => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
        const path = new URL(request.url).searchParams.get("path");
        const read = path === null ? null : fixtureFileRead(path);
        if (path !== "docs/guide.md" || read === null || !read.available) return undefined;
        return HttpResponse.json({ ...read, text, size: text.length });
      }),
    );
  };

  it("a relative link opens that file, as a push that keeps the machine in the address", async () => {
    guide("# Guide\n\nSee [the readme](../README.md) and [the cart](../src/cart.ts#L1).\n");
    const router = renderAt([`${FILES}?h=minibuch&path=docs%2Fguide.md`]);
    await userEvent.click(await screen.findByRole("link", { name: "the readme" }));
    await waitFor(() => expect(router.state.location.search).toBe("?h=minibuch&path=README.md"));
    expect(router.state.historyAction).toBe("PUSH");
    expect(await screen.findByText("Run it")).toBeTruthy();
    // The browser's own Back is the first file again.
    await act(() => router.navigate(-1));
    expect(await screen.findByRole("link", { name: "the readme" })).toBeTruthy();
    expect(router.state.location.search).toBe("?h=minibuch&path=docs%2Fguide.md");
  });

  it("the link's address is the Files address, so a long-press or a new tab lands in the same place", async () => {
    guide("[the cart](../src/cart.ts#L1) and [up](../) and [root](/docs/)\n");
    renderAt([`${FILES}?path=docs%2Fguide.md`]);
    expect((await screen.findByRole("link", { name: "the cart" })).getAttribute("href")).toBe(`${FILES}?path=src%2Fcart.ts`);
    // The root of the tree is the Changes screen itself.
    expect(screen.getByRole("link", { name: "up" }).getAttribute("href")).toBe(CHANGES);
    expect(screen.getByRole("link", { name: "root" }).getAttribute("href")).toBe(`${FILES}?dir=docs`);
  });

  it("a link ending in a slash opens the folder", async () => {
    guide("[the source](../src/)\n");
    const router = renderAt([`${FILES}?path=docs%2Fguide.md`]);
    await userEvent.click(await screen.findByRole("link", { name: "the source" }));
    await waitFor(() => expect(router.state.location.search).toBe("?dir=src"));
    expect(await screen.findByRole("button", { name: /^cart\.ts/ })).toBeTruthy();
  });

  it("a link that climbs past the root is text, not a dead link", async () => {
    guide("[out](../../etc/passwd)\n");
    renderAt([`${FILES}?path=docs%2Fguide.md`]);
    await screen.findByText("out");
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("Files: entries git ignores, and the filter", () => {
  const filterButton = () => screen.findByRole("button", { name: new RegExp(`^${en["changes.filter.button"]}`) });
  const hiddenLine = (count: number) => en["files.ignored.hidden"].replace("{count}", String(count));
  const counted = (shown: number, total: number) => en["files.filter.shown"].replace("{shown}", String(shown)).replace("{total}", String(total));
  const names = () =>
    within(document.querySelector<HTMLElement>('[data-slot="file-rows"]')!)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label")!.split(",")[0]);
  const stored = (): boolean | undefined => asJsonBoolean(asJsonObject(JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}"))?.filesShowIgnored);

  it("hides ignored rows by default and says how many, quietly", async () => {
    renderAt([FILES]);
    await screen.findByRole("button", { name: /^docs, folder/ });
    expect(names()).toEqual(["docs", "packages", "public", "src", "README.md", "index.html", "logo.png", "package.json", "current"]);
    expect(screen.getByText(hiddenLine(2))).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^node_modules/ })).toBeNull();
  });

  it("Show brings them back dimmed and still openable, and the choice outlives a remount", async () => {
    renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: en["files.ignored.showAria"] }));
    const dimmed = await screen.findByRole("button", { name: `debug.log, ${en["files.kind.file"]}, 8 KB, ${en["files.ignored.word"]}` });
    expect(dimmed.querySelector("span")?.className).toContain("text-muted-foreground");
    expect(screen.queryByText(hiddenLine(2))).toBeNull();
    expect(stored()).toBe(true);

    // Still tappable: an ignored folder opens, and everything in it is ignored.
    await userEvent.click(screen.getByRole("button", { name: /^node_modules, folder/ }));
    expect(await screen.findByRole("button", { name: /^react, folder/ })).toBeTruthy();
  });

  it("starts shown on a device that chose it", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ filesShowIgnored: true }));
    renderAt([FILES]);
    await screen.findByRole("button", { name: /^docs, folder/ });
    expect(names()).toContain("node_modules");
    expect(screen.queryByText(hiddenLine(2))).toBeNull();
  });

  // The eye left the header on 2026-10-06. What is left: the labelled toggle in the filter row, and the
  // footer line's Show and Hide. All of them write the one pref.
  const rowToggle = () => within(document.querySelector<HTMLElement>('[data-slot="files-filter"]')!).getByRole("button", { name: en["files.ignored.toggleAria"] });
  const shownLine = (count: number) => en["files.ignored.shown"].replace("{count}", String(count));

  it("has no ignored button in the header: the footer line is the switch", async () => {
    renderAt([FILES]);
    await screen.findByRole("button", { name: /^docs, folder/ });
    const header = document.querySelector<HTMLElement>("header")!;
    expect(within(header).queryByRole("button", { name: en["files.ignored.toggleAria"] })).toBeNull();
    expect(screen.queryByRole("button", { name: en["files.ignored.hideAria"] })).toBeNull();
  });

  it("Hide stands in the footer while ignored entries are shown, and puts them away again", async () => {
    renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: en["files.ignored.showAria"] }));
    expect(names()).toContain("debug.log");
    // The line says how many are shown and offers the way back; the hidden line is gone.
    expect(screen.getByText(shownLine(2))).toBeTruthy();
    expect(screen.queryByText(hiddenLine(2))).toBeNull();
    expect(screen.queryByRole("button", { name: en["files.ignored.showAria"] })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: en["files.ignored.hideAria"] }));
    expect(names()).not.toContain("debug.log");
    expect(screen.getByText(hiddenLine(2))).toBeTruthy();
    expect(stored()).toBe(false);
  });

  it("the labelled toggle in the filter row writes the same choice and names the state in words", async () => {
    renderAt([FILES]);
    await userEvent.click(await filterButton());
    await screen.findByPlaceholderText(en["files.filter.placeholder"]);
    const chip = rowToggle();
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toBe(en["files.ignored.stateHidden"]);
    await userEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.textContent).toBe(en["files.ignored.stateShown"]);
    expect(names()).toContain("debug.log");
    expect(stored()).toBe(true);
    // The footer follows: one pref, two doors.
    expect(screen.getByRole("button", { name: en["files.ignored.hideAria"] })).toBeTruthy();
    await userEvent.click(chip);
    expect(names()).not.toContain("debug.log");
    expect(stored()).toBe(false);
    expect(screen.getByRole("button", { name: en["files.ignored.showAria"] })).toBeTruthy();
  });

  it("the Show action under the list flips the same pref the filter row's toggle reads", async () => {
    renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: en["files.ignored.showAria"] }));
    await userEvent.click(await filterButton());
    await screen.findByPlaceholderText(en["files.filter.placeholder"]);
    expect(rowToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("the Ignored choice survives opening a folder", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ filesShowIgnored: true }));
    renderAt([FILES]);
    await userEvent.click(await screen.findByRole("button", { name: /^src, folder/ }));
    await screen.findByRole("button", { name: /^cart\.ts/ });
    await userEvent.click(await filterButton());
    await screen.findByPlaceholderText(en["files.filter.placeholder"]);
    expect(rowToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("filters the folder's names by a case-insensitive substring, with the count, and Clear resets it", async () => {
    renderAt([FILES]);
    await userEvent.click(await filterButton());
    await userEvent.type(await screen.findByPlaceholderText(en["files.filter.placeholder"]), "RE");
    // "RE" matches README.md and, case-insensitively inside the name, "current".
    expect(names()).toEqual(["README.md", "current"]);
    expect(await screen.findByText(counted(2, 9))).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`^${en["changes.filter.button"]}, 2 of 9`) })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en["changes.filter.clear"] }));
    expect(names()).toHaveLength(9);
    // The Ignored choice was never part of Clear.
    expect(stored()).toBeUndefined();
  });

  it("the name filter resets when the folder changes", async () => {
    renderAt([FILES]);
    await userEvent.click(await filterButton());
    const field = await screen.findByPlaceholderText(en["files.filter.placeholder"]);
    await userEvent.type(field, "src");
    expect(names()).toEqual(["src"]);
    await userEvent.click(screen.getByRole("button", { name: /^src, folder/ }));
    await screen.findByRole("button", { name: /^cart\.ts/ });
    expect(names()).toEqual(["lib", "routes", "cart.ts"]);
    // The overlay closed with the folder, and the button is not tinted.
    expect(screen.queryByPlaceholderText(en["files.filter.placeholder"])).toBeNull();
    expect((await filterButton()).getAttribute("aria-label")).toBe(en["changes.filter.button"]);
  });

  it("says nothing matches, with the way out, and the way out works", async () => {
    renderAt([FILES]);
    await userEvent.click(await filterButton());
    await userEvent.type(await screen.findByPlaceholderText(en["files.filter.placeholder"]), "zzz");
    expect(await screen.findByText(en["changes.filter.none"])).toBeTruthy();
    // The overlay's own Clear and the screen's both read "Clear filter"; either empties the field.
    await userEvent.click(screen.getAllByRole("button", { name: en["changes.filter.clear"] }).at(-1)!);
    await waitFor(() => expect(names()).toHaveLength(9));
  });

  it("a folder whose every entry is ignored says so and offers Show", async () => {
    renderAt([`${FILES}?dir=node_modules`]);
    expect(await screen.findByText(en["files.ignored.allHidden"])).toBeTruthy();
    expect(screen.getByText(hiddenLine(1))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en["files.ignored.showAria"] }));
    expect(await screen.findByRole("button", { name: /^react, folder/ })).toBeTruthy();
  });

  it("an older member's listing has no ignored field: nothing is hidden and no line shows", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => {
        const listing = fixtureFilesDir("")!;
        return HttpResponse.json({ ...listing, entries: listing.available ? listing.entries.map(({ ignored: _ignored, ...rest }) => rest) : [] });
      }),
    );
    renderAt([FILES]);
    await screen.findByRole("button", { name: /^docs, folder/ });
    expect(names()).toContain("node_modules");
    expect(names()).toContain("debug.log");
    expect(screen.queryByText(/ignored hidden/)).toBeNull();
  });

  it("an empty folder says it is empty and offers no filter", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ ...fixtureFilesDir("")!, entries: [] })));
    renderAt([FILES]);
    expect(await screen.findByText(en["files.empty"])).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(`^${en["changes.filter.button"]}`) })).toBeNull();
  });
});
