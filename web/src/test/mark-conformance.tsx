// The mark contract, as a test. `describeMarkConformance(entries)` runs the same cases over every
// mark it is given, and `components/mark-conformance.test.tsx` gives it the whole registry.
//
// What it asks is only what `components/mark-contract.ts` makes public: the props, the `--mark-*`
// variables, `data-mark`, `data-state`, `data-bead`, `data-still`, `data-ticked`, `setRate` and the ticker. A mark's own class
// names and parts are never asked for, so a regeneration that renames them cannot break this suite.
// What it DOES ask about private names is the opposite question: that they stay private, which means
// every keyframe and every inline custom property a mark invents starts with its own prefix.
//
// jsdom has no `getAnimations`, so the two cases that need one (the rate and the phase carry) install
// a fake on the SVG prototype and a `getComputedStyle` that resolves the turn the way a browser does.
// The fakes are the contract's own words: an animation named like one of the mark's keyframes is
// paced, one named like anything else is the host's and is never touched.

import { act, render } from "@testing-library/react";
import { createRef, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MARK_POSES,
  MARK_STATES,
  MARK_STATE_LOOK,
  MARK_STYLE,
  MARK_TURN,
  type MarkHandle,
  type MarkProps,
  type MarkState,
} from "@/components/mark-contract";

export interface MarkEntry {
  /** The id the mark registers under. Must equal the `data-mark` on its root. */
  id: string;
  /** The start of the mark's private names, without the hyphen: `cm` for `cm-t0` and `--cm-turn`. */
  prefix: string;
  Mark: ComponentType<MarkProps>;
}

const WEIGHTS = ["full", "header"] as const;

function rootOf(container: ParentNode): SVGSVGElement {
  const root = container.querySelector<SVGSVGElement>("svg[data-mark]");
  if (root === null) throw new Error("no mark root: no <svg data-mark> was rendered");
  return root;
}

/** The custom properties set inline on the root, by name. */
export function inlineVars(root: SVGSVGElement) {
  const names = Array.from({ length: root.style.length }, (_, i) => root.style.item(i));
  return Object.fromEntries(
    names.filter((name) => name.startsWith("--")).map((name) => [name, root.style.getPropertyValue(name)]),
  );
}

/** The mark's inline `<style>`, all of it. */
export function sheetOf(root: SVGSVGElement): string {
  return [...root.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
}

export function keyframeNames(sheet: string): string[] {
  return [...sheet.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1] ?? "");
}

/** The one inline variable that carries the turn: the one that reads `--mark-turn`. */
function turnVarOf(root: SVGSVGElement): string {
  const found = Object.entries(inlineVars(root)).filter(([, value]) => value.includes("--mark-turn"));
  if (found.length !== 1) throw new Error(`expected exactly one inline variable reading --mark-turn, found ${found.length}`);
  return found[0]?.[0] ?? "";
}

/** The inline variables that are colour, which is every one but the turn and the held-turn ones. */
function colourVars(root: SVGSVGElement): Record<string, string> {
  return Object.fromEntries(Object.entries(inlineVars(root)).filter(([, value]) => !value.includes("--mark-turn")));
}

class FakeAnimation {
  readonly animationName: string;
  currentTime: number;
  readonly playbackRate = 1;
  readonly rates: number[] = [];
  readonly effect = { getTiming: () => ({ delay: 0, duration: 1800 }) };

  constructor(animationName: string, currentTime: number) {
    this.animationName = animationName;
    this.currentTime = currentTime;
  }

  updatePlaybackRate(rate: number): void {
    this.rates.push(rate);
  }
}

/** The host's own animation: it shares the subtree and must never be paced. */
const HOST_ANIMATION = "host-fade";

function installAnimations(fakes: readonly FakeAnimation[]): void {
  Object.defineProperty(SVGSVGElement.prototype, "getAnimations", { configurable: true, value: () => fakes });
}

