import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ToggleButtonProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  /** ALREADY TRANSLATED. The accessible name: what the button does. `aria-pressed` says its state. */
  label: string;
  /** The glyph, drawn `aria-hidden`. */
  icon: ReactNode;
  /** ALREADY TRANSLATED. A visible word beside the glyph. Without it the button is a 44px square. */
  text?: string;
  /** ALREADY TRANSLATED. The native tooltip, for the icon-only form. */
  title?: string;
  /**
   * A count floated on the glyph's corner, drawn `aria-hidden`, so say it in `label` too. Absent, or
   * 0, draws nothing. It is placed absolutely, so a count arriving or changing moves nothing (§2).
   */
  badge?: number;
  /** The badge's fill, a `bg-*` class with its ink. The primary fill by default. */
  badgeClassName?: string;
  className?: string;
}

/**
 * An icon toggle button: a setting that is on or off, drawn as a button and not as a chip or a tab.
 * It owns the ONE pressed look the app has for it, which the dashboard's "needs you" switch
 * (components/needs-you-switch.tsx) and the Files view's Ignored toggle both wear: the primary tint
 * with a hairline primary ring. The ring is what keeps a pressed toggle apart from a selected
 * `bg-muted` segment next to it, because with the brand's near-black primary the two fills read
 * alike, and a control that is on and one that is merely selected must never look the same.
 *
 * A 44px target either way (DESIGN.md §6): a square when icon-only, 44px tall and as wide as its
 * word when `text` is given. Both forms reserve the ring's 1px inside the box, so a press recolours
 * and re-lays-out nothing (§2).
 */
export function ToggleButton({
  pressed,
  onPressedChange,
  label,
  icon,
  text,
  title,
  badge,
  badgeClassName = "bg-primary text-primary-foreground",
  className,
}: ToggleButtonProps) {
  return (
    <button
      type="button"
      data-slot="toggle-button"
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "relative flex h-11 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        text === undefined ? "size-11" : "gap-2 px-3 text-xs font-medium",
        pressed ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/40" : "text-muted-foreground active:bg-muted",
        className,
      )}
    >
      <span aria-hidden className="flex shrink-0">
        {icon}
      </span>
      {text !== undefined && <span aria-hidden>{text}</span>}
      {badge !== undefined && badge > 0 && (
        <span
          aria-hidden
          data-slot="toggle-badge"
          className={cn(
            "absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-[10px] leading-none font-semibold tabular-nums",
            badgeClassName,
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
