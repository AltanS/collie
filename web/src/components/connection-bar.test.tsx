import { render, screen } from "@testing-library/react";

import { ConnectionBar } from "./connection-bar";

describe("ConnectionBar", () => {
  it("shows 'offline' when the browser is offline (regardless of bridge state)", () => {
    render(<ConnectionBar online={false} bridge="connected" error={false} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when there is a refresh error", () => {
    render(<ConnectionBar online bridge="connected" error />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when the bridge status is unknown", () => {
    render(<ConnectionBar online bridge={undefined} error={false} />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'Herdr offline' when the bridge reports disconnected", () => {
    render(<ConnectionBar online bridge="disconnected" error={false} />);
    expect(screen.getByText("Herdr offline")).toBeInTheDocument();
  });

  it("shows 'live' when online, connected, and no error", () => {
    render(<ConnectionBar online bridge="connected" error={false} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("does not render a per-poll spinner while live (no flicker on revalidate)", () => {
    const { container } = render(<ConnectionBar online bridge="connected" error={false} />);
    // The bar deliberately has no `fetching` prop and no spinning indicator.
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
