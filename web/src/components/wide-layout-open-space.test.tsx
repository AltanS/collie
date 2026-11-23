import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBeltIntents } from "@/lib/belt-intent";
import { useShortcutKeyboard } from "@/hooks/use-shortcuts";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { __resetOpenBeside } from "@/lib/open-beside";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetShortcutRegistry, isShortcutActionAvailable, runShortcutAction } from "@/lib/shortcuts/registry";
import { dropSpaceLanding, peekSpaceLanding } from "@/lib/space-landing";
import { workspaceGroupKey } from "@/lib/pane-groups";
import { __resetSidebarFocus } from "@/lib/shortcuts/sidebar-focus";
import { __resetShortcutState } from "@/lib/shortcuts/state";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { __resetWideLayoutStore } from "@/lib/wide-layout-store";
import { DetailRoute } from "@/routes/detail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { ShortcutBarHost } from "./shortcut-bar-host";

// OPEN THIS SPACE IN THE PANE VIEW (`open_space`, ADR 0173). On a large screen the space has no page, so the key and
// the space's name in the bar go up to the Dashboard and ask it to land on that space. At the medium tier the page
// exists and the pane view answers (agent-chat-open-space.test.tsx), so the layout offers neither door.
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

const WORKSPACES: WorkspaceView[] = [
  { workspaceId: "w1", number: 1, label: "alpha", focused: false, activeTabId: "w1:t1", tabCount: 1, paneCount: 3 },
  { workspaceId: "w2", number: 2, label: "beta", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 1 },
];

const home = (): HomeData => ({
  bridge: "connected",
  agents: PANES,
  shellPanes: [],
  workspaces: WORKSPACES,
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

let width = 1200;
beforeAll(() => {
  // jsdom has no scrolling.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  width = 1200;
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
  server.use(http.get("/api/pane/:id", () => HttpResponse.json({ text: "preview rows", truncated: false, revision: 1 })));
  __resetOperatorCommands();
});
afterEach(() => {
  cleanup();
  dropSpaceLanding();
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

const header = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="space-header"]')!;

describe("Open this space in the pane view, on a large screen", () => {
  it("makes the space's name in the bar a button, with the label, the key and the line it always had", async () => {
    const { container } = await mount("w2:p1");
    const door = within(header(container)).getByRole("button", { name: "Open beta overview" });
    expect(door.getAttribute("data-shortcut-action")).toBe("open_space");
    expect(door.textContent).toBe("beta");
    expect(door.closest('[data-slot="space-title"]')).not.toBeNull();
    expect(door.className).toContain("hover:bg-(--state-hover)");
    expect(door.className).toContain("focus-visible:outline-2");
  });

  it("goes up to the Dashboard and asks it to land on this space, from the name and from the key alike", async () => {
    const user = userEvent.setup();
    const { router, container } = await mount("w2:p1");
    await waitFor(() => expect(isShortcutActionAvailable("open_space")).toBe(true));
    await user.click(within(header(container)).getByRole("button", { name: "Open beta overview" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(peekSpaceLanding()).toBe(workspaceGroupKey(B1));
    cleanup();
    dropSpaceLanding();
    __resetShortcutRegistry();
    const second = await mount("w1:p2");
    await waitFor(() => expect(isShortcutActionAvailable("open_space")).toBe(true));
    act(() => {
      expect(runShortcutAction("open_space")).toBe(true);
    });
    await waitFor(() => expect(second.router.state.location.pathname).toBe("/"));
    expect(peekSpaceLanding()).toBe(workspaceGroupKey(A2));
  });

  it("is neither a key nor a button at the medium tier, where the space has a page", async () => {
    width = 700;
    const { container } = await mount("w2:p1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector('[data-slot="wide-layout"]')?.getAttribute("data-width-class")).toBe("medium");
    expect(isShortcutActionAvailable("open_space")).toBe(false);
    expect(within(header(container)).queryByRole("button", { name: /overview/u })).toBeNull();
  });
});
