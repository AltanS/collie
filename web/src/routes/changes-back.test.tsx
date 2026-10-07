import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetChangeCountCache } from "@/hooks/use-workspace-change-counts";
import { resetChangesListCache } from "@/lib/changes-list-cache";
import { clearHeldImages } from "@/lib/file-image-cache";
import { en } from "@/lib/i18n/messages/en";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";

import { ChangesRoute } from "./changes";

// THE PHONE'S BOTTOM BACK. The header arrow is out of a thumb's reach on a large phone, so below the
// `md` breakpoint every level of the Changes / Files screen repeats its Back at the foot, on the
// thumb side, running the very handler and wearing the very name of the arrow above. A diff carries
// it in the Previous / Next bar; every other level has a bar of its own, Back alone.

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
    // The pane under the screen, so every level has a legitimate parent entry to step back onto.
    { initialEntries: [PANE, url], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const realMatchMedia = window.matchMedia;
/** A phone viewport answers the screen's `max-width` query yes; a wide one answers it no. */
function viewport(kind: "phone" | "wide") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: kind === "phone" && query.includes("max-width"),
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

beforeEach(() => viewport("phone"));

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia });
  localStorage.clear();
  resetChangesListCache();
  resetChangeCountCache();
  clearHeldImages();
});

const bar = () => document.querySelector<HTMLElement>('[data-slot="bottom-bar"]');
const where = (router: ReturnType<typeof renderAt>) => router.state.location.pathname + router.state.location.search;

/** Each level of the screen: what is stored for the cases, and the address, and what must show first. */
const LEVELS: { name: string; url: string; changesOnly: boolean; ready: () => Promise<HTMLElement> }[] = [
  { name: "the Changes list", url: CHANGES, changesOnly: true, ready: () => screen.findByText("webapp · 3 files") },
  {
    name: "a diff",
    url: `${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`,
    changesOnly: true,
    ready: () => screen.findByText(/checkout\.tsx/),
  },
  {
    name: "the commit view",
    url: `${CHANGES}/commit?repo=.`,
    changesOnly: true,
    ready: () => screen.findByText("3f2a9c1"),
  },
  { name: "the Files tree root", url: CHANGES, changesOnly: false, ready: () => screen.findByRole("button", { name: /^docs, folder/ }) },
  { name: "a folder", url: `${FILES}?dir=src`, changesOnly: false, ready: () => screen.findByRole("button", { name: /^cart\.ts/ }) },
  { name: "a file", url: `${FILES}?path=src%2Fcart.ts`, changesOnly: false, ready: () => screen.findByText(/cartTotal/) },
  { name: "an image file", url: `${FILES}?path=logo.png`, changesOnly: false, ready: () => screen.findByRole("img", { name: "logo.png" }) },
];

