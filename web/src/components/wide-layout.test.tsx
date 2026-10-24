import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBeltIntents, takeBeltIntent } from "@/lib/belt-intent";
import { paneRowKey } from "@/lib/hosts";
import { asJsonObject, asJsonString, parseJsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { paneScopeKey } from "@/lib/scope";
import type { AgentView } from "@/lib/types";
import { __resetWideLayoutStore } from "@/lib/wide-layout-store";
import { DetailRoute } from "@/routes/detail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

// The large-screen pane screen (ADR 0120), mounted through the real DetailRoute under the real header
// host. Only AgentChat is a stub: it is the focused column's own view, it has its own tests, and the
// rules here are about what stands around it. The stub reports the pane and whether it was told it
// stands in a strip.
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, inStrip, tabletop }: { paneId: string; inStrip?: boolean; tabletop?: boolean }) => (
    <div data-testid="chat" data-in-strip={String(inStrip === true)} data-tabletop={String(tabletop === true)}>{`pane:${paneId}`}</div>
  ),
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

function pane(paneId: string, workspaceId: string, label: string, kind: "agent" | "shell" = "agent"): AgentView {
  return {
    paneId,
    workspaceId,
    workspaceLabel: label,
    workspaceNumber: workspaceId === "w1" ? 1 : 2,
    tabId: `${workspaceId}:t1`,
    agent: kind === "agent" ? "claude" : "shell",
    paneLabel: paneId,
    status: "idle",
    cwd: "/home/me/proj",
    focused: false,
    kind,
  };
}

const A1 = pane("w1:p1", "w1", "alpha");
const A2 = pane("w1:p2", "w1", "alpha");
const A3 = pane("w1:p3", "w1", "alpha");
const SH = pane("w1:p9", "w1", "alpha", "shell");
const B1 = pane("w2:p1", "w2", "beta");

