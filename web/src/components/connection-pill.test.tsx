import { act, render, screen } from "@testing-library/react";

import { ConnectionPill } from "./connection-pill";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth } from "@/lib/connection-health";

// The tone-colored wrapper around the pill label — amber (working) while trying, red (blocked) once
// lost, green (done) while live. Grabbing the label's parent lets a test assert the escalation TONE,
// not just the copy, so "amber pre-threshold, red at lost" is provable.
function toneOf(label: string): HTMLElement {
  const el = screen.getByText(label).parentElement;
  if (!el) throw new Error(`no tone wrapper for "${label}"`);
  return el;
}

describe("ConnectionPill", () => {
  // Fresh anchor per case so a fast suite never drifts past CONNECTION_LOST_MS on its own and turns a
  // pre-threshold assertion red. (Escalation cases below drive the clock explicitly with fake timers.)
  beforeEach(() => __resetConnectionHealth());

  it("shows 'live' even when the browser claims offline, as long as polls are healthy (poll-truth)", () => {
    // The lying-onLine case: onLine stuck false while the snapshot path is fine must NOT show an
    // outage — liveness is poll-truth, not navigator.onLine.
    render(<ConnectionPill online={false} bridge="connected" error={false} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("stays amber 'reconnecting…' pre-threshold even when the browser reports offline (onLine copy-only)", () => {
    // Regression guard: onLine=false used to short-circuit straight to red "offline" BEFORE the lost
    // check — red pill ("given up") while the Collie mark still galloped ("trying"). Pre-threshold is
    // ALWAYS amber "reconnecting…"; onLine only picks the copy later, at lost.
    render(<ConnectionPill online={false} bridge="connected" error />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    expect(toneOf("reconnecting…")).toHaveClass("text-status-working");
  });

  it("shows 'reconnecting…' when there is a refresh error", () => {
    render(<ConnectionPill online bridge="connected" error />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when the bridge status is unknown", () => {
    render(<ConnectionPill online bridge={undefined} error={false} />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when the bridge reports disconnected (no separate warn label)", () => {
    // Herdr-down is just another not-live cause here — the OutageBanner names it ("Herdr is down on
    // the host") once escalated; the pill stays a single, honest liveness signal that escalates in
    // lockstep with the banner instead of sitting on its own amber "Herdr offline" forever.
    render(<ConnectionPill online bridge="disconnected" error={false} />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("shows 'live' when online, connected, and no error", () => {
    render(<ConnectionPill online bridge="connected" error={false} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("shows 'reconnecting…' when a load has stalled (online + connected, no dedicated label)", () => {
    render(<ConnectionPill online bridge="connected" error={false} stalled />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("does not render a per-poll spinner while live (no flicker on revalidate)", () => {
    const { container } = render(<ConnectionPill online bridge="connected" error={false} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// The transient amber "reconnecting…" escalates to a red "not connected" once the reconnect has
// dragged on past CONNECTION_LOST_MS — the same threshold that raises the OutageBanner, so pill and
// banner escalate as one. Fake timers drive the wall-clock hook (Vitest advances Date.now with them).
describe("ConnectionPill — escalates after a sustained outage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // anchor == frozen clock, so the threshold boundary is exact
  });
  afterEach(() => vi.useRealTimers());

  it("amber 'reconnecting…' → red 'not connected' once past the threshold (online)", () => {
    render(<ConnectionPill online bridge="connected" error />);
    expect(toneOf("reconnecting…")).toHaveClass("text-status-working"); // amber pre-threshold
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("reconnecting…")).not.toBeInTheDocument();
    expect(toneOf("not connected")).toHaveClass("text-status-blocked"); // red at lost
  });

  it("escalates to red 'offline' copy only AT the threshold, never before (onLine never affects timing)", () => {
    render(<ConnectionPill online={false} bridge="connected" error />);
    // Pre-threshold: amber "reconnecting…" — onLine=false has NOT flipped it red early.
    expect(toneOf("reconnecting…")).toHaveClass("text-status-working");
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    // At lost: red, and NOW onLine picks the "offline" copy (vs "not connected" when online).
    expect(screen.queryByText("reconnecting…")).not.toBeInTheDocument();
    expect(toneOf("offline")).toHaveClass("text-status-blocked");
  });

  it("does not escalate a stall that recovers before the threshold", () => {
    const { rerender } = render(<ConnectionPill online bridge="connected" error={false} stalled />);
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 3_000));
    rerender(<ConnectionPill online bridge="connected" error={false} />); // recovered → live
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.queryByText("not connected")).not.toBeInTheDocument();
  });
});
