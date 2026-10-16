import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands, getMuxConfig } from "@/lib/operator-config";
import { noteSessionCards } from "@/lib/session-cards";
import type { AgentView, MuxCapability, MuxConfig, SessionSummary } from "@/lib/types";
import { fixtureAgents, fixtureWorkspaces } from "@/test/handlers";
import { server } from "@/test/setup";
import { AgentList } from "./agent-list";
import { PaneActionsSheet } from "./pane-actions-sheet";
import { SpaceOverview } from "./space-overview";
import { SpaceStrip } from "./space-strip";

// THE CAPABILITY SITES PASS THE SCOPE THEY ACT IN (M55 spec 02). Each control below used to ask the
// lead's primary session whatever it acted on. Since one collie can carry a terminal multiplexer and a
// durable program side by side, each one asks the session on screen: the machine's block says yes, the
// program session's card says no, and the control follows the card only when the scope names it.

/** The machine's own block: a terminal multiplexer that can do everything asked here. */
const MACHINE = {
  createSpace: true,
  starters: true,
  agentDetection: true,
  createWorktree: true,
} satisfies Partial<Record<MuxCapability, boolean>>;
const MACHINE_NOTES = { agentDetection: "This runtime cannot tell an agent from a shell." };

/** A program session of the same runtime name, so the machine's notes still explain it. */
const DESK: SessionSummary = {
  name: "desk",
  isPrimary: false,
  reachable: true,
  agents: 0,
  working: 0,
  blocked: 0,
  kind: "program",
  mux: "reference",
  caps: { createSpace: false, starters: false, agentDetection: false, createWorktree: false },
  where: "local",
  state: "ready",
  experimental: true,
};
const PRIMARY: SessionSummary = { ...DESK, name: "default", isPrimary: true, kind: "terminal", caps: { ...MACHINE }, experimental: false };

const DESK_SCOPE = { session: "desk" };

beforeEach(() => {
  __resetOperatorCommands();
  const mux: MuxConfig = { name: "reference", capabilities: MACHINE, unsupportedKeys: [], notes: MACHINE_NOTES };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
  noteSessionCards([PRIMARY, DESK], undefined);
});
afterEach(() => __resetOperatorCommands());

const loaded = () => waitFor(() => expect(getMuxConfig()).not.toBeNull());

describe("capability sites: each asks the session it acts in", () => {
  it("the Spaces list's New space asks the dashboard's session", async () => {
    const overview = (scope?: { session: string }) =>
      render(
        <SpaceOverview
          workspaces={fixtureWorkspaces}
          agents={[]}
          onOpen={() => {}}
          onNewSpace={() => {}}
          open
          onOpenChange={() => {}}
          scope={scope}
        />,
      );
    const terminal = overview();
    await loaded();
    expect(terminal.container.querySelector('[aria-label="New space"]')).not.toBeNull();
    terminal.unmount();
    const program = overview(DESK_SCOPE);
    expect(program.container.querySelector('[aria-label="New space"]')).toBeNull();
  });

  it("the space strip's + asks the strip's session for both createSpace and starters", async () => {
    const strip = (scope?: { session: string }) =>
      render(
        <SpaceStrip
          workspaces={fixtureWorkspaces}
          agents={[]}
          selected={null}
          onSelect={() => {}}
          onNewSpace={() => {}}
          scope={scope}
        />,
      );
    const terminal = strip();
    await loaded();
    expect(terminal.container.querySelector('[aria-label="New space"]')).not.toBeNull();
    terminal.unmount();
    const program = strip(DESK_SCOPE);
    expect(program.container.querySelector('[aria-label="New space"]')).toBeNull();
  });

  it("the empty dashboard's agent-detection note asks the dashboard's session", async () => {
    const list = (scope?: { session: string }) => {
      const router = createMemoryRouter([
        { path: "/", element: <AgentList agents={[]} shellPanes={[]} bridge="connected" onOpen={() => {}} scope={scope} /> },
      ]);
      return render(<RouterProvider router={router} />);
    };
    const terminal = list();
    await loaded();
    await screen.findByText(/No agents running/);
    expect(screen.queryByText(/cannot tell an agent from a shell/)).toBeNull();
    terminal.unmount();
    list(DESK_SCOPE);
    expect(await screen.findByText(/cannot tell an agent from a shell/)).toBeInTheDocument();
  });

  it("the pane sheet's worktree row asks the lead in the sheet's session", async () => {
    const pane: AgentView = fixtureAgents[0]!;
    const sheet = (scope?: { session: string }) =>
      render(<PaneActionsSheet open onClose={() => {}} pane={pane} scope={scope} onBranchOff={vi.fn()} onRenamed={() => {}} onClosed={() => {}} />);
    const terminal = sheet();
    expect(await screen.findByRole("button", { name: "New agent in a worktree" })).toBeInTheDocument();
    terminal.unmount();
    // The card answers at once, with no read to wait for.
    sheet(DESK_SCOPE);
    expect(screen.queryByRole("button", { name: "New agent in a worktree" })).toBeNull();
  });
});
