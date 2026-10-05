import { act, renderHook } from "@testing-library/react";

import {
  CALM_TIMINGS,
  CAP_MS,
  IDLE,
  MOTION_TIMINGS,
  covering,
  handoverReducer,
  swapAllowed,
  useHandover,
  useHeldBody,
  type HandoverState,
} from "./use-handover";

// The handover is ONE sequence: covering, covered, revealing, idle. The reducer is the whole
// machine and is pure; the hook adds the clocks; useHeldBody is the rule about the body.

const run = (state: HandoverState, ...actions: Parameters<typeof handoverReducer>[1][]) =>
  actions.reduce(handoverReducer, state);

describe("handoverReducer", () => {
  it("walks idle, covering, covered, revealing, idle", () => {
    let s = run(IDLE, { type: "start", calm: false });
    expect(s.phase).toBe("covering");
    s = run(s, { type: "covered" });
    expect(s.phase).toBe("covered");
    s = run(s, { type: "dwelled" }, { type: "reveal", ready: true });
    expect(s.phase).toBe("revealing");
    expect(run(s, { type: "finish" })).toEqual(IDLE);
  });

  it("does not restart on a second edge while a sequence is on screen", () => {
    const s = run(IDLE, { type: "start", calm: false }, { type: "covered" });
    expect(run(s, { type: "start", calm: true })).toBe(s);
  });

  it("ignores events that are not for its phase, so animationend and its timer can both arrive", () => {
    expect(run(IDLE, { type: "covered" })).toBe(IDLE);
    expect(run(IDLE, { type: "reveal", ready: true })).toBe(IDLE);
    const cov = covering(false);
    expect(run(cov, { type: "dwelled" })).toBe(cov);
    expect(run(cov, { type: "reveal", ready: true })).toBe(cov);
    const revealing = run(cov, { type: "covered" }, { type: "dwelled" }, { type: "reveal", ready: true });
    expect(run(revealing, { type: "covered" })).toBe(revealing);
  });

  it("waits at covered until the body is ready", () => {
    const s = run(covering(false), { type: "covered" }, { type: "dwelled" });
    expect(run(s, { type: "reveal", ready: false }).phase).toBe("covered");
    expect(run(s, { type: "reveal", ready: true }).phase).toBe("revealing");
  });

  it("reveals on the cap even when the body never became ready", () => {
    const s = run(covering(false), { type: "covered" }, { type: "dwelled" }, { type: "capped" });
    expect(run(s, { type: "reveal", ready: false }).phase).toBe("revealing");
  });

  it("rests at least its dwell: a ready body does not reveal before it", () => {
    const s = run(covering(false), { type: "covered" });
    expect(run(s, { type: "reveal", ready: true }).phase).toBe("covered");
  });

  it("a tap ends it from any phase", () => {
    for (const s of [covering(false), run(covering(true), { type: "covered" })]) {
      expect(run(s, { type: "finish" })).toEqual(IDLE);
    }
  });
});

describe("swapAllowed", () => {
  it("allows the body to change at idle and at covered only", () => {
    expect(swapAllowed("idle")).toBe(true);
    expect(swapAllowed("covered")).toBe(true);
    expect(swapAllowed("covering")).toBe(false);
    expect(swapAllowed("revealing")).toBe(false);
  });
});

describe("useHeldBody", () => {
  type P = { wanted: boolean; phase: Parameters<typeof useHeldBody>[1] };
  const render = (p: P) => renderHook((q: P) => useHeldBody(q.wanted, q.phase), { initialProps: p });

  it("follows the wanted body at idle, as it always did", () => {
    const { result, rerender } = render({ wanted: false, phase: "idle" });
    rerender({ wanted: true, phase: "idle" });
    expect(result.current).toBe(true);
  });

  it("holds a wanted swap while covering and applies it at covered", () => {
    const { result, rerender } = render({ wanted: false, phase: "covering" });
    rerender({ wanted: true, phase: "covering" });
    expect(result.current).toBe(false);
    rerender({ wanted: true, phase: "covered" });
    expect(result.current).toBe(true);
  });

  it("holds a swap that arrives while revealing until the layer is gone", () => {
    const { result, rerender } = render({ wanted: false, phase: "revealing" });
    rerender({ wanted: true, phase: "revealing" });
    expect(result.current).toBe(false);
    rerender({ wanted: true, phase: "idle" });
    expect(result.current).toBe(true);
  });

  it("keeps the swapped body through revealing, then idle", () => {
    const { result, rerender } = render({ wanted: false, phase: "covered" });
    rerender({ wanted: true, phase: "covered" });
    rerender({ wanted: true, phase: "revealing" });
    expect(result.current).toBe(true);
    rerender({ wanted: true, phase: "idle" });
    expect(result.current).toBe(true);
  });

  it("a tap lands the pending swap in the same commit that ends the layer", () => {
    const { result, rerender } = render({ wanted: false, phase: "covering" });
    rerender({ wanted: true, phase: "covering" });
    expect(result.current).toBe(false);
    rerender({ wanted: true, phase: "idle" });
    expect(result.current).toBe(true);
  });
});

