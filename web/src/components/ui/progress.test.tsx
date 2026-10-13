import { render, screen } from "@testing-library/react";

import { Progress } from "./progress";

describe("Progress", () => {
  it("is a progressbar with its value and its name", () => {
    render(<Progress value={40.4} label="Progress" />);
    const bar = screen.getByRole("progressbar", { name: "Progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar.querySelector('[data-slot="progress-fill"]')).toHaveStyle({ width: "40.4%" });
  });

  it("clamps a value outside 0 to 100 so the fill never leaves the track", () => {
    const { rerender } = render(<Progress value={250} label="Progress" />);
    expect(document.querySelector('[data-slot="progress-fill"]')).toHaveStyle({ width: "100%" });
    rerender(<Progress value={-5} label="Progress" />);
    expect(document.querySelector('[data-slot="progress-fill"]')).toHaveStyle({ width: "0%" });
  });

  it("states its height in both sizes: 4px on a track, or a 1px line without one", () => {
    const { rerender } = render(<Progress value={10} label="Progress" />);
    expect(screen.getByRole("progressbar").className).toContain("h-1 ");
    expect(screen.getByRole("progressbar").className).toContain("bg-muted");
    rerender(<Progress value={10} label="Progress" size="hairline" />);
    expect(screen.getByRole("progressbar").className).toContain("h-px");
    expect(screen.getByRole("progressbar").className).not.toContain("bg-muted");
  });
});
