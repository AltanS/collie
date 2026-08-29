import { render } from "@testing-library/react";

import { OneOf } from "./one-of";

const OPTIONS = [
  { key: "short", node: <span>done</span> },
  { key: "long", node: <span>needs you</span> },
  { key: "mid", node: <span>working</span> },
];

const layers = (c: HTMLElement) => [...c.querySelectorAll("[class*='grid-area']")];

describe("OneOf — one box, several alternatives, one shown", () => {
  it("keeps EVERY alternative mounted whichever one is active", () => {
    // The whole point. A box that renders only the active child is sized by that child, so the
    // thing beside it moves on every state change — DESIGN.md §2, and the bug this primitive was
    // extracted to close. Rendered together in one grid cell, the box is sized by the widest of
    // them and a swap is paint, not layout. jsdom has no layout, so what is asserted is the
    // structure that makes it true: three layers, in one cell, in every state.
    for (const active of ["short", "long", "mid"]) {
      const { container, unmount } = render(<OneOf active={active} options={OPTIONS} />);
      expect(layers(container)).toHaveLength(3);
      expect(container.textContent).toBe("doneneeds youworking");
      unmount();
    }
  });

  it("marks exactly one layer front and takes the losers out of BOTH trees", () => {
    const { container } = render(<OneOf active="long" options={OPTIONS} />);
    const front = layers(container).filter((l) => l.hasAttribute("data-active"));
    expect(front).toHaveLength(1);
    expect(front[0]).toHaveTextContent("needs you");
    expect(front[0]).toHaveClass("opacity-100");

    // `inert` AND `aria-hidden`. `inert` is the load-bearing one: a losing layer may hold a
    // focusable control, and hiding a focusable thing from the accessibility tree without also
    // taking it out of the tab order is the worse of the two bugs. `aria-hidden` rides along
    // because `inert` is younger than the oldest engine this PWA runs on.
    for (const loser of layers(container).filter((l) => !l.hasAttribute("data-active"))) {
      expect(loser).toHaveClass("opacity-0", "pointer-events-none");
      expect(loser).toHaveAttribute("inert");
      expect(loser).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("shows NONE of them for a null active, and still holds the box open", () => {
    // "Shows nothing" is a state too — a gone pane, on the composer's status band. Collapsing the
    // box there would slide the machine's name at the exact moment the pane died under you.
    const { container } = render(<OneOf active={null} options={OPTIONS} />);
    expect(layers(container)).toHaveLength(3);
    expect(layers(container).filter((l) => l.hasAttribute("data-active"))).toHaveLength(0);
    for (const layer of layers(container)) expect(layer).toHaveAttribute("inert");
  });

  it("states no opinion about alignment or tone — both are the caller's", () => {
    // Domain-blind, the way `ui/strip-host.tsx` is: the primitive owns the stacking and nothing
    // else. Where the reserved space falls is a fact about the strip, not about stacking, so the
    // box takes its display and its alignment from the call site, and every layer takes the same
    // transition so the two sides of a swap animate on the same terms.
    const { container } = render(
      <OneOf
        active="short"
        options={OPTIONS}
        className="inline-grid justify-items-end"
        layerClassName="transition-opacity"
      />,
    );
    // `inline-grid` REPLACES the default `grid` rather than stacking with it — tailwind-merge
    // resolves the display conflict, which is exactly why the default is a class and not a style.
    expect(container.firstElementChild).toHaveClass("inline-grid", "justify-items-end");
    expect(container.firstElementChild?.className).not.toMatch(/(?:^|\s)grid(?=\s|$)/);
    for (const layer of layers(container)) expect(layer).toHaveClass("transition-opacity");
  });
});
