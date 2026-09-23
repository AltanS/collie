import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One tab. */
export interface TabBarItem<V extends string> {
  value: V;
  label: string;
  icon: ReactNode;
  /** A small count on the icon's corner. Drawn only when above zero. */
  badge?: number;
  /** ALREADY TRANSLATED. What the badge says to a screen reader, e.g. "2 need you". */
  badgeLabel?: string;
}

export interface TabBarProps<V extends string> {
  items: readonly TabBarItem<V>[];
  /** The selected tab, or null for none. */
  active: V | null;
  onSelect: (value: V) => void;
  /** ALREADY TRANSLATED. The nav landmark's name. */
  label: string;
  className?: string;
}

/**
 * A bottom tab bar: equal tabs in one row, each an icon over a one-line word, on the page colour
 * with one rule above (DESIGN.md §4, chrome is never a fill). It owns the band, the safe area under
 * it and the tabs' look; it owns no words and no state. The dashboard's footer is its first caller
 * (ADR 0066).
 *
 * NOTHING MOVES ON A SWITCH (DESIGN.md §2). The active mark is a 2px top edge that every tab
 * reserves, transparent, so a switch recolours an edge and re-lays-out nothing. The word never
 * changes weight. A badge floats on the icon's corner, absolutely placed, so a count arriving,
 * changing width or leaving moves no label. The row is `min-h-14` (56px, above the 44px floor of
 * §6), and each word is one truncated line, so no locale can make one tab taller than the others.
 *
 * The safe area sits UNDER the row, inside the band, so the home indicator never covers a tab.
 */
export function TabBar<V extends string>({ items, active, onSelect, label, className }: TabBarProps<V>) {
  return (
    <nav
      aria-label={label}
      data-slot="tab-bar"
      className={cn("shrink-0 border-t border-rule bg-background pb-[env(safe-area-inset-bottom)]", className)}
    >
      <div className="flex">
        {items.map((it) => {
          const on = it.value === active;
          const badge = it.badge !== undefined && it.badge > 0 ? it.badge : undefined;
          return (
            <button
              key={it.value}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => onSelect(it.value)}
              className={cn(
                // `-mt-px` lays the 2px edge over the band's 1px rule, so the active tab's mark IS
                // the top edge there rather than a second line under it.
                "relative -mt-px flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 border-t-2 border-transparent px-1 text-[11px] font-medium select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                on ? "border-foreground text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="relative flex size-5 items-center justify-center" aria-hidden>
                {it.icon}
                {badge !== undefined && (
                  <span className="absolute -top-1.5 left-[calc(100%-0.25rem)] flex h-4 min-w-4 items-center justify-center rounded-sm bg-status-blocked px-1 text-[10px] leading-none font-semibold text-background tabular-nums">
                    {badge}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate leading-tight">{it.label}</span>
              {badge !== undefined && it.badgeLabel !== undefined && <span className="sr-only">, {it.badgeLabel}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
