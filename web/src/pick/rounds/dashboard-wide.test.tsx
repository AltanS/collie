import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { wordCount } from "../types";
import ROUND from "./dashboard-wide";

// The large-screen dashboard round, drawn the way the design app's round page draws it: four numbered
// options, each the real Space sections on the twelve-Space herd. The round asks for the wide frame; the
// screen measures its box, and jsdom has no layout, so it falls back to the case's own screen width.

afterEach(cleanup);

async function draw(n: number, caseId: string): Promise<HTMLElement> {
  const option = ROUND.options.find((o) => o.n === n)!;
  const { container } = render(<>{option.render(caseId)}</>);
  const screen = await waitFor(() => {
    const el = container.querySelector<HTMLElement>(`[data-state="${option.state!}"]`);
    expect(el).not.toBeNull();
    return el!;
  });
  return screen;
}

describe("the large-screen dashboard round", () => {
  it("has four options of at most five words, each with a state, and opens on twelve Spaces", () => {
    expect(ROUND.options.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    for (const o of ROUND.options) {
      expect(wordCount(o.label)).toBeLessThanOrEqual(5);
      expect(o.state).toMatch(/^dashboard-wide-/);
    }
    expect(ROUND.cases[0]!.id).toBe("twelve");
  });

  it("asks the design app for the wide frame and draws no scale or Actual size switch", async () => {
    expect(ROUND.frame).toBe("wide");
    const screen = await draw(1, "twelve");
    expect(screen.closest("[style*='scale']")).toBeNull();
    expect(screen.textContent).not.toContain("Actual size");
    expect(screen.parentElement!.textContent).toContain("3 columns");
  });

  it("draws every Space once, in the list's order, in every option", async () => {
    for (const n of [1, 2, 3, 4]) {
      const screen = await draw(n, "twelve");
      const labels = [...screen.querySelectorAll("[data-space]")].map((el) => el.getAttribute("data-space")!.split("\u0000").at(-1));
      expect(labels, `option ${n}`).toHaveLength(12);
      if (n !== 2) expect(labels, `option ${n}`).toEqual(Array.from({ length: 12 }, (_, i) => `w${i + 1}`));
      cleanup();
    }
  });

  it("sets three columns of 384px at 1280 and four at 1920 in the row grid", async () => {
    const at1280 = await draw(1, "twelve");
    expect(at1280.querySelector<HTMLElement>('[data-slot="wide-rows"]')!.style.gridTemplateColumns).toBe("repeat(3, 384px)");
    cleanup();
    const at1920 = await draw(1, "twelve-1920");
    expect(at1920.querySelector<HTMLElement>('[data-slot="wide-rows"]')!.style.gridTemplateColumns).toBe("repeat(4, 384px)");
  });

  it("deals the Spaces of option 2 by their place: Space 4 under Space 1", async () => {
    const screen = await draw(2, "twelve");
    const columns = [...screen.querySelector('[data-slot="wide-columns"]')!.children];
    expect(columns).toHaveLength(3);
    const first = [...columns[0]!.querySelectorAll("[data-space]")].map((el) => el.getAttribute("data-space")!.split("\u0000").at(-1));
    expect(first).toEqual(["w1", "w4", "w7", "w10"]);
  });

  it("gathers the six sessions that wait on the person in option 4, and draws no band when nothing does", async () => {
    const busy = await draw(4, "twelve");
    // Three blocked and three finished unseen, in the list's order: collie, example-api ×2, infra, mobile-app, docs-site.
    expect(busy.querySelector('[data-slot="wide-waiting"]')!.querySelectorAll('[data-slot="agent-row-title"]')).toHaveLength(6);
    cleanup();
    const calm = await draw(4, "calm");
    expect(calm.querySelector('[data-slot="wide-waiting"]')).toBeNull();
  });

  it("puts the pinned sessions in a band above the Spaces, and the machine's name over each run of a crew", async () => {
    const pinned = await draw(1, "pinned");
    expect(pinned.querySelector('[data-slot="wide-pinned"]')).not.toBeNull();
    cleanup();
    const crew = await draw(1, "crew");
    expect(crew.querySelectorAll('[data-slot="wide-rows"]')).toHaveLength(2);
  });

  it("draws the phone's first-start card when the herd is empty", async () => {
    const screen = await draw(1, "empty");
    expect(screen.querySelector("[data-space]")).toBeNull();
    expect(screen.querySelectorAll("button").length).toBeGreaterThan(0);
  });
});
