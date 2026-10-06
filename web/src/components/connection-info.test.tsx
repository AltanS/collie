import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { markNotPaired, setDeviceToken } from "@/lib/pairing";
import { ConnectionInfo } from "./connection-info";

// The diagnostics panel translates the polled snapshot into a read-only "why isn't X working" view.
// The device-access row is the interesting bit — it must mirror the deviceAuth matrix on the bridge.

describe("ConnectionInfo — device access row", () => {
  // Most cases describe a paired phone; the unpaired ones clear the token themselves.
  beforeEach(() => setDeviceToken("tok-placeholder"));

  it("a paired device with the header gate off reads as enforced and paired, never 'Not enforced'", () => {
    render(<ConnectionInfo bridge="connected" device={undefined} />);
    expect(screen.getByText("Enforced, this device is paired")).toBeInTheDocument();
    expect(screen.queryByText("Not enforced")).toBeNull();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("a browser with no token reads as enforced and not paired", () => {
    localStorage.clear();
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Enforced, this device is not paired")).toBeInTheDocument();
  });

  it("a refusal latched after a self-unpair or revoke reads as not paired, even with a token", () => {
    render(<ConnectionInfo bridge="connected" device={{ enforced: true, device: "my-phone", authorized: true }} />);
    act(() => markNotPaired());
    expect(screen.getByText("Enforced, this device is not paired")).toBeInTheDocument();
  });

  it("shows full access with the device id for an authorised device", () => {
    render(
      <ConnectionInfo bridge="connected" device={{ enforced: true, device: "my-phone", authorized: true }} />,
    );
    expect(screen.getByText(/full access · my-phone/i)).toBeInTheDocument();
  });

  it("shows read-only with the device id for an unauthorised device", () => {
    render(
      <ConnectionInfo bridge="connected" device={{ enforced: true, device: "spare", authorized: false }} />,
    );
    expect(screen.getByText(/read-only · spare/i)).toBeInTheDocument();
  });

  it("labels an authorised device with no header as local (on-host operator)", () => {
    render(
      <ConnectionInfo bridge="connected" device={{ enforced: true, device: null, authorized: true }} />,
    );
    expect(screen.getByText(/full access \(local\)/i)).toBeInTheDocument();
  });

  it("an unpaired phone reads 'reachable, not paired' on the bridge row, never 'Connecting…'", () => {
    localStorage.clear();
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Reachable, not paired")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("a refused phone reads 'reachable, not paired' on the bridge row", () => {
    render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    act(() => markNotPaired());
    expect(screen.getByText("Reachable, not paired")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("a paired phone keeps 'Connecting…' only while no answer has arrived", () => {
    const { rerender } = render(<ConnectionInfo bridge={undefined} device={undefined} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    rerender(<ConnectionInfo bridge="connected" device={undefined} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows a connecting state and the server build when provided", () => {
    render(<ConnectionInfo bridge={undefined} device={undefined} build="abc1234" />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });
});
