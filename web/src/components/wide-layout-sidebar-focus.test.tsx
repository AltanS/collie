import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBeltIntents } from "@/lib/belt-intent";
import { useShortcutKeyboard } from "@/hooks/use-shortcuts";
import { paneRowKey } from "@/lib/hosts";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { __resetOpenBeside } from "@/lib/open-beside";
import { __resetShortcutRegistry, runShortcutAction } from "@/lib/shortcuts/registry";
import { __resetSidebarFocus } from "@/lib/shortcuts/sidebar-focus";
import { __resetShortcutState } from "@/lib/shortcuts/state";
import type { AgentView } from "@/lib/types";
import { __resetWideLayoutStore } from "@/lib/wide-layout-store";
import { DetailRoute } from "@/routes/detail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { ShortcutBarHost } from "./shortcut-bar-host";

// THE SIDEBAR FOCUS OF NAVIGATE MODE (M108), through the real DetailRoute, the real root listener and the
// real bar. The keys are real key events: `prefix+w` puts a ring on a row of the sidebar, `j` and `k` move
// only the ring, `Enter` opens the row as a click would, `Esc` leaves. Only AgentChat is a stub.
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId }: { paneId: string }) => <div data-testid="chat">{`pane:${paneId}`}</div>,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));
vi.mock("@/hooks/use-strip-snap", () => ({ useStripSnap: () => {} }));

function pane(paneId: string, workspaceId: string, label: string): AgentView {
  return {
    paneId,
    workspaceId,
    workspaceLabel: label,
    workspaceNumber: workspaceId === "w1" ? 1 : 2,
    tabId: `${workspaceId}:t1`,
    agent: "claude",
    paneLabel: paneId,
    status: "idle",
    cwd: "/home/me/proj",
    focused: false,
    kind: "agent",
  };
}

const A1 = pane("w1:p1", "w1", "alpha");
const A2 = pane("w1:p2", "w1", "alpha");
const A3 = pane("w1:p3", "w1", "alpha");
const B1 = pane("w2:p1", "w2", "beta");
const PANES = [A1, A2, A3, B1];

const home = (): HomeData => ({
  bridge: "connected",
  agents: PANES,
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

/** What `RootLayout` mounts: the key listener and the bar, beside the screen. */
function Keyboard() {
  const { pathname, search } = useLocation();
  useShortcutKeyboard(`${pathname}${search}`);
  return <ShortcutBarHost />;
}

function makeRouter(paneId: string) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: home,
        element: withHeaderHost(
          <>
            <Keyboard />
            <Outlet />
          </>,
        ),
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          {
            path: "pane/:paneId",
            loader: ({ params }): PaneData => ({
              paneId: params.paneId ?? "",
              scope: {},
              text: "",
              truncated: false,
              requestedLines: 600,
              revision: 0,
              error: false,
              authError: false,
            }),
            element: <DetailRoute />,
          },
        ],
      },
    ],
    { initialEntries: [panePath(paneId)] },
  );
}

const width = 1200;
beforeAll(() => {
  // jsdom has no scrolling.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  __resetWideLayoutStore();
  __resetBeltIntents();
  __resetOpenBeside();
  __resetShortcutState();
  __resetSidebarFocus();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
      ({
        matches: /min-width:\s*(\d+)px/.test(query) && width >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1]),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
  server.use(
    http.get("/api/pane/:id", () => HttpResponse.json({ text: "preview rows", truncated: false, revision: 1 })),
    http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetSidebarFocus();
  __resetWideLayoutStore();
});

async function mount(paneId: string) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const router = makeRouter(paneId);
  const { container } = render(<RouterProvider router={router} />);
  await waitFor(() => expect(container.querySelector('[data-testid="chat"]')).not.toBeNull());
  // The root listener publishes its keymap from an effect.
  await waitFor(() => expect(container.querySelector("aside")).not.toBeNull());
  return { router, container };
}

const press = (init: KeyboardEventInit) => fireEvent.keyDown(document.body, init);
const CTRL_B = { key: "b", ctrlKey: true } as const;
function enterNavigate() {
  press(CTRL_B);
  press({ key: "w" });
}

const rowsOf = (container: ParentNode) => [...container.querySelectorAll<HTMLElement>('aside [data-slot="pane-row"]')];
const ringed = (container: ParentNode) => container.querySelector<HTMLElement>("[data-shortcut-focus]");
/** The ringed row, or a failure that says so, so no test casts a maybe-null. */
function ringedRow(container: ParentNode): HTMLElement {
  const row = ringed(container);
  if (row === null) throw new Error("No row wears the focus ring");
  return row;
}
const paneOf = (row: HTMLElement | null) => PANES.find((candidate) => paneRowKey(candidate) === row?.dataset.paneKey);
const asideSlot = (container: ParentNode) => container.querySelector("aside")?.dataset.slot;
const barText = () => document.querySelector('[data-slot="shortcut-mode-bar"]')?.textContent ?? "";

