import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ModelTag } from "./model-tag";

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
