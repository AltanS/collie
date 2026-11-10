import type { ReactNode } from "react";

import { OverflowEdges } from "@/components/ui/overflow-edges";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { cn } from "@/lib/utils";

/** One tab. */
export interface TabBarItem<V extends string> {
  value: V;
  label: string;
  icon: ReactNode;
  /** A small red count on the icon's corner. Drawn only when above zero. It means something is
   *  waiting on the operator, so a caller counts only that (ADR 0066). */
  badge?: number;
  /** A quiet mark in the same corner: something is new, with no claim that it is urgent. Drawn
   *  only when there is no count; the two never show together. It wears the unseen mark's look
   *  (ui/unseen-mark.tsx). */
  dot?: boolean;
  /** ALREADY TRANSLATED. What the badge or the dot says to a screen reader, e.g. "2 blocked". */
  badgeLabel?: string;
}

/**
 * An item that is NOT a view of the bar: a tap goes one level down to a route of its own (the Hill),
 * so it is never the selected tab. It wears a tab's look and a tab's red count, with the same meaning:
 * something waits on the operator (ADR 0066).
 */
export interface TabBarLink {
  id: string;
  label: string;
  icon: ReactNode;
  /** The red count on the icon's corner, drawn only when above zero. */
  badge?: number;
  /** ALREADY TRANSLATED. What the badge says to a screen reader. */
  badgeLabel?: string;
  onSelect: () => void;
}

/** One item of the scrolling run, built by the caller (a trick's item, in its own error boundary). */
export interface TabBarExtra {
  key: string;
  node: ReactNode;
}

export interface TabBarProps<V extends string> {
  items: readonly TabBarItem<V>[];
  /** The selected tab, or null for none. */
  active: V | null;
  onSelect: (value: V) => void;
  /** ALREADY TRANSLATED. The nav landmark's name. */
  label: string;
  /** Fixed items after the tabs that open a route instead of switching the view (the Hill, M96). */
  links?: readonly TabBarLink[];
  /**
   * Items after a thin divider, in a run that scrolls sideways (the `tabbar` place of tricks). With at
   * least one, the bar changes mode: the tabs and the links keep a fixed width and stay pinned at the
   * left, and only the run scrolls. Each node is a `TabBarExtraItem` (or nothing, when its boundary
   * caught a throw).
   */
  extras?: readonly TabBarExtra[];
  className?: string;
}

const NO_LINKS: readonly TabBarLink[] = [];
const NO_EXTRAS: readonly TabBarExtra[] = [];

/**
 * The pinned cell's width in the scrolling mode, and the run's: 64px holds "Dashboard" at 11px, and gives
 * a run item's quiet badge (at most 36px, `max-w-9`) room to end 12px short of the next item's icon.
 */
const PINNED_WIDTH = "w-16 shrink-0";
const EXTRA_WIDTH = "w-16 shrink-0";

/** The cell every item wears: icon over a one-line word, the reserved 2px top edge, 56px tall. */
const CELL =
  "relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 border-t-2 border-transparent px-1 text-[11px] font-medium select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** The red count: something waits on the operator. */
function AlertBadge({ n }: { n: number }) {
  return (
    <span data-slot="tab-badge" className="absolute -top-1.5 left-[calc(100%-0.25rem)] flex h-4 min-w-4 items-center justify-center rounded-sm bg-status-blocked px-1 text-[10px] leading-none font-semibold text-background tabular-nums">
      {n}
    </span>
  );
}

/**
 * A bottom tab bar: tabs in one row, each an icon over a one-line word, on the band ground (the page
 * colour by default, a theme's `chrome: band` fill otherwise) with one rule above (DESIGN.md §4). It
 * owns the band, the safe area under it and the items' look; it owns no words and no state. The
 * dashboard's footer is its first caller (ADR 0066).
 *
 * TWO MODES (ADR 0066 and ADR 0085, amended 2026-11-10). With no `extras` the tabs and the links share
 * the width equally and nothing scrolls: today's bar, with the Hill as one more equal item. With
 * `extras`, the tabs and the links keep a fixed width (`PINNED_WIDTH`) and stay at the left, a thin
 * divider follows, and the extras scroll sideways after it with the house edge fade (`OverflowEdges`,
 * no chevron). The bar's height is the same in both: every cell is the same 56px row.
 *
 * NOTHING MOVES ON A SWITCH (DESIGN.md §2). The active mark is a 2px top edge that every tab
 * reserves, transparent, so a switch recolours an edge and re-lays-out nothing. A link and an extra
 * reserve it too and never fill it: neither is ever the selected tab. The word never changes weight.
 * A badge floats on the icon's corner, absolutely placed, so a count arriving, changing width or
 * leaving moves no label. The quiet dot takes the same absolutely placed corner slot, so a count
 * turning into a dot, or either leaving, moves nothing either. The row is `min-h-14` (56px, above the
 * 44px floor of §6), and each word is one truncated line, so no locale can make one tab taller than
 * the others.
 *
 * The safe area sits UNDER the row, inside the band, so the home indicator never covers a tab.
 */
