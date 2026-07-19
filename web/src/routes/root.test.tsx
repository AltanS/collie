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
    const { container } = render(<BootSplash />);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("Connecting to the herd…")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Can.t reach Collie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // The galloping mascot is gone — the loading sprite is unmounted and the rest state is the muted
    // static app icon (never a frozen gallop frame, which reads as stuck mid-run).
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(container.querySelector(".dog-gallop")).toBeNull();
    const icon = container.querySelector("img");
    expect(icon).toHaveAttribute("src", "/favicon.svg");
    expect(icon?.className).toMatch(/grayscale/);
  });
});
