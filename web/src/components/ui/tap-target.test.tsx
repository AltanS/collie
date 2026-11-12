import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SectionHeader } from "@/components/section-header";
import { Button } from "@/components/ui/button";
import { Fab } from "@/components/ui/fab";
import {
  HEADER_PILL_TAP_TARGET,
  HEADING_TAP_TARGET,
  PRESS_REACH,
  PRESS_REACH_ROW,
  PRESS_REACH_SOFT,
  SQUARE_36_TAP_TARGET,
  SUMMARY_LINE_TAP_TARGET,
} from "./tap-target";

// THE DASHBOARD'S FIVE SHORT TARGETS (hitbox proposal 6). jsdom has no layout, so it cannot measure a reach;
// that is `web/e2e/hitbox/reach.run.ts`, in a real engine. This pins the arithmetic each constant states and
// that the components wear it, so a class dropped in a refactor is red here before it is red on a phone.

describe("the reach constants", () => {
  it("states each reach as the pixels that bring its face to 44", () => {
    // 26px bordered pill: 24 padding box + 2 x 10 = 44, vertical only.
    expect(HEADER_PILL_TAP_TARGET).toContain("before:-inset-y-[10px]");
    expect(HEADER_PILL_TAP_TARGET).toContain("before:inset-x-0");
    // 32px line: 32 + 2 x 6 = 44. 36px heading: 36 + 2 x 4 = 44.
    expect(SUMMARY_LINE_TAP_TARGET).toContain("before:-inset-y-1.5");
    expect(HEADING_TAP_TARGET).toContain("before:-inset-y-1");
    // 36px square: 36 + 2 x 4 = 44 each way.
    expect(SQUARE_36_TAP_TARGET).toContain("before:-inset-1");
  });

  it("every reach is a transparent pseudo-element on a positioned button, never a size on the button", () => {
    for (const c of [HEADER_PILL_TAP_TARGET, HEADING_TAP_TARGET, SQUARE_36_TAP_TARGET, SUMMARY_LINE_TAP_TARGET]) {
      expect(c).toMatch(/^relative before:absolute /u);
      expect(c).toContain("before:content-['']");
    }
  });
});

describe("the controls that wear them", () => {
  it("a foldable section heading's button reaches 4px above and below", () => {
    render(<SectionHeader label="Spaces" open onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /Spaces/u }).className).toContain(HEADING_TAP_TARGET);
  });

  it("a heading that cannot fold has no button and so no reach", () => {
    render(<SectionHeader label="Pinned" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// A PRESS MAY NOT SHRINK THE HIT AREA (hitbox proposal 5). The reach exists only while pressed, so at rest nothing
// is there to cover a neighbour; the real-engine proof is `web/e2e/hitbox/press.run.ts`.
describe("the press reach", () => {
  it("exists only while the element is pressed: every class is an `active:` one", () => {
    for (const c of [PRESS_REACH, PRESS_REACH_ROW]) {
      for (const cls of c.split(" ")) expect(cls.startsWith("active:")).toBe(true);
      expect(c).toContain("active:before:content-['']");
    }
  });

  it("gives back at least what its scale takes: 3% for 95%, 1.5% for 98%, 1% sideways for 99%", () => {
    // A box scaled to s about its centre loses (1 - s) / 2 of its size at each edge.
    expect(PRESS_REACH).toContain("-inset-[3%]"); // 95%: 2.5% each side
    expect(PRESS_REACH_ROW).toContain("-inset-x-[1%]"); // 99%: 0.5% each side
    expect(PRESS_REACH_ROW).toContain("active:before:inset-y-0"); // never above or below: the next row's edge stays its own
  });

  it("the soft reach is a zero-specificity class, so a caller's reach is never beaten by it", () => {
    // `index.css` holds `.press-reach-soft:where(:active)::before { inset: -1.5% }` in the components layer. An
    // `active:before:` utility here would be (0,2,1) and shrink Send's `before:-inset-1` while pressed.
    expect(PRESS_REACH_SOFT).toBe("press-reach-soft");
    expect(PRESS_REACH_SOFT).not.toContain("active:");
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    expect(css).toMatch(/\.press-reach-soft:where\(:active\)::before\s*\{[^}]*inset:\s*-1\.5%/u);
    expect(css.slice(css.indexOf("@layer components"), css.indexOf(".press-reach-soft"))).not.toContain("@layer utilities");
  });

  it("the shared Button wears the soft reach", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" }).className).toContain(PRESS_REACH_SOFT);
  });

  it("the floating button wears the reach and no longer clips its own box", () => {
    render(<Fab label="New" onClick={() => {}} bottom="bottom-4" />);
    const fab = screen.getByRole("button", { name: "New" });
    expect(fab.className).toContain(PRESS_REACH);
    // A clip on the button would cut the reach off at the border; the label's fold is clipped one box in.
    expect(fab.className).not.toMatch(/(^| )overflow-hidden( |$)/u);
    expect(fab.firstElementChild?.className).toContain("overflow-hidden");
  });
});
