import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] select-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        // Colour only — the width is already reserved by the base string.
        outline:
          "border-border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
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
