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
