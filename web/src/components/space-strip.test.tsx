import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";

import { SpaceStrip } from "./space-strip";
import type { AgentView, MuxCapability, WorkspaceView } from "@/lib/types";

const ws: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "anchorgenius",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
};

function agent(partial: Partial<AgentView> & { paneId: string; status: AgentView["status"] }): AgentView {
  return {
    workspaceId: "w1",
    workspaceLabel: "ws",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    cwd: "/home/you/demo",
    focused: false,
    ...partial,
  };
}

describe("SpaceStrip", () => {
  it("leads with the 'All' chip when not drilled in (no onBack)", () => {
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("carries an accessible name, so the row of chips is not an unnamed run of buttons", () => {
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
  });

  it("keeps that name in the drill-in too, so the strip is one height in both states", () => {
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected="w1"
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByText("Spaces")).toBeInTheDocument();
  });

  it("shows a Back button (and no 'All' chip) in the drill-in, returning to the dashboard", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected="w1"
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
        onBack={onBack}
      />,
    );
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("still lets you switch to a sibling space from the drill-in", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={[]}
        selected="w2"
        onSelect={onSelect}
        onNewSpace={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "anchorgenius" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1");
  });
});

// ── A blocked agent on one host must not colour another host's identically-numbered chip (#209) ──
describe("SpaceStrip — chip status is host-qualified", () => {
  it("does not paint a peer's own w1 chip with another host's blocked agent", () => {
    const agents: AgentView[] = [
      agent({ paneId: "w1:p1", host: "alpha", status: "blocked" }),
      agent({ paneId: "w1:p2", host: "beta", status: "idle" }),
    ];
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={agents}
        host="beta"
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    // Beta's own w1 is merely idle — the sr-only status word is absent from the chip altogether.
    expect(screen.queryByText(/needs you/i)).not.toBeInTheDocument();
  });

  it("still counts an untagged agent toward any host's chip — the un-widened solo case", () => {
    const agents: AgentView[] = [agent({ paneId: "w1:p9", status: "blocked" })]; // no host at all
    render(
      <SpaceStrip
        workspaces={[ws]}
        agents={agents}
        host="beta"
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(screen.getByText(/needs you/i)).toBeInTheDocument();
  });
});

describe("SpaceStrip on a program that offers starters", () => {
  function serve(capabilities: Partial<Record<MuxCapability, boolean>>): void {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: { name: "durable", capabilities, unsupportedKeys: [], notes: {} },
        }),
      ),
    );
  }

  beforeEach(() => __resetOperatorCommands());

  it("draws the '+' for declared starters though no space can be made by hand", async () => {
    serve({ createSpace: false, starters: true });
    const onNewSpace = vi.fn();
    render(<SpaceStrip workspaces={[ws]} agents={[]} selected={null} onSelect={vi.fn()} onNewSpace={onNewSpace} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "New space" }));
    expect(onNewSpace).toHaveBeenCalledTimes(1);
  });

  it("hides it when the program declared neither", async () => {
    serve({ createSpace: false, starters: false });
    render(<SpaceStrip workspaces={[ws]} agents={[]} selected={null} onSelect={vi.fn()} onNewSpace={vi.fn()} />);
    await screen.findByRole("button", { name: "All" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "New space" })).toBeNull());
  });
});

describe("SpaceStrip on a program that takes renames", () => {
  function serve(capabilities: Partial<Record<MuxCapability, boolean>>): void {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: { name: "durable", capabilities, unsupportedKeys: [], notes: {} },
        }),
      ),
    );
  }

  beforeEach(() => __resetOperatorCommands());

  it("a tap on the active space chip opens the space sheet with a Rename row", async () => {
    serve({ renameSpace: true });
    const onRenamed = vi.fn();
    render(<SpaceStrip workspaces={[ws]} agents={[]} selected="w1" onSelect={vi.fn()} onNewSpace={vi.fn()} onRenamed={onRenamed} />);
    // The declaration arrives with /api/config; until then the chip is a plain switch.
    await waitFor(async () => {
      await userEvent.setup().click(screen.getByRole("button", { name: /anchorgenius/ }));
      expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    });
  });

  it("with no renameSpace declared, or no onRenamed, a tap on the active chip opens nothing", async () => {
    serve({ renameSpace: false });
    const { unmount } = render(
      <SpaceStrip workspaces={[ws]} agents={[]} selected="w1" onSelect={vi.fn()} onNewSpace={vi.fn()} onRenamed={vi.fn()} />,
    );
    await screen.findByRole("button", { name: /anchorgenius/ });
    await userEvent.setup().click(screen.getByRole("button", { name: /anchorgenius/ }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    unmount();

    __resetOperatorCommands();
    serve({ renameSpace: true });
    render(<SpaceStrip workspaces={[ws]} agents={[]} selected="w1" onSelect={vi.fn()} onNewSpace={vi.fn()} />);
    await screen.findByRole("button", { name: /anchorgenius/ });
    await userEvent.setup().click(screen.getByRole("button", { name: /anchorgenius/ }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});
