import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ModelTag } from "./model-tag";

describe("ModelTag", () => {
  it("draws the short model name, named for a screen reader, and takes no touch", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.textContent).toBe("Model: Opus 5.5");
    expect(tag?.className).toContain("pointer-events-none");
    expect(tag?.className).toContain("absolute");
  });

  it("draws nothing at all without a model", () => {
    expect(render(<ModelTag model={undefined} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model="  " />).container.innerHTML).toBe("");
  });
});
