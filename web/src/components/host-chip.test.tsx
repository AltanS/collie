import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentList } from "./agent-list";
import { HostChip } from "./host-chip";
import { PackProvider } from "./pack-provider";
import { PaneActionsSheet } from "./pane-actions-sheet";
import { TabActionsSheet } from "./tab-actions-sheet";
import { triage } from "@/lib/triage";
import { fixtureAgents, fixturePackAgents, fixtureServers } from "@/test/handlers";
import type { AgentView, ServerSummary, TabView } from "@/lib/types";

// The host label — and, far more importantly, its ABSENCE. Every case here is really one of two
// claims: a one-host install renders zero host chrome anywhere, and a multi-host one can never leave
// you unsure which machine a write is about to land on.

const solo: ServerSummary[] = [fixtureServers[0]!];

const pack = ({ children }: { children: React.ReactNode }) => (
  <PackProvider servers={fixtureServers}>{children}</PackProvider>
);
const one = ({ children }: { children: React.ReactNode }) => (
  <PackProvider servers={solo}>{children}</PackProvider>
);

const chips = () => screen.queryAllByLabelText(/host:|sends to host:/i);

describe("HostChip — the hide rule lives here", () => {
  it("renders nothing with no provider at all (a component mounted bare)", () => {
    render(<HostChip host="workshop" />);
    expect(chips()).toHaveLength(0);
  });

  it("renders nothing on a one-machine pack, even when handed a host", () => {
    render(<HostChip host="bluefin" />, { wrapper: one });
    expect(chips()).toHaveLength(0);
  });

  it("renders nothing when there is no host to name", () => {
    render(<HostChip host={undefined} />, { wrapper: pack });
    expect(chips()).toHaveLength(0);
  });

  it("names the machine on a multi-machine pack", () => {
    render(<HostChip host="workshop" />, { wrapper: pack });
    expect(screen.getByLabelText("Host: workshop")).toBeInTheDocument();
  });

  it("says so when the machine is unreachable, instead of dropping the label", () => {
    render(<HostChip host="attic" />, { wrapper: pack });
    expect(screen.getByLabelText(/attic \(unreachable\)/i)).toBeInTheDocument();
  });

  it("renders a host the roster no longer lists as itself, not as the lead", () => {
    render(<HostChip host="departed" />, { wrapper: pack });
    expect(screen.getByLabelText(/departed \(unreachable\)/i)).toBeInTheDocument();
  });

  it("the write-surface variant says where the write GOES", () => {
    render(<HostChip host="workshop" variant="target" />, { wrapper: pack });
    expect(screen.getByLabelText("Sends to host: workshop")).toBeInTheDocument();
  });

  it("is not a control — it can never be mistaken for the switcher", () => {
    render(<HostChip host="workshop" />, { wrapper: pack });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("the herd list — one cross-host 'Needs you', labelled not split", () => {
  it("a one-host install renders zero host chrome in any row", () => {
    render(<AgentList agents={fixtureAgents} onOpen={vi.fn()} />, { wrapper: one });
    expect(chips()).toHaveLength(0);
  });

  it("keeps blocked agents from BOTH machines in the same 'Needs you' section", () => {
    render(<AgentList agents={fixturePackAgents} onOpen={vi.fn()} />, { wrapper: pack });
    // One section, two machines. A per-host split would let a blocked agent hide under a collapsed
    // heading — the failure triage.ts already refuses for its own sections.
    const needs = screen.getAllByRole("heading").filter((h) => /needs you/i.test(h.textContent ?? ""));
    expect(needs).toHaveLength(1);
    const rows = screen.getAllByRole("button").filter((b) => within(b).queryByLabelText(/^host:/i));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByLabelText("Host: bluefin").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Host: workshop").length).toBeGreaterThan(0);
  });

  it("triage itself stays host-blind — the same rows bucket the same way, host or no host", () => {
    const stripped = fixturePackAgents.map(({ host: _host, ...rest }) => rest as AgentView);
    const withHosts = triage(fixturePackAgents).map((s) => [s.key, s.agents.map((a) => a.paneId)]);
    const without = triage(stripped).map((s) => [s.key, s.agents.map((a) => a.paneId)]);
    expect(withHosts).toEqual(without);
  });
});

describe("write surfaces name the machine", () => {
  const pane: AgentView = { ...fixturePackAgents[2]! }; // the peer's blocked agent
  const tab: TabView = {
    tabId: "w1:t1",
    workspaceId: "w1",
    number: 1,
    label: "code",
    focused: false,
    paneCount: 2,
  };

  it("the pane actions sheet (rename / close) says which machine's pane", () => {
    render(
      <PaneActionsSheet open pane={pane} onClose={vi.fn()} onRenamed={vi.fn()} onClosed={vi.fn()} />,
      { wrapper: pack },
    );
    expect(screen.getByLabelText("Sends to host: workshop")).toBeInTheDocument();
  });

  it("…and says nothing at all on a one-machine install", () => {
    render(
      <PaneActionsSheet open pane={pane} onClose={vi.fn()} onRenamed={vi.fn()} onClosed={vi.fn()} />,
      { wrapper: one },
    );
    expect(chips()).toHaveLength(0);
  });

  it("the tab actions sheet names the machine the ambient scope writes to", () => {
    render(
      <TabActionsSheet
        open
        tab={tab}
        scope={{ host: "workshop" }}
        onClose={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
      { wrapper: pack },
    );
    expect(screen.getByLabelText("Sends to host: workshop")).toBeInTheDocument();
  });

  it("a tab sheet with no `?h=` names the LEAD — absent is not unknown", () => {
    render(
      <TabActionsSheet open tab={tab} onClose={vi.fn()} onRenamed={vi.fn()} onClosed={vi.fn()} />,
      { wrapper: pack },
    );
    expect(screen.getByLabelText("Sends to host: bluefin")).toBeInTheDocument();
  });

  it("the close confirm is still a two-tap, with the host visible the whole way", async () => {
    render(
      <PaneActionsSheet open pane={pane} onClose={vi.fn()} onRenamed={vi.fn()} onClosed={vi.fn()} />,
      { wrapper: pack },
    );
    await userEvent.click(screen.getByRole("button", { name: /close pane/i }));
    expect(screen.getByRole("button", { name: /tap again to close/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Sends to host: workshop")).toBeInTheDocument();
  });
});

// The §10.2 presented-stale threshold, seen from the chip (M5/03). The tolerance is what stops a
// single dropped sweep flapping every label in the herd list between two good polls.
describe("HostChip — presented-stale, not merely 'the last poll missed'", () => {
  const quiet: ServerSummary[] = [
    { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 100_000 },
    { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 98_000 },
  ];
  const at = (ts: number) =>
    ({ children }: { children: React.ReactNode }) => (
      <PackProvider servers={quiet} ts={ts} pollMs={1500}>
        {children}
      </PackProvider>
    );

  it("stays plain while inside the tolerance — one missed sweep is invisible", () => {
    // 2s since the lead last heard from it, against a 4.5s (3 × 1500ms) tolerance.
    render(<HostChip host="workshop" />, { wrapper: at(100_000) });
    expect(screen.getByLabelText("Host: workshop")).toBeInTheDocument();
  });

  it("says unreachable once past it", () => {
    render(<HostChip host="workshop" />, { wrapper: at(110_000) });
    expect(screen.getByLabelText(/workshop \(unreachable\)/i)).toBeInTheDocument();
  });

  it("never degrades the LEAD — whether the phone can reach it is the other tier's answer", () => {
    // Even with a `ts` far past any tolerance, the lead's chip is plain: a lead we couldn't reach
    // would produce no snapshot at all, and duplicating tier 1's answer here is how two surfaces
    // start disagreeing about one outage.
    render(<HostChip host="bluefin" />, { wrapper: at(10_000_000) });
    expect(screen.getByLabelText("Host: bluefin")).toBeInTheDocument();
  });
});
