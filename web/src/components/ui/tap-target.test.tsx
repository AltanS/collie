import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SectionHeader } from "@/components/section-header";
import { HEADER_PILL_TAP_TARGET, HEADING_TAP_TARGET, SQUARE_36_TAP_TARGET, SUMMARY_LINE_TAP_TARGET } from "./tap-target";

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
