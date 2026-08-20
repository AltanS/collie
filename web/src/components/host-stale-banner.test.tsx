import { render, screen } from "@testing-library/react";

import { HostStaleBanner } from "./host-stale-banner";

import type { HostHealth } from "@/lib/host-health";
import { writeRefusal } from "@/lib/host-health";

// The banner's ONE job is to be true. It was not: on a healthy peer it printed
// "X is unreachable · last seen now. …replies and keys are refused until it answers." — a
// self-contradicting sentence, over a machine that was answering every request, above a composer that
// was accepting them. So every case below is really the same assertion twice: does it speak at all,
// and does what it says match what `writeRefusal` will actually do.

function health(over: Partial<HostHealth> = {}): HostHealth {
  return {
    host: "workshop",
    name: "workshop",
    state: "stale",
    writable: true,
    incompatible: false,
    lastSeenAt: 1_000,
    lastSeenLabel: "last seen 8s",
    isLead: false,
    ...over,
  };
}

describe("HostStaleBanner — it never claims a refusal that will not happen", () => {
  it("says nothing at all when the receipt is old but the lead believes the host is up", () => {
    // The bug. `state: "stale"` is a statement about the age of the LEAD's receipt; it is not a
    // verdict on the machine, and with `writable: true` no write is refused. The pane below was
    // fetched through that very link, so there is nothing here worth interrupting for.
    const h = health({ state: "stale", writable: true });
    expect(writeRefusal(h)).toBeUndefined();
    const { container } = render(<HostStaleBanner health={h} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the truthful banner when the lead really cannot reach the host", () => {
    const h = health({ state: "stale", writable: false, lastSeenLabel: "last seen 10m" });
    render(<HostStaleBanner health={h} />);
    expect(screen.getByText(/workshop is unreachable · last seen 10m/i)).toBeInTheDocument();
    // …and the refusal it announces is the one that will actually happen.
    expect(screen.getByText(/replies and keys are refused/i)).toBeInTheDocument();
    expect(writeRefusal(h)).toMatch(/workshop is unreachable/);
  });

  it("stays silent inside the §10.2 tolerance, even when the write gate has already closed", () => {
    // Unchanged smoothing: a single missed sweep must not flash a banner. The refusal still bites —
    // `writeRefusal` is what tells the operator, at the moment they try.
    const h = health({ state: "live", writable: false });
    const { container } = render(<HostStaleBanner health={h} />);
    expect(container).toBeEmptyDOMElement();
    expect(writeRefusal(h)).toMatch(/unreachable/);
  });

  it("says it is waiting for a first answer — one sentence, no refusal, when writes are allowed", () => {
    const h = health({ state: "unknown", writable: true, lastSeenAt: 0, lastSeenLabel: "never seen" });
    render(<HostStaleBanner health={h} />);
    expect(
      screen.getByText(/Nothing from workshop yet — waiting for its first answer\./i),
    ).toBeInTheDocument();
    // The two claims this row may not make: the machine is not down, and nothing is being refused.
    expect(screen.queryByText(/unreachable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refused/i)).not.toBeInTheDocument();
    expect(writeRefusal(h)).toBeUndefined();
    // …and it says it once. "…has not sent anything yet. Nothing cached … yet." stuttered, and read
    // like two separate faults on a member that simply has not spoken.
    expect(screen.queryByText(/nothing cached/i)).not.toBeInTheDocument();
  });

  it("still names an unreachable never-seen member as unreachable", () => {
    render(
      <HostStaleBanner health={health({ state: "unknown", writable: false, lastSeenLabel: "never seen" })} />,
    );
    expect(screen.getByText(/workshop is unreachable · never seen/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing cached for this machine yet/i)).toBeInTheDocument();
  });

  it("names an incompatible member with the peer's reason verbatim", () => {
    render(
      <HostStaleBanner
        health={health({
          state: "stale",
          writable: false,
          incompatible: true,
          protocolDetail: "pack protocol 2 (this collie speaks 1)",
        })}
      />,
    );
    expect(screen.getByText(/running an incompatible Collie/i)).toBeInTheDocument();
    expect(screen.getByText(/pack protocol 2 \(this collie speaks 1\)/i)).toBeInTheDocument();
  });

  it("renders nothing on a solo install or a live host", () => {
    expect(render(<HostStaleBanner health={undefined} />).container).toBeEmptyDOMElement();
    expect(render(<HostStaleBanner health={health({ state: "live" })} />).container).toBeEmptyDOMElement();
  });
});
