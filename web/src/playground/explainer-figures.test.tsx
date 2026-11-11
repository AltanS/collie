// The figures the website mounts: one per chapter, in chapter order, within the aspect the site reserves,
// still when not playing, with no timer left after unmount, and drawn from no playground fixture.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BLOCKS, FIGURE_NAMES, FIGURES, LIVE_FIGURES, RETIRED_FIGURE_NAMES } from "./explainer-figures";
import { TOUR_ASPECT } from "./tricks-explainer/place-explorer";
import { CHAPTERS } from "./tricks-explainer/chapter";

const HERE = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the explainer's figures", () => {
  it("name one figure per website chapter, in chapter order, and keep the retired ones drawing", () => {
    expect([...FIGURE_NAMES]).toEqual(CHAPTERS.filter((c) => c.site).map((c) => c.figure));
    expect(Object.keys(FIGURES).toSorted()).toEqual([...FIGURE_NAMES, ...RETIRED_FIGURE_NAMES].toSorted());
    for (const c of CHAPTERS) expect(Object.keys(FIGURES), c.key).toContain(c.figure);
  });

  it("write FIGURE_NAMES as a plain array literal, so the site can read it as text", () => {
    const text = readFileSync(join(HERE, "explainer-figures.tsx"), "utf8");
    const literal = /export const FIGURE_NAMES = \[([^\]]*)\] as const;/u.exec(text)?.[1] ?? "";
    const names = [...literal.matchAll(/"([a-z-]+)"/gu)].map((m) => m[1]);
    expect(names).toEqual([...FIGURE_NAMES]);
  });

  it("keep an aspect between 1 and 1.6, but for the places figure, a portrait phone", () => {
    expect(FIGURES["where-a-trick-can-show"].aspect).toBe(TOUR_ASPECT);
    expect(TOUR_ASPECT).toBeGreaterThan(0.55);
    for (const name of [...FIGURE_NAMES, ...RETIRED_FIGURE_NAMES]) {
      if (name === "where-a-trick-can-show") continue;
      const { aspect } = FIGURES[name];
      expect(aspect, name).toBeGreaterThanOrEqual(1);
      expect(aspect, name).toBeLessThanOrEqual(1.6);
    }
  });

  it("draw playing and still, and leave no timer behind", () => {
    vi.useFakeTimers();
    for (const name of [...FIGURE_NAMES, ...RETIRED_FIGURE_NAMES]) {
      for (const playing of [true, false]) {
        const { container, unmount } = render(<>{FIGURES[name].render({ playing })}</>);
        expect(container.textContent, name).not.toBe("");
        vi.advanceTimersByTime(10_000);
        unmount();
        expect(vi.getTimerCount(), `${name} playing=${String(playing)}`).toBe(0);
      }
    }
  });

  it("give the places figure a live twin that draws its chips", async () => {
    const Live = LIVE_FIGURES["where-a-trick-can-show"];
    const { findAllByRole } = render(<Live />);
    const chips = await findAllByRole("button", { pressed: false });
    expect(chips.length).toBeGreaterThan(0);
  });

  it("export the walk as a block: four steps, two columns from 640 px, no timer after unmount", () => {
    vi.useFakeTimers();
    const Walk = BLOCKS["gates-walk"];
    const { container, unmount } = render(<Walk />);
    expect(container.querySelectorAll("[data-slot='gates-walk'] > li")).toHaveLength(4);
    expect(container.querySelector("[data-slot='gates-walk']")?.className).toContain("@min-[640px]:grid-cols-2");
    expect(container.querySelector("[data-slot='gates-walk']")?.parentElement?.className).toContain("@container");
    vi.advanceTimersByTime(10_000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("import no playground fixture, directly or through the explainer's modules", () => {
    const files = [
      "explainer-figures.tsx",
      "tricks-explainer/map.tsx",
      "tricks-explainer/hues.tsx",
      "tricks-explainer/flows.ts",
      "tricks-explainer/place-ids.ts",
      "tricks-explainer/motion.ts",
      "tricks-explainer/place-explorer.tsx",
      "tricks-explainer/place-scenes.tsx",
      "tricks-explainer/place-data.ts",
      "tricks-explainer/place-world.ts",
      "tricks-explainer/morph.tsx",
    ];
    for (const file of files) {
      const text = readFileSync(join(HERE, file), "utf8");
      expect(text, file).not.toMatch(/from "[^"]*fixtures/u);
      expect(text, file).not.toMatch(/from "\.\.\/harness"/u);
      expect(text, file).not.toMatch(/from "\.\/(tricks-explainer\/)?real-places"/u);
    }
    const figures = readFileSync(join(HERE, "explainer-figures.tsx"), "utf8");
    expect(figures).not.toMatch(/from "\.\/tricks-explainer\/(?!map|hues|flows|place-ids|place-explorer|motion)/u);
  });
});
