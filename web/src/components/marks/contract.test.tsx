import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollieHome } from "@/components/collie-home";
import { __resetOperatorBusy, beginBusy } from "@/lib/busy";
import { SHIPPED_MARKS, type ShippedMark } from "@/lib/shipped-marks";
import { clearStatus, setStatus } from "@/lib/status";
import { setActiveTheme } from "@/lib/theme/store";
import { markIsLive } from "@/test/collie-mark";

import { CollieMarkAdapter } from "./collie";
import { MARKS, type MarkState } from "./index";

// THE MARK CONTRACT, for every entry in the registry (M57 spec 10). contract.ts says what a mark
// is; this file holds each mark to it. jsdom runs no CSS animation, so the motion is checked
// statically: the mark's own <style> is parsed into its top-level rules, and a rule "runs" in a
// state when it carries an `animation` and its selector matches an element of the mark drawn in
// that state. That is the same question a browser asks, minus the clock.

const STATES: readonly MarkState[] = ["idle", "loading", "lost"];

/**
 * The dog's lost state is its idle drift under grey: `marks/collie.tsx` passes `loading={false}` to
 * the sealed `collie-mark.tsx`, and theme-mark.test.tsx holds that markup to the old bytes. So for
 * the dog alone (and any id that still draws it), "lost runs nothing" is read as "lost runs only the
 * slow rest motion".
 */
const lostDrifts = (id: ShippedMark): boolean => MARKS[id] === CollieMarkAdapter;

/** The slowest a resting loop may be: the dog's slowest resting part turns once in 12.8 s. */
const SLOW_MS = 10_000;

interface Rule {
  selector: string;
  body: string;
}

