import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus } from "@/lib/status";
import type { MuxCapability, MuxConfig, WorkspaceView } from "@/lib/types";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// THE FLOATING NEW BUTTON (DESIGN.md §1, card 1.3, 2026-10-08), through the real home route: when it
// is drawn, what its sheet offers, and the three ways it steps aside (a sheet, the keyboard, a
// device that may not write). Its look is pinned in components/ui/fab.test.tsx and the sheet's rows
// in components/new-sheet.test.tsx.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));
const keyboard = vi.hoisted(() => ({ open: false }));
vi.mock("@/hooks/use-keyboard", () => ({ useKeyboardOpen: () => keyboard.open }));

const REFUSAL = "Saved copy. Reconnect to make changes.";

const repoSpaces: WorkspaceView[] = fixtureWorkspaces.map((w) => ({
  ...w,
  repoRoot: `/home/op/${w.label}`,
  isWorktree: false,
}));

function homeData(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: fixtureAgents,
    shellPanes: fixtureShellPanes,
    workspaces: fixtureWorkspaces,
    tabs: fixtureTabs,
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    ...over,
  };
}

function renderHome(data: HomeData) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <HomeRoute />
          </CrewProvider>,
        ),
      },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

function serveNoWorktrees(): void {
  server.use(http.get(/\/api\/workspace\/[^/]+\/worktrees$/, () => HttpResponse.json({ ok: true, worktrees: [] })));
}

function serveLaunchers(): void {
  server.use(
    http.get("/api/launchers", () =>
      HttpResponse.json({ launchers: [{ command: "rumen-peek", label: "Runs & quota" }], home: "/home/op" }),
    ),
  );
}

const fab = () => document.querySelector<HTMLButtonElement>('[data-slot="fab"]');
/** The fixed toast dock: the one portalled `div.fixed` that is not the button's own layer. */
const toastDock = () =>
  [...document.body.querySelectorAll<HTMLElement>("div.fixed")].find((el) => el.className.includes("z-40"));

afterEach(() => {
  cleanup();
  clearStatus();
  keyboard.open = false;
  localStorage.clear();
  __resetOperatorCommands();
});

