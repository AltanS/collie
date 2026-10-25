import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatCost, hasFigure, hasGauge, ModelTag } from "./model-tag";

describe("ModelTag", () => {
  it("draws the short model name, named for a screen reader, and takes no touch", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    // The eye reads the short name; the screen reader reads the sentence from the dictionary.
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5");
    expect(tag?.className).toContain("pointer-events-none");
    // Absolute and owning no line, so it arriving or leaving moves nothing (DESIGN.md §2).
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("draws the effort after the model, in the harness's own word, for the eye and the screen reader", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · high");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5 · high");
  });

  it("an empty or hostile effort draws the model alone, and an effort never draws without a model", () => {
    const alone = (effort: string | undefined) =>
      render(<ModelTag model="claude-opus-5-5" effort={effort} />).container.querySelector("[aria-hidden]")?.textContent;
    expect(alone(undefined)).toBe("Opus 5.5");
    expect(alone("  ")).toBe("Opus 5.5");
    expect(alone("\u001b[31m\u0007")).toBe("Opus 5.5");
    expect(alone(`  ${"x".repeat(40)} `)).toBe(`Opus 5.5 · ${"x".repeat(15)}…`);
    expect(render(<ModelTag model={undefined} effort="high" />).container.innerHTML).toBe("");
  });

  it("draws nothing at all without a model", () => {
    expect(render(<ModelTag model={undefined} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model="  " />).container.innerHTML).toBe("");
  });
});

describe("ModelTag usage dots", () => {
  const usage = { context: 42, limits: [{ window: "5h" as const, used: 58 }, { window: "7d" as const, used: 81 }] };

  it("draws a gauge per reported number after the model, five dots each, and says the figures", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" usage={usage} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · highctx5h7d");
    const gauges = [...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"));
    expect(gauges).toEqual(["context", "5h", "7d"]);
    const dots = [...container.querySelectorAll("[data-slot='usage-dots']")];
    expect(dots.map((d) => d.getAttribute("data-lit"))).toEqual(["2", "2", "4"]);
    expect(dots.every((d) => d.children.length === 5)).toBe(true);
    // 80% and up takes the working colour; under it does not.
    expect(dots.map((d) => d.hasAttribute("data-warn"))).toEqual([false, false, true]);
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(
      "Model Opus 5.5 · high. Context 42% used. 5-hour limit 58% used. 7-day limit 81% used",
    );
    // Still absolute and still no touch with the dots in it (DESIGN.md §2).
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).toContain("pointer-events-none");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("draws the dots alone while the screen names the model, and only the gauges reported", () => {
    const { container } = render(<ModelTag model={undefined} effort="high" usage={{ context: 7 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("ctx");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Context 7% used");
  });

  it("skips a window this build does not know, and draws nothing for an empty reading", () => {
    // SAFETY: a newer bridge may send a window this build has no label for; the test sends one on purpose.
    const strange = { limits: [{ window: "30d" as "7d", used: 50 }] };
    expect(render(<ModelTag model={undefined} usage={strange} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model={undefined} usage={{}} />).container.innerHTML).toBe("");
  });

  it("lights one dot per full fifth, so only 100% lights the fifth", () => {
    const lit = (context: number) =>
      render(<ModelTag model={undefined} usage={{ context }} />).container.querySelector("[data-slot='usage-dots']")?.getAttribute("data-lit");
    // One dot per FULL fifth: only a full window lights the fifth dot.
    expect(lit(0)).toBe("0");
    expect(lit(19)).toBe("0");
    expect(lit(20)).toBe("1");
    expect(lit(81)).toBe("4");
    expect(lit(99)).toBe("4");
    expect(lit(100)).toBe("5");
  });
});

// The caller keeps the model beside the dots while the screen names it, so "a gauge to draw" is one
// answer in one place.
describe("hasGauge", () => {
  it("is true for a context or a window this build draws, false for nothing", () => {
    expect(hasGauge({ context: 0 })).toBe(true);
    expect(hasGauge({ limits: [{ window: "7d", used: 5 }] })).toBe(true);
    expect(hasGauge({})).toBe(false);
    expect(hasGauge(undefined)).toBe(false);
  });
});

describe("formatCost", () => {
  it("writes under a cent as <$0.01, two decimals under $100, whole dollars from there", () => {
    expect(formatCost(0)).toBe("<$0.01");
    expect(formatCost(0.0099)).toBe("<$0.01");
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.114)).toBe("$0.11");
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(99.99)).toBe("$99.99");
    expect(formatCost(100)).toBe("$100");
    expect(formatCost(123.45)).toBe("$123");
    expect(formatCost(1234.5)).toBe("$1235");
  });

  it("never writes $100.00, and reads a value that is no amount as under a cent", () => {
    expect(formatCost(99.996)).toBe("$100");
    expect(formatCost(Number.NaN)).toBe("<$0.01");
    expect(formatCost(-3)).toBe("<$0.01");
  });
});

describe("ModelTag session cost", () => {
  it("draws the cost after the last gauge, as a figure and not a gauge, and says it", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ context: 42, cost: 0.1137 }} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5ctx$0.11");
    const cost = container.querySelector("[data-slot='usage-cost']");
    expect(cost?.textContent).toBe("$0.11");
    expect(cost?.className).toContain("tabular-nums");
    expect(cost?.className).not.toContain("status-working");
    expect(cost?.querySelector("[data-slot='usage-dots']")).toBeNull();
    expect(container.querySelectorAll("[data-gauge]")).toHaveLength(1);
    expect(cost?.previousElementSibling?.getAttribute("data-gauge")).toBe("context");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5. Context 42% used. Session cost $0.11");
  });

  it("draws <$0.01 for a cost under a cent", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ cost: 0.002 }} />);
    expect(container.querySelector("[data-slot='usage-cost']")?.textContent).toBe("<$0.01");
  });

  it("draws no cost span when none is reported, or when the number is not an amount", () => {
    for (const usage of [undefined, { context: 5 }, { cost: Number.NaN }, { cost: -1 }]) {
      const { container } = render(<ModelTag model="claude-opus-5-5" usage={usage} />);
      expect(container.querySelector("[data-slot='usage-cost']")).toBeNull();
      expect(container.querySelector(".sr-only")?.textContent).not.toContain("Session cost");
    }
  });

  it("draws a tag for a cost alone while the screen names the model, and hasGauge ignores the cost", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ cost: 12.5 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("$12.50");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Session cost $12.50");
    expect(hasGauge({ cost: 12.5 })).toBe(false);
  });

  it("a cost counts like a gauge for the caller: hasFigure keeps the model name beside it", () => {
    expect(hasFigure({ cost: 0.11 })).toBe(true);
    expect(hasFigure({ context: 3 })).toBe(true);
    expect(hasFigure({ cost: Number.NaN })).toBe(false);
    expect(hasFigure({})).toBe(false);
    expect(hasFigure(undefined)).toBe(false);
    // The caller (agent-chat.tsx) passes the model whenever hasFigure is true, so the cost never floats alone.
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ cost: 0.11 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5$0.11");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5. Session cost $0.11");
  });
});
