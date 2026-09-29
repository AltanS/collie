import { act, render, screen } from "@testing-library/react";

import { AgentStart } from "./agent-start";

// The overlay's contract, not its looks. Three things can strand a person here: it never leaves, it
// leaves before it has said anything, or it cannot be dismissed. Each has a case.
describe("AgentStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("names the harness in a live region, so it is announced as well as drawn", () => {
    render(<AgentStart harness="opencode" onDone={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Handed to opencode" })).toBeInTheDocument();
  });

  it("hands the pane back on a timer, never on an animation event", () => {
    // A killed animation fires no `animationend`, so a layer waiting for one would never leave.
    const onDone = vi.fn();
    render(<AgentStart harness="opencode" onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1400));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a tap ends it at once, and the timer cannot then fire a second time", () => {
    const onDone = vi.fn();
    render(<AgentStart harness="claude" onDone={onDone} />);
    act(() => screen.getByRole("status").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(3000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion it still says what happened, and leaves sooner", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const onDone = vi.fn();
    render(<AgentStart harness="pi" onDone={onDone} />);
    expect(screen.getByText("Handed to pi")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(800));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("drops its timer on unmount, so a pane switch mid-flight calls nothing", () => {
    const onDone = vi.fn();
    const { unmount } = render(<AgentStart harness="codex" onDone={onDone} />);
    unmount();
    act(() => void vi.advanceTimersByTime(3000));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("survives a header with no mark on screen, which is what zen looks like", () => {
    // `aimAtHeaderMark` falls back to the layer's own corner rather than throwing on a null query.
    expect(() => render(<AgentStart harness="grok" onDone={vi.fn()} />)).not.toThrow();
  });
});
