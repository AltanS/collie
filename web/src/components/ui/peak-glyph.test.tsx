import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HillPriorityGlyph, HillPriorityMark } from "@/components/hill-priority";

import { PeakGlyph, type PeakCount } from "./peak-glyph";

// The three-peak glyph (M96): as many peaks filled as the level, readable without colour, one box for
// every level, named when it stands alone and hidden when words beside it say the level.

const filledOf = (svg: Element) => [...svg.querySelectorAll("path")].map((p) => p.getAttribute("data-peak"));

describe("the peak glyph", () => {
  it.each<[PeakCount, string[]]>([
    [3, ["filled", "filled", "filled"]],
    [2, ["filled", "filled", "empty"]],
    [1, ["filled", "empty", "empty"]],
  ])("fills %i of the three peaks, low to high", (filled, peaks) => {
    const { container } = render(<PeakGlyph filled={filled} />);
    const svg = container.querySelector("svg")!;
    expect(filledOf(svg)).toEqual(peaks);
    // The count is in the shape, not the colour: a filled peak is the caller's ink, an empty one the surface.
    for (const path of svg.querySelectorAll('[data-peak="filled"]')) expect(path.getAttribute("class")).toBe("fill-current");
    for (const path of svg.querySelectorAll('[data-peak="empty"]')) expect(path.getAttribute("class")).toBe("fill-card");
  });

  it("draws every level in the same box, so a change of level moves nothing", () => {
    const boxes = ([1, 2, 3] as const).map((n) => render(<PeakGlyph filled={n} />).container.querySelector("svg")!.getAttribute("class"));
    expect(new Set(boxes).size).toBe(1);
  });

  it("is an image with a name when it has a label", () => {
    const { getByRole } = render(<PeakGlyph filled={2} label="Today" />);
    expect(getByRole("img", { name: "Today" })).toHaveAttribute("data-filled", "2");
  });

  it("is hidden from a screen reader without one", () => {
    const { container } = render(<PeakGlyph filled={1} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
  });

  it("fills an empty peak with the surface it stands on", () => {
    const { container } = render(<PeakGlyph filled={1} surface="background" />);
    expect(container.querySelector('[data-peak="empty"]')?.getAttribute("class")).toBe("fill-background");
  });
});

describe("a Decision's priority as peaks", () => {
  it.each([
    ["now", "3", "Now", "text-status-working"],
    ["today", "2", "Today", "text-foreground"],
    ["later", "1", "Later", "text-muted-foreground"],
  ] as const)("draws %s with %s peaks, named %s, in its ink", (priority, filled, word, ink) => {
    const { getByRole } = render(<HillPriorityGlyph priority={priority} />);
    const glyph = getByRole("img", { name: word });
    expect(glyph).toHaveAttribute("data-filled", filled);
    expect(glyph.getAttribute("class")).toContain(ink);
  });

  it("names the mark once: the glyph carries the word, the visible word is for the eye", () => {
    const { container, getAllByRole } = render(<HillPriorityMark priority="now" />);
    expect(getAllByRole("img", { name: "Now" })).toHaveLength(1);
    expect(container.querySelector('[data-slot="decision-priority"] > span[aria-hidden="true"]')).toHaveTextContent("Now");
  });
});
