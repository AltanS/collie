// The mark contract, as a test. `describeMarkConformance(entries)` runs the same cases over every
// mark it is given, and `components/mark-conformance.test.tsx` gives it the whole registry.
//
// What it asks is only what `components/mark-contract.ts` makes public: the props, the `--mark-*`
// variables, `data-mark`, `data-state`, `data-bead`, `data-still`, `data-slow`, `drift` and `setRate`. A mark's own class
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
  MARK_DRIFT,
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
          // Before any input a drifting state is held too: only a `run` state turns on a page nobody touched.
          expect(root.hasAttribute("data-still")).toBe(MARK_STATE_LOOK[state].motion !== "run");
          expect(root.hasAttribute("data-slow")).toBe(MARK_STATE_LOOK[state].pace !== "live");
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

    // Issue 748: a page left alone draws no frame. A resting mark drifts while the page is in use and
    // holds once it is not; the update always turns, at the calm pace. The engine half (what a real
    // browser runs, for every character) is web/e2e/idle-repaint.spec.ts.
    it("drifts at rest while the page is in use, slow and smooth, and holds idle where it is", () => {
      const roots = MARK_STATES.map((state) => ({ state, root: rootOf(render(<Mark state={state} />).container) }));
      // Opening a page is not use: only the update and the fast states turn before the first input.
      for (const { state, root } of roots) {
        const turns = state === "loading" || state === "applying" || state === "reconnected";
        expect(root.hasAttribute("data-still"), `${state} before input`).toBe(!turns);
      }
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      for (const { state, root } of roots) {
        expect(root.hasAttribute("data-still"), state).toBe(state === "idle");
        expect(root.hasAttribute("data-slow"), state).toBe(state === "rest" || state === "idle" || state === "applying");
      }
      expect(MARK_STYLE).toBe("[data-mark][data-still] *{animation-play-state:paused!important}");
    });

    it("rests from the first frame on a page nobody has touched, and an input starts the drift", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const probe = render(<Mark />);
      const names = keyframeNames(sheetOf(rootOf(probe.container)));
      probe.unmount();
      const fakes = names.map((name) => new FakeAnimation(name, 0));
      installAnimations(fakes);
      const { container, unmount } = render(<Mark />);
      const root = rootOf(container);
      // A fresh page is not in use: held at once, and a long wait with no input changes nothing.
      expect(root.hasAttribute("data-still")).toBe(true);
      act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs + MARK_DRIFT.easeMs + 1000));
      expect(root.hasAttribute("data-still")).toBe(true);
      expect(fakes.flatMap((a) => a.rates)).toEqual([]);
      // One input arms the window; with no second input it ends after `windowMs` and the mark holds again.
      act(() => {
        window.dispatchEvent(new Event("keydown"));
      });
      expect(root.hasAttribute("data-still")).toBe(false);
      act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs - 1));
      expect(root.hasAttribute("data-still")).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      act(() => vi.advanceTimersByTime(MARK_DRIFT.easeMs + 200));
      expect(root.hasAttribute("data-still")).toBe(true);
      unmount();
    });

    it("is not armed by a scroll alone, even inside a nested scroller", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const { container, unmount } = render(
        <div data-testid="thread">
          <Mark />
        </div>,
      );
      const root = rootOf(container);
      // A scroll no person made: a chat that follows new output, scroll anchoring, scrollIntoView.
      act(() => {
        window.dispatchEvent(new Event("scroll"));
        document.dispatchEvent(new Event("scroll"));
        container.firstElementChild?.dispatchEvent(new Event("scroll"));
      });
      expect(root.hasAttribute("data-still")).toBe(true);
      // Real input inside the nested scroller reaches the capture listener on window and arms the window.
      act(() => {
        container.firstElementChild?.dispatchEvent(new Event("touchstart", { bubbles: true }));
      });
      expect(root.hasAttribute("data-still")).toBe(false);
      unmount();
    });

    it("starts at rest on a page that opens hidden, and stays there after it shows with no input", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const visibility = vi.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue("hidden");
      const { container, unmount } = render(<Mark />);
      const root = rootOf(container);
      expect(root.hasAttribute("data-still")).toBe(true);
      visibility.mockReturnValue("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs));
      expect(root.hasAttribute("data-still")).toBe(true);
      unmount();
    });

    it("stops at once on pagehide, and a quiet timer left over cannot start the drift again", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const { container, unmount } = render(<Mark />);
      const root = rootOf(container);
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      expect(root.hasAttribute("data-still")).toBe(false);
      // The page is still "visible" as pagehide fires, as a page going into the back-forward cache can be.
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      act(() => vi.advanceTimersByTime(MARK_DRIFT.easeMs + 200));
      expect(root.hasAttribute("data-still")).toBe(true);
      act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs * 2));
      expect(root.hasAttribute("data-still")).toBe(true);
      unmount();
    });

    it("counts no input as use on a hidden page, and stops at once when the page turns hidden", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const visibility = vi.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue("hidden");
      const { container, unmount } = render(<Mark />);
      const root = rootOf(container);
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      expect(root.hasAttribute("data-still")).toBe(true);
      visibility.mockReturnValue("visible");
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      expect(root.hasAttribute("data-still")).toBe(false);
      visibility.mockReturnValue("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => vi.advanceTimersByTime(MARK_DRIFT.easeMs + 200));
      expect(root.hasAttribute("data-still")).toBe(true);
      unmount();
    });

    it("eases to a stop when nobody uses the page, holds, and drifts on at the next input", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const probe = render(<Mark />);
      const names = keyframeNames(sheetOf(rootOf(probe.container)));
      probe.unmount();
      const fakes = names.map((name) => new FakeAnimation(name, 0));
      installAnimations(fakes);
      const { container, unmount } = render(<Mark />);
      const root = rootOf(container);
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs - 1));
      expect(root.hasAttribute("data-still")).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      // The ease: still running, its rate falling, for MARK_DRIFT.easeMs.
      expect(root.hasAttribute("data-still")).toBe(false);
      act(() => vi.advanceTimersByTime(MARK_DRIFT.easeMs / 2));
      const falling = fakes.find((a) => a.rates.length > 0)?.rates.at(-1) ?? 1;
      expect(falling).toBeGreaterThan(0);
      expect(falling).toBeLessThan(1);
      act(() => vi.advanceTimersByTime(MARK_DRIFT.easeMs / 2 + 200));
      expect(root.hasAttribute("data-still")).toBe(true);
      // Held, and the rate is back at 1 for when it runs again.
      for (const a of fakes.filter((f) => f.rates.length > 0)) expect(a.rates.at(-1)).toBe(1);
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      expect(root.hasAttribute("data-still")).toBe(false);
      unmount();
    });

    it("never stops drifting with drift=always, and always turns while applying", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
      const always = render(<Mark drift="always" />);
      const applying = render(<Mark state="applying" />);
      act(() => vi.advanceTimersByTime(MARK_DRIFT.windowMs + MARK_DRIFT.easeMs + 1000));
      expect(rootOf(always.container).hasAttribute("data-still")).toBe(false);
      expect(rootOf(applying.container).hasAttribute("data-still")).toBe(false);
      always.unmount();
      applying.unmount();
    });

    it("comes off a fast state with no last lap: rest drifts on at once, idle holds", () => {
      const { container, rerender } = render(<Mark state="loading" />);
      expect(rootOf(container).hasAttribute("data-slow")).toBe(false);
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      rerender(<Mark state="rest" />);
      expect(rootOf(container).hasAttribute("data-still")).toBe(false);
      expect(rootOf(container).hasAttribute("data-slow")).toBe(true);
      expect(inlineVars(rootOf(container))[turnVarOf(rootOf(container))]).toBe(`var(--mark-turn, ${MARK_TURN.rest}s)`);
      rerender(<Mark state="reconnected" />);
      rerender(<Mark state="idle" />);
      expect(rootOf(container).hasAttribute("data-still")).toBe(true);
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
