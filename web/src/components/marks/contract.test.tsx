import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollieHome } from "@/components/collie-home";
import { __resetOperatorBusy } from "@/lib/busy";
import { SHIPPED_MARKS, type ShippedMark } from "@/lib/shipped-marks";
import { clearStatus, setStatus } from "@/lib/status";
import { setActiveTheme } from "@/lib/theme/store";
import { markIsLive, markPaper } from "@/test/collie-mark";

import { CollieMarkAdapter } from "./collie";
import { MARKS, type MarkState } from "./index";

// THE MARK CONTRACT, held for every entry of the registry (M57 spec 10). contract.ts says what a mark
// is; this file checks it on the rendered DOM. jsdom runs no CSS animation, so the motion checks are
// static: they read the mark's own <style>, find each rule that sets `animation`, and ask the DOM
// with `matches` whether that rule selects anything in the drawn state. A rule that selects nothing
// is a loop that does not run in that state.
//
// THE DOG'S TWO WAIVERS. collie-mark.tsx is generated and hash-sealed, and it keeps its 48 s resting
// drift in idle AND in lost (the adapter greys it; it cannot stop the orbit without editing the sealed
// file). So for an id the dog draws, the idle check and the lost check below ask only what the dog
// can answer: its idle is held by collie-mark.test.tsx, and its lost state must be grey. That is
// `collie`, plus any new id whose own mark has not landed yet (the registry still points it at the
// adapter). Every new mark answers both in full.

const isDog = (id: ShippedMark): boolean => MARKS[id] === CollieMarkAdapter;

