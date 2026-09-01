import { cleanup, render, screen, within } from "@testing-library/react";
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
    // SAFETY: `host` is optional on AgentView, so a row with it destructured away IS one — TS just
    // types the rest object as the exact remainder rather than relating it back to the interface.
    const stripped = fixturePackAgents.map(({ host: _host, ...rest }) => rest as AgentView);
    const withHosts = triage(fixturePackAgents).map((s) => [s.key, s.agents.map((a) => a.paneId)]);
    const without = triage(stripped).map((s) => [s.key, s.agents.map((a) => a.paneId)]);
    expect(withHosts).toEqual(without);
  });
});

// The caption run is the ONE variant that stands in a strip somebody else reserved, so its glyph is
// sized by that strip and not by the chip's own taste.
describe("HostChip — the caption glyph is sized by the band it stands in", () => {
  const glyph = () => document.querySelector("svg")!;

  it("draws a 10px glyph in the caption run and 12px in the pills", () => {
    // MEASURED in the browser on the pane screen at a true 390px viewport. The composer's status
    // band is 13px: a 12px line box plus its own 1px rule. A `size-3` glyph is 12px — the band's
    // whole content box — so it painted 0.0 → 12.0 from the band's top edge: no clearance at the
    // seam above it, the rule immediately below it, and an optical centre (6.00) that was neither
    // the band's (6.5) nor the caps' beside it. There was no room either side to centre it INTO.
    // At `size-2.5` it is 1.5 → 11.5 in the same box, centroid 6.5 — the band's own middle, the
    // same middle as the text it stands with, and clear of both edges. It is also the right weight
    // beside 10px type. The pills keep 12: they sit in boxes with their own padding.
    //
    // Fails in both directions: 12px in the caption run puts the glyph back on the seam, and 10px
    // in a pill shrinks a glyph whose box was never the constraint.
    render(<HostChip host="workshop" variant="caption" />, { wrapper: pack });
    expect(glyph().getAttribute("class")).toMatch(/(?:^|\s)size-2\.5(?=\s|$)/);
    cleanup();

    for (const variant of ["tag", "target"] as const) {
      render(<HostChip host="workshop" variant={variant} />, { wrapper: pack });
      expect(glyph().getAttribute("class")).toMatch(/(?:^|\s)size-3(?=\s|$)/);
      cleanup();
    }
  });

  it("keeps the size when the caption run degrades to the OTHER glyph", () => {
    // The caption run has no border to dash, so the shape of the fault moves into the glyph —
    // ServerOff rather than Server (WCAG 1.4.1: colour alone may not carry it). That swap is PAINT,
    // not layout: an unreachable machine may not be 2px taller than a reachable one, or the band's
    // whole centring is a fact about health. DESIGN.md §2.
    const down: ServerSummary[] = [
      { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 100_000 },
      { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 98_000 },
    ];
    const unreachable = ({ children }: { children: React.ReactNode }) => (
      <PackProvider servers={down} ts={100_000} pollMs={1500}>
        {children}
      </PackProvider>
    );
    render(<HostChip host="workshop" variant="caption" />, { wrapper: unreachable });
    expect(screen.getByLabelText(/workshop \(unreachable\)/i)).toBeInTheDocument();
    expect(glyph().getAttribute("class")).toMatch(/(?:^|\s)size-2\.5(?=\s|$)/);
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

// Which FACT the chip tracks (M5/03). `state === "stale"` is the age of the lead's receipt; the word
// "unreachable" and the degraded look are the lead's plain boolean, the same one that refuses a write.
// The chip announced a peer down whenever its receipt aged past the tolerance — over a machine that
// was answering every request, next to a composer that was accepting sends.
describe("HostChip — 'unreachable' is the write gate's word, never the receipt's age", () => {
  const quiet = (workshop: Partial<ServerSummary>): ServerSummary[] => [
    { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 100_000 },
    {
      id: "workshop",
      name: "workshop",
      isLead: false,
      reachable: true,
      protocol: "ok",
      lastSeenAt: 98_000,
      ...workshop,
    },
  ];
  const at = (ts: number, servers: ServerSummary[] = quiet({})) =>
    ({ children }: { children: React.ReactNode }) => (
      <PackProvider servers={servers} ts={ts} pollMs={1500}>
        {children}
      </PackProvider>
    );

  it("an old receipt on a machine the lead still believes up leaves the chip untouched", () => {
    // 12s of receipt age against a 4.5s (3 × 1500ms) tolerance, so `state` is `stale` — and that
    // changes nothing here, because `reachable` is still true and no write would be refused.
    const chip = render(<HostChip host="workshop" />, { wrapper: at(110_000) }).container
      .firstElementChild;
    expect(screen.getByLabelText("Host: workshop")).toBeInTheDocument();
    expect(screen.queryByLabelText(/unreachable/i)).not.toBeInTheDocument();
    // The look and the label are one condition, so neither may degrade without the other.
    expect(chip?.className).not.toMatch(/border-dashed/);
  });

  it("says unreachable the moment the lead's own boolean does, tolerance or no tolerance", () => {
    // Inside the tolerance (2s of age), so `state` is `live` — the refusal is not smoothed, and the
    // chip sits beside a composer that is already disabled.
    render(<HostChip host="workshop" />, { wrapper: at(100_000, quiet({ reachable: false })) });
    const chip = screen.getByLabelText(/workshop \(unreachable\)/i);
    expect(chip.className).toMatch(/border-dashed/);
  });

  it("marks a member that has never answered without calling it unreachable", () => {
    // Nothing cached, but the lead believes it is up: the chip stands out, the label does not lie.
    render(<HostChip host="workshop" />, { wrapper: at(100_000, quiet({ lastSeenAt: 0 })) });
    const chip = screen.getByLabelText("Host: workshop");
    expect(chip.className).toMatch(/border-dashed/);
  });

  it("never degrades the LEAD — whether the phone can reach it is the other tier's answer", () => {
    // Even with a `ts` far past any tolerance, the lead's chip is plain: a lead we couldn't reach
    // would produce no snapshot at all, and duplicating tier 1's answer here is how two surfaces
    // start disagreeing about one outage.
    render(<HostChip host="bluefin" />, { wrapper: at(10_000_000) });
    expect(screen.getByLabelText("Host: bluefin")).toBeInTheDocument();
  });
});

// ── The identity tint ────────────────────────────────────────────────────────────────────────────
//
// Colour is the SECOND encoding here and never the first: every assertion below has a name beside
// it. What the tests actually pin is the hide rule one more time — a solo install must not gain a
// single `host-` class — and the precedence: a machine that is not answering is a STATE, and a
// state outranks whose machine it is. The tint itself lands on the GLYPH ONLY: the tag root (its
// border, background and name text) stays the literal untinted classes on every variant.
describe("HostChip — the per-host tint (glyph only)", () => {
  // `fixtureServers` is bluefin (lead) / workshop / attic, and lib/hosts.ts hands that roster
  // slots 2 / 9 / 8. The numbers are asserted rather than recomputed: a change to the hash is a
  // change to every operator's learned colours, and it should have to be typed out here.
  const tag = (name: string) => screen.getByLabelText(name);
  // `tag`/`target` route through AddressTag, which wraps the glyph in its own span to carry the
  // tint (ui/address-tag.tsx) — the svg itself stays undecorated, so the tint lives one level up.
  // `caption` has no such wrapper; it puts the tint straight on the svg (host-chip.tsx).
  const glyphOf = (name: string) => {
    const root = tag(name);
    const svg = root.querySelector("svg")!;
    return svg.parentElement !== root ? svg.parentElement! : svg;
  };

  it("tints the row tag's glyph only — the tag root carries no host class", () => {
    render(<HostChip host="workshop" />, { wrapper: pack });
    const root = tag("Host: workshop").className;
    expect(root).not.toMatch(/bg-host-/);
    expect(root).not.toMatch(/text-host-/);
    expect(glyphOf("Host: workshop").getAttribute("class")).toMatch(/text-host-9/);
  });

  it("gives two machines two different glyph colours", () => {
    render(
      <>
        <HostChip host="bluefin" />
        <HostChip host="workshop" />
      </>,
      { wrapper: pack },
    );
    expect(glyphOf("Host: bluefin").getAttribute("class")).toMatch(/text-host-2/);
    expect(glyphOf("Host: workshop").getAttribute("class")).toMatch(/text-host-9/);
  });

  it("lets the unreachable reading win outright — a state outranks an identity", () => {
    render(<HostChip host="attic" />, { wrapper: pack });
    const chip = screen.getByLabelText(/attic \(unreachable\)/i);
    expect(chip.className).toContain("text-status-blocked");
    expect(chip.className).not.toMatch(/host-\d/);
    // The glyph itself must not pick up a host tint either — alert wins everywhere, not just on
    // the root.
    expect(chip.querySelector("svg")?.getAttribute("class")).not.toMatch(/host-\d/);
  });

  it("tints only the caption run's glyph — the name stays the muted ink", () => {
    render(<HostChip host="workshop" variant="caption" />, { wrapper: pack });
    const root = tag("Sends to host: workshop");
    expect(root.className).not.toMatch(/host-\d/);
    expect(glyphOf("Sends to host: workshop").getAttribute("class")).toMatch(/text-host-9/);
  });

  it("tints only the write surface header's glyph — its pill is already emphasis", () => {
    render(<HostChip host="workshop" variant="target" />, { wrapper: pack });
    const root = tag("Sends to host: workshop");
    expect(root.className).not.toMatch(/bg-host-/);
    expect(root.className).not.toMatch(/text-host-/);
    expect(glyphOf("Sends to host: workshop").getAttribute("class")).toMatch(/text-host-9/);
  });

  it("carries no host class ANYWHERE on a one-machine pack", () => {
    // The hide rule, restated in colour: a solo collie renders the dashboard it always rendered.
    render(<AgentList agents={fixtureAgents} onOpen={vi.fn()} />, { wrapper: one });
    expect(document.body.innerHTML).not.toMatch(/host-\d/);
  });

  it("carries no host class with no provider at all", () => {
    render(<HostChip host="workshop" />);
    expect(document.body.innerHTML).not.toMatch(/host-\d/);
  });
});
