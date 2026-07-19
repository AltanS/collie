import { act, render, screen } from "@testing-library/react";

import { BootSplash } from "./root";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";

// BootSplash is the router's HydrateFallback: it stays mounted until the FIRST loader run settles, so
// over a dead tailnet (a hanging initial fetch) it can otherwise gallop the dog forever with no way
// out. It must escalate to an actionable "Not connected" state once stuck past CONNECTION_LOST_MS.
// Fake timers drive the wall-clock hook (Vitest advances Date.now with them).
describe("BootSplash — escalates a stuck cold start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the galloping-dog splash before the threshold", () => {
    render(<BootSplash />);
    expect(screen.getByText("Connecting to the herd…")).toBeInTheDocument();
    // still the plain splash a beat before the threshold
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(screen.getByText("Connecting to the herd…")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  it("escalates to 'Not connected' with a Retry once stuck past the threshold", () => {
    render(<BootSplash />);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("Connecting to the herd…")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Can.t reach Collie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The mascot re-labels (and stops galloping) — the loading label is gone.
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Not connected")).toBeInTheDocument();
  });
});
