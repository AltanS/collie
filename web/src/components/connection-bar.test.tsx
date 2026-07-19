import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { ConnectionBar } from "./connection-bar";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";

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
  it("shows 'offline' when the browser is offline (regardless of bridge state)", () => {
    renderBar(<ConnectionBar online={false} bridge="connected" error={false} />);
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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reconnecting… → not connected once past the threshold", () => {
    render(<ConnectionBar online bridge="connected" error />, { wrapper: MemoryRouter });
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("reconnecting…")).not.toBeInTheDocument();
    expect(screen.getByText("not connected")).toBeInTheDocument();
  });

  it("rests the header mark (stops galloping) once the outage passes the threshold", () => {
    const { container } = render(<ConnectionBar online bridge="connected" error />, {
      wrapper: MemoryRouter,
    });
    // Reconnecting: the mark gallops.
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    // Escalated: same mark, no longer galloping.
    const sprite = container.querySelector(".dog-gallop");
    expect(sprite).not.toBeNull();
    expect(sprite).not.toHaveClass("dog-gallop--running");
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
