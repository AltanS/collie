import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { ConnectionBar } from "./connection-bar";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth } from "@/lib/connection-health";

// The bar calls useNavigate (the Settings gear) and renders router-aware children, so it needs a
// router context.
function renderBar(ui: ReactElement) {
  return render(ui, { wrapper: MemoryRouter });
}

// Probe the live router location so a test can assert where an imperative navigation landed.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderBarAt(ui: ReactElement, initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      {ui}
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("ConnectionBar", () => {
  it("shows 'live' even when the browser claims offline, as long as polls are healthy (poll-truth)", () => {
    // The lying-onLine case: onLine stuck false while the snapshot path is fine must NOT gallop a
    // phantom outage — liveness is poll-truth, not navigator.onLine.
    renderBar(<ConnectionBar online={false} bridge="connected" error={false} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("shows 'offline' only when NOT live AND the browser reports offline (copy-only use of onLine)", () => {
    // Here the snapshot genuinely failed (error), so we're not live; onLine=false then picks "offline"
    // as the most-likely cause to name.
    renderBar(<ConnectionBar online={false} bridge="connected" error />);
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when there is a refresh error", () => {
    renderBar(<ConnectionBar online bridge="connected" error />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when the bridge status is unknown", () => {
    renderBar(<ConnectionBar online bridge={undefined} error={false} />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'Herdr offline' when the bridge reports disconnected", () => {
    renderBar(<ConnectionBar online bridge="disconnected" error={false} />);
    expect(screen.getByText("Herdr offline")).toBeInTheDocument();
  });

  it("shows 'live' when online, connected, and no error", () => {
    renderBar(<ConnectionBar online bridge="connected" error={false} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when a load has stalled (online + connected, no dedicated label)", () => {
    renderBar(<ConnectionBar online bridge="connected" error={false} stalled />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("returns to the dashboard via onHome when the Collie wordmark is tapped", async () => {
    const onHome = vi.fn();
    renderBar(<ConnectionBar online bridge="connected" error={false} onHome={onHome} />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("does not render a per-poll spinner while live (no flicker on revalidate)", () => {
    const { container } = renderBar(<ConnectionBar online bridge="connected" error={false} />);
    // The bar deliberately has no `fetching` prop and no spinning indicator.
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("navigates to /settings with no ?s= on the primary session", async () => {
    renderBarAt(<ConnectionBar online bridge="connected" error={false} />, ["/"]);
    // Imperative nav — assert it lands on the right, session-scoped path.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("loc").textContent).toBe("/settings");
  });

  it("carries the current session into the Settings navigation", async () => {
    renderBarAt(
      <ConnectionBar online bridge="connected" error={false} session="collie-demo" />,
      ["/?s=collie-demo"],
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("loc").textContent).toBe("/settings?s=collie-demo");
  });
});

// The transient "reconnecting…" pill escalates to an honest "not connected" once the reconnect has
// dragged on past CONNECTION_LOST_MS — the same threshold that raises the prominent prompt, so the
// two agree. Fake timers drive the wall-clock hook (Vitest advances Date.now with them).
describe("ConnectionBar — escalates the pill after a sustained outage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // anchor == frozen clock, so the threshold boundary is exact
  });
  afterEach(() => vi.useRealTimers());

  it("reconnecting… → not connected once past the threshold", () => {
    render(<ConnectionBar online bridge="connected" error />, { wrapper: MemoryRouter });
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("reconnecting…")).not.toBeInTheDocument();
    expect(screen.getByText("not connected")).toBeInTheDocument();
  });

  it("rests the header mark on the muted static icon (never a frozen sprite) past the threshold", () => {
    const { container } = render(<ConnectionBar online bridge="connected" error />, {
      wrapper: MemoryRouter,
    });
    // Reconnecting: the mark gallops.
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    // Escalated: the gallop sprite is gone entirely, replaced by the static app icon muted to grayscale
    // — no full-stretch rest-frame that looks frozen mid-run.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    const icon = container.querySelector("img");
    expect(icon).toHaveAttribute("src", "/favicon.svg");
    expect(icon?.className).toMatch(/grayscale/);
  });

  it("does not escalate a stall that recovers before the threshold", () => {
    const { rerender } = render(<ConnectionBar online bridge="connected" error={false} stalled />, {
      wrapper: MemoryRouter,
    });
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 3_000));
    rerender(<ConnectionBar online bridge="connected" error={false} />); // recovered → live
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.queryByText("not connected")).not.toBeInTheDocument();
  });
});
