import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { ConnectionBanner, EXIT_MS, GREEN_MS } from "./connection-banner";

// Drive the two shared-clock thresholds directly so the amber→red→green STATE MACHINE can be tested
// without burning real seconds; the 4s/15s wall-clock lockstep itself is proven in
// use-connection-lost.test.ts. The mocks ignore their arg and return the staged values.
const h = vi.hoisted(() => ({ trouble: false, lost: false }));
vi.mock("@/hooks/use-connection-lost", () => ({
  useConnectionTrouble: () => h.trouble,
  useConnectionLost: () => h.lost,
}));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

// The /api/config probe (red only) — controllable + counted, so we don't lean on MSW timing under fake
// timers. `reachable` false makes fetchConfig throw (bridge unreachable).
const cfg = vi.hoisted(() => ({ reachable: true, calls: 0 }));
vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(async () => {
    cfg.calls += 1;
    if (!cfg.reachable) throw new Error("unreachable");
    return { push: false, vapidPublicKey: "" };
  }),
}));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

// A harness whose own state forces the banner to re-render (creating a fresh element so the mocked
// hooks are re-read) — RouterProvider re-rendered with the same static route element would bail out.
let rerenderBanner: () => void = () => {};

function renderBanner(props: { bridge?: "connected" | "disconnected"; error?: boolean } = {}) {
  function Harness() {
    const [, setN] = useState(0);
    rerenderBanner = () => setN((n) => n + 1);
    return (
      <ConnectionBanner bridge={props.bridge ?? "disconnected"} error={props.error ?? false} />
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.trouble = false;
  h.lost = false;
  cfg.reachable = true;
  cfg.calls = 0;
  setOnline(true);
});
afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe("ConnectionBanner — the single connection surface", () => {
  it("renders nothing while healthy — no bar at all", () => {
    renderBanner({ bridge: "connected" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fades in amber 'Reconnecting…' on sustained trouble — ambient, no Retry button", () => {
    h.trouble = true;
    renderBanner();
    const row = screen.getByRole("status");
    expect(row).toHaveTextContent("Reconnecting…");
    expect(row.className).toMatch(/bg-status-working/); // amber = checking
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull(); // ambient → no actions
  });

  it("escalates to a red alert with Retry + Reload once lost, naming Herdr when the bridge answers", async () => {
    h.trouble = true;
    h.lost = true;
    cfg.reachable = true; // the config probe succeeds → the bridge is up, so Herdr is the outage
    renderBanner();
    await act(async () => {}); // flush the probe microtask
    const row = screen.getByRole("alert");
    expect(row.className).toMatch(/bg-status-blocked/); // red = failed
    expect(row).toHaveTextContent("Herdr is down on the host");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("says 'Offline' in red when the probe fails AND the browser reports offline", async () => {
    h.lost = true;
    cfg.reachable = false;
    setOnline(false);
    renderBanner();
    await act(async () => {});
    expect(screen.getByText("Offline — can't reach Collie")).toBeInTheDocument();
    expect(screen.getByRole("alert").className).toMatch(/bg-status-blocked/); // offline is always red
  });

  it("says 'Can't reach Collie' when the probe fails but the browser still reports online", async () => {
    h.lost = true;
    cfg.reachable = false;
    setOnline(true);
    renderBanner();
    await act(async () => {});
    expect(screen.getByText("Can't reach Collie")).toBeInTheDocument();
  });

  it("Retry re-probes the bridge", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    expect(cfg.calls).toBe(1); // probed once when it appeared
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    });
    expect(cfg.calls).toBe(2); // Retry ran a fresh probe
  });

  it("is one crisp, non-wrapping row (text-xs, a single truncating flex-1 copy span)", async () => {
    h.lost = true;
    renderBanner();
    await act(async () => {});
    const row = screen.getByRole("alert");
    expect(row.className).toMatch(/text-xs/);
    expect(row.className).not.toMatch(/flex-wrap/);
    expect(row.querySelector("span.truncate.flex-1")).not.toBeNull();
  });

  it("flashes green 'Connected' only after a visible bar recovers, then collapses and unmounts", () => {
    h.trouble = true;
    renderBanner();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();

    // Recover: the signals go healthy → because a bar WAS visible, a green confirmation appears.
    h.trouble = false;
    act(() => rerenderBanner());
    const green = screen.getByRole("status");
    expect(green).toHaveTextContent("Connected");
    expect(green.className).toMatch(/bg-status-done/); // green = established

    // It lingers ~1.8s, then the row collapses and the DOM node unmounts (delayed-unmount exit).
    act(() => vi.advanceTimersByTime(GREEN_MS));
    expect(screen.getByText("Connected")).toBeInTheDocument(); // still there, collapsing
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing on a blip that never reached trouble — green needs a visible bar first", () => {
    renderBanner({ bridge: "connected" });
    // Never troubled → never showed a bar → a later 'recovery' re-render must not flash green.
    act(() => rerenderBanner());
    act(() => vi.advanceTimersByTime(GREEN_MS + EXIT_MS));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
