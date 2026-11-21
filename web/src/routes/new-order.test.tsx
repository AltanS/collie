import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { t } from "@/lib/i18n";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { useRootData } from "@/lib/route-data";
import { clearStatus } from "@/lib/status";
import type { LauncherItem } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";

import { NewRoute } from "./new";

// THE AGENT SELECT'S ORDER (lib/new-page.ts `agentsInPickOrder`): the person's own agents first, then the
// built-in agents that are installed, then those that are not. The agent selected when New opens does not move:
// it is the first built-in that starts, as before, never an own agent for standing first.

function homeData(): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function Crew() {
  const data = useRootData();
  return (
    <CrewProvider servers={data.servers} sessions={[]} ts={0} pollMs={1500}>
      <Outlet />
    </CrewProvider>
  );
}

function mount() {
  const data = homeData();
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ ...data }),
        element: withHeaderHost(<Crew />),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "new", element: <NewRoute /> },
        ],
      },
    ],
    { initialEntries: ["/new"] },
  );
  render(<RouterProvider router={router} />);
}

const ITEMS: LauncherItem[] = [
  { key: "harness:claude", start: { harness: "claude" }, group: "agents", label: "Claude Code", harness: "claude", source: "builtin", noPrompts: false, branch: true, available: true },
  { key: "harness:grok", start: { harness: "grok" }, group: "agents", label: "Grok", harness: "grok", source: "builtin", noPrompts: false, branch: true, available: false, reason: "not_found" },
  { key: "harness:codex", start: { harness: "codex" }, group: "agents", label: "Codex", harness: "codex", source: "builtin", noPrompts: false, branch: true, available: true },
  { key: "row:claude --review", start: { command: "claude --review" }, group: "agents", label: "Review bot", harness: "claude", command: "claude --review", source: "added", noPrompts: true, branch: true, available: true },
  { key: "shell", start: { shell: true }, group: "commands", label: "Shell", source: "builtin", noPrompts: false, branch: true, available: true },
];

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
  __resetOperatorCommands();
});

describe("the New page's Agent select", () => {
  it("lists own agents first, then installed built-ins, then those not installed, and opens on the same agent as before", async () => {
    server.use(http.get("/api/launchers", () => HttpResponse.json({ launchers: [], home: "/home/you", harnesses: [], items: ITEMS })));
    mount();
    const select = await screen.findByRole("combobox", { name: t("newPage.kind.agent") });
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(4));
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("value"))).toEqual(["row:claude --review", "harness:claude", "harness:codex", "harness:grok"]);
    expect(options.map((o) => o.hasAttribute("disabled"))).toEqual([false, false, false, true]);
    // The default: the first built-in that starts, as on the order before; never the own agent now first.
    expect(select).toHaveValue("harness:claude");
  });
});
