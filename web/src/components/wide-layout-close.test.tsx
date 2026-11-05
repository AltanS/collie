import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBeltIntents } from "@/lib/belt-intent";
import { paneRowKey } from "@/lib/hosts";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { __resetOpenBeside } from "@/lib/open-beside";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { clearStatus, useStatus } from "@/lib/status";
import type { ActionResponse, AgentView, DeviceAuth, MuxCapability, MuxConfig } from "@/lib/types";
import { __resetWideLayoutStore } from "@/lib/wide-layout-store";
import { DetailRoute } from "@/routes/detail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

// «слева в панели вкладки в которых я уже сделал exit которые не нужны, я не могу закрыть через правую
// кнопку мышки. мне нужно обязательно выходить на главную страницу ... хотелось бы не выходя из
// пространства иметь просто с боковой панели закрывать вкладку».
//
// The large-screen layout through the real DetailRoute, as wide-layout.test.tsx mounts it. The world
// is alive: a pane closed through the mocked `closePane` leaves the next snapshot, as on a bridge.

const { closePane } = vi.hoisted(() => ({ closePane: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  closePane,
}));
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId }: { paneId: string }) => <div data-testid="chat">{`pane:${paneId}`}</div>,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));
vi.mock("@/hooks/use-strip-snap", () => ({ useStripSnap: () => undefined }));

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
const OTHER_SESSION: AgentView = { ...pane("w5:p1", "w5", "gamma"), session: "project-y" };

const REFUSAL = "the bridge refused this close";

let extraAgents: AgentView[] = [];
let device: DeviceAuth | undefined;
let rootError = false;
const closed = new Set<string>();

function scopeOf(request: Request): Scope {
  const session = new URL(request.url).searchParams.get("s");
  return session === null ? {} : { session };
}

const alive = (p: AgentView) => !closed.has(p.paneId);

const home = (request: Request): HomeData => ({
  bridge: "connected",
  agents: [A1, A2, A3, B1, ...extraAgents].filter(alive),
  shellPanes: [SH].filter(alive),
  workspaces: [],
  tabs: [],
  device,
  sessions: [],
  servers: [],
  ts: 0,
  scope: scopeOf(request),
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: rootError,
  authError: false,
});

function makeRouter(address: string) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: ({ request }) => home(request),
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          {
            path: "pane/:paneId",
            loader: ({ params, request }): PaneData => ({
              paneId: params.paneId ?? "",
              scope: scopeOf(request),
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
    { initialEntries: [address] },
  );
}

function answer(query: string): boolean {
  const minW = /min-width:\s*(\d+)px/.exec(query);
  const minH = /min-height:\s*(\d+)px/.exec(query);
  return minW !== null && 1200 >= Number(minW[1]) && (minH === null || 900 >= Number(minH[1]));
}

function declares(capabilities: Partial<Record<MuxCapability, boolean>>) {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  __resetWideLayoutStore();
  __resetBeltIntents();
  __resetOpenBeside();
  clearStatus();
  closed.clear();
  closePane.mockReset();
  closePane.mockImplementation((paneId: string): Promise<ActionResponse> => {
    closed.add(paneId);
    return Promise.resolve({ ok: true });
  });
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
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  server.use(http.get("/api/pane/:id", () => HttpResponse.json({ text: "preview rows", truncated: false, revision: 1 })));
  declares({ closePane: true, renamePane: true, setFocus: true });
});
afterEach(() => {
  cleanup();
  extraAgents = [];
  device = undefined;
  rootError = false;
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
  __resetOperatorCommands();
});

async function mount(address: string) {
  const router = makeRouter(address);
  const { container } = render(<RouterProvider router={router} />);
  await waitFor(() => expect(container.querySelector('[data-testid="chat"]')).not.toBeNull());
  const at = () => `${router.state.location.pathname}${router.state.location.search}`;
  return { router, container, at };
}

const q = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const columns = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-col-key]")];
const sidebarRow = (root: ParentNode, p: AgentView) =>
  [...q(root, "aside")!.querySelectorAll<HTMLElement>("[data-pane-key]")].find((el) => el.dataset.paneKey === paneRowKey(p)) ?? null;
const shownPane = (root: ParentNode) => q(root, '[data-testid="chat"]')?.textContent;

