import { useLayoutEffect, useRef, useState } from "react";

import { TrickViewItem } from "@/components/trick-place-items";
import { Segmented, segmentLook, type SegmentedOption } from "@/components/ui/segmented";
import { useLocale } from "@/hooks/use-locale";
import type { DashView } from "@/lib/dash-view";
import { t, tn } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { partKey, type WireTrickPart } from "@/lib/tricks/schema";
import type { TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE DASHBOARD'S VIEWS ON A LARGE SCREEN (ADR 0158, addendum 2026-11-21). The phone's tab bar at the foot holds
// the views (Crew, Dashboard, Files), the Hill and the tricks' `tabbar` items. On a large screen there is no bar:
// the views are the compact `ui/segmented` control in the header, with their words, the Dashboard's red count on
// its segment, and the tricks' items go last in the same row, each with its glyph and its label (a trick gets no
// fixed room, it goes last). The Hill is an icon button in the header's right cluster (`routes/home.tsx`).
//
// WHERE IT STANDS. Centred on the window while it fits between the identity and the right cluster; slid toward
// the free side when one side is short; and when the row is wider than the whole gap, the tricks' labels give way
// first (glyph only, the label stays the tooltip and the accessible name), then the row scrolls inside its own
// box. The views never lose their words. Measured from the header row's own children, in a layout effect, so the
// first paint is already placed.

/** One built-in view's segment, in px: room for "Dashboard" and its count at the 14px weight. */
const VIEW_SEGMENT_PX = 136;
/** The air kept between the control and its neighbours in the row, in px. */
const NEIGHBOUR_AIR_PX = 16;

export interface DashboardViewsProps {
  view: DashView;
  onSelect: (view: DashView) => void;
  /** Whether a crew is configured: the Crew view leads. */
  crew: boolean;
  /** Whether the machine has a screen: the Files view. */
  files: boolean;
  /** The Dashboard's red count, the panes blocked on you. */
  blockedCount: number;
  /** The held `tabbar` parts, in manifest order. */
  tabbarParts: readonly WireTrickPart[];
  /** The trick sessions, where a trick item's tap goes. */
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  store?: TricksStore;
}

interface Place {
  /** The box's left edge in the header row, px. */
  left: number;
  /** The widest the box may be: the gap between the identity and the right cluster, px. */
  room: number;
}

export function DashboardViews({ view, onSelect, crew, files, blockedCount, tabbarParts, sessions, onOpenSession, store }: DashboardViewsProps) {
  useLocale();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  // The width the row needs with every trick label shown, read while they are shown; null until read.
  const [fullWidth, setFullWidth] = useState<number | null>(null);
  const tricksKey = tabbarParts.map(partKey).join("\u0000");
  const [shortFor, setShortFor] = useState<string | null>(null);
  const short = shortFor === tricksKey;

  const options: SegmentedOption<DashView>[] = [
    ...(crew ? [{ value: "crew" as const, label: t("crew.title") }] : []),
    { value: "dashboard", label: t("home.tabs.dashboard"), badge: blockedCount, badgeLabel: tn("home.tabs.blocked", blockedCount) },
    ...(files ? [{ value: "changes" as const, label: t("files.title") }] : []),
  ];

  useLayoutEffect(() => {
    const el = box.current;
    const row = el?.closest<HTMLElement>('[data-slot="header-row"]');
    if (el === null || el === undefined || row === null || row === undefined) return;
    const measure = () => {
      const rowBox = row.getBoundingClientRect();
      const identity = row.querySelector<HTMLElement>('[data-slot="header-identity"]');
      const right = row.querySelector<HTMLElement>('[data-slot="header-right"]');
      const leftEdge = (identity?.getBoundingClientRect().right ?? rowBox.left) + NEIGHBOUR_AIR_PX;
      const rightEdge = (right?.getBoundingClientRect().left ?? rowBox.right) - NEIGHBOUR_AIR_PX;
      const room = Math.max(0, rightEdge - leftEdge);
      const natural = el.scrollWidth;
      const width = Math.min(natural, room);
      const centred = rowBox.left + rowBox.width / 2 - width / 2;
      const x = Math.min(Math.max(centred, leftEdge), rightEdge - width);
      setPlace((prev) => {
        const next = { left: Math.round(x - rowBox.left), room: Math.floor(room) };
        return prev !== null && prev.left === next.left && prev.room === next.room ? prev : next;
      });
      // The labels give way when the row with them is wider than the gap, and come back when the gap holds it again.
      if (!short && natural > room + 0.5) {
        setFullWidth(natural);
        setShortFor(tricksKey);
        return;
      }
      if (short && fullWidth !== null && fullWidth <= room) setShortFor(null);
    };
    measure();
    if (globalThis.ResizeObserver === undefined) return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(el.firstElementChild ?? el);
    for (const slot of ["header-identity", "header-right"]) {
      const node = row.querySelector(`[data-slot="${slot}"]`);
      if (node !== null) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [short, fullWidth, tricksKey]);

  if (options.length + tabbarParts.length < 2) return null;
  return (
    <div
      ref={box}
      data-slot="dashboard-views"
      data-short={short ? "" : undefined}
      // `overflow-x-auto`: past the gap the row scrolls in its own box; `py-1` keeps each segment's 44px reach inside it.
      className={cn("absolute top-1/2 -translate-y-1/2 overflow-x-auto py-1 [scrollbar-width:none]", place === null && "invisible")}
      style={place === null ? undefined : { left: place.left, maxWidth: place.room }}
    >
      <div className="flex w-max items-center">
        <div className="shrink-0" style={{ width: options.length * VIEW_SEGMENT_PX }}>
          <Segmented<DashView>
            semantics="tabs"
            compact
            options={options}
            value={view}
            onChange={onSelect}
            label={t("home.tabs.aria")}
            // With the tricks' items after it, the row's square end is theirs, so the last view meets them flat.
            className={cn("w-full", tabbarParts.length > 0 && "[&>button:last-child]:rounded-r-none")}
          />
        </div>
        {tabbarParts.length > 0 && (
          <div role="group" aria-label={t("tricks.space.title")} className="-ml-px flex items-center">
            {tabbarParts.map((part) => {
              const key = partKey(part);
              return (
                <TrickBoundary key={key} fallback="none" resetKey={`${key}@${part.rev}`}>
                  <TrickViewItem
                    part={part}
                    sessions={sessions}
                    onOpenSession={onOpenSession}
                    iconOnly={short}
                    className={cn(segmentLook({ on: false, compact: true }), "shrink-0 first:rounded-l-none")}
                    store={store}
                  />
                </TrickBoundary>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
