import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
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
  AgentChat: ({ paneId, inStrip }: { paneId: string; inStrip?: boolean }) => (
    <div data-testid="chat" data-in-strip={String(inStrip === true)}>{`pane:${paneId}`}</div>
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
function answer(query: string): boolean {
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

describe("the sidebar", () => {
  it("is a raised panel with the mark, the word and an open toggle, and the header docks in the focused column", async () => {
    const { container } = await mount("w1:p1", 1200);
    const aside = q(container, "aside")!;
    expect(aside.dataset.slot).toBe("wide-sidebar");
    expect(aside.className).toContain("bg-card");
    expect(aside.style.width).toBe("320px");
    expect(within(aside).getByText("ColliePWA")).toBeTruthy();
    expect(q(aside, '[data-slot="sidebar-mark"] [data-slot="collie-mark"]')).not.toBeNull();
    expect(q(container, '[data-testid="chat"]')?.dataset.inStrip).toBe("true");
    // The header moved into the focused column, and the mark is not drawn twice.
    expect(q(container, "header")?.closest('[data-slot="column-head"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="collie-mark"]')).toHaveLength(1);
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
    expect(focused!.className).toContain("border-ring");
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
