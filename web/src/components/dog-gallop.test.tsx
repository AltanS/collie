import { render, screen } from "@testing-library/react";

import { DogGallop } from "./dog-gallop";

describe("DogGallop", () => {
  it("renders a decorative mascot by default (aria-hidden, no img role)", () => {
    const { container } = render(<DogGallop />);
    const el = container.querySelector(".dog-gallop");
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("adds the running modifier only while galloping", () => {
    const { container, rerender } = render(<DogGallop running={false} />);
    expect(container.querySelector(".dog-gallop")).not.toHaveClass("dog-gallop--running");
    rerender(<DogGallop running />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
  });

  it("exposes an accessible image when given a label", () => {
    render(<DogGallop label="Loading" />);
    const el = screen.getByRole("img", { name: "Loading" });
    expect(el).not.toHaveAttribute("aria-hidden");
  });

  it("drives box + sprite scale from a single --dog-size length", () => {
    const { container } = render(<DogGallop size="4rem" />);
    expect(container.querySelector<HTMLElement>(".dog-gallop")?.style.getPropertyValue("--dog-size")).toBe(
      "4rem",
    );
  });

  it("forwards className for placement", () => {
    const { container } = render(<DogGallop className="mr-2" />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("mr-2");
  });
});
