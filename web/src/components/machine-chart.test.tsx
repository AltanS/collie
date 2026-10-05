import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { FIXTURE_MACHINES_TS, fixtureMachineHistory } from "@/test/machine-fixtures";

import type { MachineHistoryPoint } from "@/lib/types";

import { MachineChart } from "./machine-chart";

// The charts are drawn from the day of history in the fixtures: a thirty-minute hole 300 minutes ago (a
// restart) and a ten-minute stretch with no network counters 60 minutes ago.

const TS = FIXTURE_MACHINES_TS;
const day = fixtureMachineHistory();

function lines(container: HTMLElement, series: string): SVGPathElement[] {
  return [...container.querySelectorAll<SVGPathElement>(`path[data-series="${series}"]`)];
}

/** How many subpaths a path's `d` holds. */
function subpaths(path: SVGPathElement): number {
  return (path.getAttribute("d")?.match(/M/g) ?? []).length;
}

describe("MachineChart gaps", () => {
  it("draws the restart as a gap in the 24 hour view, not as a line across it", () => {
    const { container } = render(
      <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="day" />,
    );
    // Two runs: before the hole and after it. The average and the peak break at the same place.
    expect(lines(container, "avg")).toHaveLength(2);
    expect(lines(container, "peak")).toHaveLength(2);
    for (const run of lines(container, "avg")) expect(subpaths(run)).toBe(1);
  });

  it("draws one unbroken line in the last hour, where nothing is missing", () => {
    const { container } = render(
      <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />,
    );
    expect(lines(container, "avg")).toHaveLength(1);
  });

  it("breaks the network lines where the counters are null, and keeps the CPU whole", () => {
    const { container } = render(
      <MachineChart kind="net" points={day.points} ts={TS} stepMs={day.stepMs} range="day" />,
    );
    // The restart AND the counterless stretch: three runs per direction.
    expect(lines(container, "rx")).toHaveLength(3);
    expect(lines(container, "tx")).toHaveLength(3);
  });

  it("closes a band between the average and the peak only where both exist", () => {
    const { container } = render(
      <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="day" />,
    );
    expect(container.querySelectorAll('path[data-series="band"]')).toHaveLength(2);
  });
});

describe("MachineChart threshold", () => {
  const dashedY = (container: HTMLElement) =>
    Number(container.querySelector('line[data-series="threshold"]')?.getAttribute("y1"));

  it("draws no alert line when no rule is set", () => {
    const { container } = render(
      <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />,
    );
    expect(container.querySelector('line[data-series="threshold"]')).toBeNull();
  });

  it("draws a dashed line that sits higher for a higher threshold", () => {
    const at = (threshold: number) => {
      const { container, unmount } = render(
        <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={threshold} />,
      );
      const y = dashedY(container);
      expect(container.querySelector('line[data-series="threshold"]')?.getAttribute("stroke-dasharray")).toBeTruthy();
      unmount();
      return y;
    };
    // SVG y grows downwards: a bigger threshold is a smaller y.
    expect(at(0.95)).toBeLessThan(at(0.9));
    expect(at(0.9)).toBeLessThan(at(0.8));
  });

  it("puts the line on the same y axis the percent labels use (0 to 100%)", () => {
    const { container } = render(
      <MachineChart kind="mem" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.5} />,
    );
    const labels = [...container.querySelectorAll("svg > g text")].map((n) => n.textContent);
    expect(labels).toEqual(expect.arrayContaining(["0%", "50%", "100%"]));
    // 50% is the middle of the plot, and so is the gridline labelled 50%.
    const lineY = dashedY(container);
    const mid = [...container.querySelectorAll("svg > g")].find((g) => g.textContent === "50%")?.querySelector("line");
    expect(lineY).toBe(Number(mid?.getAttribute("y1")));
  });

  it("never draws one on the network chart", () => {
    const { container } = render(
      <MachineChart kind="net" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />,
    );
    expect(container.querySelector('line[data-series="threshold"]')).toBeNull();
  });
});

describe("MachineChart disk", () => {
  it("draws the fullest disk's fraction on the percent scale, with its threshold and legend", () => {
    const { container } = render(
      <MachineChart kind="disk" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />,
    );
    expect(lines(container, "avg")).toHaveLength(1);
    expect(container.querySelector('line[data-series="threshold"]')).not.toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Disk, last hour: now 66%/);
    expect(screen.getByText("Fullest disk")).toBeInTheDocument();
  });

  it("says the machine reports no disk when its minutes carry none, and an older bridge's six-value points read the same", () => {
    const sixes = day.points.map((p): MachineHistoryPoint => [p[0], p[1], p[2], p[3], p[4], p[5]]);
    render(<MachineChart kind="disk" points={sixes} ts={TS} stepMs={day.stepMs} range="hour" />);
    expect(screen.getByText("This machine reports no disk usage.")).toBeInTheDocument();
  });
});

