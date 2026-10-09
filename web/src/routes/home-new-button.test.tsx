import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus } from "@/lib/status";
import type { HarnessInfo, MuxCapability, MuxConfig } from "@/lib/types";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// THE FLOATING NEW BUTTON AND THE ONE NEW SHEET (DESIGN.md §1, M48 spec 01), through the real home
// route: when the button is drawn, how it shrinks, what the sheet offers and lists as not working,
// the start by id with its request id, the unknown outcome, and the ways the button steps aside. Its
// look is pinned in components/ui/fab.test.tsx and the sheet's rules in lib/new-sheet.test.ts.

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

const HARNESSES: readonly HarnessInfo[] = [
  { id: "claude", label: "Claude Code", found: true },
  { id: "codex", label: "Codex", found: true },
  { id: "grok", label: "Grok", found: false },
];

/** This machine's rows and agents, as a 1.19.0 bridge answers them. */
function serveLaunchers(harnesses: readonly HarnessInfo[] = HARNESSES): void {
  server.use(
    http.get("/api/launchers", () =>
      HttpResponse.json({ launchers: [{ command: "rumen-peek", label: "Runs & quota" }], home: "/home/op", harnesses }),
    ),
  );
}

/** Answer every launch with a fresh pane, and keep each body. */
function serveLaunch(bodies: unknown[], fail: number[] = []): void {
  server.use(
    http.post("/api/launch", async ({ request }) => {
      bodies.push(await request.json());
      if (fail.includes(bodies.length)) return new HttpResponse("bad gateway", { status: 502 });
      return HttpResponse.json({
        ok: true,
        pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" },
      });
    }),
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

  it("opens ONE sheet: the agents this machine found, Shell and the rows, and Start runs the agent by id", async () => {
    serveLaunchers();
    const bodies: unknown[] = [];
    serveLaunch(bodies);
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    const group = within(sheet).getByRole("radiogroup", { name: "What to start" });
    await within(group).findByRole("radio", { name: /Claude Code/ });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Codex"),
      "Shell",
      "Runs & quota",
    ]);
    // Opens on the first agent found, and the line above Start says so.
    expect(within(group).getByRole("radio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "true");
    expect(within(sheet).getByTestId("new-sheet-summary")).toHaveTextContent("Claude Code in ~");
    await userEvent.click(within(group).getByRole("radio", { name: /Codex/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Folder" }), "~/src/app");
    expect(within(sheet).getByTestId("new-sheet-summary")).toHaveTextContent("Codex in ~/src/app");
    await userEvent.click(within(sheet).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bodies).toEqual([{ harness: "codex", cwd: "~/src/app", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
  });

  it("lists what cannot run at the TOP, each with its reason, and never offers it below", async () => {
    serveLaunchers();
    declares({ createWorktree: false });
    renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    const off = await within(sheet).findByTestId("new-sheet-off");
    await waitFor(() => expect(off).toHaveTextContent("Grok: not found on this machine"));
    await waitFor(() => expect(off).toHaveTextContent("On a new branch: needs Herdr"));
    expect(within(sheet).queryByRole("radio", { name: /Grok/ })).toBeNull();
    // The block sits above everything it is about.
    const group = within(sheet).getByRole("radiogroup", { name: "What to start" });
    expect(off.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an older Collie: no agents, a line that says why, and Shell goes through its space create", async () => {
    // The default handler answers without `harnesses`, as a bridge before 1.19.0 does.
    const created: unknown[] = [];
    server.use(
      http.post("/api/workspace", async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json({
          ok: true,
          pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/op" },
        });
      }),
    );
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    expect(await within(sheet).findByTestId("new-sheet-off")).toHaveTextContent(
      "Agents: this machine runs an older Collie, which cannot start agents by name",
    );
    expect(within(sheet).getByRole("radio", { name: "Shell" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(sheet).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(created).toEqual([{}]);
  });

  it("an answer that never came is shown, never re-sent, and Try again sends the SAME request id", async () => {
    serveLaunchers();
    const bodies: Array<{ requestId?: string }> = [];
    serveLaunch(bodies, [1]);
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    await within(sheet).findByRole("radio", { name: /Claude Code/ });
    await userEvent.click(within(sheet).getByRole("button", { name: "Start" }));
    expect(await within(sheet).findByRole("status")).toHaveTextContent("Collie could not confirm the start.");
    expect(bodies).toHaveLength(1);
    await userEvent.click(within(sheet).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId);
  });

  it("the next opening offers Again with the last start, and one tap runs it", async () => {
    serveLaunchers();
    const bodies: unknown[] = [];
    serveLaunch(bodies);
    const router = renderHome(homeData());
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    let sheet = await screen.findByRole("dialog", { name: "New" });
    await userEvent.click(await within(sheet).findByRole("radio", { name: /Codex/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w9%3Ap1"));
    // Back on the dashboard, a second opening.
    await router.navigate("/");
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    sheet = await screen.findByRole("dialog", { name: "New" });
    const again = await within(sheet).findByRole("button", { name: /Again: Codex/ });
    await userEvent.click(again);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ harness: "codex" });
  });

  it("the Spaces list's folder button opens the same sheet", async () => {
    renderHome(homeData());
    await screen.findByRole("button", { name: "New" });
    const spaces = screen.getByRole("button", { name: /new space/i });
    await userEvent.click(spaces);
    expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
  });

  it("an empty dashboard shows the large first-agent card, which opens the same sheet", async () => {
    renderHome(homeData({ agents: [], shellPanes: [] }));
    const card = await screen.findByRole("button", { name: /Start your first agent/ });
    await userEvent.click(card);
    expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await screen.findByRole("dialog", { name: "New" });
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