describe("Changes: the phone's bottom Back", () => {
  for (const level of LEVELS) {
    describe(level.name, () => {
      beforeEach(() => {
        localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: level.changesOnly }));
      });

      it("has a bar, a Back in it named like the header arrow, and the arrow stays", async () => {
        renderAt(level.url);
        await level.ready();
        const footer = bar();
        if (footer === null) throw new Error("no bottom bar on a phone");
        const label = within(footer).getByText(en["files.back"]).closest("button")?.getAttribute("aria-label");
        if (label === undefined || label === null || label === "") throw new Error("no named Back in the bar");
        // The visible word, and the same name as the arrow above, which is still there.
        expect(within(footer).getByText(en["files.back"])).toBeTruthy();
        const arrows = screen.getAllByRole("button", { name: label }).filter((b) => !footer.contains(b));
        expect(arrows.length).toBe(1);
      });

      it("lands where the header arrow lands", async () => {
        const viaBar = renderAt(level.url);
        await level.ready();
        const footer = bar();
        if (footer === null) throw new Error("no bottom bar on a phone");
        const back = within(footer).getByText(en["files.back"]).closest("button");
        if (back === null) throw new Error("no Back button");
        const label = back.getAttribute("aria-label") ?? "";
        const arrow = screen.getAllByRole("button", { name: label }).find((b) => !footer.contains(b));
        if (arrow === undefined) throw new Error("no header arrow");
        await userEvent.click(back);
        const landed = where(viaBar);
        expect(landed).not.toBe(level.url);
        cleanup();
        resetChangesListCache();

        const viaArrow = renderAt(level.url);
        await level.ready();
        const again = bar();
        if (again === null) throw new Error("no bottom bar on a phone");
        const name = within(again).getByText(en["files.back"]).closest("button")?.getAttribute("aria-label") ?? "";
        await userEvent.click(screen.getAllByRole("button", { name }).find((b) => !again.contains(b)) ?? arrow);
        expect(where(viaArrow)).toBe(landed);
      });
    });
  }

  describe("the bar", () => {
    beforeEach(() => {
      localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    });

    it("holds Back alone at the right end for the right hand", async () => {
      renderAt(CHANGES);
      await screen.findByText("webapp · 3 files");
      const footer = bar();
      if (footer === null) throw new Error("no bottom bar");
      expect(within(footer).getAllByRole("button").length).toBe(1);
      expect(footer.className).toContain("justify-end");
    });

    it("puts Back at the left end for the left hand", async () => {
      localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ hand: "left" }));
      renderAt(CHANGES);
      await screen.findByText("webapp · 3 files");
      expect(bar()?.className).toContain("justify-start");
    });

    it("joins Previous and Next on a diff in one bar, Back at the thumb's end", async () => {
      renderAt(`${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
      await screen.findByText(/checkout\.tsx/);
      expect(document.querySelectorAll('[data-slot="bottom-bar"]').length).toBe(1);
      const names = () =>
        Array.from(bar()?.querySelectorAll("button") ?? []).map((b) => b.textContent);
      expect(names()).toEqual([en["changes.file.prev"], en["changes.file.next"], en["files.back"]]);
    });

    it("turns the diff's bar round for the left hand", async () => {
      localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ hand: "left" }));
      renderAt(`${CHANGES}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
      await screen.findByText(/checkout\.tsx/);
      const names = Array.from(bar()?.querySelectorAll("button") ?? []).map((b) => b.textContent);
      expect(names).toEqual([en["files.back"], en["changes.file.prev"], en["changes.file.next"]]);
    });
  });

  describe("the on-screen keyboard", () => {
    afterEach(() => {
      Reflect.deleteProperty(window, "visualViewport");
    });

    it("takes the bar away while the keyboard is up, and brings it back", async () => {
      localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
      const listeners: (() => void)[] = [];
      const screenView = {
        height: 800,
        width: 400,
        addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
        removeEventListener: () => undefined,
      };
      Object.defineProperty(window, "visualViewport", { configurable: true, value: screenView });
      renderAt(CHANGES);
      await screen.findByText("webapp · 3 files");
      expect(bar()).not.toBeNull();
      screenView.height = 450;
      act(() => listeners.forEach((fn) => fn()));
      expect(bar()).toBeNull();
      screenView.height = 800;
      act(() => listeners.forEach((fn) => fn()));
      expect(bar()).not.toBeNull();
    });
  });

  describe("a wide screen", () => {
    beforeEach(() => viewport("wide"));

    for (const level of LEVELS) {
      it(`draws no bar on ${level.name}, and the header arrow stays`, async () => {
        localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: level.changesOnly }));
        renderAt(level.url);
        await level.ready();
        // A diff keeps its Previous / Next bar at every width; it just holds no Back.
        const footer = bar();
        expect(footer === null || within(footer).queryByText(en["files.back"]) === null).toBe(true);
        if (level.name !== "a diff") expect(footer).toBeNull();
        expect(screen.getByRole("button", { name: /^(Back|Up one)/ })).toBeTruthy();
      });
    }
  });
});