/** A browser resolves `var(--mark-turn, 48s)` to `48s`; jsdom does not, so the carry would see none. */
function resolveTurnLikeABrowser(): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((node, pseudo) => {
    const decl = real(node, pseudo);
    const read = decl.getPropertyValue.bind(decl);
    decl.getPropertyValue = (name) => {
      const inline = node instanceof SVGElement ? node.style.getPropertyValue(name) : "";
      return (inline === "" ? read(name) : inline).replace(/^var\(--mark-turn,\s*([^)]+)\)$/, "$1");
    };
    return decl;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(SVGSVGElement.prototype, "getAnimations");
});

export function describeMarkConformance(entries: readonly MarkEntry[]): void {
  describe.each(entries)("the $id mark", ({ id, prefix, Mark }) => {
    it("says which mark it is, and rests by default", () => {
      const { container } = render(<Mark />);
      const root = rootOf(container);
      expect(root.getAttribute("data-mark")).toBe(id);
      expect(root.getAttribute("data-state")).toBe("rest");
      expect(root.getAttribute("width")).toBe("32");
      expect(root.getAttribute("height")).toBe("32");
    });

    it("takes the deprecated loading flag as state=loading, and lets state win", () => {
      const { container, rerender } = render(<Mark loading />);
      expect(rootOf(container).getAttribute("data-state")).toBe("loading");
      rerender(<Mark loading state="rest" />);
      expect(rootOf(container).getAttribute("data-state")).toBe("rest");
    });

    for (const weight of WEIGHTS) {
      for (const state of MARK_STATES) {
        it(`draws ${state} at the ${weight} weight, with its data attributes`, () => {
          const { container } = render(<Mark size={64} weight={weight} state={state} />);
          const root = rootOf(container);
          expect(root.getAttribute("data-mark")).toBe(id);
          expect(root.getAttribute("data-state")).toBe(state);
          expect(root.getAttribute("width")).toBe("64");
          expect(root.hasAttribute("data-bead")).toBe(MARK_STATE_LOOK[state].bead !== null);
          expect(root.hasAttribute("data-still")).toBe(MARK_STATE_LOOK[state].motion === "hold");
          expect(root.hasAttribute("data-ticked")).toBe(MARK_STATE_LOOK[state].motion === "tick");
          expect(root.getAttribute("viewBox")).not.toBeNull();
        });
      }
    }

    it("crops the header weight to its own view box", () => {
      const full = rootOf(render(<Mark weight="full" />).container).getAttribute("viewBox");
      const header = rootOf(render(<Mark weight="header" />).container).getAttribute("viewBox");
      expect(header).not.toBe(full);
    });

    // Under prefers-reduced-motion every mark stops turning, so colour is the whole message.
    for (const state of MARK_STATES.filter((s): s is Exclude<MarkState, "rest"> => s !== "rest")) {
      it(`differs from rest by colour in ${state}, so it reads with no movement`, () => {
        const rest = rootOf(render(<Mark />).container);
        const other = rootOf(render(<Mark state={state} />).container);
        if (MARK_STATE_LOOK[state].dim) {
          expect(other.style.opacity).toBe("0.4");
          expect(other.style.filter).toContain("grayscale");
          expect(rest.style.opacity).toBe("");
          return;
        }
        expect(colourVars(other)).not.toEqual(colourVars(rest));
      });
    }

    it("forces the status colour in applying and reconnected, and only a beads prop beats it", () => {
      for (const state of ["applying", "reconnected"] as const) {
        const forced = MARK_STATE_LOOK[state].bead;
        const plain = rootOf(render(<Mark state={state} />).container);
        expect(inlineVars(plain)["--mark-bead"]).toBe(forced);
        const own = rootOf(render(<Mark state={state} beads="hotpink" />).container);
        expect(inlineVars(own)["--mark-bead"]).toBe("hotpink");
      }
    });

    it("sets one bead colour for every bead, or a list in bead order that repeats", () => {
      // One colour goes on `--mark-bead` AND every per-bead variable: a bead reads its own variable
      // first, so a `--mark-bead-<i>` from a stylesheet must not beat the colour the prop asked for.
      const one = inlineVars(rootOf(render(<Mark beads="red" />).container));
      expect(one["--mark-bead"]).toBe("red");
      const each = Object.entries(one).filter(([name]) => name.startsWith("--mark-bead-"));
      expect(each.length).toBeGreaterThan(0);
      for (const [, value] of each) expect(value).toBe("red");
      const list = rootOf(render(<Mark beads={["a", "b", "c"]} />).container);
      const vars = inlineVars(list);
      expect(list.hasAttribute("data-bead")).toBe(true);
      expect(vars["--mark-bead-0"]).toBe("a");
      expect(vars["--mark-bead-1"]).toBe("b");
      expect(vars["--mark-bead-2"]).toBe("c");
      if (vars["--mark-bead-3"] !== undefined) expect(vars["--mark-bead-3"]).toBe("a");
      // `--mark-bead` takes the list's first colour, for anything that reads the one variable.
      expect(vars["--mark-bead"]).toBe("a");
      const single = inlineVars(rootOf(render(<Mark beads={["solo"]} />).container));
      expect(single["--mark-bead"]).toBe("solo");
    });

    it("paints every bead from the bead variables, so a stylesheet can recolour them all", () => {
      const html = rootOf(render(<Mark />).container).outerHTML;
      const indexes = [...html.matchAll(/var\(--mark-bead-(\d+),\s*var\(--mark-bead,/g)].map((m) => Number(m[1]));
      expect(indexes.length).toBeGreaterThan(0);
      // Contiguous from 0: a bead that skipped the variable would leave a hole.
      const distinct = [...new Set(indexes)].toSorted((a, b) => a - b);
      expect(distinct).toEqual(distinct.map((_, i) => i));
    });

    it("reads the ink, and the accents when it has them, from the shared variables", () => {
      const root = rootOf(render(<Mark />).container);
      const html = root.outerHTML;
      expect(html).toContain("--mark-ink");
      expect(html.includes("--mark-accent-1")).toBe(html.includes("--mark-accent-2"));
    });

    it("paces the orbit by the shared table, and lets a prop or a variable change the period", () => {
      const rest = rootOf(render(<Mark />).container);
      const loading = rootOf(render(<Mark state="loading" />).container);
      expect(inlineVars(rest)[turnVarOf(rest)]).toBe(`var(--mark-turn, ${MARK_TURN.rest}s)`);
      expect(inlineVars(loading)[turnVarOf(loading)]).toBe(`var(--mark-turn, ${MARK_TURN.live}s)`);
      // The update turns at the calm pace, between the drift and the live turn.
      const applying = rootOf(render(<Mark state="applying" />).container);
      expect(inlineVars(applying)[turnVarOf(applying)]).toBe(`var(--mark-turn, ${MARK_TURN.calm}s)`);
      const own = rootOf(render(<Mark state="loading" turn={3} />).container);
      expect(Object.values(inlineVars(own))).toContain("3s");
      expect(Object.values(inlineVars(own)).some((value) => value.includes("--mark-turn"))).toBe(false);
    });

    it("holds the orbit where it is for turn=0, and says so", () => {
      const held = rootOf(render(<Mark state="loading" turn={0} />).container);
      expect(held.hasAttribute("data-still")).toBe(true);
      expect(sheetOf(held)).toContain(MARK_STYLE);
      expect(rootOf(render(<Mark state="loading" turn={2} />).container).hasAttribute("data-still")).toBe(false);
    });

    // Issue 748: a slow mark runs no animation. In rest and applying every animation under the root
    // is paused and the ticker seeks it; the engine half (no running animation in a real browser,
    // for every character) is web/e2e/idle-repaint.spec.ts.
    it("pauses every animation in rest and applying, and holds idle where it is", () => {
      for (const state of MARK_STATES) {
        const root = rootOf(render(<Mark state={state} />).container);
        const motion = MARK_STATE_LOOK[state].motion;
        expect(root.hasAttribute("data-ticked"), state).toBe(state === "rest" || state === "applying");
        expect(motion === "run", state).toBe(state === "loading" || state === "reconnected");
      }
      const root = rootOf(render(<Mark />).container);
      expect(sheetOf(root)).toContain(MARK_STYLE);
      expect(MARK_STYLE).toContain("[data-mark][data-ticked] *");
      expect(MARK_STYLE).toContain("[data-mark][data-still] *");
      expect(MARK_STYLE).toContain("animation-play-state:paused!important");
      // jsdom resolves no `animation-play-state` from a stylesheet, so that the rule reaches every
      // part (and that a browser reports each animation as paused) is the e2e spec's to check.
    });

    it("draws rest in poses from the ticker, MARK_POSES a second, and stops when it leaves", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      // Read off a mark that is gone again: the fakes stand in for every mark's animations, and a
      // second resting mark would tick them too.
      const probe = render(<Mark />);
      const names = keyframeNames(sheetOf(rootOf(probe.container)));
      probe.unmount();
      const fakes = names.map((name) => new FakeAnimation(name, 0));
      installAnimations(fakes);
      const { rerender, unmount } = render(<Mark />);
      const pose = 1000 / MARK_POSES.perSecond;
      act(() => vi.advanceTimersByTime(pose - 1));
      expect(fakes.every((a) => a.currentTime === 0)).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      for (const a of fakes) expect(a.currentTime).toBeCloseTo(pose, 3);
      act(() => vi.advanceTimersByTime(1000));
      for (const a of fakes) expect(a.currentTime).toBeCloseTo(pose + 1000, 3);
      // A fast state runs the real animation; the ticker draws no pose of it.
      rerender(<Mark state="loading" />);
      const left = fakes.map((a) => a.currentTime);
      act(() => vi.advanceTimersByTime(1000));
      expect(fakes.map((a) => a.currentTime)).toEqual(left);
      // Idle holds the pose it is in.
      rerender(<Mark state="idle" />);
      act(() => vi.advanceTimersByTime(1000));
      expect(fakes.map((a) => a.currentTime)).toEqual(left);
      unmount();
    });

    it("comes off a fast state with no last lap: rest is ticked on at once, idle holds", () => {
      const { container, rerender } = render(<Mark state="loading" />);
      rerender(<Mark state="rest" />);
      expect(rootOf(container).hasAttribute("data-ticked")).toBe(true);
      expect(inlineVars(rootOf(container))[turnVarOf(rootOf(container))]).toBe(`var(--mark-turn, ${MARK_TURN.rest}s)`);
      rerender(<Mark state="reconnected" />);
      rerender(<Mark state="idle" />);
      expect(rootOf(container).hasAttribute("data-still")).toBe(true);
      expect(rootOf(container).hasAttribute("data-ticked")).toBe(false);
    });

    it("runs a ticked mark while the host rates it, and ticks it again at rate 1", () => {
      const ref = createRef<MarkHandle>();
      const { container } = render(<Mark ref={ref} />);
      expect(rootOf(container).hasAttribute("data-ticked")).toBe(true);
      act(() => ref.current?.setRate(2.7));
      expect(rootOf(container).hasAttribute("data-ticked")).toBe(false);
      act(() => ref.current?.setRate(1));
      expect(rootOf(container).hasAttribute("data-ticked")).toBe(true);
    });

    it("hands the caller's paper to the knockout, and falls back to --mark-paper", () => {
      const own = rootOf(render(<Mark paper="var(--muted)" />).container);
      expect(Object.values(inlineVars(own))).toContain("var(--muted)");
      const fallback = rootOf(render(<Mark />).container);
      expect(Object.values(inlineVars(fallback)).some((value) => value.includes("--mark-paper"))).toBe(true);
    });

    it("is decorative unless titled, and an image with a name when it is", () => {
      const bare = rootOf(render(<Mark />).container);
      expect(bare.getAttribute("role")).toBe("presentation");
      const titled = rootOf(render(<Mark title="Collie" />).container);
      expect(titled.getAttribute("role")).toBe("img");
      expect(titled.getAttribute("aria-label")).toBe("Collie");
    });

    it("forwards className to the root, and marks the live pace with a class of its own", () => {
      const rest = rootOf(render(<Mark className="host-class" />).container);
      expect(rest.classList.contains("host-class")).toBe(true);
      const live = rootOf(render(<Mark className="host-class" state="loading" />).container);
      expect(live.classList.contains("host-class")).toBe(true);
      expect(live.getAttribute("class")).not.toBe(rest.getAttribute("class"));
    });

    it("keeps the same element across a state change, and the same stylesheet in every state", () => {
      const { container, rerender } = render(<Mark />);
      const before = rootOf(container);
      const restSheet = sheetOf(before);
      rerender(<Mark state="applying" />);
      expect(rootOf(container)).toBe(before);
      expect(sheetOf(before)).toBe(restSheet);
    });

    it("stops every animation under prefers-reduced-motion", () => {
      const sheet = sheetOf(rootOf(render(<Mark state="loading" />).container));
      expect(sheet).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{[^{]*\{[^}]*animation:\s*none/);
    });

    it(`keeps every keyframe and custom property private to its prefix (${prefix}-)`, () => {
      const root = rootOf(render(<Mark state="applying" beads={["a", "b"]} />).container);
      const names = keyframeNames(sheetOf(root));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name.startsWith(`${prefix}-`), `keyframe ${name}`).toBe(true);
      for (const name of Object.keys(inlineVars(root))) {
        const allowed = name.startsWith("--mark-") || name.startsWith(`--${prefix}-`);
        expect(allowed, `custom property ${name}`).toBe(true);
      }
    });

    it("rates only its own animations when the host calls setRate", () => {
      const names = keyframeNames(sheetOf(rootOf(render(<Mark />).container)));
      const fakes = [...names, HOST_ANIMATION].map((name) => new FakeAnimation(name, 0));
      installAnimations(fakes);
      const ref = createRef<MarkHandle>();
      render(<Mark ref={ref} />);
      expect(ref.current).not.toBeNull();
      act(() => ref.current?.setRate(2.5));
      act(() => ref.current?.setRate(1));
      const rated = fakes.filter((a) => a.rates.length > 0);
      expect(rated.length).toBeGreaterThan(0);
      for (const a of rated) {
        expect(a.animationName.startsWith(`${prefix}-`)).toBe(true);
        expect(a.rates).toEqual([2.5, 1]);
      }
      expect(fakes.find((a) => a.animationName === HOST_ANIMATION)?.rates).toEqual([]);
    });

    it("still rates its animations when setRate first ran before they existed", () => {
      // A call on the first frame can find no animations yet. An empty answer must not be cached, or
      // every later call would rate nothing for the rest of the mount (found by the website's copy).
      installAnimations([]);
      const ref = createRef<MarkHandle>();
      render(<Mark ref={ref} />);
      act(() => ref.current?.setRate(2));
      const names = keyframeNames(sheetOf(rootOf(render(<Mark />).container)));
      const fakes = names.map((name) => new FakeAnimation(name, 0));
      installAnimations(fakes);
      act(() => ref.current?.setRate(3));
      expect(fakes.some((a) => a.rates.includes(3))).toBe(true);
    });

    it("carries the orbit's phase across a change of pace, and leaves the host's animations alone", () => {
      resolveTurnLikeABrowser();
      const names = keyframeNames(sheetOf(rootOf(render(<Mark />).container)));
      // A quarter of the way round the resting turn, in milliseconds. A running CSS animation keeps
      // its ELAPSED time when its duration changes, so the browser leaves 12000 where it was.
      const quarter = (MARK_TURN.rest / 4) * 1000;
      const fakes = [...names, HOST_ANIMATION].map((name) => new FakeAnimation(name, quarter));
      installAnimations(fakes);
      const { rerender } = render(<Mark />);
      rerender(<Mark state="loading" />);
      // The new duration is the live turn, 1.8 s; the same quarter of it is 450 ms.
      const moved = fakes.filter((a) => a.currentTime !== quarter);
      expect(moved.length).toBeGreaterThan(0);
      for (const a of moved) {
        expect(a.animationName.startsWith(`${prefix}-`)).toBe(true);
        expect(a.currentTime).toBeCloseTo(450, 3);
      }
      expect(fakes.find((a) => a.animationName === HOST_ANIMATION)?.currentTime).toBe(quarter);
    });
  });
}
