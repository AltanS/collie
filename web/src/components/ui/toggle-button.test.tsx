import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Eye } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { ToggleButton } from "./toggle-button";

function draw(props: { pressed: boolean; text?: string; onPressedChange?: (p: boolean) => void }) {
  return render(
    <ToggleButton label="Show it" icon={<Eye />} onPressedChange={props.onPressedChange ?? (() => {})} {...props} />,
  );
}

describe("ToggleButton", () => {
  it("is named by its label and says its state with aria-pressed", () => {
    draw({ pressed: false });
    expect(screen.getByRole("button", { name: "Show it" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for the opposite state on a tap", async () => {
    const onPressedChange = vi.fn();
    draw({ pressed: false, onPressedChange });
    await userEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });

  it("wears the primary tint and the hairline ring only while pressed", () => {
    const { rerender } = draw({ pressed: false });
    const off = screen.getByRole("button").className;
    expect(off).not.toContain("ring-primary/40");
    rerender(<ToggleButton pressed label="Show it" icon={<Eye />} onPressedChange={() => {}} />);
    const on = screen.getByRole("button").className;
    expect(on).toContain("bg-primary/10");
    expect(on).toContain("ring-primary/40");
  });

  it("is a 44px square without text and 44px tall with it", () => {
    const { rerender } = draw({ pressed: false });
    expect(screen.getByRole("button").className).toContain("size-11");
    rerender(<ToggleButton pressed={false} label="Show it" icon={<Eye />} text="Shown" onPressedChange={() => {}} />);
    const labelled = screen.getByRole("button");
    expect(labelled.className).toContain("h-11");
    expect(labelled.className).not.toContain("size-11");
    expect(labelled.textContent).toBe("Shown");
  });

  it("floats a count on the corner, hidden from a reader, and draws none for 0", () => {
    const { rerender } = render(<ToggleButton pressed={false} label="Only, 3" icon={<Eye />} badge={3} onPressedChange={() => {}} />);
    const button = screen.getByRole("button", { name: "Only, 3" });
    const badge = button.querySelector('[data-slot="toggle-badge"]');
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(badge?.className).toContain("absolute");
    rerender(<ToggleButton pressed={false} label="Only" icon={<Eye />} badge={0} onPressedChange={() => {}} />);
    expect(screen.getByRole("button").querySelector('[data-slot="toggle-badge"]')).toBeNull();
  });
});
