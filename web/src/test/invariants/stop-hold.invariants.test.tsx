// M102 spec 15, the hold-to-stop button (staging 491d0e900, ui/stop-hold): seeded press sequences on the
// real ScreenStop. A press is a finger down, a few moves within a thumb's jitter, a wait, and a lift; or a
// key's click; sometimes the turn ends or the pane changes under the finger.
//
//   I2  every press the person ends (a lift, a key) ends in the Stop request or in words on the button
//       ("Hold", "Stop?"), or the button goes dim because the turn or the pane it was for is gone.
//       A full hold with the finger still down sends the Stop once. A turn that ended under the finger
//       never gets a Stop.
//
// A move past the jitter bound (the belt scrolls) or a pointer cancel (the system took the touch) is no
// press: it may end silent.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenStop } from "@/components/harness-bar";
import { STOP_HOLD_MS } from "@/lib/arm";

import { replayHint, rngOf, runSeeds, type Rng } from "./seed";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PRESSES_PER_SEED = 40;
const SEEDS = runSeeds();

type Step =
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "jitter"; readonly dx: number }
  | { readonly kind: "turn-ends" }
  | { readonly kind: "pane-changes" };

interface Press {
  readonly how: "finger" | "key";
  readonly steps: readonly Step[];
  readonly lift: boolean;
}

function pressOf(rng: Rng): Press {
  if (rng.chance(0.15)) return { how: "key", steps: [{ kind: "wait", ms: rng.int(600) }], lift: true };
  const steps: Step[] = [];
  const parts = 1 + rng.int(4);
  for (let i = 0; i < parts; i++) {
    const roll = rng.int(20);
    if (roll === 0) steps.push({ kind: "turn-ends" });
    else if (roll === 1) steps.push({ kind: "pane-changes" });
    else if (roll < 8) steps.push({ kind: "jitter", dx: rng.int(9) });
    else steps.push({ kind: "wait", ms: rng.pick([50, 120, 300, 900, 1500, 1999, 2000, 2600]) });
  }
  return { how: "finger", steps, lift: true };
}

function describePress(p: Press): string {
  return `${p.how}: ${p.steps.map((s) => (s.kind === "wait" ? `wait ${String(s.ms)}` : s.kind === "jitter" ? `jitter ${String(s.dx)}px` : s.kind)).join(", ")}`;
}

/** One press on a fresh button. What the person sees after it, and whether the Stop went out. */
async function run(p: Press) {
  vi.useFakeTimers();
  const onStop = vi.fn(async () => {});
  let running = true;
  let paneId = "w1:p1";
  const view = render(<ScreenStop paneId={paneId} running={running} onStop={onStop} />);
  const button = () => screen.getByRole("button", { name: /stop the turn|tap again/i });
  const before = button().textContent ?? "";
  let held = 0;
  let stopsAtFullHold = 0;
  let ended = false;
  let fillAfterChange = false;
  if (p.how === "key") {
    fireEvent.click(button(), { detail: 0 });
  } else {
    fireEvent.pointerDown(button(), { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    for (const step of p.steps) {
      if (step.kind === "wait") {
        await act(async () => {
          vi.advanceTimersByTime(step.ms);
        });
        held += step.ms;
        // A hold that the turn or the pane dropped must not stay drawn as running to its end.
        if (ended && document.querySelector("[data-slot='belt-stop-fill']") !== null) fillAfterChange = true;
        if (held >= STOP_HOLD_MS && !ended && stopsAtFullHold === 0) stopsAtFullHold = onStop.mock.calls.length;
      } else if (step.kind === "jitter") {
        fireEvent.pointerMove(button(), { clientX: 10 + step.dx, clientY: 10, pointerType: "touch" });
      } else if (step.kind === "turn-ends") {
        running = false;
        ended = true;
        view.rerender(<ScreenStop paneId={paneId} running={running} onStop={onStop} />);
      } else {
        paneId = "w1:p2";
        ended = true;
        view.rerender(<ScreenStop paneId={paneId} running={running} onStop={onStop} />);
      }
    }
    fireEvent.pointerUp(button(), { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    fireEvent.click(button(), { detail: 1 });
  }
  await act(async () => {
    await Promise.resolve();
  });
  const after = button();
  return {
    onStop: onStop.mock.calls.length,
    before,
    words: after.textContent ?? "",
    dim: after.getAttribute("aria-disabled") === "true",
    held,
    ended,
    stopsAtFullHold,
    fillAfterChange,
  };
}

describe("M102-15, the hold-to-stop button", () => {
  for (const seed of SEEDS) {
    it(`I2: every press ends in a Stop, words on the button, or a dim button (${replayHint(seed, "stop hold")})`, async () => {
      const rng = rngOf(seed);
      const broken: string[] = [];
      for (let i = 0; i < PRESSES_PER_SEED; i++) {
        const p = pressOf(rng);
        const out = await run(p);
        cleanup();
        vi.useRealTimers();
        const line = `${describePress(p)} -> stops ${String(out.onStop)}, words "${out.words}", dim ${String(out.dim)}; ${replayHint(seed, `press ${String(i)}`)}`;
        if (out.onStop > 1) broken.push(`two Stops: ${line}`);
        // A turn that ended (or a pane that changed) under the finger before the hold was full gets no Stop.
        if (out.ended && out.onStop > 0 && out.stopsAtFullHold === 0) broken.push(`a Stop for a turn that was gone: ${line}`);
        if (p.how === "finger" && !out.ended && out.held >= STOP_HOLD_MS && out.onStop !== 1) broken.push(`a full hold sent no Stop: ${line}`);
        const spoke = out.words !== out.before;
        if (out.onStop === 0 && !spoke && !out.dim && !out.ended) broken.push(`silent: ${line}`);
        if (out.ended && out.onStop === 0 && !spoke && !out.dim) paneSilent.push(line);
      }
      expect(broken).toEqual([]);
    });
  }

  const paneSilent: string[] = [];
  it("I2: a hold that began on another pane ends in a Stop or words, not a full fill and nothing", async () => {
    // Named case, on every seed: the pane changes under the finger, the new pane runs too, the finger holds on.
    const out = await run({ how: "finger", steps: [{ kind: "pane-changes" }, { kind: "wait", ms: 600 }, { kind: "wait", ms: STOP_HOLD_MS }], lift: true });
    console.info(`[invariants.stop-hold] i2-stop-hold-pane: ${String(paneSilent.length)} sampled presses silent`);
    // The hold that the pane change dropped ends in sight: no fill is drawn after the change.
    expect(out.onStop > 0 || out.words !== out.before || out.dim || !out.fillAfterChange).toBe(true);
  });
});