function draw(id: ShippedMark, state: MarkState, extra: { paper?: string; className?: string } = {}): SVGSVGElement {
  const Mark = MARKS[id];
  const { container } = render(<Mark size={40} weight="header" state={state} {...extra} />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error(`${id} drew no svg`);
  return svg;
}

/** The stylesheet with every `@keyframes` block and every `@media` block removed. */
function topLevelRules(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "@") {
      // Skip the at-rule and its whole braced body.
      const open = css.indexOf("{", i);
      let depth = 0;
      let j = open;
      for (; j < css.length; j++) {
        if (css[j] === "{") depth++;
        if (css[j] === "}" && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

interface Loop {
  selector: string;
  animation: string;
}

/** Every selector of a rule that sets a running animation, with the value it sets. */
function loops(css: string): Loop[] {
  const found: Loop[] = [];
  for (const m of topLevelRules(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decl = /animation:([^;]+)/.exec(m[2] ?? "");
    const value = decl?.[1]?.trim() ?? "";
    if (value === "" || value.startsWith("none")) continue;
    for (const selector of (m[1] ?? "").split(",")) found.push({ selector: selector.trim(), animation: value });
  }
  return found;
}

/** The loops whose selector matches an element of the drawn mark, the root included. */
function running(svg: SVGSVGElement): Loop[] {
  const css = svg.querySelector("style")?.textContent ?? "";
  const nodes = [svg, ...svg.querySelectorAll("*")];
  return loops(css).filter((loop) => nodes.some((node) => node.matches(loop.selector)));
}

/** The duration of each comma-separated animation in a shorthand, in seconds. */
function seconds(animation: string): number[] {
  return animation.split(",").map((one) => {
    const t = /(?:^|\s)([\d.]+)(m?s)(?:\s|$)/.exec(one);
    if (t === null) return Number.NaN;
    return Number(t[1]) / (t[2] === "ms" ? 1000 : 1);
  });
}

describe("the mark contract", () => {
  afterEach(() => cleanup());

  for (const id of SHIPPED_MARKS) {
    describe(id, () => {
      it("draws one svg of its size and nothing beside it, in every state", () => {
        for (const state of ["idle", "loading", "lost"] as const) {
          const Mark = MARKS[id];
          const { container } = render(<Mark size={24} state={state} weight="header" />);
          expect(container.children).toHaveLength(1);
          const svg = container.firstElementChild;
          expect(svg?.tagName.toLowerCase()).toBe("svg");
          expect(svg?.getAttribute("width")).toBe("24");
          expect(svg?.getAttribute("height")).toBe("24");
          cleanup();
        }
      });

      it("is decorative without a title and an image with one", () => {
        expect(draw(id, "idle").getAttribute("role")).toBe("presentation");
        cleanup();
        const Mark = MARKS[id];
        const { getByRole } = render(<Mark size={40} title="Collie" />);
        expect(getByRole("img", { name: "Collie" })).toBeInTheDocument();
      });

      it("forwards className and hands paper to the knockout", () => {
        const svg = draw(id, "idle", { paper: "var(--muted)", className: "probe-class" });
        expect(svg.classList.contains("probe-class")).toBe(true);
        expect(markPaper(svg.parentElement ?? svg)).toBe("var(--muted)");
      });

      it("is live while loading, with at least five loops, and still while idle", () => {
        const loading = draw(id, "loading");
        expect(loading.classList.contains("cm-live")).toBe(true);
        const live = running(loading);
        expect(new Set(live.map((l) => l.selector)).size).toBeGreaterThanOrEqual(5);
        cleanup();
        const idle = draw(id, "idle");
        expect(idle.classList.contains("cm-live")).toBe(false);
        if (isDog(id)) return;
        // At most one loop at rest, and a slow one: nothing a person typing below would notice.
        const rest = running(idle);
        expect(rest.length).toBeLessThanOrEqual(1);
        for (const loop of rest) {
          for (const s of seconds(loop.animation)) expect(s).toBeGreaterThanOrEqual(15);
        }
      });

      it("holds still and muted while lost", () => {
        const svg = draw(id, "lost");
        expect(svg.classList.contains("cm-live")).toBe(false);
        const muted = svg.style.color.includes("--muted-foreground") || svg.classList.contains("grayscale");
        expect(muted).toBe(true);
        if (isDog(id)) return;
        expect(running(svg)).toEqual([]);
      });

      it("stops every animated class under reduced motion, and names every keyframe cm-", () => {
        const css = draw(id, "loading").querySelector("style")?.textContent ?? "";
        const reduce = /prefers-reduced-motion: reduce\)\{([^{]*)\{animation:none!important\}\}/.exec(css);
        expect(reduce).not.toBeNull();
        const stopped = (reduce?.[1] ?? "").split(",");
        const all = loops(css);
        expect(all.length).toBeGreaterThan(0);
        for (const { selector } of all) {
          // The class the rule animates is the last one of its selector.
          const last = selector.match(/\.[\w-]+/g)?.at(-1) ?? "";
          expect(stopped.some((s) => last.startsWith(s))).toBe(true);
        }
        // The header's rate ramp collects only animations whose name starts with `cm-`.
        for (const m of css.matchAll(/@keyframes ([\w-]+)/g)) expect(m[1]?.startsWith("cm-")).toBe(true);
      });

      it("uses no SMIL, no image and no foreign object", () => {
        for (const state of ["idle", "loading", "lost"] as const) {
          const svg = draw(id, state);
          expect(svg.querySelector("animate, animateTransform, animateMotion, set, image, foreignObject")).toBeNull();
          cleanup();
        }
      });
    });
  }
});

// THE ROUND WITH EVERY MARK. collie-home.tsx turns the mark for one round when a status lands. The
// ramp is written against the DOM, not the dog, so the same round must run and end with each mark
// in the header: live at once, still live one tick short of 1.8 s, at rest after it.
describe("the header round, with every mark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
    __resetOperatorBusy();
  });
  afterEach(() => {
    act(() => clearStatus());
    vi.useRealTimers();
    cleanup();
    setActiveTheme("collie");
  });

  for (const id of SHIPPED_MARKS) {
    it(`turns ${id} for one round and stops`, () => {
      act(() => setActiveTheme(id));
      const { container } = render(<CollieHome trouble={false} />);
      expect(markIsLive(container)).toBe(false);
      act(() => setStatus("claude is done", "success"));
      expect(markIsLive(container)).toBe(true);
      act(() => void vi.advanceTimersByTime(1799));
      expect(markIsLive(container)).toBe(true);
      act(() => void vi.advanceTimersByTime(1));
      expect(markIsLive(container)).toBe(false);
    });
  }
});