describe("the floating New button on the dashboard", () => {
  it("is drawn, round, named New, with the Plus glyph", async () => {
    renderHome(homeData());
    const button = await screen.findByRole("button", { name: "New" });
    expect(button).toBe(fab());
    expect(button).toHaveClass("size-14", "rounded-full", "bg-primary");
  });

  it("opens ONE sheet titled New, with only the Space row when nothing else can be made", async () => {
    renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    expect(within(sheet).getByRole("button", { name: "Space" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Agent" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Agent on a branch" })).toBeNull();
  });

  it("offers Agent once the launcher rows arrive, and a row runs the same /api/launch call", async () => {
    serveLaunchers();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/launch", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          ok: true,
          pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "peek", tabId: "w9:t1", cwd: "/home/op" },
        });
      }),
    );
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    await userEvent.click(await within(sheet).findByRole("button", { name: "Agent" }));
    // The second level lists the rows, with the command as the hint, and a Back row.
    const agents = await screen.findByRole("dialog", { name: "Agent" });
    expect(within(agents).getByRole("button", { name: "Back" })).toBeInTheDocument();
    await userEvent.click(within(agents).getByRole("button", { name: /Runs & quota/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bodies).toEqual([{ command: "rumen-peek" }]);
  });

  it("offers Agent on a branch only with a repo, and opens the new-space sheet on its Worktree tab", async () => {
    serveNoWorktrees();
    renderHome(homeData({ workspaces: repoSpaces }));
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Agent on a branch" }));
    // The New sheet closes and the other one arrives alone, already on the Worktree side.
    const space = await screen.findByRole("dialog", { name: "New space" });
    expect(screen.queryByRole("dialog", { name: "New" })).toBeNull();
    expect(within(space).getByRole("tab", { name: "Worktree" })).toHaveAttribute("aria-selected", "true");
  });

  it("Space opens the new-space sheet on its plain side", async () => {
    serveNoWorktrees();
    renderHome(homeData({ workspaces: repoSpaces }));
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "New" })).getByRole("button", { name: "Space" }));
    const space = await screen.findByRole("dialog", { name: "New space" });
    expect(within(space).getByRole("tab", { name: "Space" })).toHaveAttribute("aria-selected", "true");
  });

  it("hides the branch row when the multiplexer cannot make a worktree, whatever repos are open", async () => {
    declares({ createWorktree: false });
    renderHome(homeData({ workspaces: repoSpaces }));
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    expect(within(sheet).getByRole("button", { name: "Space" })).toBeInTheDocument();
    // The capability read is async and the default reads as capable (lib/mux-capability.ts), so the
    // row is withdrawn when the bridge's answer lands.
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "Agent on a branch" })).toBeNull());
  });

  it("is not drawn when nothing can be created: no createSpace, no launchers, no repo", async () => {
    declares({ createSpace: false });
    renderHome(homeData());
    await screen.findByRole("combobox", { name: "Workspace" });
    // The capability read is async; give it a turn, then it must still be absent.
    await waitFor(() => expect(fab()).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(fab()).toBeNull();
  });

  it("is drawn on launchers alone when the multiplexer cannot make a space", async () => {
    declares({ createSpace: false });
    serveLaunchers();
    renderHome(homeData());
    await screen.findByRole("button", { name: "New" });
    await userEvent.click(fab()!);
    const sheet = await screen.findByRole("dialog", { name: "New" });
    expect(within(sheet).getByRole("button", { name: "Agent" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Space" })).toBeNull();
  });

  it("is drawn on the Dashboard tab only: not on Files, and back on return", async () => {
    renderHome(homeData());
    await screen.findByRole("button", { name: "New" });
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    await waitFor(() => expect(fab()).toBeNull());
    // The toast lift and the stamp's air follow the button, so a hidden one leaves both as they were.
    expect(toastDock()?.className).toContain("bottom-[calc(3.5rem+1px)]");
    expect(document.querySelector('[class*="pb-20"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Dashboard/ }));
    await waitFor(() => expect(fab()).not.toBeNull());
  });

  it("is not drawn on a device that may not write", async () => {
    renderHome(homeData({ device: { enforced: true, device: "d1", authorized: false } }));
    await screen.findByRole("combobox", { name: "Workspace" });
    expect(fab()).toBeNull();
  });

  it("steps aside while any sheet is open, and comes back when it closes", async () => {
    renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await screen.findByRole("dialog", { name: "New" });
    expect(fab()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(fab()).not.toBeNull());
  });

  it("stays hidden across the hand-off from the New sheet to the new-space sheet", async () => {
    renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "New" })).getByRole("button", { name: "Space" }));
    await screen.findByRole("dialog", { name: "New space" });
    expect(fab()).toBeNull();
  });

  it("steps aside while the on-screen keyboard is up", async () => {
    keyboard.open = true;
    renderHome(homeData());
    await screen.findByRole("combobox", { name: "Workspace" });
    expect(fab()).toBeNull();
  });

  it("stays drawn on a saved copy and refuses on the tap: no sheet, the floating status says why", async () => {
    renderHome(homeData({ stale: true }));
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the toast dock beside the New button", () => {
  it("lifts above the button's top edge when it is drawn", async () => {
    renderHome(homeData());
    await screen.findByRole("button", { name: "New" });
    // Footer 56px + 1px rule + the button's 16px gap and 56px face.
    expect(toastDock()?.className).toContain("bottom-[calc(3.5rem+1px+1rem+3.5rem)]");
    // The button's own bottom edge is the footer plus the same 16px gap, so its top edge is the
    // lift minus nothing: the two numbers must stay one sum.
    expect(fab()?.parentElement?.className).toContain("bottom-[calc(3.5rem_+_1px_+_env(safe-area-inset-bottom)_+_1rem)]");
  });

  it("keeps the footer-only lift when no button is offered", async () => {
    renderHome(homeData({ device: { enforced: true, device: "d1", authorized: false } }));
    await screen.findByRole("combobox", { name: "Workspace" });
    expect(toastDock()?.className).toContain("bottom-[calc(3.5rem+1px)]");
    expect(toastDock()?.className).not.toContain("3.5rem+1px+1rem");
  });

  it("gives the last row room to scroll clear of the button", async () => {
    renderHome(homeData());
    await screen.findByRole("button", { name: "New" });
    const stamp = document.querySelector<HTMLElement>('[class*="pb-20"]');
    expect(stamp).not.toBeNull();
  });
});
