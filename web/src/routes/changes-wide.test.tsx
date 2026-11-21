import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiffView } from "@/components/changes-view";
import { resetChangesListCache } from "@/lib/changes-list-cache";
import { __resetDiffLayout, diffLayoutFor, SPLIT_MIN_COLUMN_PX } from "@/lib/diff-layout";
import { clearHeldImages } from "@/lib/file-image-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";

import { ChangesRoute } from "./changes";

// FILES AND CHANGES ON A LARGE SCREEN (ADR 0173): two columns under one header. The left column
// holds the tree, which opens folders in place, or the list of changes; the right column holds the open file. Only a
// file is a new history entry, and the header's arrow leaves the screen.

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

const PANE = "/pane/w1%3Ap1";
const CHANGES = `${PANE}/changes`;
const FILES = `${PANE}/changes/files`;

function renderAt(url: string) {
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
        ],
      },
    ],
    { initialEntries: [PANE, url], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const realMatchMedia = window.matchMedia;
/** A large screen: every `min-width` and `min-height` query answers yes, so the width class is `expanded`. */
function largeScreen() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("min-width") || query.includes("min-height"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => largeScreen());

afterEach(() => {
  cleanup();
  localStorage.clear();
  __resetDiffLayout();
  resetChangesListCache();
  clearHeldImages();
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia });
});