describe("useHandover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const setup = (initial: { active: boolean; ready: boolean }) => {
    const finish = vi.fn();
    const hook = renderHook((p: { active: boolean; ready: boolean }) => useHandover(p.active, p.ready, finish), {
      initialProps: initial,
    });
    return { finish, ...hook };
  };
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("is idle until the layer is on screen", () => {
    const { result } = setup({ active: false, ready: true });
    expect(result.current.phase).toBe("idle");
  });

  it("begins covering in the same render the edge arrives", () => {
    const { result, rerender } = setup({ active: false, ready: true });
    rerender({ active: true, ready: true });
    expect(result.current.phase).toBe("covering");
  });

  it("covers on animationend, before its timer", () => {
    const { result, rerender } = setup({ active: false, ready: true });
    rerender({ active: true, ready: true });
    act(() => result.current.onCovered());
    expect(result.current.phase).toBe("covered");
  });

  it("covers on its timer when no animationend comes", () => {
    const { result, rerender } = setup({ active: false, ready: true });
    rerender({ active: true, ready: true });
    advance(MOTION_TIMINGS.cover + MOTION_TIMINGS.slack);
    expect(result.current.phase).toBe("covered");
  });

  it("reveals after its rest when the body is ready, and takes the layer down when the reveal is over", () => {
    const { result, rerender, finish } = setup({ active: false, ready: true });
    rerender({ active: true, ready: true });
    act(() => result.current.onCovered());
    advance(MOTION_TIMINGS.dwell - 1);
    expect(result.current.phase).toBe("covered");
    advance(1);
    expect(result.current.phase).toBe("revealing");
    expect(finish).not.toHaveBeenCalled();
    advance(MOTION_TIMINGS.reveal + MOTION_TIMINGS.slack);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("stays covered while the body is not ready, and reveals when it is", () => {
    const { result, rerender } = setup({ active: false, ready: false });
    rerender({ active: true, ready: false });
    act(() => result.current.onCovered());
    advance(CAP_MS - 1);
    expect(result.current.phase).toBe("covered");
    rerender({ active: true, ready: true });
    expect(result.current.phase).toBe("revealing");
  });

  it("reveals at the cap if the body never gets ready", () => {
    const { result, rerender } = setup({ active: false, ready: false });
    rerender({ active: true, ready: false });
    act(() => result.current.onCovered());
    advance(CAP_MS);
    expect(result.current.phase).toBe("revealing");
  });

  it("a tap (the layer going away) returns to idle from covering", () => {
    const { result, rerender } = setup({ active: false, ready: false });
    rerender({ active: true, ready: false });
    expect(result.current.phase).toBe("covering");
    rerender({ active: false, ready: false });
    expect(result.current.phase).toBe("idle");
    advance(5000);
    expect(result.current.phase).toBe("idle");
  });

  it("under reduced motion the timers are the whole clock and the sequence is the same", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const { result, rerender, finish } = setup({ active: false, ready: true });
    rerender({ active: true, ready: true });
    expect(result.current.calm).toBe(true);
    advance(CALM_TIMINGS.cover);
    expect(result.current.phase).toBe("covered");
    advance(CALM_TIMINGS.dwell);
    expect(result.current.phase).toBe("revealing");
    advance(CALM_TIMINGS.reveal);
    expect(finish).toHaveBeenCalledTimes(1);
    // The whole picture is as long as it always was.
    expect(CALM_TIMINGS.cover + CALM_TIMINGS.dwell + CALM_TIMINGS.reveal).toBe(800);
  });

  it("the full bloom is as long as it always was when the body is ready", () => {
    expect(MOTION_TIMINGS.cover + MOTION_TIMINGS.dwell + MOTION_TIMINGS.reveal).toBe(1400);
  });
});
