import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionInfo } from "./connection-info";

// The diagnostics panel translates the polled snapshot into a read-only "why isn't X working" view.
// The device-access row is the interesting bit — it must mirror the deviceAuth matrix on the bridge.

describe("ConnectionInfo — device access row", () => {
  it("reads 'Not enforced' when the feature is off (no device on the snapshot)", () => {
    render(<ConnectionInfo bridge="connected" device={undefined} />);
    expect(screen.getByText("Not enforced")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
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

  it("shows a connecting state and the server build when provided", () => {
    render(<ConnectionInfo bridge={undefined} device={undefined} build="abc1234" />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });
});
