import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LevelSource } from "@/lib/audio-meter";
import { SILENCE_FINISH_MS } from "@/lib/speech-endpoint";

import { VOICE_BAR_COUNT, VOICE_ROW_FRAME, VoiceTakeover, type VoiceTakeoverProps } from "./voice-takeover";

// The takeover's per-frame loop runs on requestAnimationFrame, so these cases drive it with fake
// timers (which fake rAF and performance.now together) and a scripted level source, never a real
// microphone. The detector's own arithmetic is pinned in lib/speech-endpoint.test.ts; what is
// pinned here is that the component wires it: the ring, the auto-finish, the hand, the labels.

const SPEECH = 0.12;
const QUIET = 0.003;

/** A level source whose loudness the test sets. */
function scripted(initial = QUIET) {
  const state = { rms: initial };
  const source: LevelSource = {
    read: (bars) => {
      bars.fill(state.rms > 0.01 ? 0.7 : 0.05);
      return state.rms;
    },
  };
  return { state, source };
}

function renderTakeover(props: Partial<VoiceTakeoverProps> = {}) {
  const onStop = vi.fn();
  const onDiscard = vi.fn();
  const view = render(
    <VoiceTakeover
      phase="recording"
      elapsed="0:07"
      source={null}
      padClassName="pb-2"
      onStop={onStop}
      onDiscard={onDiscard}
      {...props}
    />,
  );
  return { onStop, onDiscard, ...view };
}

function ring(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg[viewBox="-24 -24 48 48"]');
  if (!(svg instanceof SVGSVGElement)) throw new Error("no ring");
  return svg;
}

/** The progress circle of the countdown ring: the ring's last child. */
function arcOf(container: HTMLElement): SVGElement {
  const arc = ring(container).lastElementChild;
  if (!(arc instanceof SVGElement)) throw new Error("no progress circle");
  return arc;
}

