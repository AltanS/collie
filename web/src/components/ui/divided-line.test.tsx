import { render, screen } from "@testing-library/react";

import { DividedLine } from "./divided-line";

describe("DividedLine", () => {
  it("draws its words between two hairlines", () => {
    const { container } = render(<DividedLine>Context compacted</DividedLine>);
    expect(screen.getByText("Context compacted")).toHaveClass("text-[11px]", "text-muted-foreground");
    expect(container.querySelectorAll("div[aria-hidden].h-px.bg-border")).toHaveLength(2);
  });

  it("marks a line still being written without changing its box", () => {
    const { container, rerender } = render(<DividedLine partial>Writing</DividedLine>);
    expect(container.firstElementChild).toHaveAttribute("data-partial", "true");
    rerender(<DividedLine>Writing</DividedLine>);
    expect(container.firstElementChild).not.toHaveAttribute("data-partial");
  });
});
