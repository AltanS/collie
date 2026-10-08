import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Fab } from "./fab";

const BOTTOM = "bottom-[calc(3.5rem_+_1px_+_env(safe-area-inset-bottom)_+_1rem)]";

describe("Fab, the dashboard's one floating New button", () => {
  it("is a 56px circle in the primary fill, named by the caller", () => {
    render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    const button = screen.getByRole("button", { name: "New" });
    expect(button).toHaveClass("size-14", "rounded-full", "bg-primary", "text-primary-foreground");
    // The reserved transparent edge (DESIGN.md §2): a state recolours, never re-lays-out.
    expect(button).toHaveClass("border", "border-transparent");
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
