import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SHIPPED_MARKS } from "@/lib/shipped-marks";
import { markPaper } from "@/test/collie-mark";

import { CollieMarkAdapter } from "./collie";
import { MARKS, type MarkState } from "./index";

// THE MARK CONTRACT, for every entry of the registry (M57 spec 10). marks/contract.ts says what a mark
// is; this holds every shipped mark to it. jsdom has no `getAnimations`, so motion is checked
// statically: the mark's own `<style>` is read, every rule that sets `animation` is found, and its
// selector is run against the rendered state. That tells which elements move in which state, and
// whether the reduced-motion rule reaches each of them.
//
// The dog (and any id that still draws it through the adapter) is held to the parts its sealed,
// generated file can meet. Its rest is the 48 s drift through custom properties, which a static read
// cannot time, and its lost state is the old grey dog over that drift. Both predate the contract;
// the new marks meet the stricter rule.

const STATES: readonly MarkState[] = ["idle", "loading", "lost"];

interface Rule {
  selector: string;
  body: string;
}

/** The top-level rules of a stylesheet, with `@keyframes` dropped and `@media` blocks kept apart. */
function rules(css: string) {
  const plain: Rule[] = [];
  const reduce: Rule[] = [];
  let i = 0;
  const block = (from: number) => {
    let depth = 0;
    for (let j = from; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) return { inner: css.slice(from + 1, j), end: j + 1 };
      }
    }
    throw new Error("unbalanced stylesheet");
  };
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

const animates = (body: string) => /(^|;)\s*animation\s*:(?!\s*none)/.test(body);

function draw(id: (typeof SHIPPED_MARKS)[number], state: MarkState) {
  const Mark = MARKS[id];
  const { container } = render(<Mark size={40} weight="header" state={state} paper="var(--card)" />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("no svg");
  const css = svg.querySelector("style")?.textContent ?? "";
  const { plain, reduce } = rules(css);
  const animated = plain.filter((r) => animates(r.body));
  const moving = new Set<Element>();
  const durations: string[] = [];
  for (const r of animated) {
    const hits = [...container.querySelectorAll(r.selector)];
    for (const el of hits) moving.add(el);
    if (hits.length > 0) durations.push(r.body);
  }
  const stopped = reduce.filter((r) => /animation\s*:\s*none/.test(r.body)).map((r) => r.selector);
  return { container, svg, css, moving, durations, stopped };
}

/** Every literal duration in the `animation` declarations of the given rule bodies, in seconds. */
function seconds(bodies: string[]): number[] {
  const out: number[] = [];
  for (const body of bodies) {
    const decl = /animation\s*:([^;]*)/.exec(body)?.[1] ?? "";
    for (const part of decl.split(",")) {
      const m = /(?:^|\s)(\d*\.?\d+)(m?s)(?:\s|$)/.exec(part.trim());
      if (m !== null) out.push(Number(m[1]) / (m[2] === "ms" ? 1000 : 1));
    }
  }
  return out;
}

describe("the mark contract, over the registry", () => {
  afterEach(() => cleanup());

  for (const id of SHIPPED_MARKS) {
    const dog = MARKS[id] === CollieMarkAdapter;

    describe(id, () => {
      for (const state of STATES) {
        it(`draws one svg of its size, nothing beside it, while ${state}`, () => {
          const Mark = MARKS[id];
          const { container } = render(<Mark size={24} state={state} weight="header" />);
          expect(container.children).toHaveLength(1);
          const svg = container.firstElementChild;
          expect(svg?.tagName.toLowerCase()).toBe("svg");
          expect(svg?.getAttribute("width")).toBe("24");
          expect(svg?.getAttribute("height")).toBe("24");
          expect(svg?.getAttribute("role")).toBe("presentation");
        });
      }

      it("is an image with a name when it has a title", () => {
        const Mark = MARKS[id];
        const { container } = render(<Mark size={40} title="Collie" />);
        const svg = container.querySelector("svg");
        expect(svg?.getAttribute("role")).toBe("img");
        // The dog names itself on `aria-label` (its file is sealed); the new marks carry a <title>.
        const name = svg?.getAttribute("aria-label") ?? svg?.querySelector(":scope > title")?.textContent;
        expect(name).toBe("Collie");
      });

      it("forwards className and puts paper on the knockout", () => {
        const Mark = MARKS[id];
        const { container } = render(<Mark size={40} className="probe-class" paper="var(--muted)" />);
        expect(container.querySelector("svg")?.classList.contains("probe-class")).toBe(true);
        expect(markPaper(container)).toBe("var(--muted)");
      });

      it("carries cm-live on the root while loading, and only then", () => {
        for (const state of STATES) {
          const { svg } = draw(id, state);
          expect(svg.classList.contains("cm-live")).toBe(state === "loading");
          cleanup();
        }
      });

      it("uses CSS keyframes inside its own style only, named for the rate ramp", () => {
        const { svg, css } = draw(id, "loading");
        expect(svg.querySelector("animate, animateTransform, animateMotion, set, image")).toBeNull();
        const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) expect(name.startsWith("cm-")).toBe(true);
      });

      it("moves at least five separate elements while loading", () => {
        // The static stand-in for `getAnimations({ subtree: true })`, which jsdom lacks.
        expect(draw(id, "loading").moving.size).toBeGreaterThanOrEqual(5);
      });

      it("stops every moving element under prefers-reduced-motion", () => {
        for (const state of STATES) {
          const { moving, stopped } = draw(id, state);
          if (moving.size > 0) expect(stopped.length).toBeGreaterThan(0);
          const all = stopped.join(",");
          for (const el of moving) expect(el.matches(all)).toBe(true);
          cleanup();
        }
      });

      if (!dog) {
        it("rests slowly: at most two parts move at rest, none on a loop under 6 s", () => {
          const { moving, durations } = draw(id, "idle");
          expect(moving.size).toBeLessThanOrEqual(2);
          const secs = seconds(durations);
          expect(secs.length).toBe(durations.length);
          for (const s of secs) expect(s).toBeGreaterThanOrEqual(6);
        });

        it("holds still when lost, in the muted ink", () => {
          const { moving, svg } = draw(id, "lost");
          expect(moving.size).toBe(0);
          expect(svg.style.color).toBe("var(--muted-foreground)");
        });

        it("stays under 40,960 bytes of source", () => {
          const bytes = readFileSync(join(import.meta.dirname, `${id}.tsx`)).byteLength;
          expect(bytes).toBeLessThan(40_960);
        });
      } else {
        it("greys out when lost (the dog's lost look)", () => {
          const { svg } = draw(id, "lost");
          expect(svg.classList.contains("grayscale")).toBe(true);
        });
      }
    });
  }
});
