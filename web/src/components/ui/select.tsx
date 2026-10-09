import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SelectProps extends Omit<ComponentProps<"select">, "className"> {
  /** Sizes the box the select lives in: `flex-1`, `min-w-0`, `shrink-0`. The select fills it. */
  className?: string;
  /**
   * A glyph or dot in front of the text, drawn `aria-hidden` and inert. It owns the left gutter, so
   * the text starts after it; the caller sizes and tints it. Omit and the text starts at the edge.
   */
  lead?: ReactNode;
}

/**
 * The app's form select: a NATIVE `<select>` in a 44px box with our own chevron. Native on purpose,
 * for the reason `language-control.tsx` gives: on a phone the OS draws the picker, it is the control
 * every thumb already knows, and it needs no popover (`ui/sheet.tsx` is the app's only floating
 * layer). The engine's caret is removed with `appearance-none` and the chevron is ours, because iOS
 * Safari keeps its own caret and padding otherwise.
 *
 * The box is a full border on all four sides in `--border`, the page colour inside and the house
 * 2px corner. The text truncates, so a long option never widens the box it sits in. `min-h-11` is
 * the tap floor (DESIGN.md §6), and nothing about the select changes its box when the value does
 * (§2): the native control sizes itself to its widest option, not to the chosen one.
 *
 * The dashboard's workspace and order selects use it (the old new-space sheet's Repository and
 * Agent fields did, before the one New sheet replaced them with chips in M48). The three
 * Settings selects (language, typeface, terminal font) carry the same construction by hand and have
 * not been moved onto this yet.
 */
export function Select({ className, lead, children, ...props }: SelectProps) {
  return (
    <div data-slot="select" className={cn("relative", className)}>
      <select
        {...props}
        className={cn(
          "h-11 w-full appearance-none truncate rounded-lg border border-border bg-background pr-8 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          lead === undefined ? "pl-3" : "pl-8",
        )}
      >
        {children}
      </select>
      {lead !== undefined && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center text-muted-foreground"
        >
          {lead}
        </span>
      )}
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