const home = (): HomeData => ({
  bridge: "connected",
  agents: [A1, A2, A3, B1],
  shellPanes: [SH],
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

function makeRouter(paneId: string) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: home,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          { path: "new", element: <div data-testid="new">NEW</div> },
          { path: "settings", element: <div data-testid="settings">SETTINGS</div> },
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

// The window's width, as the two width-class media queries read it.
let width = 1200;
// How a foldable is held, as the Viewport Segments media features read it. "flat" matches neither.
let posture: "flat" | "tabletop" | "book" = "flat";
function answer(query: string): boolean {
  if (query.includes("vertical-viewport-segments")) return posture === "tabletop";
  if (query.includes("horizontal-viewport-segments")) return posture === "book";
  const min = /min-width:\s*(\d+)px/.exec(query);
  return min !== null && width >= Number(min[1]);
}

beforeAll(() => {
  // jsdom has no scrolling; the read-only transcript pins itself to the bottom with it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  __resetWideLayoutStore();
  __resetBeltIntents();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
      ({
        matches: answer(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
  server.use(http.get("/api/pane/:id", () => HttpResponse.json({ text: "preview rows", truncated: false, revision: 1 })));
});
afterEach(() => {
  posture = "flat";
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

async function mount(paneId: string, px: number) {
  width = px;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  const router = makeRouter(paneId);
  const { container } = render(<RouterProvider router={router} />);
  await waitFor(() => expect(container.querySelector('[data-testid="chat"]')).not.toBeNull());
  return { router, container };
}

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const columns = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-col-key]")];
// A row's key holds NUL separators, which a CSS selector cannot name, so the rows are read back by value.
const sidebarRow = (root: ParentNode, p: AgentView) =>
  [...q(root, "aside")!.querySelectorAll<HTMLElement>("[data-pane-key]")].find((el) => el.dataset.paneKey === paneRowKey(p)) ?? null;
const key = (p: AgentView) => paneScopeKey({}, p.paneId);

async function openBesideFromSidebar(container: HTMLElement, p: AgentView) {
  fireEvent.contextMenu(sidebarRow(container, p)!);
  const sheet = await within(container).findByRole("button", { name: "Open beside" });
  fireEvent.click(sheet);
  await waitFor(() => expect(q(container, '[data-testid="chat"]')?.textContent).toBe(`pane:${p.paneId}`));
}

describe("below 600 px", () => {
  it("changes nothing: no sidebar, no strip, the pane view as on a phone", async () => {
    const { container } = await mount("w1:p1", 599);
    expect(q(container, '[data-slot="wide-layout"]')).toBeNull();
    expect(q(container, "aside")).toBeNull();
    expect(q(container, '[data-testid="chat"]')?.dataset.inStrip).toBe("false");
    // The one header stands at the top of the screen, not in a column, and holds the mark.
    const header = q(container, "header")!;
    expect(header.closest('[data-slot="column-head"]')).toBeNull();
    expect(q(header, '[data-slot="collie-mark"]')).not.toBeNull();
  });
});

describe("the page under the layout", () => {
  it("stops a sideways overscroll from going back while the layout is mounted, and only then", async () => {
    const root = document.documentElement;
    await mount("w1:p1", 1200);
    expect(root.style.overscrollBehaviorX).toBe("none");
    expect(q(document.body, '[data-slot="strip"]')?.className).toContain("overscroll-x-contain");
    cleanup();
    expect(root.style.overscrollBehaviorX).toBe("");
    await mount("w1:p1", 599);
    expect(root.style.overscrollBehaviorX).toBe("");
  });
});

describe("the sidebar", () => {
  it("is a raised panel with the mark, the word and an open toggle, and the header docks in the focused column", async () => {
    const { container } = await mount("w1:p1", 1200);
    const aside = q(container, "aside")!;
    expect(aside.dataset.slot).toBe("wide-sidebar");
    expect(aside.className).toContain("bg-card");
    expect(aside.style.width).toBe("320px");
    // One word in two inks: Collie in the text colour, PWA in the brand token.
    expect(q(aside, '[data-slot="sidebar-word"]')?.textContent).toBe("ColliePWA");
    expect(within(aside).getByText("PWA").className).toContain("text-brand");
    expect(q(aside, '[data-slot="sidebar-mark"] [data-slot="collie-mark"]')).not.toBeNull();
    expect(q(container, '[data-testid="chat"]')?.dataset.inStrip).toBe("true");
    // The header moved into the focused column, and the mark is not drawn twice.
    expect(q(container, "header")?.closest('[data-slot="column-head"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="collie-mark"]')).toHaveLength(1);
    // A space heading speaks in the quiet voice: the muted ink, the name's own case.
    const heading = within(aside).getByRole("heading", { name: "alpha" }).firstElementChild!;
    expect(heading.className).toContain("text-muted-foreground");
    expect(heading.className).not.toContain("label-caps");
    // Every pane is a row, the shell too, each with its full identity for the gestures.
    for (const p of [A1, A2, A3, B1]) expect(sidebarRow(container, p)).not.toBeNull();
  });

  it("is 280 px wide at medium", async () => {
    const { container } = await mount("w1:p1", 700);
    expect(q(container, "aside")?.style.width).toBe("280px");
  });

  it("closes to a rail of icons with status marks, remembered on this device", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    const toggle = q(container, '[data-slot="sidebar-toggle"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBeTruthy();
    fireEvent.click(toggle);

    const rail = await waitFor(() => {
      const el = q(container, 'aside[data-slot="rail"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(rail.style.width).toBe("56px");
    expect(q(container, '[data-slot="sidebar-toggle"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("collie:wide-sidebar:v1")).toBe("0");
    expect(within(rail).queryByText("ColliePWA")).toBeNull();
    expect(q(rail, '[data-slot="collie-mark"]')).not.toBeNull();
    // Grouped by space, every pane an icon, the shell included.
    expect(within(rail).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["alpha", "beta"]);
    for (const p of [A1, A2, A3, SH, B1]) expect(sidebarRow(container, p)).not.toBeNull();
    expect(sidebarRow(container, A1)?.getAttribute("aria-current")).toBe("true");

    // The same tap as the open sidebar.
    fireEvent.click(sidebarRow(container, A2)!);
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p2")));
  });
});

describe("the strip", () => {
  it("a tap on a row replaces the focused column", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    fireEvent.click(sidebarRow(container, A2)!);
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p2")));
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A2)]));
  });

  it("Open beside adds a column right of the focus; a tap on an open pane focuses it", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2)]);
    expect(columns(container)[1]?.hasAttribute("data-focused")).toBe(true);

    fireEvent.click(sidebarRow(container, A1)!);
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2)]);
    expect(columns(container)[0]?.hasAttribute("data-focused")).toBe(true);
  });

  it("Open here replaces the focused column", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    fireEvent.contextMenu(sidebarRow(container, A3)!);
    fireEvent.click(await within(container).findByRole("button", { name: "Open here" }));
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A3)]));
  });

  it("frames the focused column on all four sides, and reserves the frame on every column", async () => {
    const { container } = await mount("w1:p1", 1200);
    const lone = q(columns(container)[0]!, '[data-slot="column-frame"]')!;
    // One column: the frame stays off, its width still reserved.
    expect(lone.className).toContain("border-2");
    expect(lone.className).toContain("border-transparent");

    await openBesideFromSidebar(container, A2);
    const [other, focused] = columns(container).map((c) => q(c, '[data-slot="column-frame"]')!);
    expect(focused!.className).toContain("border-2");
    expect(focused!.className).toContain("border-pane-active");
    expect(other!.className).toContain("border-2");
    expect(other!.className).toContain("border-transparent");
  });

  it("shows a belt in every column, and the reply box only where the pane view is", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const other = columns(container)[0]!;
    // The column without focus: its own header, its read-only view, its belt, and no reply box.
    expect(q(other, '[data-slot="column-header"]')).not.toBeNull();
    expect(within(other).getByRole("button", { name: "Keys" })).toBeTruthy();
    expect(within(other).queryByRole("textbox")).toBeNull();
    expect(q(other, '[data-testid="chat"]')).toBeNull();
    await waitFor(() => expect(other.textContent).toContain("preview rows"));
    // The focused column holds the one pane view, which brings the belt and the reply box.
    expect(q(columns(container)[1]!, '[data-testid="chat"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="chat"]')).toHaveLength(1);
  });

  it("a belt tap in a column without focus acts on that pane and gives it the focus", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const other = columns(container)[0]!;
    fireEvent.click(within(other).getByRole("button", { name: "Keys" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
    // The tap left its act for that pane's own composer, and for no other pane.
    expect(takeBeltIntent(key(A2))).toBeNull();
    expect(takeBeltIntent(key(A1))).toEqual({ kind: "action", id: "keys" });
  });

  it("a tap on a column without focus gives it the focus", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const body = q(columns(container)[0]!, '[data-slot="column-body"]')!;
    fireEvent.pointerDown(body, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(body, { clientX: 12, clientY: 11 });
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
  });

  it("Remove from view drops a column, and the last column cannot leave", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    const lone = within(columns(container)[0]!).getByRole("button", { name: "Remove from view" });
    expect(lone).toBeDisabled();

    await openBesideFromSidebar(container, A2);
    fireEvent.click(within(columns(container)[0]!).getByRole("button", { name: "Remove from view" }));
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A2)]));
    // A removed column without focus moves nothing else.
    expect(router.state.location.pathname).toBe(panePath("w1:p2"));

    // A removed FOCUSED column hands the focus to its neighbour.
    await openBesideFromSidebar(container, A3);
    fireEvent.click(within(columns(container)[1]!).getByRole("button", { name: "Remove from view" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p2")));
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A2)]);
  });

  it("keeps each space's columns on this device", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const stored = parseJsonObject(localStorage.getItem("collie:wide-layout:v1") ?? "{}") ?? {};
    const strips = Object.values(stored).map((strip) => asJsonObject(strip)?.cols);
    expect(strips).toHaveLength(1);
    const cols = strips[0];
    expect(Array.isArray(cols) ? cols.map((c) => asJsonString(asJsonObject(c)?.key)) : null).toEqual([key(A1), key(A2)]);
  });
});