function mockReducedMotion(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("VoiceTakeover — what it is", () => {
  it("is a labelled group that fills its block and wears the composer's own bottom padding", () => {
    renderTakeover({ padClassName: "pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" });
    const region = screen.getByRole("group", { name: /voice input/i });
    expect(region.className).toMatch(/\babsolute\b/);
    expect(region.className).toMatch(/\binset-0\b/);
    expect(region.className).toContain("pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]");
  });

  it("has OK and the bin as named buttons, 44px reach included", () => {
    renderTakeover();
    const ok = screen.getByRole("button", { name: /finish and transcribe/i });
    const bin = screen.getByRole("button", { name: /discard recording/i });
    for (const button of [ok, bin]) {
      expect(button.className).toContain("before:-inset-1");
      expect(button.className).toContain("size-9");
      expect(button.className).toContain("rounded-full");
    }
  });

  it("says what OK will do when the transcript is sent straight away", () => {
    renderTakeover({ sends: true });
    expect(screen.getByRole("button", { name: /transcribe and send/i })).toBeInTheDocument();
  });

  it("announces Listening politely, then Transcribing, in one live region", async () => {
    const { rerender, onStop, onDiscard } = renderTakeover();
    const status = screen.getByRole("status");
    // `role="status"` is a polite live region by itself; an `aria-live` beside it is refused by notice.test.tsx.
    expect(status).not.toHaveAttribute("aria-live");
    await act(async () => {});
    expect(status).toHaveTextContent("Listening");
    rerender(
      <VoiceTakeover phase="transcribing" elapsed="0:09" source={null} padClassName="pb-2" onStop={onStop} onDiscard={onDiscard} />,
    );
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
  });

  it("shows the elapsed time with tabular figures", () => {
    renderTakeover({ elapsed: "1:23" });
    expect(screen.getByText("1:23").className).toContain("tabular-nums");
  });

  it("OK sits on the end the mic sits on, and the row mirrors for the left hand", () => {
    const right = renderTakeover();
    const rightRow = right.container.querySelector('[data-slot="voice-takeover-row"]');
    expect(rightRow?.className).not.toContain("flex-row-reverse");
    right.unmount();
    const left = renderTakeover({ hand: "left" });
    expect(left.container.querySelector('[data-slot="voice-takeover-row"]')?.className).toContain("flex-row-reverse");
  });

  it("copies the composer's frame, so OK stands on the mic: p-1 for the field, p-1.5 for the box", () => {
    const rowOf = (container: HTMLElement) => container.querySelector('[data-slot="voice-takeover-row"]');
    const field = renderTakeover();
    expect(rowOf(field.container)?.className).toContain("p-1 ");
    expect(rowOf(field.container)?.className).not.toContain("p-1.5");
    field.unmount();
    const box = renderTakeover({ layout: "box" });
    expect(rowOf(box.container)?.className).toContain("p-1.5");
    expect(rowOf(box.container)?.className).toContain("border-rule");
    expect(VOICE_ROW_FRAME.box).toContain("p-1.5");
  });

  it("reserves all its bar slots up front, and animates by scale, never by size", () => {
    const { container } = renderTakeover();
    const bars = container.querySelectorAll('[data-level] > span');
    expect(bars).toHaveLength(VOICE_BAR_COUNT);
    for (const bar of bars) expect(bar.className).toContain("[transform:scaleY(0.08)]");
  });
});

describe("VoiceTakeover — focus and keys", () => {
  it("moves focus to OK once recording, and to the bin while transcribing", () => {
    const { rerender, onStop, onDiscard } = renderTakeover();
    expect(screen.getByRole("button", { name: /finish and transcribe/i })).toHaveFocus();
    rerender(
      <VoiceTakeover phase="transcribing" elapsed="0:09" source={null} padClassName="pb-2" onStop={onStop} onDiscard={onDiscard} />,
    );
    expect(screen.getByRole("button", { name: /discard recording/i })).toHaveFocus();
  });

  it("holds focus on the region itself while the permission prompt is up, and OK is not yet live", () => {
    renderTakeover({ phase: "requesting" });
    expect(screen.getByRole("group", { name: /voice input/i })).toHaveFocus();
    expect(screen.getByRole("button", { name: /finish and transcribe/i })).toBeDisabled();
  });

  it("Escape discards", () => {
    const { onDiscard } = renderTakeover();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("OK stops and the bin discards", () => {
    const { onStop, onDiscard } = renderTakeover();
    fireEvent.click(screen.getByRole("button", { name: /finish and transcribe/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /discard recording/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceTakeover — transcribing", () => {
  it("disables OK, keeps its check, leaves the bin live, and shows ONE turning arc on the ring's track", () => {
    const { container, onDiscard } = renderTakeover({ phase: "transcribing" });
    expect(screen.getByRole("button", { name: /finish and transcribe/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /discard recording/i })).toBeEnabled();
    // One moving thing: no separate spinner glyph anywhere in the takeover.
    expect(container.querySelector(".lucide-loader-circle, .lucide-loader-2, [class*='lucide-loader']")).toBeNull();
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
    // The arc turns INSIDE the svg, never as a rotated box: a rotated box sweeps its corners past the
    // takeover and makes every scroller above it scrollable (the flash on the right edge).
    expect(spinner?.tagName.toLowerCase()).toBe("circle");
    expect(spinner?.getAttribute("class")).toContain("motion-reduce:animate-none");
    // The arc hides and a full ring at 40% shows when reduced motion asks.
    const circles = spinner?.closest("svg")?.querySelectorAll("circle") ?? [];
    expect(circles).toHaveLength(3);
    expect(circles[1]?.getAttribute("class")).toContain("motion-reduce:hidden");
    expect(circles[2]?.getAttribute("class")).toContain("motion-reduce:block");
    expect(circles[2]?.getAttribute("class")).toContain("opacity-40");
    fireEvent.click(screen.getByRole("button", { name: /discard recording/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("draws the bars dimmed and still", () => {
    const { container } = renderTakeover({ phase: "transcribing" });
    expect(container.querySelector("[data-level]")?.className).toContain("opacity-30");
  });
});

describe("VoiceTakeover — auto-finish on silence", () => {
  it("does nothing before any speech, however long it listens", () => {
    const { source } = scripted(QUIET);
    const { onStop } = renderTakeover({ source });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onStop).not.toHaveBeenCalled();
  });

  it("stops once, SILENCE_FINISH_MS after speech goes quiet, and closes the ring on the way", () => {
    const { state, source } = scripted(QUIET);
    const { onStop, container } = renderTakeover({ source });
    act(() => vi.advanceTimersByTime(500));
    state.rms = SPEECH;
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector("[data-level]")?.getAttribute("data-level")).toBe("speaking");
    expect(ring(container).style.opacity).toBe("0");
    state.rms = QUIET;
    act(() => vi.advanceTimersByTime(SILENCE_FINISH_MS / 2));
    expect(container.querySelector("[data-level]")?.getAttribute("data-level")).toBe("quiet");
    expect(ring(container).style.opacity).toBe("1");
    const arc = arcOf(container);
    const offset = Number.parseFloat(arc.style.strokeDashoffset);
    expect(offset).toBeGreaterThan(40);
    expect(offset).toBeLessThan(60);
    expect(onStop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SILENCE_FINISH_MS / 2 + 100));
    expect(onStop).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(10_000));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("resets the ring when speech resumes inside the countdown", () => {
    const { state, source } = scripted(QUIET);
    const { onStop, container } = renderTakeover({ source });
    state.rms = SPEECH;
    act(() => vi.advanceTimersByTime(800));
    state.rms = QUIET;
    act(() => vi.advanceTimersByTime(SILENCE_FINISH_MS * 0.8));
    expect(ring(container).style.opacity).toBe("1");
    state.rms = SPEECH;
    act(() => vi.advanceTimersByTime(100));
    expect(ring(container).style.opacity).toBe("0");
    expect(arcOf(container).style.strokeDashoffset).toBe("100");
    state.rms = QUIET;
    act(() => vi.advanceTimersByTime(SILENCE_FINISH_MS * 0.8));
    expect(onStop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SILENCE_FINISH_MS * 0.3));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("never auto-finishes with no level source (a browser without Web Audio)", () => {
    const { onStop } = renderTakeover({ source: null });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onStop).not.toHaveBeenCalled();
  });

  it("stops reading levels when it leaves the recording phase", () => {
    const { state, source } = scripted(SPEECH);
    const read = vi.spyOn(source, "read");
    const { rerender, onStop, onDiscard } = renderTakeover({ source });
    act(() => vi.advanceTimersByTime(200));
    const callsWhileRecording = read.mock.calls.length;
    expect(callsWhileRecording).toBeGreaterThan(3);
    rerender(
      <VoiceTakeover phase="transcribing" elapsed="0:09" source={source} padClassName="pb-2" onStop={onStop} onDiscard={onDiscard} />,
    );
    state.rms = QUIET;
    act(() => vi.advanceTimersByTime(5000));
    expect(read.mock.calls.length).toBe(callsWhileRecording);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("stops the loop when it unmounts", () => {
    const { source } = scripted(SPEECH);
    const read = vi.spyOn(source, "read");
    const { unmount } = renderTakeover({ source });
    act(() => vi.advanceTimersByTime(100));
    unmount();
    const calls = read.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(read.mock.calls.length).toBe(calls);
  });
});

describe("VoiceTakeover — the bars", () => {
  function scaleOf(el: HTMLElement): number {
    const match = /scaleY\(([\d.]+)\)/.exec(el.style.transform);
    return Number.parseFloat(match?.[1] ?? "NaN");
  }

  it("scale with the level, in place", () => {
    const { state, source } = scripted(QUIET);
    const { container } = renderTakeover({ source });
    const bar = container.querySelector<HTMLElement>("[data-level] > span");
    if (bar === null) throw new Error("no bar");
    act(() => vi.advanceTimersByTime(100));
    const resting = scaleOf(bar);
    state.rms = SPEECH;
    act(() => vi.advanceTimersByTime(100));
    expect(scaleOf(bar)).toBeGreaterThan(resting + 0.3);
    // Only the transform moved: no width or height is ever written.
    expect(bar.style.width).toBe("");
    expect(bar.style.height).toBe("");
  });

  it("hold a static fill under reduced motion: no per-frame movement, the ink still follows the voice", () => {
    mockReducedMotion(true);
    const { state, source } = scripted(QUIET);
    const { container, onStop } = renderTakeover({ source });
    const bar = container.querySelector<HTMLElement>("[data-level] > span");
    if (bar === null) throw new Error("no bar");
    state.rms = SPEECH;
    act(() => vi.advanceTimersByTime(100));
    const loud = scaleOf(bar);
    // The source jumps to a different bar height; a reduced-motion takeover does not follow it.
    source.read = (bars) => {
      bars.fill(0.2);
      return SPEECH;
    };
    act(() => vi.advanceTimersByTime(100));
    expect(scaleOf(bar)).toBe(loud);
    expect(container.querySelector("[data-level]")?.getAttribute("data-level")).toBe("speaking");
    // Auto-finish still works, and the ring moves in thirds.
    state.rms = QUIET;
    source.read = () => QUIET;
    act(() => vi.advanceTimersByTime(1100));
    expect(Number.parseFloat(arcOf(container).style.strokeDashoffset)).toBeCloseTo(100 - 100 / 3, 3);
    act(() => vi.advanceTimersByTime(2200));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceTakeover — the phone engine (ADR 0096)", () => {
  it("says the clip is transcribed on this phone, and still draws the one spinner", () => {
    const { container } = renderTakeover({ phase: "transcribing", engine: "phone" });
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing on this phone");
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("keeps the plain word for the host", () => {
    renderTakeover({ phase: "transcribing", engine: "host" });
    expect(screen.getByRole("status").textContent).toBe("Transcribing");
  });

  it("shows the failure sentence in an alert, with no OK button and no spinner", () => {
    const { container } = renderTakeover({ phase: "failed", failure: "The speech engine stopped." });
    expect(screen.getByRole("alert")).toHaveTextContent("The speech engine stopped.");
    expect(screen.queryByRole("button", { name: /finish and transcribe/i })).toBeNull();
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
    // The bin is still there and throws the clip away.
    expect(screen.getByRole("button", { name: /discard recording/i })).toBeInTheDocument();
  });

  it("offers Send to host only when it is given a handler, and calls it once per tap", () => {
    const onSendToHost = vi.fn();
    const { rerender, onStop, onDiscard } = renderTakeover({ phase: "failed", failure: "x", onSendToHost: null });
    expect(screen.queryByRole("button", { name: /send the recording to the host/i })).toBeNull();

    rerender(
      <VoiceTakeover
        phase="failed"
        elapsed="0:07"
        source={null}
        padClassName="pb-2"
        failure="x"
        onSendToHost={onSendToHost}
        onStop={onStop}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /send the recording to the host/i }));
    expect(onSendToHost).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("lets Escape and the bin throw the failed clip away", () => {
    const { onDiscard } = renderTakeover({ phase: "failed", failure: "x" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /discard recording/i }));
    expect(onDiscard).toHaveBeenCalledTimes(2);
  });
});
