import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { PackProvider } from "./pack-provider";

import type { AgentView, ServerSummary } from "@/lib/types";
import { ServerSwitcher } from "./server-switcher";

// The machine switcher, built on the SessionSwitcher's contract: hidden unless there is a real
// choice, portalled sheet, unreachable rows disabled AND guarded. What it adds on top is the honest
// presentation of a member that is down or incompatible — §10.2's "listed, never hidden".

const lead: ServerSummary = {
  id: "bluefin",
  name: "bluefin",
  isLead: true,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 1_000,
};
const peer: ServerSummary = {
  id: "workshop",
  name: "workshop",
  isLead: false,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 990,
};
const down: ServerSummary = {
  id: "attic",
  name: "attic",
  isLead: false,
  reachable: false,
  protocol: "ok",
  lastSeenAt: Date.now() - 60_000,
};
/** Enrolled, but has never once answered — `lastSeenAt: 0` (§9.2), which is not "just now". */
const neverSeen: ServerSummary = {
  id: "cellar",
  name: "cellar",
  isLead: false,
  reachable: false,
  protocol: "unknown",
  lastSeenAt: 0,
};
const skewed: ServerSummary = {
  id: "garage",
  name: "garage",
  isLead: false,
  reachable: false,
  protocol: "incompatible",
  protocolDetail: "pack protocol 2 (this collie speaks 1)",
  lastSeenAt: 0,
};

const agentOn = (host: string, paneId: string, status: AgentView["status"]): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "ws",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status,
  cwd: "/home/you/ws",
  focused: false,
  host,
});