/** The top-level rules of a stylesheet, without the `@keyframes` and `@media` blocks. */
function topLevelRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (!selector.startsWith("@")) rules.push({ selector, body: css.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return rules;
}

/** The `animation` shorthand of a rule, or null when it has none or it is `none`. */
function animationOf(rule: Rule): string | null {
  const decl = /(?:^|;)\s*animation\s*:([^;]*)/.exec(rule.body);
  if (decl === null) return null;
  const value = (decl[1] ?? "").trim();
  return value === "none" || value.startsWith("none!") ? null : value;
}

/** The custom property `name`, read up the tree from `el` through inline styles. */
function customProperty(el: Element, name: string): string | null {
  for (let at: Element | null = el; at !== null; at = at.parentElement) {
    const style = at.getAttribute("style") ?? "";
    const hit = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
    if (hit !== null) return (hit[1] ?? "").trim();
  }
  return null;
}

/**
 * The duration in ms of each animation in a shorthand, resolving `var()` against `el` and a `calc()`
 * of products and quotients. NaN when a part cannot be resolved, which fails the caller's check.
 */
function durationsMs(shorthand: string, el: Element): number[] {
  const resolve = (text: string): string =>
    text.replace(/var\((--[\w-]+)\)/g, (_, name: string) => customProperty(el, name) ?? "NaN");
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < shorthand.length; i++) {
    if (shorthand[i] === "(") depth++;
    else if (shorthand[i] === ")") depth--;
    else if (shorthand[i] === "," && depth === 0) {
      parts.push(shorthand.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(shorthand.slice(from));
  return parts.map((part) => {
    const text = resolve(part.trim());
    const calc = /calc\(([^()]*)\)/.exec(text);
    const expr = calc !== null ? (calc[1] ?? "") : (/(?:^|\s)([\d.]+m?s)(?:\s|$)/.exec(text)?.[1] ?? "NaN");
    let ms = Number.NaN;
    let op = "*";
    for (const token of expr.split(/\s+/).filter((t) => t !== "")) {
      if (token === "*" || token === "/") {
        op = token;
        continue;
      }
      const unit = /^([\d.]+)(ms|s)?$/.exec(token);
      if (unit === null) return Number.NaN;
      const n = Number(unit[1]) * (unit[2] === "s" ? 1000 : 1);
      ms = Number.isNaN(ms) ? n : op === "*" ? ms * n : ms / n;
    }
    return ms;
  });
}

interface Running {
  selector: string;
  durations: number[];
}

/** Every animated rule that matches an element of the mark in `container`, with its durations. */
function running(container: HTMLElement): Running[] {
  const css = container.querySelector("svg > style")?.textContent ?? "";
  const out: Running[] = [];
  for (const rule of topLevelRules(css)) {
    const animation = animationOf(rule);
    if (animation === null) continue;
    for (const selector of rule.selector.split(",").map((s) => s.trim())) {
      for (const el of container.querySelectorAll(selector)) {
        out.push({ selector, durations: durationsMs(animation, el) });
      }
    }
  }
  return out;
}

function draw(id: ShippedMark, state: MarkState, paper?: string) {
  const Mark = MARKS[id];
  return render(<Mark size={40} weight="header" state={state} paper={paper} />).container;
}

describe("the mark contract", () => {
  afterEach(() => cleanup());

  for (const id of SHIPPED_MARKS) {
    describe(id, () => {
      it("forwards className and is named only by its title", () => {
        const Mark = MARKS[id];
        const { container, rerender } = render(<Mark size={40} className="probe-class" />);
        const svg = container.querySelector("svg");
        expect(svg?.classList.contains("probe-class")).toBe(true);
        expect(screen.queryByRole("img")).toBeNull();
        rerender(<Mark size={40} title="Collie" className="probe-class" />);
        expect(screen.getByRole("img", { name: "Collie" })).toBeInTheDocument();
      });

      it("hands `paper` to the knockout", () => {
        for (const state of STATES) {
          const svg = draw(id, state, "var(--card)").querySelector("svg");
          expect(svg?.style.getPropertyValue("--cm-paper")).toBe("var(--card)");
          cleanup();
        }
      });

      it("draws with CSS only: no SMIL, no image, no foreign object", () => {
        for (const state of STATES) {
          const container = draw(id, state);
          expect(container.querySelectorAll("animate, animateTransform, animateMotion, set, image, foreignObject")).toHaveLength(0);
          cleanup();
        }
      });

      it("gives each instance its own ids", () => {
        const Mark = MARKS[id];
        const { container } = render(
          <div>
            <Mark size={40} />
            <Mark size={64} state="loading" />
          </div>,
        );
        const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("rests slowly while idle", () => {
        const idle = running(draw(id, "idle"));
        for (const r of idle) {
          for (const ms of r.durations) expect(ms, r.selector).toBeGreaterThanOrEqual(SLOW_MS);
        }
      });

      it("moves at least five elements while loading, and says so with cm-live", () => {
        const container = draw(id, "loading");
        expect(markIsLive(container)).toBe(true);
        const selectors = new Set(running(container).map((r) => r.selector));
        expect(selectors.size).toBeGreaterThanOrEqual(5);
        // Every loading name starts with `cm-`, so the header's rate ramp collects it.
        const css = container.querySelector("svg > style")?.textContent ?? "";
        for (const name of css.matchAll(/@keyframes\s+([\w-]+)/g)) expect(name[1]).toMatch(/^cm-/);
      });

      it("holds still and mutes its ink while lost", () => {
        const container = draw(id, "lost");
        expect(markIsLive(container)).toBe(false);
        const lost = running(container);
        if (lostDrifts(id)) {
          for (const r of lost) for (const ms of r.durations) expect(ms, r.selector).toBeGreaterThanOrEqual(SLOW_MS);
          expect(container.querySelector("svg")?.getAttribute("class")).toContain("grayscale");
        } else {
          expect(lost.map((r) => r.selector)).toEqual([]);
          expect(container.innerHTML).toContain("var(--muted-foreground)");
        }
      });

      it("stops every animated class under prefers-reduced-motion", () => {
        const container = draw(id, "loading");
        const css = container.querySelector("svg > style")?.textContent ?? "";
        const reduce = /prefers-reduced-motion: reduce\)\{([^{]*)\{animation:none!important\}\}/.exec(css);
        expect(reduce).not.toBeNull();
        const stopped = (reduce?.[1] ?? "").split(",").map((s) => s.trim());
        const animated = topLevelRules(css)
          .filter((rule) => animationOf(rule) !== null)
          .flatMap((rule) => rule.selector.split(","))
          .map((selector) => /(\.[\w-]+)\s*$/.exec(selector.trim())?.[1] ?? selector);
        expect(animated.length).toBeGreaterThan(0);
        for (const cls of new Set(animated)) {
          expect(
            stopped.some((s) => cls.startsWith(s)),
            cls,
          ).toBe(true);
        }
      });
    });
  }
});

// THE RATE RAMP with each mark in the header. jsdom has no `getAnimations`, so the ramp itself falls
// back to its square wave here (collie-home.tsx says why that is never an error); what this holds
// is that the header's round and busy spin start and stop every mark through `cm-live`, without a
// throw. The ramp on real animations is checked in a browser and recorded in each mark's notes.
describe("the header round with every mark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
    __resetOperatorBusy();
  });
  afterEach(() => {
    act(() => clearStatus());
    act(() => __resetOperatorBusy());
    act(() => setActiveTheme("collie"));
    cleanup();
    vi.useRealTimers();
  });

  for (const id of SHIPPED_MARKS) {
    it(`${id}: one round on a status, a spin while busy, still while lost`, () => {
      act(() => setActiveTheme(id));
      const { container, unmount } = render(<CollieHome trouble={false} />);
      expect(markIsLive(container)).toBe(false);
      act(() => setStatus("claude is done", "success"));
      expect(markIsLive(container)).toBe(true);
      act(() => void vi.advanceTimersByTime(1800));
      expect(markIsLive(container)).toBe(false);

      let release!: () => void;
      act(() => {
        release = beginBusy();
      });
      expect(markIsLive(container)).toBe(true);
      act(() => release());
      expect(markIsLive(container)).toBe(false);
      unmount();

      const lost = render(<CollieHome trouble lost />).container;
      act(() => void beginBusy());
      expect(markIsLive(lost)).toBe(false);
    });
  }
});
