import { act, render, screen } from "@testing-library/react";

import { useHandover } from "@/hooks/use-handover";
import { AgentStart } from "./agent-start";

// The layer's contract, not its looks. It draws the phase it is handed and reports two things back:
// that its covering flight ended, and that it is done. Three things can strand a person here: it
// never leaves, it leaves before it has said anything, or it cannot be dismissed. Each has a case.

/** The layer under the real handover hook, the way agent-chat mounts it. */
function Sequence({ finish }: { finish: () => void }) {
  const h = useHandover(true, finish);
  return (
    <>
      <span data-testid="phase">{h.phase}</span>
      <AgentStart harness="opencode" phase={h.phase} calm={h.calm} onCovered={h.onCovered} onFinish={h.onFinish} />
    </>
  );
}

/**
 * jsdom has no AnimationEvent, so `fireEvent.animationEnd` would drop the name, and React there
 * listens for the prefixed event name. Set the name by hand and send both spellings: exactly one is
 * the one React listens to, and a browser only ever sends the plain one.
 */
function animationEnd(el: Element, animationName: string) {
  for (const type of ["animationend", "webkitAnimationEnd"]) {
    const e = Object.assign(new Event(type, { bubbles: true }), { animationName });
    act(() => void el.dispatchEvent(e));
  }
}

/** Advance in small steps, so the effect a phase change schedules runs before the next one is due. */
function pass(ms: number) {
  for (let t = 0; t < ms; t += 10) act(() => void vi.advanceTimersByTime(Math.min(10, ms - t)));
}

describe("AgentStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const props = { phase: "covering" as const, calm: false, onCovered: vi.fn(), onFinish: vi.fn() };

  it("names the harness in a live region, so it is announced as well as drawn", () => {
    render(<AgentStart harness="opencode" {...props} />);
    expect(screen.getByRole("status", { name: "Handed to opencode" })).toBeInTheDocument();
  });

  it("draws the phase it is handed", () => {
    const { rerender } = render(<AgentStart harness="opencode" {...props} />);
    expect(screen.getByRole("status")).toHaveAttribute("data-phase", "covering");
    rerender(<AgentStart harness="opencode" {...props} phase="revealing" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-phase", "revealing");
  });

  it("reports the end of the covering flight, and the end of the veil's leaving, and nothing else", () => {
    const onCovered = vi.fn();
    const onFinish = vi.fn();
    render(<AgentStart harness="opencode" {...props} onCovered={onCovered} onFinish={onFinish} />);
    const layer = screen.getByRole("status");
    // The icon and the word share `as-out`; their end is not the layer's end.
    animationEnd(layer, "as-out");
    animationEnd(layer, "as-in");
    expect(onCovered).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    animationEnd(layer, "as-go");
    expect(onCovered).toHaveBeenCalledTimes(1);
    animationEnd(layer, "as-veil-out");
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("a tap ends it at once, wherever the sequence is", () => {
    const finish = vi.fn();
    render(<Sequence finish={finish} />);
    expect(screen.getByTestId("phase")).toHaveTextContent("covering");
    act(() => screen.getByRole("status").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("leaves on its timers, never on an animation event, when none comes", () => {
    // A killed animation fires no `animationend`, so a layer waiting for one would never leave.
    const finish = vi.fn();
    render(<Sequence finish={finish} />);
    expect(finish).not.toHaveBeenCalled();
    pass(1400 + 150 * 2);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion it still says what happened, and leaves in 800 ms", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const finish = vi.fn();
    render(<Sequence finish={finish} />);
    expect(screen.getByText("Handed to opencode")).toBeInTheDocument();
    pass(799);
    expect(finish).not.toHaveBeenCalled();
    pass(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("drops its timers on unmount, so a pane switch mid-flight calls nothing", () => {
    const finish = vi.fn();
    const { unmount } = render(<Sequence finish={finish} />);
    unmount();
    act(() => void vi.advanceTimersByTime(5000));
    expect(finish).not.toHaveBeenCalled();
  });

  it("survives a header with no mark on screen, which is what zen looks like", () => {
    // `aimAtHeaderMark` falls back to the layer's own corner rather than throwing on a null query.
    expect(() => render(<AgentStart harness="grok" {...props} />)).not.toThrow();
  });
});
