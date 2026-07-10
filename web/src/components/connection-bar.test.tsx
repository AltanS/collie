import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { ConnectionBar } from "./connection-bar";

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
