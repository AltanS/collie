import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { resetChangesListCache } from "@/lib/changes-list-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearNotPaired, isNotPaired } from "@/lib/pairing";
import { fixtureAgents, fixtureFileRead, fixtureFilesDir } from "@/test/handlers";
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

const FILES = "/pane/w1%3Ap1/changes/files";

/** The Files route at `entries`, the last one current. Settings and the pane are stand-in screens. */
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetChangesListCache();
  clearNotPaired();
});

describe("Files: the folder view", () => {
  it("lists the root, folders first, with a size for files and the kind for a reader", async () => {
    renderAt([FILES]);
    const first = await screen.findByRole("button", { name: /^docs, folder/ });
    const rows = first.closest("ul");
    if (rows === null) throw new Error("the rows are not in a list");
    const names = within(rows)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "docs, folder",
      "src, folder",
      "README.md, file, 1.2 KB",
      "index.html, file, 468 B",
      "logo.png, file, 20 KB",
      "package.json, file, 312 B",
      "current, link",
    ]);
  });

  it("asks the pane route for the root, then for a folder with ?dir=", async () => {
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, ({ request }) => {
        asked.push(new URL(request.url).pathname + new URL(request.url).search);
      }),
    );
    renderAt([FILES]);
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
    renderAt(["/space/w1/changes/files"]);
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

  it("reads no-folder the way Changes reads it", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => HttpResponse.json({ available: false, reason: "no-folder" })),
    );
    renderAt([FILES]);
    expect(await screen.findByText(en["changes.unavailable.noFolder"])).toBeTruthy();
  });

  it("asks again only on the refresh button, never on a timer", async () => {
    let asks = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/files/, () => {
        asks++;
      }),
    );
    renderAt([FILES]);
    await screen.findByRole("button", { name: /^docs, folder/ });
    expect(asks).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: en["files.refreshAria"] }));
    await waitFor(() => expect(asks).toBe(2));
  });

  it("switches to the Changes tab sideways", async () => {
    const router = renderAt([FILES]);
    await userEvent.click(await screen.findByRole("tab", { name: en["changes.tabs.changes"] }));
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1/changes");
    expect(await screen.findByText("webapp · 3 files")).toBeTruthy();
    // The same tab strip sits on the Changes screen and brings Files back.
    await userEvent.click(screen.getByRole("tab", { name: en["changes.tabs.files"] }));
    expect(router.state.location.pathname).toBe(FILES);
  });
});

describe("Files: back goes up one level", () => {
  it("steps up through the file, its folders and the root, then leaves to where Changes goes", async () => {
    const router = renderAt([
      "/pane/w1%3Ap1",
      { pathname: FILES, state: { from: "/pane/w1%3Ap1" } },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /^src, folder/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^routes, folder/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^checkout\.tsx/ }));
    expect(router.state.location.search).toBe("?path=src%2Froutes%2Fcheckout.tsx");
    expect(await screen.findByText("Checkout", { exact: false })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: en["files.backAria.folder"] }));
    await waitFor(() => expect(router.state.location.search).toBe("?dir=src%2Froutes"));
    await userEvent.click(await screen.findByRole("button", { name: en["files.backAria.parent"] }));
    await waitFor(() => expect(router.state.location.search).toBe("?dir=src"));
    await userEvent.click(await screen.findByRole("button", { name: en["files.backAria.parent"] }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(router.state.location.pathname).toBe(FILES);
    // At the root the arrow names where Changes goes today.
    await userEvent.click(await screen.findByRole("button", { name: en["changes.backAria.pane"] }));
    expect(await screen.findByText("pane screen")).toBeTruthy();
  });

  it("steps BACK onto the parent folder instead of stacking another entry", async () => {
    const router = renderAt([
      "/pane/w1%3Ap1",
      { pathname: FILES, state: { from: "/pane/w1%3Ap1" } },
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

describe("Files: the file view", () => {
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
    expect(screen.queryByRole("radiogroup")).toBeNull();
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

describe("Files: what a refusal reads as", () => {
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
    const router = renderAt([FILES]);
    expect(await screen.findByText(en["files.notPaired"])).toBeTruthy();
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

describe("Changes → Files: Preview from a diff", () => {
  it("offers Preview for a changed Markdown file and opens it from the root, with the repo's folder", async () => {
    const router = renderAt([
      "/pane/w1%3Ap1",
      { pathname: "/pane/w1%3Ap1/changes", state: { from: "/pane/w1%3Ap1" } },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /notes\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: en["changes.file.previewAria"] }));
    expect(router.state.location.pathname).toBe(FILES);
    expect(router.state.location.search).toBe("?path=packages%2Fapi%2Fnotes.md");
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
    expect(screen.getByRole("link", { name: "up" }).getAttribute("href")).toBe(FILES);
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
