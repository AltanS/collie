import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus } from "@/lib/status";
import type { MuxCapability, MuxConfig } from "@/lib/types";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// THE FLOATING NEW BUTTON AND THE WAYS INTO THE NEW PAGE (DESIGN.md §1, M48 spec 01), through the real
// home route: when the button is drawn, how it shrinks, where each entry goes (/new, on the machine
// the view shows), and the ways the button steps aside. The page itself is in routes/new.test.tsx,
// the button's look in components/ui/fab.test.tsx and the rules in lib/new-page.test.ts.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));
const keyboard = vi.hoisted(() => ({ open: false }));
vi.mock("@/hooks/use-keyboard", () => ({ useKeyboardOpen: () => keyboard.open }));

const REFUSAL = "Saved copy. Reconnect to make changes.";

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

function renderHome(data: HomeData, entry = "/") {
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
      { path: "/new", element: <div data-testid="new-page" /> },
      { path: "/pane/:paneId", element: <div data-testid="pane" /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
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
  it("reads \"+ New\" at the top: a pill in the house 2px corner, named New", async () => {
    renderHome(homeData());
    const button = await screen.findByRole("button", { name: "New" });
    expect(button).toBe(fab());
    expect(button).toHaveClass("w-28", "rounded-md", "bg-primary");
    expect(button).not.toHaveAttribute("data-collapsed");
  });

  it("shrinks to the round \"+\" once the list scrolls, and grows back at the top", async () => {
    renderHome(homeData());
    const button = await screen.findByRole("button", { name: "New" });
    const scroller = document.querySelector<HTMLElement>("div.overflow-y-auto");
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 200;
    fireEvent.scroll(scroller!);
    await waitFor(() => expect(button).toHaveAttribute("data-collapsed", "true"));
    expect(button).toHaveClass("w-14", "rounded-[28px]");
    scroller!.scrollTop = 0;
    fireEvent.scroll(scroller!);
    await waitFor(() => expect(button).not.toHaveAttribute("data-collapsed"));
  });

  it("goes to the New page: a push to /new that remembers the dashboard it came from", async () => {
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await screen.findByTestId("new-page");
    expect(router.state.location.pathname).toBe("/new");
    expect(router.state.location.search).toBe("");
    expect(router.state.location.state).toEqual({ from: "/" });
  });

  it("carries the machine the view shows, so the page opens on it", async () => {
    const router = renderHome(homeData({ scope: { host: "mini" } }), "/?h=mini");
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await screen.findByTestId("new-page");
    expect(router.state.location.pathname + router.state.location.search).toBe("/new?machine=mini");
    expect(router.state.location.state).toEqual({ from: "/?h=mini" });
  });

  it("the Spaces list's folder button goes to the same page", async () => {
    const router = renderHome(homeData());
    await screen.findByRole("button", { name: "New" });
    await userEvent.click(screen.getByRole("button", { name: /new space/i }));
    await screen.findByTestId("new-page");
    expect(router.state.location.pathname).toBe("/new");
  });

  it("an empty dashboard shows the large first-agent card, which goes to the same page", async () => {
    const router = renderHome(homeData({ agents: [], shellPanes: [] }));
    await userEvent.click(await screen.findByRole("button", { name: /Start your first agent/ }));
    await screen.findByTestId("new-page");
    expect(router.state.location.pathname).toBe("/new");
  });

  it("is not drawn when nothing can be created: no createSpace and no launchers", async () => {
    declares({ createSpace: false });
    renderHome(homeData());
    await screen.findByRole("combobox", { name: "Workspace" });
    // The capability read is async; give it a turn, then it must still be absent.
    await waitFor(() => expect(fab()).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(fab()).toBeNull();
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
    await screen.findByRole("button", { name: "New" });
    // A row's hold opens the pane actions sheet, the app's one floating layer.
    const section = screen.getByRole("heading", { name: "webapp" }).closest("section")!;
    fireEvent.contextMenu(within(section.querySelector<HTMLElement>('[data-slot="list-group"]')!).getAllByRole("button")[0]!);
    await screen.findByRole("dialog");
    expect(fab()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(fab()).not.toBeNull());
  });

  it("steps aside while the on-screen keyboard is up", async () => {
    keyboard.open = true;
    renderHome(homeData());
    await screen.findByRole("combobox", { name: "Workspace" });
    expect(fab()).toBeNull();
  });

  it("stays drawn on a saved copy and refuses on the tap: no navigation, the floating status says why", async () => {
    const router = renderHome(homeData({ stale: true }));
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
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