export function TabBar<V extends string>({ items, active, onSelect, label, links = NO_LINKS, extras = NO_EXTRAS, className }: TabBarProps<V>) {
  const scrolling = extras.length > 0;
  const width = scrolling ? PINNED_WIDTH : "flex-1";
  return (
    <nav
      aria-label={label}
      data-slot="tab-bar"
      data-mode={scrolling ? "scroll" : "equal"}
      className={cn("shrink-0 border-t border-band-rule bg-band-ground pb-[env(safe-area-inset-bottom)]", className)}
    >
      <div className="flex">
        {items.map((it) => {
          const on = it.value === active;
          const badge = it.badge !== undefined && it.badge > 0 ? it.badge : undefined;
          const dot = badge === undefined && it.dot === true;
          const marked = badge !== undefined || dot;
          return (
            <button
              key={it.value}
              type="button"
              data-slot="tab"
              aria-current={on ? "page" : undefined}
              onClick={() => onSelect(it.value)}
              className={cn(
                // `-mt-px` lays the 2px edge over the band's 1px rule, so the active tab's mark IS
                // the top edge there rather than a second line under it.
                CELL,
                "-mt-px",
                width,
                on ? "border-foreground text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="relative flex size-5 items-center justify-center" aria-hidden>
                {it.icon}
                {badge !== undefined && <AlertBadge n={badge} />}
                {dot && (
                  <span data-slot="tab-dot" className="absolute -top-0.5 left-[calc(100%-0.125rem)] flex">
                    <UnseenMark />
                  </span>
                )}
              </span>
              <span className="max-w-full truncate leading-tight">{it.label}</span>
              {marked && it.badgeLabel !== undefined && <span className="sr-only">, {it.badgeLabel}</span>}
            </button>
          );
        })}
        {links.map((link) => {
          const badge = link.badge !== undefined && link.badge > 0 ? link.badge : undefined;
          return (
            <button
              key={link.id}
              type="button"
              data-slot="tab-link"
              data-link={link.id}
              onClick={link.onSelect}
              // Never `aria-current` and never the filled edge: a link opens a route, it is not a view.
              className={cn(CELL, "-mt-px text-muted-foreground", width)}
            >
              <span className="relative flex size-5 items-center justify-center" aria-hidden>
                {link.icon}
                {badge !== undefined && <AlertBadge n={badge} />}
              </span>
              <span className="max-w-full truncate leading-tight">{link.label}</span>
              {badge !== undefined && link.badgeLabel !== undefined && <span className="sr-only">, {link.badgeLabel}</span>}
            </button>
          );
        })}
        {scrolling && (
          <>
            <span aria-hidden data-slot="tab-bar-divider" className="my-3 w-px shrink-0 self-stretch bg-border" />
            {/* `-mt-px` on the run, not on its cells: inside a scroller the cells' own negative margin
                would be clipped. The run's cells never fill their top edge, so the rule shows through. */}
            <div className="-mt-px flex min-w-0 flex-1">
              <OverflowEdges cue="none">
                {(ref) => (
                  <div
                    ref={ref}
                    data-slot="tab-bar-extras"
                    className="flex min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  >
                    {extras.map((extra) => (
                      <div key={extra.key} className="flex shrink-0">
                        {extra.node}
                      </div>
                    ))}
                  </div>
                )}
              </OverflowEdges>
            </div>
          </>
        )}
      </div>
    </nav>
  );
}

export interface TabBarExtraItemProps {
  label: string;
  icon: ReactNode;
  /** A quiet outlined count or short word on the icon's corner. Never the red badge: it is not "waiting on you". 0 draws none. */
  badge?: number | string;
  /** ALREADY TRANSLATED. The item's whole name for a screen reader (the badge included). */
  name: string;
  /** The tap. Absent: the item is drawn, inert, and is no control at all. */
  onSelect?: () => void;
  className?: string;
  /** Data attributes for the caller's own handle (`data-trick`). */
  data?: Readonly<Record<`data-${string}`, string | undefined>>;
}

/**
 * One item of the bar's scrolling run, in the bar's own look: the tab's cell, a fixed 64px width, and
 * a quiet outlined badge (ADR 0066: the red count means something waits on you, and a trick's figure
 * does not). With a tap it is a button; without one it is a span that takes no tap.
 */
export function TabBarExtraItem({ label, icon, badge, name, onSelect, className, data }: TabBarExtraItemProps) {
  const shown = badge === undefined || badge === 0 ? undefined : String(badge);
  const face = (
    <>
      <span className="relative flex size-5 items-center justify-center" aria-hidden>
        {icon}
        {shown !== undefined && (
          <span
            data-slot="tab-extra-badge"
            className="absolute -top-1.5 left-[calc(100%-0.25rem)] flex h-4 max-w-9 min-w-4 items-center justify-center rounded-sm border border-border bg-card px-0.5 text-[10px] leading-none font-semibold text-foreground tabular-nums"
          >
            <span className="truncate">{shown}</span>
          </span>
        )}
      </span>
      <span aria-hidden className="max-w-full truncate leading-tight">
        {label}
      </span>
    </>
  );
  if (onSelect === undefined) {
    return (
      <span data-slot="tab-extra" {...data} className={cn(CELL, EXTRA_WIDTH, "text-muted-foreground", className)}>
        <span className="sr-only">{name}</span>
        {face}
      </span>
    );
  }
  return (
    <button type="button" data-slot="tab-extra" {...data} aria-label={name} onClick={onSelect} className={cn(CELL, EXTRA_WIDTH, "text-muted-foreground", className)}>
      {face}
    </button>
  );
}