function renderSwitcher(
  servers: ServerSummary[],
  host: string | undefined,
  agents: AgentView[] = [],
) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <ServerSwitcher servers={servers} scope={{ host }} agents={agents} />,
      },
    ],
    { initialEntries: [host ? `/?h=${host}` : "/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const location = (router: ReturnType<typeof renderSwitcher>) =>
  router.state.location.pathname + router.state.location.search;

const trigger = () => screen.queryByRole("button", { name: /switch host/i });
// Rows are looked up INSIDE the sheet's list: the trigger carries the current machine's name too, so
// a bare `getByRole("button", {name: /bluefin/})` would be ambiguous.
const row = (name: RegExp) => within(screen.getByRole("list")).getByRole("button", { name });

describe("ServerSwitcher — trigger visibility", () => {
  it("renders nothing on a solo snapshot (no servers at all)", () => {
    renderSwitcher([], undefined);
    expect(trigger()).not.toBeInTheDocument();
  });

  it("renders nothing for a lead with no enrolled peers", () => {
    renderSwitcher([lead], undefined);
    expect(trigger()).not.toBeInTheDocument();
  });

  it("shows the trigger once a second machine is reachable", () => {
    renderSwitcher([lead, peer], undefined);
    expect(trigger()).toBeInTheDocument();
  });

  it("still shows the trigger when you are on a peer and it is the only reachable one", () => {
    // SessionSwitcher's second clause, one dimension up: you must always be able to get BACK.
    renderSwitcher([{ ...lead, reachable: false }, peer], "workshop");
    expect(trigger()).toBeInTheDocument();
  });

  it("names the machine you are currently on", () => {
    renderSwitcher([lead, peer], "workshop");
    expect(trigger()).toHaveAccessibleName(/workshop/i);
  });
});

describe("ServerSwitcher — selecting a machine", () => {
  it("navigates home on that host, carrying the session and dropping the pane", async () => {
    const router = renderSwitcher([lead, peer], undefined);
    await userEvent.click(trigger()!);
    await userEvent.click(row(/workshop/i));
    expect(location(router)).toBe("/?h=workshop");
  });

  it("selecting the lead restores today's bare URL — absent `?h=` IS the lead", async () => {
    const router = renderSwitcher([lead, peer], "workshop");
    await userEvent.click(trigger()!);
    await userEvent.click(row(/bluefin/i));
    expect(location(router)).toBe("/");
  });

  it("marks the current machine with aria-current", async () => {
    renderSwitcher([lead, peer], "workshop");
    await userEvent.click(trigger()!);
    expect(row(/workshop/i)).toHaveAttribute("aria-current", "true");
    expect(row(/bluefin/i)).not.toHaveAttribute("aria-current");
  });

  // M5/04: looking is not the dangerous verb. An unreachable member's last-good herd is merged,
  // counted on this very row and reachable from triage — where a notification tap for one of its
  // agents lands — so the switcher must not be the one surface that hides it. The write ban lives on
  // the composer and every write handler, behind the same `writable` flag; the destination announces
  // it with the HostStaleBanner before you can reach either.
  it("an unreachable machine still navigates — you may look at its last-known state", async () => {
    const router = renderSwitcher([lead, peer, down], undefined);
    await userEvent.click(trigger()!);
    const el = row(/attic/i);
    expect(el).not.toBeDisabled();
    await userEvent.click(el);
    expect(location(router)).toBe("/?h=attic");
  });

  it("an incompatible machine navigates too — its screen explains itself", async () => {
    const router = renderSwitcher([lead, peer, skewed], undefined);
    await userEvent.click(trigger()!);
    await userEvent.click(row(/garage/i));
    expect(location(router)).toBe("/?h=garage");
  });
});

describe("ServerSwitcher — a down or skewed machine is listed, never hidden", () => {
  it("keeps an unreachable machine in the list, with how long since it last answered", async () => {
    renderSwitcher([lead, peer, down], undefined);
    await userEvent.click(trigger()!);
    const el = row(/attic/i);
    expect(within(el).getByText(/unreachable/i)).toBeInTheDocument();
    expect(within(el).getByText(/last seen/i)).toBeInTheDocument();
  });

  it("says 'never seen' rather than '0s ago' for a member that has never answered", async () => {
    renderSwitcher([lead, peer, neverSeen], undefined);
    await userEvent.click(trigger()!);
    expect(within(row(/cellar/i)).getByText(/never seen/i)).toBeInTheDocument();
  });

  it("an incompatible member reads as incompatible, not as merely unreachable", async () => {
    // The two states are distinct (§10.2): unreachable is retried on the poll, incompatible is not,
    // and only one of them has an answer the operator can act on.
    renderSwitcher([lead, peer, skewed], undefined);
    await userEvent.click(trigger()!);
    expect(within(row(/garage/i)).queryByText(/unreachable/i)).not.toBeInTheDocument();
  });

  it("surfaces an incompatible peer's refusal reason verbatim", async () => {
    renderSwitcher([lead, peer, skewed], undefined);
    await userEvent.click(trigger()!);
    const el = row(/garage/i);
    expect(within(el).getByText("incompatible")).toBeInTheDocument();
    expect(within(el).getByText("pack protocol 2 (this collie speaks 1)")).toBeInTheDocument();
  });

  it("offers no pack administration — no reconnect, promote, leave or rotate", async () => {
    renderSwitcher([lead, peer, down], undefined);
    await userEvent.click(trigger()!);
    for (const verb of [/reconnect/i, /promote/i, /leave/i, /rotate/i, /retry/i]) {
      expect(screen.queryByRole("button", { name: verb })).not.toBeInTheDocument();
    }
  });
});

describe("ServerSwitcher — counts come from the merged rows, not the roster", () => {
  it("counts each machine's blocked and working agents", async () => {
    renderSwitcher([lead, peer], undefined, [
      agentOn("bluefin", "w1:p1", "working"),
      agentOn("workshop", "w1:p1", "blocked"),
      agentOn("workshop", "w2:p1", "blocked"),
    ]);
    await userEvent.click(trigger()!);
    expect(within(row(/bluefin/i)).getByText("1 working")).toBeInTheDocument();
    expect(within(row(/workshop/i)).getByText("2 needs you")).toBeInTheDocument();
  });

  it("still counts an unreachable machine's last-good panes (they never vanish)", async () => {
    renderSwitcher([lead, peer, down], undefined, [agentOn("attic", "w1:p1", "blocked")]);
    await userEvent.click(trigger()!);
    expect(within(row(/attic/i)).getByText("1 needs you")).toBeInTheDocument();
  });
});

// The switcher's rows read the same tier-2 derivation as every chip (M5/03), so "unreachable" means
// presented-stale, and the age it prints is measured on the LEAD's clock — the only clock
// `lastSeenAt` is comparable to.
describe("ServerSwitcher — staleness on the rows", () => {
  const quiet: ServerSummary[] = [
    { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 100_000 },
    { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 98_000 },
  ];

  function renderAt(ts: number) {
    render(
      <MemoryRouter>
        <PackProvider servers={quiet} ts={ts} pollMs={1500}>
          <ServerSwitcher servers={quiet} scope={{ host: "workshop" }} />
        </PackProvider>
      </MemoryRouter>,
    );
  }

  it("does not call a member unreachable while it is inside the tolerance", async () => {
    renderAt(100_000);
    await userEvent.click(screen.getByRole("button", { name: /switch host/i }));
    expect(screen.queryByText(/unreachable/i)).not.toBeInTheDocument();
  });

  it("labels it once past the tolerance, with the lead-clock age", async () => {
    renderAt(700_000); // 602s ≈ 10m since the lead last heard from it
    await userEvent.click(screen.getByRole("button", { name: /switch host/i }));
    expect(screen.getByText(/unreachable · last seen 10m/i)).toBeInTheDocument();
  });
});