describe("MachineChart words", () => {
  it("names the chart in one sentence: metric, range, now, average and peak", () => {
    render(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />);
    const chart = screen.getByRole("img");
    const name = chart.getAttribute("aria-label") ?? "";
    expect(name).toMatch(/^CPU, last hour: now \d+%, average \d+%, peak \d+%\./);
    expect(name).toContain("Alert line at 90%.");
  });

  it("says the range it was given", () => {
    render(<MachineChart kind="mem" points={day.points} ts={TS} stepMs={day.stepMs} range="day" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Memory, last 24 hours");
  });

  it("names every mark in a legend, so colour is never the only carrier", () => {
    render(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />);
    expect(screen.getByText("Average")).toBeInTheDocument();
    expect(screen.getByText("Peak")).toBeInTheDocument();
    expect(screen.getByText("Alert at 90%")).toBeInTheDocument();
  });

  it("labels the x axis with how far back each tick is", () => {
    const { container } = render(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />);
    const texts = [...container.querySelectorAll("svg text")].map((n) => n.textContent);
    expect(texts).toEqual(expect.arrayContaining(["60 min ago", "30 min ago", "now"]));
  });

  it("scales the network axis with a unit", () => {
    const { container } = render(<MachineChart kind="net" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />);
    const texts = [...container.querySelectorAll("svg text")].map((n) => n.textContent ?? "");
    expect(texts.some((x) => x.endsWith("KB/s"))).toBe(true);
    expect(texts).toContain("0 B/s");
  });
});

describe("MachineChart with nothing to draw", () => {
  it("says so in a box instead of drawing an empty plot", () => {
    render(<MachineChart kind="cpu" points={[]} ts={TS} stepMs={60_000} range="hour" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("No readings in this range yet.")).toBeInTheDocument();
  });

  it("says a machine has no network counters when every value is null", () => {
    const quiet = fixtureMachineHistory({ network: false });
    render(<MachineChart kind="net" points={quiet.points} ts={TS} stepMs={60_000} range="hour" />);
    expect(screen.getByText("This machine reports no network counters.")).toBeInTheDocument();
  });

  it("keeps a lone minute visible as a dot", () => {
    const lone = [[TS - 60_000, 0.4, 0.5, 0.3, null, null]] satisfies [number, number, number, number, null, null][];
    const { container } = render(<MachineChart kind="mem" points={lone} ts={TS} stepMs={60_000} range="hour" />);
    const [path] = lines(container, "avg");
    expect(path?.getAttribute("stroke-linecap")).toBe("round");
    expect(path?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  });
});

describe("MachineChart alert label", () => {
  const label = (container: HTMLElement) => container.querySelector<SVGGElement>('[data-slot="threshold-label"]');

  it("sits on a plate of the card's own colour, with the label's words, above the dashed line", () => {
    const { container } = render(
      <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.8} />,
    );
    const g = label(container)!;
    expect(g.textContent).toBe("80%");
    expect(g.getAttribute("data-side")).toBe("above");
    const plate = g.querySelector("rect")!;
    expect(plate.getAttribute("class")).toContain("fill-card");
    const lineY = Number(container.querySelector('line[data-series="threshold"]')?.getAttribute("y1"));
    expect(Number(plate.getAttribute("y")) + Number(plate.getAttribute("height"))).toBeLessThan(lineY);
    // Anchored at the right end of the plot.
    expect(Number(plate.getAttribute("x")) + Number(plate.getAttribute("width"))).toBe(360 - 8);
  });

  it("flips under the line when it is near the top of the plot", () => {
    const { container } = render(
      <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />,
    );
    const g = label(container)!;
    expect(g.getAttribute("data-side")).toBe("below");
    const lineY = Number(container.querySelector('line[data-series="threshold"]')?.getAttribute("y1"));
    expect(Number(g.querySelector("rect")?.getAttribute("y"))).toBeGreaterThan(lineY);
  });

  it("keeps the legend entry that names the line", () => {
    render(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />);
    expect(screen.getByText("Alert at 90%")).toBeTruthy();
  });
});

describe("MachineChart size", () => {
  it("is drawn at the column's own pixel width, so one unit is one pixel and the 10px text stays 10px", () => {
    // SAFETY: the chart reads only `width` off the rect, and jsdom has no layout to answer with.
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 788 } as DOMRect);
    try {
      const { container } = render(
        <MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" threshold={0.9} />,
      );
      const svg = container.querySelector("svg[data-kind]")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 788 200");
      expect(svg.getAttribute("width")).toBe("788");
      expect(svg.getAttribute("height")).toBe("200");
      for (const text of svg.querySelectorAll("text")) expect(text.getAttribute("font-size")).toBe("10");
    } finally {
      spy.mockRestore();
    }
  });

  it("without a measured column it keeps the phone shape", () => {
    const { container } = render(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />);
    expect(container.querySelector("svg[data-kind]")?.getAttribute("viewBox")).toBe("0 0 360 150");
  });

  it("draws once when its props do not change: a poll tick re-renders the page, not the chart", () => {
    const spy = vi.spyOn(Array.prototype, "filter");
    try {
      const { rerender } = render(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />);
      const before = spy.mock.calls.length;
      rerender(<MachineChart kind="cpu" points={day.points} ts={TS} stepMs={day.stepMs} range="hour" />);
      // `pointsInRange` filters the history on every draw; no filter call means no draw.
      expect(spy.mock.calls.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
