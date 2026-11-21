import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { PRESS_REACH_SOFT } from "@/components/ui/tap-target";

/**
 * The house focus mark, outside the box: a 2px outline held 2px off the edge. Every control that can take
 * the keyboard wears it; `Button` carries it in its base string.
 */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The same mark drawn INSIDE the box, for a row that is flush with a clipping edge (a card, a scroller): an
 * outside outline would be cut off there. Same width, same colour.
 */
export const FOCUS_RING_INSET = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/**
 * The house hover for a control with no fill of its own: `--state-hover`, the hover of the plane it stands on
 * (index.css; DESIGN.md §14), as the ghost button's. A pointer only (Tailwind wraps `hover:` in `(hover: hover)`),
 * so a touch never leaves a stuck fill.
 */
export const HOVER_FILL = "hover:bg-(--state-hover)";

/**
 * "MY MENU IS OPEN", ONE LOOK FOR EVERY TRIGGER. A control that opens a menu, a dock or a dialog beside it
 * and carries `aria-expanded` wears the app's "on" look while that attribute is `true`: `--state-open` (the
 * `control-on` tint, held off the plane it stands on; DESIGN.md §14) and the `control-on` ink that the belt gives an open dock (`ON` in `actions-row.tsx`) and the switch gives an on
 * track. It reads the ATTRIBUTE, not a second prop, so the look and the screen reader's word cannot part.
 *
 * Fill and ink only: no border, no size, no layout (DESIGN.md section 2). Open wins over hover, which is
 * why the hover variant is pinned to the same fill: an open control hovered must not repaint as a
 * hovered one. Both themes, since `--control-on` is a `light-dark()` pair. A control whose `aria-expanded`
 * is `false` or absent shows nothing, so the constant is safe on every state of one button.
 */
export const TRIGGER_OPEN =
  "aria-expanded:bg-(--state-open) aria-expanded:text-control-on-foreground aria-expanded:hover:bg-(--state-open) aria-expanded:hover:text-control-on-foreground";

// Every variant shares ONE box. `border border-transparent` lives in the base string, so a
// component that flips `default` ↔ `outline` (nav-tray's keypad, the quick-reply dock) no longer
// gains and loses 1px on all four sides mid-press: only the border's COLOUR changes. `outline` just
// paints the edge it already reserved. `ui/badge.tsx:7` has always done it this way; this is the
// same move, one folder over.
//
// Focus is a separate channel and sits OUTSIDE the box: `outline-2 outline-offset-2 outline-ring`.
// The 2px gap keeps the focus mark from touching the 1px state border, so the two read as two marks
// rather than one smear. There is deliberately no `outline-none` reset here — in Tailwind v4 it sets
// `--tw-outline-style: none`, which the `focus-visible:outline-2` below would then resolve THROUGH,
// silently painting nothing.
const buttonVariants = cva(
  [
    `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 ${FOCUS_RING} active:scale-[0.98] select-none`,
    // While pressed, the scale's share of the hit area is given back (ui/tap-target.ts).
    PRESS_REACH_SOFT,
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        // Colour only — the width is already reserved by the base string.
        outline:
          "border-border bg-background shadow-xs hover:bg-(--state-hover) hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-(--state-hover) hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 rounded-md px-6 has-[>svg]:px-4 text-base",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

// `buttonVariants` is exported so a real <a> can wear the button's clothes where a navigation, not a
// click handler, is the point — see the access-refused banner's "Sign in".
export { Button, buttonVariants };
