import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Fab, FabButton } from "./fab";

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

  it("is the 640px column's layer by default, and a layer of the given width, centred, for the large-screen grid", () => {
    const { rerender } = render(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} />);
    const layer = () => document.querySelector<HTMLElement>('[data-slot="fab-layer"]')!;
    expect(layer()).toHaveClass("max-w-screen-sm", "px-4");
    expect(layer().style.maxWidth).toBe("");
    rerender(<Fab label="New" onClick={vi.fn()} bottom={BOTTOM} columnWidth={1248} />);
    expect(layer().style.maxWidth).toBe("1248px");
    expect(layer()).toHaveClass("mx-auto", "px-6");
    expect(layer()).not.toHaveClass("max-w-screen-sm");
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

describe("FabButton, the New button's face without a place to stand", () => {
  it("the float size is the very button the Fab draws", () => {
    render(<FabButton label="New" onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "New" })).toHaveClass("h-12", "w-24", "rounded-md", "shadow-md", "bg-background", "border-border");
  });

  it("the compact size keeps the tokens and the name, is 32px tall, and buys the 44px floor as reach", async () => {
    const onClick = vi.fn();
    render(<FabButton size="compact" label="New" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "New" });
    // The same fill, edge, ink and press tokens as the Fab; only the size and the shadow differ.
    expect(button).toHaveClass("border", "border-border", "bg-background", "text-foreground", "hover:bg-accent", "dark:bg-card", "rounded-md");
    expect(button).toHaveClass("h-8");
    expect(button).not.toHaveClass("shadow-md", "h-12", "w-24");
    // 30px padding box plus 7px each way is 44.
    expect(button.className).toContain("before:-inset-y-[7px]");
    // The word is drawn beside the glyph, and the name is the label.
    expect(button).toHaveTextContent("New");
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a compact button never folds to the round glyph", () => {
    render(<FabButton size="compact" label="New" collapsed onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "New" });
    expect(button).not.toHaveAttribute("data-collapsed");
    expect(button.querySelector("span[aria-hidden]")).not.toHaveClass("max-w-0");
    // The word carries no 64px cap, so a longer word of another locale shows whole; the float size keeps its cap.
    expect(button.querySelector("span[aria-hidden]")).not.toHaveClass("max-w-16");
  });
});
