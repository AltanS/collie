import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import { __resetSidebarFocus } from "@/lib/shortcuts/sidebar-focus";
import { __resetShortcutState } from "@/lib/shortcuts/state";
import type { AgentView, MuxCapability, WorkspaceView } from "@/lib/types";
import { t } from "@/lib/i18n";
import { __resetWideLayoutStore } from "@/lib/wide-layout-store";
import { DetailRoute } from "@/routes/detail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { ShortcutBarHost } from "./shortcut-bar-host";

// RENAME SPACE IN THE PANE VIEW (ADR 0165, ADR 0173). On a large screen `/space/:id` opens the
// pane view, so the Actions palette's "Rename space" answers there, for the space in view, where the multiplexer
// declares `renameSpace`; it opens the phone space strip's own sheet on its rename view and posts the same rename.
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
  );
  __resetOperatorCommands();
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

function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  server.use(
    http.get("/api/config", () =>
      HttpResponse.json({ push: false, vapidPublicKey: "", mux: { name: "durable", capabilities, unsupportedKeys: [], notes: {} } }),
    ),
  );
}

describe("Rename space in the pane view", () => {
  it("answers where the multiplexer declares renameSpace, and renames the space in view", async () => {
    declares({ renameSpace: true });
    const posted: Array<{ id: string; body: unknown }> = [];
    server.use(
      http.post("/api/space/:id/rename", async ({ params, request }) => {
        posted.push({ id: String(params.id), body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
    );
    await mount("w1:p2");
    await waitFor(() => expect(isShortcutActionAvailable("rename_space")).toBe(true));
    expect(runShortcutAction("rename_space")).toBe(true);
    const sheet = await screen.findByRole("dialog", { name: t("space.space.titleWithLabel", { label: "alpha" }) });
    const field = await within(sheet).findByRole("textbox");
    expect(field).toHaveValue("alpha");
    const user = userEvent.setup();
    await user.clear(field);
    await user.type(field, "gamma");
    await user.click(within(sheet).getByRole("button", { name: t("actionSheet.save") }));
    await waitFor(() => expect(posted).toEqual([{ id: "w1", body: { label: "gamma" } }]));
  });

  it("is not offered where the multiplexer does not declare renameSpace", async () => {
    declares({ renameSpace: false });
    await mount("w1:p2");
    // The config has landed: a declared capability would have answered by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isShortcutActionAvailable("rename_space")).toBe(false);
  });
});
