import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SHIPPED_MARKS, type ShippedMark } from "@/lib/shipped-marks";
import { markPaper } from "@/test/collie-mark";

import { CollieMarkAdapter } from "./collie";
import { MARKS, type MarkState } from "./index";

// THE MARK CONTRACT, for every entry of the registry (M57 spec 10). contract.ts says what a mark is;
// this file holds each shipped mark to it. jsdom runs no CSS animation and has no `getAnimations`, so
// the motion is checked statically: the mark's own <style> is read into its top-level rules, and a
// rule "runs" in a state when it sets an `animation` and its selector matches an element of the mark
// drawn in that state. That is the question a browser asks, minus the clock.
//
// THE DOG'S SEALED BEHAVIOUR. collie-mark.tsx is generated and hash-sealed. It keeps its 48 s drift at
// rest AND when lost (the adapter greys it; it cannot stop the orbit without editing the sealed file).
// So for an id the dog draws, "lost runs nothing" is read as "lost runs only slow loops, under the
// grey filter". Every other mark meets the strict rule.

const STATES: readonly MarkState[] = ["idle", "loading", "lost"];

/** The slowest a resting loop may be: 10 s. The dog's fastest resting part takes 17.8 s. */
const SLOW_MS = 10_000;

const isDog = (id: ShippedMark): boolean => MARKS[id] === CollieMarkAdapter;

interface Rule {
  selector: string;
  body: string;
}

interface Sheet {
  plain: Rule[];
  reduce: Rule[];
}

/**
 * The top-level rules of a stylesheet, `@keyframes` dropped, and apart from them the rules inside a
 * `prefers-reduced-motion: reduce` block.
 */
function rules(css: string): Sheet {
  const plain: Rule[] = [];
  const reduce: Rule[] = [];
  const block = (from: number) => {
    let depth = 0;
    for (let j = from; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) return { inner: css.slice(from + 1, j), end: j + 1 };
    }
    throw new Error("unbalanced stylesheet");
  };
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prelude = css.slice(i, open).trim();
    const { inner, end } = block(open);
    i = end;
    if (prelude.startsWith("@keyframes")) continue;
    if (prelude.startsWith("@media")) {
      if (prelude.includes("prefers-reduced-motion: reduce")) reduce.push(...rules(inner).plain);
      continue;
    }
    plain.push({ selector: prelude, body: inner });
  }
  return { plain, reduce };
}

/** The `animation` shorthand of a rule, or null when it has none or it is `none`. */
function animationOf(body: string): string | null {
  const decl = /(?:^|;)\s*animation\s*:([^;]*)/.exec(body);
  if (decl === null) return null;
  const value = (decl[1] ?? "").trim();
  return value.startsWith("none") ? null : value;
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
 * The duration in ms of each animation in a shorthand, resolving `var()` against `el` (the dog sets
 * its drift through custom properties) and a `calc()` of products and quotients. NaN when a part
 * cannot be resolved, which fails the caller's check.
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
  el: Element;
  durations: number[];
}

interface Drawn {
  svg: SVGSVGElement;
  css: string;
  running: Running[];
  /** The selectors inside the reduced-motion block that set `animation: none`. */
  stopped: string[];
}

