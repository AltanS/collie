import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { cn } from "@/lib/utils";

import { AddButton } from "./add-button";
import { STRIP_TAP_TARGET_SQUARE, TAB_ROW_ADD_TAP_TARGET, TAB_ROW_SQUARE_TAP_TARGET } from "./labelled-strip";

/** The ring face every size can wear: a dashed circle, muted ink, no fade while busy. */
const FACE = [
  "rounded-full",
  "border",
  "border-dashed",
  "border-border",
  "text-muted-foreground",
  "shrink-0",
  "disabled:opacity-100",
];

/**
 * Every class of a recipe after tailwind-merge, so a test can say "this reach is on the button"
 * token by token. Merged, because a recipe may override itself: `STRIP_TAP_TARGET_SQUARE` widens
 * `STRIP_TAP_TARGET`'s `before:inset-x-0`, and only the widened inset reaches the DOM.
 */
const tokens = (recipe: string) => cn(recipe).split(/\s+/u).filter(Boolean);

function mount(props: Partial<Parameters<typeof AddButton>[0]> = {}) {
  const onClick = props.onClick ?? vi.fn();
  const { container } = render(
    <AddButton size="sm" reach={TAB_ROW_SQUARE_TAP_TARGET} label="New tab" onClick={onClick} {...props} />,
  );
  // SAFETY: AddButton renders exactly one <button> as its root; the render above just mounted it.
  const button = container.querySelector("button")!;
  return { button, onClick };
}

describe("AddButton — the '+'", () => {
  it("draws both sizes the strips used, as circles", () => {
    const sm = mount({ size: "sm" }).button;
    expect(sm).toHaveClass("size-7", ...FACE);
    const md = mount({ size: "md", reach: STRIP_TAP_TARGET_SQUARE, label: "New space" }).button;
    expect(md).toHaveClass("size-8", ...FACE);
  });

  it("draws the tab row's bare face: the glyph alone in a 24px box, the ring's ink, hover and press, no border", () => {
    const { button } = mount({ size: "xs", face: "bare", reach: TAB_ROW_ADD_TAP_TARGET });
    expect(button).toHaveClass("size-6", "rounded-full", "text-muted-foreground", "hover:bg-accent", "active:scale-95", "disabled:opacity-100");
    for (const ring of ["border", "border-dashed", "border-border"]) expect(button).not.toHaveClass(ring);
    expect(button.querySelector(".lucide-plus")).toHaveClass("size-4");
    expect(button).toHaveClass(...tokens(TAB_ROW_ADD_TAP_TARGET));
  });

  it("keeps the spinner in the bare face's box while busy", () => {
    const { button } = mount({ size: "xs", face: "bare", reach: TAB_ROW_ADD_TAP_TARGET, busy: true });
    expect(button.querySelector(".animate-spin")).toHaveClass("size-4");
    expect(button.querySelector(".lucide-plus")).toBeNull();
  });

  it("wears the reach its caller passes, whole", () => {
    expect(mount({ reach: TAB_ROW_SQUARE_TAP_TARGET }).button).toHaveClass(...tokens(TAB_ROW_SQUARE_TAP_TARGET));
    expect(mount({ reach: STRIP_TAP_TARGET_SQUARE }).button).toHaveClass(...tokens(STRIP_TAP_TARGET_SQUARE));
  });

  it("is named by its label and is a plain button", () => {
    const { button } = mount({ label: "New tab in moonward" });
    expect(button).toHaveAccessibleName("New tab in moonward");
    expect(button).toHaveAttribute("type", "button");
  });

  it("answers a tap", async () => {
    const { button, onClick } = mount();
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("while busy: disabled, marked busy, a spinner in the plus's place, and a tap goes nowhere", async () => {
    const { button, onClick } = mount({ busy: true });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(button.querySelector(".lucide-plus")).toBeNull();
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("at rest: enabled, not busy, the plus drawn", () => {
    const { button } = mount();
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.querySelector(".lucide-plus")).not.toBeNull();
  });
});