const CLOSE = "Close pane";
const ARMED = "Tap again to close";

/** Right click on the row: the sheet that opens, found by its "Open here" row. */
async function openMenu(container: HTMLElement, p: AgentView) {
  fireEvent.contextMenu(sidebarRow(container, p)!);
  const openHere = await screen.findByRole("button", { name: "Open here" });
  return within(openHere.closest<HTMLElement>('[role="dialog"]') ?? document.body);
}

async function closeFromRow(container: HTMLElement, p: AgentView) {
  const sheet = await openMenu(container, p);
  await waitFor(() => expect(sheet.queryByRole("button", { name: CLOSE })).not.toBeNull());
  fireEvent.click(sheet.getByRole("button", { name: CLOSE }));
  fireEvent.click(await sheet.findByRole("button", { name: ARMED }));
  await waitFor(() => expect(closePane).toHaveBeenCalled());
}

async function openBeside(container: HTMLElement, p: AgentView) {
  const sheet = await openMenu(container, p);
  fireEvent.click(sheet.getByRole("button", { name: "Open beside" }));
  await waitFor(() => expect(shownPane(container)).toBe(`pane:${p.paneId}`));
}

async function foldSidebar(container: HTMLElement) {
  fireEvent.click(q(container, '[data-slot="sidebar-toggle"]')!);
  await waitFor(() => expect(q(container, 'aside[data-slot="rail"]')).not.toBeNull());
}