function draw(id: ShippedMark, state: MarkState): Drawn {
  const Mark = MARKS[id];
  const { container } = render(<Mark size={40} weight="header" state={state} paper="var(--card)" />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error(`${id} drew no svg`);
  const css = svg.querySelector("style")?.textContent ?? "";
  const { plain, reduce } = rules(css);
  const nodes = [svg, ...svg.querySelectorAll("*")];
  const running: Running[] = [];
  for (const rule of plain) {
    const animation = animationOf(rule.body);
    if (animation === null) continue;
    for (const selector of rule.selector.split(",").map((s) => s.trim())) {
      for (const el of nodes.filter((node) => node.matches(selector))) {
        running.push({ selector, el, durations: durationsMs(animation, el) });
      }
    }
  }
  const stopped = reduce.filter((r) => /animation\s*:\s*none/.test(r.body)).map((r) => r.selector);
  return { svg, css, running, stopped };
}

describe("the mark contract, over the registry", () => {
  afterEach(() => cleanup());

  for (const id of SHIPPED_MARKS) {
    describe(id, () => {
      it("draws one svg of its size, nothing beside it, in every state", () => {
        const Mark = MARKS[id];
        for (const state of STATES) {
          const { container } = render(<Mark size={24} state={state} weight="header" />);
          expect(container.children).toHaveLength(1);
          const svg = container.firstElementChild;
          expect(svg?.tagName.toLowerCase()).toBe("svg");
          expect(svg?.getAttribute("width")).toBe("24");
          expect(svg?.getAttribute("height")).toBe("24");
          expect(svg?.getAttribute("role")).toBe("presentation");
          cleanup();
        }
      });

      it("is an image with a name when it has a title", () => {
        const Mark = MARKS[id];
        const { container } = render(<Mark size={40} title="Collie" />);
        const svg = container.querySelector("svg");
        expect(svg?.getAttribute("role")).toBe("img");
        // The dog names itself on `aria-label` (its file is sealed); the new marks carry a <title>.
        const name = svg?.getAttribute("aria-label") ?? svg?.querySelector(":scope > title")?.textContent;
        expect(name).toBe("Collie");
      });

      it("forwards className and hands paper to the knockout in every state", () => {
        const Mark = MARKS[id];
        for (const state of STATES) {
          const { container } = render(<Mark size={40} state={state} className="probe-class" paper="var(--muted)" />);
          expect(container.querySelector("svg")?.classList.contains("probe-class")).toBe(true);
          expect(markPaper(container)).toBe("var(--muted)");
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

      it("uses CSS keyframes in its own style only, named cm- for the rate ramp", () => {
        const { svg, css } = draw(id, "loading");
        expect(svg.querySelector("animate, animateTransform, animateMotion, set, image, foreignObject")).toBeNull();
        const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) expect(name?.startsWith("cm-"), name).toBe(true);
      });

      it("carries cm-live on the root while loading, and only then", () => {
        for (const state of STATES) {
          expect(draw(id, state).svg.classList.contains("cm-live"), state).toBe(state === "loading");
          cleanup();
        }
      });

      it("animates at least five distinct selectors while loading", () => {
        // The static stand-in for `getAnimations({ subtree: true })`, which jsdom lacks.
        const selectors = new Set(draw(id, "loading").running.map((r) => r.selector));
        expect(selectors.size).toBeGreaterThanOrEqual(5);
      });

      it("rests slowly: every loop at rest takes 10 s or more", () => {
        for (const r of draw(id, "idle").running) {
          for (const ms of r.durations) expect(ms, r.selector).toBeGreaterThanOrEqual(SLOW_MS);
        }
      });

      if (isDog(id)) {
        it("when lost, drifts only slowly under the grey filter (the sealed dog)", () => {
          const { svg, running } = draw(id, "lost");
          for (const r of running) for (const ms of r.durations) expect(ms, r.selector).toBeGreaterThanOrEqual(SLOW_MS);
          expect(svg.classList.contains("grayscale")).toBe(true);
        });
      } else {
        it("holds still when lost, in the muted ink", () => {
          const { svg, running } = draw(id, "lost");
          expect(running.map((r) => r.selector)).toEqual([]);
          expect(svg.style.color).toBe("var(--muted-foreground)");
        });

        it("stays under 40,960 bytes of source", () => {
          const bytes = readFileSync(join(import.meta.dirname, `${id}.tsx`)).byteLength;
          expect(bytes).toBeLessThan(40_960);
        });
      }

      it("stops every animated element under prefers-reduced-motion", () => {
        for (const state of STATES) {
          const { running, stopped } = draw(id, state);
          if (running.length > 0) expect(stopped.length, state).toBeGreaterThan(0);
          const all = stopped.join(",");
          for (const r of running) expect(r.el.matches(all), `${state} ${r.selector}`).toBe(true);
          cleanup();
        }
      });
    });
  }
});