describe("width", () => {
  it("in wide mode a new column is 1/2 and the button cycles 1/2, 4/5, Full", async () => {
    // 1200 less the 320 sidebar leaves 880, at least two panes of 360.
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const col = columns(container)[0]!;
    const button = () => within(col).getByRole("button", { name: /^Width / });
    expect(button().textContent).toBe("1/2");
    expect(col.style.flex).toBe("0 0 50%");
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe("4/5"));
    expect(col.style.flex).toBe("0 0 80%");
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe("Full"));
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe("1/2"));
    // The width is the column's own: the button changes nothing about the focus.
    expect(columns(container)[1]?.hasAttribute("data-focused")).toBe(true);
  });

  it("out of wide mode every column is full width and there is no width button", async () => {
    // 700 less the 280 sidebar leaves 420, under two panes of 360.
    const { container } = await mount("w1:p1", 700);
    await openBesideFromSidebar(container, A2);
    for (const col of columns(container)) {
      expect(col.style.flex).toBe("0 0 100%");
      expect(within(col).queryByRole("button", { name: /^Width / })).toBeNull();
    }
  });
});

describe("adding", () => {
  const slot = (root: ParentNode) => q(root, '[data-slot="add-slot"]');

  it("the add slot stands in the strip's free width, and only while the columns leave some", async () => {
    // One column at 1/2 of 880 leaves half the strip.
    const { container } = await mount("w1:p1", 1200);
    expect(slot(container)?.style.flex).toBe("0 0 50%");
    expect(within(slot(container)!).getByRole("button", { name: "Add a pane" })).toBeTruthy();
    const widthButton = () => within(columns(container)[0]!).getByRole("button", { name: /^Width / });
    fireEvent.click(widthButton());
    await waitFor(() => expect(widthButton().textContent).toBe("4/5"));
    expect(Number.parseFloat(slot(container)!.style.flex.split(" ")[2]!)).toBeCloseTo(20);
    fireEvent.click(widthButton());
    await waitFor(() => expect(widthButton().textContent).toBe("Full"));
    expect(slot(container)).toBeNull();
    // Two half columns fill the strip.
    fireEvent.click(widthButton());
    await openBesideFromSidebar(container, A2);
    expect(slot(container)).toBeNull();
  });

  it("is absent out of wide mode, where every column is full width", async () => {
    const { container } = await mount("w1:p1", 700);
    expect(slot(container)).toBeNull();
  });

  it("lists this space's panes the strip does not show, each to open beside the focus", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    fireEvent.click(within(slot(container)!).getByRole("button", { name: "Add a pane" }));
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-slot="add-row"]')];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // Not the pane in view, not another space's pane; the space's shell is a pane like the others.
    expect(rows.map((r) => r.textContent)).toEqual([A2, A3, SH].map((p) => `${p.paneLabel}Open beside`));
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /^Open beside/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p2")));
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2)]);
  });

  it("its New agent goes down to the New page", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    fireEvent.click(within(slot(container)!).getByRole("button", { name: "Add a pane" }));
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="add-row"]')?.parentElement;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "New agent in a new space" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
  });
});