/** Time for anything a wrong implementation would still do after the answer to reach the route. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("@oracle:requirement @req:CLOSE-1 the row's right-click menu", () => {
  it("offers Close pane beside Open here and Open beside, and opening it moves nothing", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A2);
    expect(sheet.getByRole("button", { name: "Open beside" })).toBeInTheDocument();
    expect(await sheet.findByRole("button", { name: CLOSE })).toBeInTheDocument();
    expect(at()).toBe(panePath(A1.paneId));
    expect(shownPane(container)).toBe(`pane:${A1.paneId}`);
    expect(closePane).not.toHaveBeenCalled();
  });

  it("offers Close pane on the row of the pane on screen too", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A1);
    expect(await sheet.findByRole("button", { name: CLOSE })).toBeInTheDocument();
    expect(at()).toBe(panePath(A1.paneId));
  });

  it("offers Close pane on the row of a shell pane", async () => {
    const { container } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, SH);
    expect(await sheet.findByRole("button", { name: CLOSE })).toBeInTheDocument();
  });

  it("offers it on the folded sidebar as well, and opening it moves nothing", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await foldSidebar(container);
    const sheet = await openMenu(container, A2);
    expect(sheet.getByRole("button", { name: "Open beside" })).toBeInTheDocument();
    expect(await sheet.findByRole("button", { name: CLOSE })).toBeInTheDocument();
    expect(at()).toBe(panePath(A1.paneId));
  });

  it("Open here still opens the pane in the focused column", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A2);
    fireEvent.click(sheet.getByRole("button", { name: "Open here" }));
    await waitFor(() => expect(at()).toBe(panePath(A2.paneId)));
    expect(columns(container)).toHaveLength(1);
    expect(closePane).not.toHaveBeenCalled();
  });

  it("Open beside still adds a column", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await openBeside(container, A2);
    expect(at()).toBe(panePath(A2.paneId));
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual([paneScopeKey({}, A1.paneId), paneScopeKey({}, A2.paneId)]);
    expect(closePane).not.toHaveBeenCalled();
  });
});

describe("@oracle:requirement @req:CLOSE-2 two clicks close the row's pane", () => {
  it("the first click arms it and calls nothing", async () => {
    const { container } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A2);
    fireEvent.click(await sheet.findByRole("button", { name: CLOSE }));
    expect(await sheet.findByRole("button", { name: ARMED })).toBeInTheDocument();
    await settle();
    expect(closePane).not.toHaveBeenCalled();
  });

  it("the second click closes that row's pane, once", async () => {
    const { container } = await mount(panePath(A1.paneId));
    await closeFromRow(container, A2);
    await settle();
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane.mock.calls[0]?.[0]).toBe(A2.paneId);
    // SAFETY: the second argument of `closePane` is its `scope?: Scope` (lib/api.ts).
    expect((closePane.mock.calls[0]?.[1] as Scope | undefined)?.session).toBeUndefined();
  });

  it("a pane of another session is closed in that session", async () => {
    extraAgents = [OTHER_SESSION];
    const { container } = await mount(panePath(A1.paneId));
    await closeFromRow(container, OTHER_SESSION);
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane.mock.calls[0]?.[0]).toBe(OTHER_SESSION.paneId);
    expect(closePane.mock.calls[0]?.[1]).toMatchObject({ session: "project-y" });
  });

  it("a pane of the session on screen is closed in that session", async () => {
    const { container } = await mount(panePath(A1.paneId, { session: "project-x" }));
    await closeFromRow(container, A2);
    expect(closePane.mock.calls[0]?.[1]).toMatchObject({ session: "project-x" });
  });

  it("arming one row does not arm another: a single click on the next row closes nothing", async () => {
    const { container } = await mount(panePath(A1.paneId));
    const first = await openMenu(container, A2);
    fireEvent.click(await first.findByRole("button", { name: CLOSE }));
    await first.findByRole("button", { name: ARMED });

    fireEvent.contextMenu(sidebarRow(container, A3)!);
    const next = await screen.findByRole("button", { name: CLOSE });
    fireEvent.click(next);
    await settle();
    expect(closePane).not.toHaveBeenCalled();
  });
});

describe("@oracle:requirement @req:CLOSE-3 closing a pane that is not the route's", () => {
  it("leaves the route where it is, and the row goes", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await closeFromRow(container, A3);
    await waitFor(() => expect(sidebarRow(container, A3)).toBeNull());
    await settle();
    expect(at()).toBe(panePath(A1.paneId));
    expect(shownPane(container)).toBe(`pane:${A1.paneId}`);
    expect(screen.queryByTestId("home")).toBeNull();
  });

  it("leaves the route alone for a pane of another space", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await closeFromRow(container, B1);
    await waitFor(() => expect(sidebarRow(container, B1)).toBeNull());
    await settle();
    expect(at()).toBe(panePath(A1.paneId));
    expect(screen.queryByTestId("home")).toBeNull();
  });

  it("closing a column beside the focus leaves the focus and drops that column", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await openBeside(container, A2);
    await closeFromRow(container, A1);
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([paneScopeKey({}, A2.paneId)]));
    await settle();
    expect(at()).toBe(panePath(A2.paneId));
    expect(screen.queryByTestId("home")).toBeNull();
  });

  it("closes the sheet, so the operator stays in the space with nothing over it", async () => {
    const { container } = await mount(panePath(A1.paneId));
    await closeFromRow(container, A3);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open here" })).toBeNull());
  });
});

describe("@oracle:requirement @req:CLOSE-4 closing the route's pane with another column open", () => {
  it("moves to that column's pane, not to another pane of the space and not home", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await openBeside(container, A2);
    await closeFromRow(container, A2);
    await waitFor(() => expect(at()).toBe(panePath(A1.paneId)));
    await waitFor(() => expect(columns(container).map((c) => c.dataset.colKey)).toEqual([paneScopeKey({}, A1.paneId)]));
    expect(shownPane(container)).toBe(`pane:${A1.paneId}`);
    expect(screen.queryByTestId("home")).toBeNull();
  });

  it("keeps the session on screen in the address it moves to", async () => {
    const scope = { session: "project-x" };
    const { container, at } = await mount(panePath(A1.paneId, scope));
    await openBeside(container, A2);
    await closeFromRow(container, A2);
    await waitFor(() => expect(at()).toBe(panePath(A1.paneId, scope)));
  });
});

describe("@oracle:requirement @req:CLOSE-5 closing the route's pane with one column and other panes in the space", () => {
  const SAME_SPACE = [A2, A3, SH].map((p) => panePath(p.paneId));

  it("moves to one of those panes, same space, not home", async () => {
    const { container, at } = await mount(panePath(A1.paneId));
    await closeFromRow(container, A1);
    await waitFor(() => expect(at()).not.toBe(panePath(A1.paneId)));
    expect(SAME_SPACE).toContain(at());
    await waitFor(() => expect(shownPane(container)).toBe(`pane:${decodeURIComponent(at().slice("/pane/".length))}`));
    expect(screen.queryByTestId("home")).toBeNull();
  });

  it("keeps the session on screen in the address it moves to", async () => {
    const scope = { session: "project-x" };
    const { at } = await mount(panePath(A1.paneId, scope));
    await waitFor(() => expect(sidebarRow(document.body, A1)).not.toBeNull());
    await closeFromRow(document.body, A1);
    await waitFor(() => expect(at()).not.toBe(panePath(A1.paneId, scope)));
    expect([A2, A3, SH].map((p) => panePath(p.paneId, scope))).toContain(at());
  });
});

describe("@oracle:requirement @req:CLOSE-6 closing the only pane of the space", () => {
  it("goes home, with no error screen", async () => {
    const { container, at } = await mount(panePath(B1.paneId));
    await closeFromRow(container, B1);
    await waitFor(() => expect(at()).toBe("/"));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
  });

  it("goes home of the same session", async () => {
    const { container, at } = await mount(panePath(B1.paneId, { session: "project-x" }));
    await closeFromRow(container, B1);
    await waitFor(() => expect(at()).toBe("/?s=project-x"));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
  });
});

describe("@oracle:requirement @req:CLOSE-7 a device that may not close", () => {
  it("a read-only device is offered no Close pane, and the rest of the menu stays", async () => {
    device = { enforced: true, device: "phone", authorized: false };
    const { container } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A2);
    expect(sheet.getByRole("button", { name: "Open beside" })).toBeInTheDocument();
    await settle();
    expect(sheet.queryByRole("button", { name: CLOSE })).toBeNull();
  });

  it("a saved copy is offered no Close pane, and the rest of the menu stays", async () => {
    rootError = true;
    const { container } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A2);
    expect(sheet.getByRole("button", { name: "Open beside" })).toBeInTheDocument();
    await settle();
    expect(sheet.queryByRole("button", { name: CLOSE })).toBeNull();
  });

  it("a multiplexer that cannot close a pane is offered no Close pane", async () => {
    declares({ closePane: false, renamePane: true, setFocus: true });
    const { container } = await mount(panePath(A1.paneId));
    const sheet = await openMenu(container, A2);
    await waitFor(() => expect(sheet.queryByRole("button", { name: CLOSE })).toBeNull());
    await settle();
    expect(sheet.queryByRole("button", { name: CLOSE })).toBeNull();
  });
});

describe("@oracle:requirement @req:CLOSE-8 a close that fails", () => {
  const FAILURES: Array<[string, () => Promise<ActionResponse>]> = [
    ["refused", () => Promise.resolve({ ok: false, error: REFUSAL })],
    ["rejected", () => Promise.reject(new Error(REFUSAL))],
  ];

  /** The app's status line is the way a sheet reports a failure (pane-actions-sheet.tsx); text in the sheet counts too. */
  function failureShown(status: { current: { text: string } | null }) {
    return status.current?.text.includes(REFUSAL) === true || screen.queryByText(new RegExp(REFUSAL, "u")) !== null;
  }

  it.each(FAILURES)("%s on the route's pane: the route stays, the failure shows, nothing moves", async (_name, fail) => {
    closePane.mockImplementation(fail);
    const status = renderHook(() => useStatus());
    const { container, at } = await mount(panePath(A1.paneId));
    const before = columns(container).map((c) => c.dataset.colKey);
    await closeFromRow(container, A1);

    await waitFor(() => expect(failureShown({ current: status.result.current })).toBe(true));
    await settle();
    expect(at()).toBe(panePath(A1.paneId));
    expect(shownPane(container)).toBe(`pane:${A1.paneId}`);
    expect(columns(container).map((c) => c.dataset.colKey)).toEqual(before);
    expect(sidebarRow(container, A1)).not.toBeNull();
    expect(screen.queryByTestId("home")).toBeNull();
  });

  it.each(FAILURES)("%s on another row: the sheet stays open and the route stays", async (_name, fail) => {
    closePane.mockImplementation(fail);
    const status = renderHook(() => useStatus());
    const { container, at } = await mount(panePath(A1.paneId));
    await closeFromRow(container, A2);

    await waitFor(() => expect(failureShown({ current: status.result.current })).toBe(true));
    await settle();
    expect(screen.getByRole("button", { name: "Open here" })).toBeInTheDocument();
    expect(at()).toBe(panePath(A1.paneId));
    expect(sidebarRow(container, A2)).not.toBeNull();
  });
});