describe("Navigate mode on the sidebar", () => {
  it("puts the ring on the row of the current pane, and names it for a screen reader", async () => {
    const { container } = await mount(A2.paneId);
    enterNavigate();
    await waitFor(() => expect(ringed(container)).not.toBeNull());
    expect(paneOf(ringed(container))).toBe(A2);
    const list = container.querySelector('[data-slot="sidebar-list"]');
    expect(list?.getAttribute("aria-activedescendant")).toBe(ringed(container)?.id);
    expect(ringed(container)?.id).not.toBe("");
  });

  it("moves only the ring on j and k, never the route or the view, and stops at the ends", async () => {
    const { container, router } = await mount(A2.paneId);
    enterNavigate();
    await waitFor(() => expect(ringed(container)).not.toBeNull());
    const rows = rowsOf(container);
    const at = rows.indexOf(ringedRow(container));
    press({ key: "j" });
    expect(ringed(container)).toBe(rows[at + 1]);
    press({ key: "ArrowDown" });
    expect(ringed(container)).toBe(rows[at + 2]);
    press({ key: "k" });
    expect(ringed(container)).toBe(rows[at + 1]);
    for (let step = 0; step < rows.length + 2; step++) press({ key: "ArrowUp" });
    expect(ringed(container)).toBe(rows[0]);
    for (let step = 0; step < rows.length + 2; step++) press({ key: "j" });
    expect(ringed(container)).toBe(rows.at(-1));
    expect(router.state.location.pathname).toBe(panePath(A2.paneId));
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe(`pane:${A2.paneId}`);
    // Only one row wears the ring.
    expect(container.querySelectorAll("[data-shortcut-focus]")).toHaveLength(1);
  });

  it("opens the focused row on Enter, as a click would, and leaves the mode", async () => {
    const { container, router } = await mount(A2.paneId);
    enterNavigate();
    await waitFor(() => expect(ringed(container)).not.toBeNull());
    press({ key: "j" });
    const target = paneOf(ringed(container));
    expect(target).not.toBe(A2);
    press({ key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath(target?.paneId ?? "")));
    expect(ringed(container)).toBeNull();
    expect(barText()).toBe("");
    // The mode is over: a bare j is typing again.
    expect(press({ key: "j" })).toBe(true);
  });

  it("leaves on Esc with no route change, and the sidebar stays open when it was open", async () => {
    const { container, router } = await mount(A2.paneId);
    enterNavigate();
    await waitFor(() => expect(ringed(container)).not.toBeNull());
    press({ key: "j" });
    press({ key: "Escape" });
    expect(ringed(container)).toBeNull();
    expect(router.state.location.pathname).toBe(panePath(A2.paneId));
    expect(asideSlot(container)).toBe("wide-sidebar");
  });

  it("opens a hidden sidebar for the mode, and hides it again on Esc", async () => {
    const { container, router } = await mount(A2.paneId);
    act(() => {
      runShortcutAction("toggle_sidebar");
    });
    await waitFor(() => expect(asideSlot(container)).toBe("rail"));
    enterNavigate();
    await waitFor(() => expect(asideSlot(container)).toBe("wide-sidebar"));
    await waitFor(() => expect(paneOf(ringed(container))).toBe(A2));
    press({ key: "Escape" });
    await waitFor(() => expect(asideSlot(container)).toBe("rail"));
    expect(ringed(container)).toBeNull();
    expect(router.state.location.pathname).toBe(panePath(A2.paneId));
  });

  it("opens the row on Enter from a hidden sidebar, then hides the sidebar again", async () => {
    const { container, router } = await mount(A2.paneId);
    act(() => {
      runShortcutAction("toggle_sidebar");
    });
    await waitFor(() => expect(asideSlot(container)).toBe("rail"));
    enterNavigate();
    await waitFor(() => expect(paneOf(ringed(container))).toBe(A2));
    press({ key: "j" });
    const target = paneOf(ringed(container));
    press({ key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath(target?.paneId ?? "")));
    await waitFor(() => expect(asideSlot(container)).toBe("rail"));
  });

  it("shows the mode's own bar text", async () => {
    await mount(A2.paneId);
    enterNavigate();
    await waitFor(() => expect(document.querySelector('[data-slot="shortcut-mode-bar"]')).not.toBeNull());
    const text = barText().replaceAll(/\s+/gu, "");
    expect(text).toContain("Navigate");
    expect(text).toContain("Move:jk↑↓");
    expect(text).toContain("Open:Enter");
    expect(text).toContain("Leave:Esc");
    press({ key: "Escape" });
    expect(document.querySelector('[data-slot="shortcut-mode-bar"]')).toBeNull();
  });

  it("does not take h, l or a tab number in the mode: they are swallowed", async () => {
    const { container, router } = await mount(A2.paneId);
    enterNavigate();
    await waitFor(() => expect(ringed(container)).not.toBeNull());
    const before = ringed(container);
    for (const key of ["h", "l", "3"]) expect(press({ key }), key).toBe(false);
    expect(ringed(container)).toBe(before);
    expect(router.state.location.pathname).toBe(panePath(A2.paneId));
  });
});