describe("the sidebar's own entries", () => {
  async function toRail(root: HTMLElement) {
    fireEvent.click(q(root, '[data-slot="sidebar-toggle"]')!);
    return await waitFor(() => {
      const el = q(root, 'aside[data-slot="rail"] [data-slot="sidebar-foot"]');
      expect(el).not.toBeNull();
      return el!;
    });
  }

  it("New space goes down to the New page, from the open sidebar and from the rail", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    fireEvent.click(within(q(container, '[data-slot="sidebar-foot"]')!).getByRole("button", { name: "New space" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    cleanup();
    const again = await mount("w1:p1", 1200);
    const foot = await toRail(again.container);
    fireEvent.click(within(foot).getByRole("button", { name: "New space" }));
    await waitFor(() => expect(again.router.state.location.pathname).toBe("/new"));
  });

  it("the gear beside it goes down to Settings, from the open sidebar and from the rail", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    fireEvent.click(within(q(container, '[data-slot="sidebar-foot"]')!).getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    cleanup();
    const again = await mount("w1:p1", 1200);
    const foot = await toRail(again.container);
    fireEvent.click(within(foot).getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(again.router.state.location.pathname).toBe("/settings"));
  });

  it("the logo row is the mark's button: a tap on the word is the mark's tap", async () => {
    // The mark goes where the pane view's header tells it (up to the dashboard); AgentChat is a stub
    // here, so what is proven is that the word hands its tap to the mark and is no control of its own.
    const { container } = await mount("w1:p1", 1200);
    const word = q(container, '[data-slot="sidebar-word"]')!;
    expect(word.getAttribute("aria-hidden")).toBe("true");
    expect(word.tabIndex).toBe(-1);
    const mark = q(container, '[data-slot="sidebar-mark"] button')!;
    expect(mark.getAttribute("aria-label")).toBeTruthy();
    const taps = vi.fn();
    mark.addEventListener("click", taps);
    fireEvent.click(word);
    expect(taps).toHaveBeenCalledTimes(1);
  });
});

describe("the space header", () => {
  it("names the space, counts it, and moves to the next space's remembered pane", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    const header = q(container, '[data-slot="space-header"]')!;
    expect(header.textContent).toContain("alpha");
    expect(header.textContent).toContain("space 1 of 2");
    expect(within(header).getByRole("button", { name: "Previous space" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(within(header).getByRole("button", { name: "Next space" }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w2:p1")));
    expect(q(container, '[data-slot="space-header"]')?.textContent).toContain("space 2 of 2");
    // Back up: alpha's own focus is where it was left.
    fireEvent.click(within(q(container, '[data-slot="space-header"]')!).getByRole("button", { name: "Previous space" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
  });
});

/** A soft keyboard for `useKeyboardOpen`, which reads `visualViewport` (jsdom has none). */
function withSoftKeyboard() {
  const listeners = new Set<() => void>();
  const vv = {
    width: 900,
    height: 800,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return {
    open: (height: number) => {
      vv.height = height;
      act(() => listeners.forEach((fn) => fn()));
    },
    restore: () => Reflect.deleteProperty(window, "visualViewport"),
  };
}

const frame = (root: ParentNode) => q(root, '[data-slot="fold-frame"]')!;
const chat = (root: ParentNode) => q(root, '[data-testid="chat"]')!;

describe("folded postures", () => {
  it("flat: no browser that lacks the segment features sees a fold", async () => {
    const { container } = await mount("w1:p1", 1200);
    expect(frame(container).dataset.fold).toBe("flat");
    expect(chat(container).dataset.tabletop).toBe("false");
    expect(container.querySelectorAll("[data-segment]")).toHaveLength(0);
  });

  it("tabletop on a phone-width screen: the pane view sends its belt and reply box under the fold", async () => {
    posture = "tabletop";
    const { container } = await mount("w1:p1", 412);
    expect(q(container, '[data-slot="wide-layout"]')).toBeNull();
    expect(frame(container).dataset.fold).toBe("tabletop");
    expect(chat(container).dataset.tabletop).toBe("true");
    // The header stays above the fold, in the frame that ends at the top segment.
    expect(q(container, "header")?.closest('[data-segment="bottom"]')).toBeNull();
  });

  it("tabletop on a large screen: the other columns show their Chat only, with no belt", async () => {
    posture = "tabletop";
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const other = columns(container)[0]!;
    expect(q(other, '[data-slot="column-body"]')).not.toBeNull();
    expect(q(other, '[data-slot="chrome-block"]')).toBeNull();
    expect(within(other).queryByRole("button", { name: "Keys" })).toBeNull();
    expect(chat(container).dataset.tabletop).toBe("true");
  });

  it("tabletop falls back to the normal layout while the soft keyboard is up", async () => {
    posture = "tabletop";
    const kb = withSoftKeyboard();
    try {
      const { container } = await mount("w1:p1", 1200);
      expect(frame(container).dataset.fold).toBe("tabletop");
      const view = chat(container);
      kb.open(400);
      await waitFor(() => expect(frame(container).dataset.fold).toBe("flat"));
      expect(chat(container).dataset.tabletop).toBe("false");
      // The same pane view, not a new one: the keyboard's field keeps its focus.
      expect(chat(container)).toBe(view);
    } finally {
      kb.restore();
    }
  });

  it("book with two columns: the rail and one column in the left segment, the other in the right, a gutter between", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    // Unfolded to a book: mount again under the new media answer, on the layout the device kept.
    cleanup();
    posture = "book";
    const folded = await mount("w1:p2", 1200);
    const root = folded.container;
    const aside = q(root, "aside")!;
    expect(aside.dataset.slot).toBe("rail");
    expect(aside.dataset.segment).toBe("left");
    // A presentation only: the stored choice is still "open".
    expect(localStorage.getItem("collie:wide-sidebar:v1")).toBeNull();
    expect(q(root, '[data-slot="sidebar-toggle"]')).toBeNull();
    const strip = q(root, '[data-slot="strip"]')!;
    const parts = [...strip.children].map((el) => (el instanceof HTMLElement ? (el.dataset.segment ?? el.dataset.slot) : ""));
    expect(parts).toEqual(["left", "fold-gutter", "right"]);
    expect(columns(root).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2)]);
    // The presets rest while folded: no width button, no inline width, no position strip.
    for (const col of columns(root)) {
      expect(within(col).queryByRole("button", { name: /^Width / })).toBeNull();
      expect(col.style.flex).toBe("");
    }
    expect(q(root, '[data-slot="position-strip"]')).toBeNull();
    // The space header is cut at the fold too.
    expect(q(q(root, '[data-slot="space-header"]')!, ".fold-gutter")).not.toBeNull();
  });

  it("book with one column: the full sidebar fills the left segment and the column the right one", async () => {
    posture = "book";
    const { container } = await mount("w1:p1", 1200);
    const aside = q(container, "aside")!;
    expect(aside.dataset.slot).toBe("wide-sidebar");
    expect(aside.className).toContain("fold-left-full");
    expect(aside.nextElementSibling instanceof HTMLElement && aside.nextElementSibling.dataset.slot).toBe("fold-gutter");
    const right = q(container, '[data-segment="right"]')!;
    expect(q(right, "[data-col-key]")?.dataset.colKey).toBe(key(A1));
  });

  it("book shows the focused column and its neighbour, and only from 600 px", async () => {
    const flat = await mount("w1:p1", 1200);
    await openBesideFromSidebar(flat.container, A2);
    await openBesideFromSidebar(flat.container, A3);
    expect(columns(flat.container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2), key(A3)]);
    // One screen at a time: two mounted layouts on two routes would each move the shared focus.
    cleanup();
    posture = "book";
    // The focus at the end: it and its left neighbour.
    const last = await mount("w1:p3", 1200);
    expect(columns(last.container).map((c) => c.dataset.colKey)).toEqual([key(A2), key(A3)]);
    cleanup();
    // The focus first: it and its right neighbour.
    const first = await mount("w1:p1", 1200);
    expect(columns(first.container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2)]);
    cleanup();
    const phone = await mount("w1:p1", 599);
    expect(frame(phone.container).dataset.fold).toBe("flat");
    expect(q(phone.container, "aside")).toBeNull();
  });
});
