import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import type { RefObject } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBeltIntents, takeBeltIntent } from "@/lib/belt-intent";
import { paneRowKey } from "@/lib/hosts";
import { asJsonObject, asJsonString, parseJsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { readAgentLaunch } from "@/lib/agent-startup";
import { __resetOpenBeside } from "@/lib/open-beside";
import { paneScopeKey } from "@/lib/scope";
import { statusLabel, type AgentView, type DeviceAuth, type TabView } from "@/lib/types";
import { __resetWideLayoutStore, setWideLayoutMode } from "@/lib/wide-layout-store";
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
// The wheel settle has its own tests (hooks/use-strip-snap.test.tsx). Here it is caught, so a test can
// end a gesture by hand over a strip whose boxes it has laid out itself (jsdom lays out nothing).
interface CaughtSnap {
  onSettled?: (left: number) => void;
  columnStarts: () => number[];
}
interface SnapCatch {
  options: CaughtSnap | null;
}
const snap = vi.hoisted((): SnapCatch => ({ options: null }));
vi.mock("@/hooks/use-strip-snap", () => ({
  useStripSnap: (_el: RefObject<HTMLElement | null> | HTMLElement | null, options: CaughtSnap) => {
    snap.options = options;
  },
}));

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

// A test that needs a space with tabs sets these; afterEach clears them.
let extraAgents: AgentView[] = [];
let tabs: TabView[] = [];
let device: DeviceAuth | undefined;

const home = (): HomeData => ({
  bridge: "connected",
  agents: [A1, A2, A3, B1, ...extraAgents],
  shellPanes: [SH],
  workspaces: [],
  tabs,
  device,
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

// The window's width and height, as the two width-class media queries read them.
let width = 1200;
let windowHeight = 900;
// How a foldable is held, as the Viewport Segments media features read it. "flat" matches neither.
let posture: "flat" | "tabletop" | "book" = "flat";
function answer(query: string): boolean {
  if (query.includes("vertical-viewport-segments")) return posture === "tabletop";
  if (query.includes("horizontal-viewport-segments")) return posture === "book";
  const minW = /min-width:\s*(\d+)px/.exec(query);
  const minH = /min-height:\s*(\d+)px/.exec(query);
  return minW !== null && width >= Number(minW[1]) && (minH === null || windowHeight >= Number(minH[1]));
}

beforeAll(() => {
  // jsdom has no scrolling; the read-only transcript pins itself to the bottom with it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  __resetWideLayoutStore();
  __resetBeltIntents();
  __resetOpenBeside();
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
  windowHeight = 900;
  extraAgents = [];
  tabs = [];
  device = undefined;
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

async function mount(paneId: string, px: number, tall = 900) {
  width = px;
  windowHeight = tall;
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

describe("under 480 px tall", () => {
  it("keeps the phone layout on a phone held sideways, 915 by 412", async () => {
    const { container } = await mount("w1:p1", 915, 412);
    expect(q(container, '[data-slot="wide-layout"]')).toBeNull();
    expect(q(container, "aside")).toBeNull();
  });

  it("shows the layout at 915 by 600", async () => {
    const { container } = await mount("w1:p1", 915, 600);
    expect(q(container, '[data-slot="wide-layout"]')?.dataset.widthClass).toBe("expanded");
  });
});

describe("Large-screen layout set to Off", () => {
  it("keeps the phone layout at every width", async () => {
    setWideLayoutMode("off");
    const { container } = await mount("w1:p1", 1200);
    expect(q(container, '[data-slot="wide-layout"]')).toBeNull();
    expect(q(container, "aside")).toBeNull();
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
    // One word: Collie in the text colour, then three inked letters (components/wordmark.tsx).
    expect(q(aside, '[data-slot="sidebar-word"]')?.textContent).toBe("ColliePWA");
    expect([...aside.querySelectorAll(".wordmark-ink")].map((el) => el.textContent)).toEqual(["P", "W", "A"]);
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

describe("the sidebar launcher", () => {
  it("opens a launched agent with the launch intent that gates its Send", async () => {
    server.use(
      http.get("/api/launchers", () =>
        HttpResponse.json({ home: "/home", launchers: [{ command: "kiro", label: "Launch Kiro", kind: "agent", harness: "kiro" }] }),
      ),
      http.post("/api/launch", () =>
        HttpResponse.json({ ok: true, pane: { paneId: "new:p1", workspaceId: "new", workspaceLabel: "Kiro", tabId: "new:t1", cwd: "/home" } }),
      ),
    );
    const { router, container } = await mount("w1:p1", 1200);
    fireEvent.click(await within(q(container, "aside")!).findByText("Launch Kiro"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/new%3Ap1"));
    expect(readAgentLaunch(router.state.location.state, "new:p1")?.harness).toBe("kiro");
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
    expect(lone).toHaveAttribute("title", "The agent keeps running.");

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

describe("the sidebar's structure", () => {
  it("one 16px inset, 44px icon buttons with 20px glyphs, a hairline between rows, more air above a heading", async () => {
    const { container } = await mount("w1:p1", 1200);
    const aside = q(container, "aside")!;
    const list = q(aside, "[data-pane-key]")!.closest("section")!.parentElement!;
    // The list's 8px plus each row's, heading's and summary row's own 8px: 16px from the edge.
    expect(list.className).toContain("px-2");
    expect(list.className).toContain("gap-6");
    const heading = within(aside).getByRole("heading", { name: "alpha" }).parentElement!;
    expect(heading.className).toContain("px-2");
    // The summary row: a 44px row, its order glyphs 20px like every icon button around them.
    const radios = within(aside).getAllByRole("radio");
    expect(radios[0]?.closest("div.min-h-11")).not.toBeNull();
    for (const r of radios) expect(r.querySelector("svg")?.getAttribute("class")).toContain("size-5");
    // The toggle is the same glyph size, so it reads as the same icon set.
    expect(q(container, '[data-slot="sidebar-toggle"] svg')?.getAttribute("class")).toContain("size-5");
    // Rows: a hairline drawn once, between rows; a floor, never a fixed height; stated line boxes.
    const row = sidebarRow(container, A2)!;
    expect(row.parentElement?.className).toContain("[&>*+*]:before:bg-rule");
    expect(row.className).toContain("min-h-11");
    expect(row.className).not.toMatch(/(?:^|\s)h-\d/);
    expect(q(row, ".leading-4")?.textContent).toContain("alpha");
  });
});

describe("the space header", () => {
  it("is the one bar that names the space: a column header keeps its branch, machine and state, not the space", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const line = q(columns(container)[0]!, '[data-slot="column-header-line"]')!;
    expect(line.textContent).not.toContain("alpha");
    expect(line.textContent).toContain(statusLabel("idle"));
    expect(q(container, '[data-slot="space-title"]')?.textContent).toBe("alpha");
  });

  it("holds the space's tabs: a tap on one opens its pane", async () => {
    const A4: AgentView = { ...pane("w1:p4", "w1", "alpha"), tabId: "w1:t2" };
    extraAgents = [A4];
    tabs = [
      { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 4 },
      { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "side", focused: false, paneCount: 1 },
    ];
    const { container, router } = await mount("w1:p1", 1200);
    const nav = within(q(container, '[data-slot="space-header"]')!).getByRole("navigation", { name: "Tabs" });
    // A tab holding one named pane is called by that pane's name (lib/pane-name.ts `tabCellTitle`).
    fireEvent.click(within(nav).getByRole("button", { name: /w1:p4/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p4")));
  });
});

describe("the space's tab actions", () => {
  const T1: TabView = { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 4 };
  const T2: TabView = { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "side", focused: false, paneCount: 1 };
  const A4: AgentView = { ...pane("w1:p4", "w1", "alpha"), tabId: "w1:t2" };
  const chip = (container: HTMLElement, name: RegExp) =>
    within(within(q(container, '[data-slot="space-header"]')!).getByRole("navigation", { name: "Tabs" })).getByRole("button", { name });

  it("a long-press on a chip offers rename and close", async () => {
    extraAgents = [A4];
    tabs = [T1, T2];
    const { container } = await mount("w1:p1", 1200);
    fireEvent.contextMenu(chip(container, /w1:p4/));
    expect(await screen.findByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeInTheDocument();
  });

  it("a device that cannot write gets a note and neither action", async () => {
    extraAgents = [A4];
    tabs = [T1, T2];
    device = { enforced: true, device: "phone", authorized: false };
    const { container } = await mount("w1:p1", 1200);
    fireEvent.contextMenu(chip(container, /w1:p4/));
    expect(await screen.findByText(/isn't authorised to rename or close tabs/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
  });

  const closeTabOf = async (container: HTMLElement, name: RegExp) => {
    fireEvent.contextMenu(chip(container, name));
    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Tap again to close/ }));
  };

  it("closing the tab that holds the focused column moves the focus to a neighbouring tab's pane", async () => {
    extraAgents = [A4];
    tabs = [T1, T2];
    let closed = "";
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, ({ request }) => {
        closed = decodeURIComponent(new URL(request.url).pathname);
        return HttpResponse.json({ ok: true });
      }),
    );
    const { container, router } = await mount("w1:p4", 1200);
    await closeTabOf(container, /w1:p4/);
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
    expect(closed).toBe("/api/tab/w1:t2/close");
  });

  it("closing another tab leaves the focus where it is", async () => {
    extraAgents = [A4];
    tabs = [T1, T2];
    let closed = false;
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, () => {
        closed = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { container, router } = await mount("w1:p1", 1200);
    await closeTabOf(container, /w1:p4/);
    await waitFor(() => expect(closed).toBe(true));
    expect(router.state.location.pathname).toBe(panePath("w1:p1"));
  });
});

describe("the add column", () => {
  const addColumn = (root: ParentNode) => q(root, '[data-slot="add-column"]');
  const openSheet = async (root: HTMLElement) => {
    fireEvent.click(within(addColumn(root)!).getByRole("button", { name: "Add a pane" }));
    return await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-slot="add-row"]')];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
  };

  it("always ends the strip, after the last column, as wide as the room it leaves and never under a pane", async () => {
    // One column at 1/2 of 880: the add column is the other half.
    const { container } = await mount("w1:p1", 1200);
    const strip = q(container, '[data-slot="strip"]')!;
    expect(strip.lastElementChild).toBe(addColumn(container));
    expect(addColumn(container)?.style.flex).toBe("0 0 440px");
    const widthButton = () => within(columns(container)[0]!).getByRole("button", { name: /^Width / });
    fireEvent.click(widthButton());
    await waitFor(() => expect(widthButton().textContent).toBe("4/5"));
    // 1/5 of 880 is under a pane: the add column is a pane wide, so the strip scrolls to it.
    expect(addColumn(container)?.style.flex).toBe("0 0 360px");
    fireEvent.click(widthButton());
    await waitFor(() => expect(widthButton().textContent).toBe("Full"));
    expect(addColumn(container)?.style.flex).toBe("0 0 360px");
  });

  it("keeps its plus in the part of it that is in view", async () => {
    const { container } = await mount("w1:p1", 1200);
    expect(q(addColumn(container)!, '[data-slot="add-button"]')?.className).toContain("sticky");
  });

  it("is a snap point and no column: no focus, no frame, not counted", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const add = addColumn(container)!;
    expect(add.className).toContain("snap-start");
    expect(add.hasAttribute("data-col-key")).toBe(false);
    expect(add.hasAttribute("data-col-index")).toBe(false);
    expect(q(add, '[data-slot="column-frame"]')).toBeNull();
    expect(columns(container)).toHaveLength(2);
  });

  it("stands out of wide mode too, a pane wide, and not in a book or below 600 px", async () => {
    const { container } = await mount("w1:p1", 700);
    expect(addColumn(container)?.style.flex).toBe("0 0 360px");
    cleanup();
    posture = "book";
    const book = await mount("w1:p1", 1200);
    expect(addColumn(book.container)).toBeNull();
    cleanup();
    posture = "flat";
    const phone = await mount("w1:p1", 599);
    expect(addColumn(phone.container)).toBeNull();
  });

  it("lists this space's panes not in view; Open here makes one the last column and focuses it", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    // Focus the first column, so a step beside the focus and a step to the end differ.
    const body = q(columns(container)[0]!, '[data-slot="column-body"]')!;
    fireEvent.pointerDown(body, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(body, { clientX: 12, clientY: 11 });
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
    const rows = await openSheet(container);
    // Not the panes in view, not another space's pane; the space's shell is a pane like the others.
    expect(rows.map((r) => r.textContent)).toEqual([A3, SH].map((p) => `${p.paneLabel}Open here`));
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /^Open here/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p3")));
    await waitFor(() => expect(columns(container)[2]?.hasAttribute("data-focused")).toBe(true));
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(A2), key(A3)]);
  });

  it("its New agent in this space goes down to the New page told which space, and the new pane opens beside the focus", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    // Focus the first column: beside the focus and at the end now differ.
    const body = q(columns(container)[0]!, '[data-slot="column-body"]')!;
    fireEvent.pointerDown(body, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(body, { clientX: 12, clientY: 11 });
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
    const rows = await openSheet(container);
    fireEvent.click(within(rows[0]!.parentElement!).getByRole("button", { name: "New agent in this space" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    expect(new URLSearchParams(router.state.location.search).get("beside")).toBe("w1:p1");
    expect(new URLSearchParams(router.state.location.search).get("pane")).toBeNull();

    // The agent starts on the New page; its pane is one the space did not hold.
    const fresh: AgentView = { ...pane("w1:p7", "w1", "alpha"), tabId: "w1:t7" };
    // As use-spaces does: navigate with the fresh pane before any snapshot lists it.
    await act(async () => {
      await router.navigate(panePath("w1:p7"), { state: { freshPane: fresh } });
    });
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(fresh), key(A2)]));
    expect(columns(container)[1]?.hasAttribute("data-focused")).toBe(true);
    // The snapshot catches up: the order and the focus stay.
    extraAgents = [fresh];
    await act(async () => {
      await router.revalidate();
    });
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A1), key(fresh), key(A2)]);
    expect(columns(container)[1]?.hasAttribute("data-focused")).toBe(true);
  });

  it("a pane that arrives as a freshPane the snapshot does not list yet gets a column, and does not loop", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    const fresh: AgentView = { ...pane("w1:p7", "w1", "alpha"), tabId: "w1:t7" };
    await act(async () => {
      await router.navigate(panePath("w1:p7"), { state: { freshPane: fresh } });
    });
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toContain(key(fresh)));
    const at = columns(container).findIndex((c) => c.dataset.colKey === key(fresh));
    expect(columns(container)[at]?.hasAttribute("data-focused")).toBe(true);
  });

  it("a pane the space already held, opened after backing out of the New page, still replaces the focus", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    const rows = await openSheet(container);
    fireEvent.click(within(rows[0]!.parentElement!).getByRole("button", { name: "New agent in this space" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    await act(async () => {
      await router.navigate(panePath("w1:p3"));
    });
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([key(A3)]));
  });

  it("its New agent in a new space goes down to the New page", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    const rows = await openSheet(container);
    fireEvent.click(within(rows[0]!.parentElement!).getByRole("button", { name: "New agent in a new space" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
  });

  it("the focus that follows the view never lands on it: with no whole column in view, the focus stays", async () => {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    // Lay the strip out by hand: two half columns of 440 and the add column after them.
    const strip = q(container, '[data-slot="strip"]')!;
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 880 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 1320 });
    const box = (el: HTMLElement, left: number, w: number) => {
      Object.defineProperty(el, "offsetLeft", { configurable: true, value: left });
      Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
    };
    const [c1, c2] = columns(container);
    box(c1!, 0, 440);
    box(c2!, 440, 440);
    box(addColumn(container)!, 880, 440);
    // The add column is a snap point, held at the end of the scroll range.
    expect(snap.options?.columnStarts()).toEqual([0, 440, 440]);
    // Settled with only the add column whole: the focus (the second column) stays.
    act(() => snap.options?.onSettled?.(880));
    expect(router.state.location.pathname).toBe(panePath("w1:p2"));
    // Settled at the start with the focus still whole: nothing changes either.
    act(() => snap.options?.onSettled?.(0));
    expect(router.state.location.pathname).toBe(panePath("w1:p2"));
  });
});

describe("the focus that follows the view", () => {
  async function laidOut() {
    const { container, router } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const strip = q(container, '[data-slot="strip"]')!;
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 440 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 1320 });
    const box = (el: HTMLElement, left: number, w: number) => {
      Object.defineProperty(el, "offsetLeft", { configurable: true, value: left });
      Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
    };
    const [c1, c2] = columns(container);
    box(c1!, 0, 440);
    box(c2!, 440, 440);
    box(q(container, '[data-slot="add-column"]')!, 880, 440);
    return { container, router, focusedColumn: c2! };
  }

  it("waits while the reply box has the document focus, and follows again after the blur", async () => {
    const { router, focusedColumn } = await laidOut();
    const reply = document.createElement("textarea");
    focusedColumn.appendChild(reply);
    reply.focus();
    expect(document.activeElement).toBe(reply);
    // The view rests on the first column only: without the typing, the focus would move there.
    act(() => snap.options?.onSettled?.(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30)); // navigation is async; give a wrong move time to land
    });
    expect(router.state.location.pathname).toBe(panePath("w1:p2"));
    reply.blur();
    act(() => snap.options?.onSettled?.(0));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
  });

  it("is not held by a text field outside the layout", async () => {
    const { router } = await laidOut();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    act(() => snap.options?.onSettled?.(0));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath("w1:p1")));
    outside.remove();
  });
});

describe("a sideways scroll over a column", () => {
  it("reaches the strip: the columns hand their x overscroll on, and only the strip contains it", async () => {
    const { container } = await mount("w1:p1", 1200);
    const layout = q(container, '[data-slot="wide-layout"]')!;
    expect(layout.className).not.toContain("overscroll-x-contain");
    expect(q(container, '[data-slot="strip"]')?.className).toContain("overscroll-x-contain");
    for (const col of columns(container)) {
      expect(col.className).toContain("[&_*]:overscroll-x-auto!");
      expect(col.className).not.toContain("overscroll-x-contain");
    }
  });
});

describe("the position line", () => {
  it("floats over the strip's top edge, hidden at rest, shown while the strip moves", async () => {
    const { container } = await mount("w1:p1", 1200);
    await openBesideFromSidebar(container, A2);
    const line = q(container, '[data-slot="position-strip"]')!;
    expect(line.className).toContain("absolute");
    expect(line.className).toContain("pointer-events-none");
    expect(line.className).toContain("opacity-0");
    fireEvent.scroll(q(container, '[data-slot="strip"]')!);
    await waitFor(() => expect(q(container, '[data-slot="position-strip"]')?.className).toContain("opacity-100"));
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
