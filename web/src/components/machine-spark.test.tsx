import { render } from "@testing-library/react";

import { MachineSpark, sparkRuns } from "./machine-spark";

// The half-hour spark on a machine card: a fixed 0..100 % scale, the minutes against the right edge,
// a gap for a missing minute, and the reading now as a dot at the edge.

describe("sparkRuns", () => {
  it("puts the newest minute one slot before the right edge, and the reading now on it", () => {
    const runs = sparkRuns([0, 1], 2, 0.5);
    // Two slots: minute 0 at x 0, minute 1 at x 50, the reading now at x 100.
    expect(runs).toEqual([
      [
        [0, 30.5],
        [50, 1.5],
        [100, 16],
      ],
    ]);
  });

  it("draws a short history against the right edge, not stretched across", () => {
    const [run] = sparkRuns([0.5, 0.5], 30);
    expect(run?.[0]?.[0]).toBeCloseTo((28 / 30) * 100, 0);
  });

  it("breaks the line at a missing minute", () => {
    const runs = sparkRuns([0.2, null, 0.4, 0.4], 4);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(1);
    expect(runs[1]).toHaveLength(2);
  });

  it("keeps the newest minutes when given more than it spans", () => {
    const runs = sparkRuns([0.9, 0.1, 0.1], 2);
    expect(runs[0]).toHaveLength(2);
    expect(runs[0]?.[0]?.[1]).toBeCloseTo(27.6, 1);
  });

  it("clamps a value outside 0..1 to the box", () => {
    const [run] = sparkRuns([2, -1], 2);
    expect(run?.[0]?.[1]).toBe(1.5);
    expect(run?.[1]?.[1]).toBe(30.5);
  });
});

describe("MachineSpark", () => {
  it("is one image with the sentence it was given, and a dashed line only when a rule is set", () => {
    const { container, rerender } = render(
      <MachineSpark values={[0.1, 0.2]} minutes={30} now={0.3} tone="normal" label="CPU, now 30%" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "CPU, now 30%");
    expect(svg.querySelector('[data-series="threshold"]')).toBeNull();
    rerender(<MachineSpark values={[0.1, 0.2]} minutes={30} now={0.3} threshold={0.9} tone="normal" label="CPU, now 30%" />);
    expect(svg.querySelector('[data-series="threshold"]')).not.toBeNull();
  });

  it("draws the floor and no line when it has no minute and no reading", () => {
    const { container } = render(<MachineSpark values={[]} minutes={30} tone="quiet" label="CPU" />);
    expect(container.querySelector('[data-series="line"]')).toBeNull();
    expect(container.querySelector('[data-series="now"]')).toBeNull();
    expect(container.querySelectorAll("line")).toHaveLength(1);
  });

  it("is memoised, so a poll that brings the same minutes draws nothing", () => {
    expect(MachineSpark).toHaveProperty("$$typeof", Symbol.for("react.memo"));
  });
});
