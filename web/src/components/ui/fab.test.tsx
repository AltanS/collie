import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Fab } from "./fab";

const BOTTOM = "bottom-[calc(3.5rem_+_1px_+_env(safe-area-inset-bottom)_+_1rem)]";

describe("Fab, the dashboard's one floating New button", () => {
  it("reads \"+ New\" at rest, a 48px-tall outline pill in the house 2px corner, named by the caller", () => {
    render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    const button = screen.getByRole("button", { name: "New" });
    expect(button).toHaveClass("h-12", "w-24", "rounded-md", "bg-background", "text-foreground", "border-border", "shadow-md");
    // Quiet: no filled primary, no heavy shadow.
    expect(button.className).not.toMatch(/(^|\s)(bg-primary|text-primary-foreground|shadow-lg)(\s|$)/);
    // Hover and press take the accent the outline buttons use, in both themes.
    expect(button).toHaveClass("hover:bg-accent", "active:bg-accent", "dark:bg-card", "dark:hover:bg-accent");
    expect(button).not.toHaveClass("rounded-[24px]");
    expect(button).toHaveTextContent("New");
    // One uniform 1px edge, reserved at rest (DESIGN.md §2): a state recolours, never re-lays-out.
    expect(button).toHaveClass("border");
    expect(button.className).not.toMatch(/border-(l|r|t|b)-/);
  });

  it("collapses to the 48px round \"+\", keeping its name, and moves without motion when asked", () => {
    const { rerender } = render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    const pill = screen.getByRole("button", { name: "New" });
    rerender(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} collapsed />);
    const round = screen.getByRole("button", { name: "New" });
    // One button through both shapes: the same element, so focus and a tap in flight survive.
    expect(round).toBe(pill);
    expect(round).toHaveClass("h-12", "w-12", "rounded-[24px]");
    expect(round).toHaveAttribute("data-collapsed", "true");
    // The word folds away and is never read twice: the label is the name in both shapes.
    const word = round.querySelector("span[aria-hidden]");
    expect(word).toHaveClass("max-w-0", "opacity-0");
    // Reduced motion: the width, the corner and the word change at once.
    expect(round).toHaveClass("motion-reduce:transition-none");
    expect(word).toHaveClass("motion-reduce:transition-none");
  });

  it("portals to <body>, never inside the caller's tree", () => {
    // A screen transition's transform on an ancestor would turn `fixed` into "fixed to the route".
    const { container } = render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("floats in the content column's right edge and eats no tap outside the button", () => {
    render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    const layer = screen.getByRole("button", { name: "New" }).parentElement;
    expect(layer).toHaveClass("fixed", "inset-x-0", "mx-auto", "w-full", "max-w-screen-sm", "justify-end", "pointer-events-none", "z-30");
    expect(layer).toHaveClass(BOTTOM);
    expect(screen.getByRole("button", { name: "New" })).toHaveClass("pointer-events-auto");
  });

  it("sits under the toast (z-40) and the sheets (z-50)", () => {
    render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    expect(screen.getByRole("button", { name: "New" }).parentElement).toHaveClass("z-30");
  });

  it("fires on a tap", async () => {
    const onClick = vi.fn();
    render(<Fab label="New" onClick={onClick} bottom={BOTTOM} />);
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("swaps the glyph for a spinner in place while busy, disabled and at full ink", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Fab label="New" onClick={onClick} bottom={BOTTOM} />);
    const idle = screen.getByRole("button", { name: "New" });
    expect(idle.querySelector(".animate-spin")).toBeNull();
    rerender(<Fab label="New" onClick={onClick} bottom={BOTTOM} busy />);
    const busy = screen.getByRole("button", { name: "New" });
    expect(busy).toBe(idle);
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveClass("disabled:opacity-100");
    expect(busy.querySelector(".animate-spin")).not.toBeNull();
    await userEvent.click(busy);
    expect(onClick).not.toHaveBeenCalled();
  });
});