const where = (router: ReturnType<typeof renderAt>) => router.state.location.pathname + router.state.location.search;
const tree = (path: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-tree-path="${path}"]`);
    if (el === null) throw new Error(`no row ${path}`);
    return el;
  });
const item = (name: string) => screen.findByRole("treeitem", { name: new RegExp(`^${name}`) });

describe("Files on a large screen: the tree", () => {
  it("opens and closes a folder in place, with no new address", async () => {
    const router = renderAt(CHANGES);
    const src = await item("src");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(src);
    expect(await item("lib")).toBeTruthy();
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(where(router)).toBe(CHANGES);
    await userEvent.click(src);
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /^lib/ })).toBeNull());
    expect(where(router)).toBe(CHANGES);
  });

  it("walks the rows with the arrow keys: Down and Up move, Right opens a folder, Left closes it", async () => {
    renderAt(CHANGES);
    const docs = await item("docs");
    act(() => docs.focus());
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-tree-path")).toBe("packages");
    await userEvent.keyboard("{End}");
    const last = document.activeElement?.getAttribute("data-tree-path");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement?.getAttribute("data-tree-path")).toBe("docs");
    expect(last).not.toBe("docs");
    const src = await item("src");
    act(() => src.focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(await item("lib")).toBeTruthy();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.getAttribute("data-tree-path")).toBe("src/lib");
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.getAttribute("data-tree-path")).toBe("src");
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(src.getAttribute("aria-expanded")).toBe("false"));
  });

  it("keeps one tab stop for the whole tree", async () => {
    renderAt(CHANGES);
    await item("src");
    const stops = screen.getAllByRole("treeitem").filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it("opens the folders above a deep link and marks the file", async () => {
    renderAt(`${FILES}?path=src/lib/cart.ts`);
    const file = await tree("src/lib/cart.ts");
    expect(file.getAttribute("data-tree-path")).toBe("src/lib/cart.ts");
    expect(file.getAttribute("aria-current")).toBe("page");
    expect((await item("src")).getAttribute("aria-expanded")).toBe("true");
    expect((await item("lib")).getAttribute("aria-expanded")).toBe("true");
  });

  it("says what the right column is for while no file is chosen", async () => {
    renderAt(CHANGES);
    expect(await screen.findByText(en["files.nothingChosen"])).toBeTruthy();
  });

  it("keeps the mode control on top of the left column while a file is open", async () => {
    renderAt(`${FILES}?path=src/lib/cart.ts`);
    await tree("src/lib/cart.ts");
    const aside = document.querySelector("aside");
    if (aside === null) throw new Error("no left column");
    expect(within(aside).getByRole("radiogroup")).toBeTruthy();
  });
});

describe("Files on a large screen: the history", () => {
  it("adds one entry per file, Back returns to the file before, and the header arrow leaves Files", async () => {
    const router = renderAt(CHANGES);
    await userEvent.click(await item("src"));
    await userEvent.click(await item("lib"));
    await userEvent.click(await tree("src/lib/cart.ts"));
    await waitFor(() => expect(where(router)).toBe(`${FILES}?path=src%2Flib%2Fcart.ts`));
    await userEvent.click(await item("routes"));
    await userEvent.click(await screen.findByRole("treeitem", { name: /^checkout\.tsx/ }));
    await waitFor(() => expect(where(router)).toBe(`${FILES}?path=src%2Froutes%2Fcheckout.tsx`));
    // The folders opened on the way added nothing: one step back is the file before.
    await act(() => router.navigate(-1));
    expect(where(router)).toBe(`${FILES}?path=src%2Flib%2Fcart.ts`);
    await act(() => router.navigate(-1));
    expect(where(router)).toBe(CHANGES);
    await act(() => router.navigate(1));
    await tree("src/lib/cart.ts");
    // The arrow leaves Files for the pane, past the files opened on the way.
    await userEvent.click(screen.getByRole("button", { name: en["changes.backAria.pane"] }));
    expect(await screen.findByText("pane screen")).toBeTruthy();
  });
});

describe("Files on a large screen: a file's row", () => {
  it("holds Previous file and Next file, with the foot bar's names and disabled rule, and no foot bar", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    renderAt(`${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
    const prev = await screen.findByRole("button", { name: en["changes.file.prev"] });
    const next = screen.getByRole("button", { name: en["changes.file.next"] });
    await waitFor(() => expect(next).toBeEnabled());
    expect(prev).toBeDisabled();
    expect(prev.closest("[data-slot=file-steps]")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: en["changes.file.prev"] })).toHaveLength(1);
  });

  it("keeps the person's choice of side by side on this device", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    renderAt(`${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
    const split = await screen.findByRole("radio", { name: en["changes.diffLayout.split"] });
    // jsdom measures the column at 0px: one column until a choice.
    expect(screen.getByRole("radio", { name: en["changes.diffLayout.unified"] }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.querySelector("[data-slot=diff]")).not.toBeNull());
    expect(document.querySelector("[data-split]")).toBeNull();
    await userEvent.click(split);
    expect(localStorage.getItem("collie:diff-layout:v1")).toBe("split");
    expect(document.querySelector("[data-slot=diff][data-split]")).not.toBeNull();
    cleanup();
    __resetDiffLayout();
    renderAt(`${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
    expect((await screen.findByRole("radio", { name: en["changes.diffLayout.split"] })).getAttribute("aria-checked")).toBe("true");
  });

  it("draws a new file in one column, with the control disabled", async () => {
    localStorage.setItem("collie:diff-layout:v1", "split");
    __resetDiffLayout();
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    renderAt(`${CHANGES}?repo=.&path=src%2Flib%2Fcart.ts`);
    const unified = await screen.findByRole("radio", { name: en["changes.diffLayout.unified"] });
    await waitFor(() => expect(unified).toBeDisabled());
    expect(unified.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: en["changes.diffLayout.split"] })).toBeDisabled();
    await waitFor(() => expect(document.querySelector("[data-slot=diff]")).not.toBeNull());
    expect(document.querySelector("[data-split]")).toBeNull();
  });

  it("draws the list of changes as flat rows, the open file chosen", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true, changesLayout: "list" }));
    renderAt(`${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
    await screen.findByRole("radio", { name: en["changes.diffLayout.split"] });
    const aside = document.querySelector("aside");
    if (aside === null) throw new Error("no left column");
    const chosen = await waitFor(() => {
      const el = aside.querySelector("[aria-current=page]");
      if (el === null) throw new Error("no chosen row");
      return el;
    });
    expect(chosen.textContent).toContain("checkout.tsx");
    expect(chosen.className).toContain("h-9");
    expect(chosen.className).toContain("pointer-coarse:h-11");
  });
});

describe("the diff layout rule", () => {
  it("opens side by side from 1200px of column width, in one column at 1199px", () => {
    expect(SPLIT_MIN_COLUMN_PX).toBe(1200);
    expect(diffLayoutFor(null, 1199)).toBe("unified");
    expect(diffLayoutFor(null, 1200)).toBe("split");
  });

  it("lets a kept choice win at every width", () => {
    expect(diffLayoutFor("unified", 1600)).toBe("unified");
    expect(diffLayoutFor("split", 900)).toBe("split");
  });
});

describe("the split diff", () => {
  const DIFF = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n");

  it("draws a comment no line anchors above the first hunk, across both halves", () => {
    const comment = { id: 7, repo: ".", path: "a.ts", rowKeys: ["add:9:9:gone"], lineLabel: "+9", linesText: ["+gone"], note: "still here" };
    render(
      <DiffView
        diff={DIFF}
        path="a.ts"
        split
        commenting={{ selectedKeys: new Set(), onToggleRow: () => undefined, comments: [comment], onEditComment: () => undefined }}
      />,
    );
    const body = document.querySelector("[data-slot=diff][data-split]");
    if (!(body instanceof HTMLElement)) throw new Error("the diff is not side by side");
    const chip = within(body).getByRole("button", { name: /still here/ });
    expect(body.firstElementChild).toBe(chip);
  });

  it("stays in one column for a diff with one side", () => {
    const added = ["--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1,2 @@", "+one", "+two", ""].join("\n");
    render(<DiffView diff={added} path="n.ts" split />);
    expect(document.querySelector("[data-slot=diff]")).not.toBeNull();
    expect(document.querySelector("[data-split]")).toBeNull();
  });
});
