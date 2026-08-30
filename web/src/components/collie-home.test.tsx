import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStatus, setStatus } from "@/lib/status";
import { markIsLive } from "@/test/collie-mark";
import { CollieHome } from "./collie-home";

// THE ROUND IS AN EVENT, NOT A STATE. A status published anywhere in the app (a send, a kill, an
// error) turns the mark's orbit exactly once, at the loading rate, and then hands it back to the
// resting drift. These cases hold the two halves of that sentence: exactly once, and back.
describe("CollieHome — the event round", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
  });
  afterEach(() => {
    act(() => clearStatus());
    vi.useRealTimers();
  });

  it("turns the orbit for one round when a status is published, then stops", () => {
    const { container } = render(<CollieHome trouble={false} />);
    expect(markIsLive(container)).toBe(false);

    act(() => setStatus("Sent ✓", "success"));
    expect(markIsLive(container)).toBe(true);

    // Still turning one tick short of the round.
    act(() => void vi.advanceTimersByTime(1799));
    expect(markIsLive(container)).toBe(true);

    act(() => void vi.advanceTimersByTime(1));
    expect(markIsLive(container)).toBe(false);
  });

  // One action often publishes more than one status — the send acknowledges, then the pane's own
  // lifecycle moves. Each of those must NOT extend the round: an orbit that keeps going is a state
  // again, which is the one thing the round must not be mistaken for.
  it("does not extend the round when more statuses land while it is turning", () => {
    const { container } = render(<CollieHome trouble={false} />);

    act(() => setStatus("Sent ✓", "success"));
    act(() => void vi.advanceTimersByTime(900));
    act(() => setStatus("working", "info"));
    expect(markIsLive(container)).toBe(true);

    act(() => void vi.advanceTimersByTime(900));
    expect(markIsLive(container)).toBe(false);
  });

  // `lost` is a state the mark holds still and muted for. A passing event must not light it up and
  // tell the reader something is working when the connection has been given up on.
  it("stays still while the connection is lost", () => {
    const { container } = render(<CollieHome trouble lost />);
    act(() => setStatus("Sent ✓", "success"));
    expect(markIsLive(container)).toBe(false);
  });

  // The connection bloom outranks the round: it is already the loading input, and it must still be
  // turning after the round's timer has run out.
  it("leaves the connection bloom turning after the round would have ended", () => {
    const { container } = render(<CollieHome trouble />);
    expect(markIsLive(container)).toBe(true);

    act(() => setStatus("Sent ✓", "success"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(markIsLive(container)).toBe(true);
  });
});
