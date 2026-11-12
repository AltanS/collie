import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { StatusItem } from "@/components/trick-status-item";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { hasResizeObserver } from "@/lib/env";
import { effortLabel, modelLabel } from "@/lib/model-label";
import { visibleStatusCount } from "@/lib/tricks/status";
import type { PaneUsage } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE PANE'S MODEL, SMALL, ABOVE THE BELT. Altan asked for the selected model "somewhere subtle and
// super small above the belt, floating and at all times": which brain is answering is a fact he
// checks before he sends, and until now it was one tap away inside the Model command.
//
// IT FLOATS ON THE MIRROR'S BOTTOM-RIGHT CORNER, inside the same `relative` box the terminal-draft
// notice's slot pins to (agent-chat.tsx). Absolute, so it changes the height of nothing: not the
// scroller, not the card dock, not the chrome block (DESIGN.md §2). It is not a floating LAYER in the
// sense of ui/sheet.tsx: it is anchored to the pane, scrolls with nothing, takes no touch
// (`pointer-events-none`, so a tap on it reaches the mirror under it) and holds no control. The
// right corner because terminal and chat text both start at the left, and the centre belongs to the
// jump-to-latest button. Under the notice slot's `z-20`, so a draft notice covers it while it shows.
//
// 10px on a 12px line box, the caption size the belt's own tags use, on a page ground translucent
// enough that the mirror's last row still shows where the tag ends, and opaque enough that a dot does
// not drown in the letters under it. Absent, never a placeholder: nothing to say, no tag.
//
// THE USAGE DOTS FOLLOW THE MODEL (.adr/0115): the context use, then the 5-hour and 7-day windows of
// the subscription, five dots each, one per fifth. Picked by Altan from three shapes in the playground
// (2026-10-23, `#usage-row`, card 2). A dot lights from the left for each FULL fifth, so only 100% lights
// the fifth and 81% shows four, not five as a full window would; at 80% and up the lit dots take the
// working colour, never red, because red marks harm (DESIGN.md §4). A gauge the harness did not report
// is not drawn, and the screen reader gets the exact figure the dots round down.
//
// THE SESSION COST CLOSES THE ROW (.adr/0115, amended 2026-10-25): dollars after the last gauge, in the
// gauges' muted colour and the tag's own size. It is a figure, not a gauge: no dots and never the working
// colour, whatever the amount. Drawn whenever the harness reported one, even when its own status line
// prints a cost too. Absent, never a placeholder: no cost, no span.
//
// THE MODEL NAME STANDS DOWN WHILE THE SCREEN NAMES IT, but only when it would stand ALONE. With no
// gauge and no cost to draw, the caller passes no model while the screen names it (agent-chat.tsx
// asks hooks/use-model-on-screen.ts), so a statusline that prints "Opus 5.5" is not doubled by a bare
// label. A cost counts like a gauge ({@link hasFigure}): a bare "$0.11" would float unlabelled too.
// With a gauge or a cost the tag is the row Claude Code has, model, context and
// limits, and it names the model whatever the screen prints, so the dots never float unlabelled
// (Altan, 2026-10-25). The effort goes with the model either way. The tag is absolute, so it arriving
// or leaving moves nothing (DESIGN.md §2): there is no line to reserve because it owns none.
//
// THE TRICKS' STATUS ITEMS FOLLOW COLLIE'S OWN (M94 re-cut, the `status` place): one chip per trick, in
// manifest order, after the cost, in the same type and the same gap (components/trick-status-item.tsx).
// They are the first thing to give way. When the row is wider than the room it has, the last item hides,
// then the one before it, and Collie's own items never move: the model name truncates only once no trick
// item is left (lib/tricks/status.ts holds the rule, {@link useStatusFit} measures). A hidden item stays
// in the tree, invisible and inert and out of the reading order, so its width is still measured and it
// returns the moment there is room. A trick item may take a tap, so it takes touches back the way the
// notice slot does; the tag itself still takes none.

/** At or above this percentage a gauge takes the working colour. */
export const USAGE_WARN_AT = 80;

/** The dots per gauge: one per fifth. */
const DOTS = 5;

/** The tag's widest share of the mirror box it floats in (`max-w-[70%]` below). */
const TAG_MAX_SHARE = 0.7;
/** The tag's own horizontal padding, `px-1` on both sides, in px. */
const TAG_PADDING = 8;
/** The gap between two items, `gap-1.5`, in px. */
const ITEM_GAP = 6;

/** The natural width of an element: what it would take unshrunk, which a truncating label reports as `scrollWidth`. */
function naturalWidth(el: HTMLElement): number {
  return Math.max(el.offsetWidth, el.scrollWidth);
}

/**
 * How many of the trick items fit, measured from the DOM after every render and, where there is a
 * `ResizeObserver` (not jsdom), whenever the mirror box, the Collie group or an item changes size. `key`
 * names the items, so the observer follows them when they change. Returns the count to show, from the
 * first.
 */
function useStatusFit(key: string, count: number, tagRef: RefObject<HTMLDivElement | null>, ownRef: RefObject<HTMLSpanElement | null>, itemsRef: RefObject<HTMLSpanElement | null>): number {
  const [shown, setShown] = useState(count);
  const measure = useCallback(() => {
    const box = tagRef.current?.parentElement;
    const items = itemsRef.current;
    if (box === null || box === undefined || items === null) return;
    const room = Math.floor(box.clientWidth * TAG_MAX_SHARE) - TAG_PADDING;
    const mine = ownRef.current === null ? [] : [...ownRef.current.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    const own = mine.reduce((sum, el) => sum + naturalWidth(el), 0) + ITEM_GAP * Math.max(0, mine.length - 1);
    const widths = [...items.children].filter((el): el is HTMLElement => el instanceof HTMLElement).map((el) => el.offsetWidth);
    const next = visibleStatusCount({ room, own, gap: ITEM_GAP, widths });
    setShown((was) => (was === next ? was : next));
  }, [tagRef, ownRef, itemsRef]);
  useLayoutEffect(() => {
    if (count > 0) measure();
  });
  useLayoutEffect(() => {
    const box = tagRef.current?.parentElement;
    const items = itemsRef.current;
    if (count === 0 || box === null || box === undefined || items === null || !hasResizeObserver()) return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const el of ownRef.current?.children ?? []) observer.observe(el);
    for (const el of items.children) observer.observe(el);
    return () => observer.disconnect();
    // `key` is the items' identity: a new set of items has new elements to observe.
  }, [key, count, measure, tagRef, ownRef, itemsRef]);
  return Math.min(shown, count);
}

/** The short label and the spoken sentence of each window the phone draws. Unknown windows are skipped. */
const WINDOW_KEYS = new Map<string, { short: MessageKey; spoken: MessageKey }>([
  ["5h", { short: "chat.usage.window.5h", spoken: "chat.usage.window.5h.aria" }],
  ["7d", { short: "chat.usage.window.7d", spoken: "chat.usage.window.7d.aria" }],
]);

/**
 * A session cost as the tag writes it: `<$0.01` below a cent, two decimals up to $100 (`$0.11`), whole
 * dollars from there (`$123`). Plain `$`, since the harnesses report US dollars. A value that is not a
 * non-negative number reads as below a cent; the caller draws only a real one.
 */
export function formatCost(usd: number): string {
  if (!(usd >= 0.01)) return "<$0.01";
  const cents = Math.round(usd * 100) / 100;
  return cents < 100 ? `$${cents.toFixed(2)}` : `$${Math.round(usd).toString()}`;
}

/** The cost to draw, or null when the reading names none or a number a peer should not have sent. */
function costOf(usage: PaneUsage | undefined): number | null {
  const cost = usage?.cost;
  return cost !== undefined && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

interface Gauge {
  id: string;
  short: string;
  spoken: string;
  used: number;
}

/** The gauges to draw, in order: the context, then each window this build knows. */
function gaugesOf(usage: PaneUsage | undefined): Gauge[] {
  if (usage === undefined) return [];
  const gauges: Gauge[] = [];
  if (usage.context !== undefined) {
    gauges.push({ id: "context", short: t("chat.usage.context"), spoken: t("chat.usage.context.aria", { percent: Math.round(usage.context) }), used: usage.context });
  }
  for (const limit of usage.limits ?? []) {
    const keys = WINDOW_KEYS.get(limit.window);
    if (keys === undefined) continue;
    gauges.push({ id: limit.window, short: t(keys.short), spoken: t(keys.spoken, { percent: Math.round(limit.used) }), used: limit.used });
  }
  return gauges;
}

/**
 * Whether a usage reading draws any gauge: the context, or a window this build draws. The caller keeps
 * the model name beside the dots then, even while the screen names the model.
 */
export function hasGauge(usage: PaneUsage | undefined): boolean {
  return gaugesOf(usage).length > 0;
}

/**
 * Whether a usage reading draws any figure at all: a gauge, or the session cost. This is the test the
 * caller uses to keep the model name beside the figures while the screen names the model, so a lone
 * cost never floats without it.
 */
export function hasFigure(usage: PaneUsage | undefined): boolean {
  return hasGauge(usage) || costOf(usage) !== null;
}

/** Five 3px dots, lit from the left, one per full fifth. A dot is as wide as it is tall, so it may be round (DESIGN.md §3). */
function Dots({ used }: { used: number }) {
  const lit = Math.min(DOTS, Math.max(0, Math.floor(used / (100 / DOTS))));
  const warn = used >= USAGE_WARN_AT;
  return (
    <span data-slot="usage-dots" data-lit={lit} data-warn={warn || undefined} className="inline-flex items-center gap-px">
      {Array.from({ length: DOTS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-[3px] rounded-full",
            i < lit ? (warn ? "bg-status-working" : "bg-muted-foreground") : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

export function ModelTag({
  model,
  effort,
  usage,
  trailing,
}: {
  model: string | undefined;
  effort?: string | undefined;
  usage?: PaneUsage | undefined;
  /** The tricks' status items, in manifest order, drawn after Collie's own and hidden first when the row overflows. */
  trailing?: readonly StatusItem[] | undefined;
}) {
  useLocale();
  const tagRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLSpanElement>(null);
  const itemsRef = useRef<HTMLSpanElement>(null);
  const items = trailing ?? [];
  const shown = useStatusFit(items.map((item) => item.id).join(" "), items.length, tagRef, ownRef, itemsRef);
  const name = modelLabel(model);
  const gauges = gaugesOf(usage);
  const cost = costOf(usage);
  if (name === null && gauges.length === 0 && cost === null && items.length === 0) return null;
  // THE EFFORT FOLLOWS THE MODEL, in the harness's own word (#463): "Opus 5.5 · high". It never draws
  // alone, and it goes with the model when the screen already names it, because the caller passes
  // neither then. The same model at `high` and at `low` is a different trade-off in time and cost.
  const level = name === null ? null : effortLabel(effort);
  const label = name === null ? null : level === null ? name : `${name} · ${level}`;
  const spoken = [label === null ? null : t("chat.model.aria", { name: label }), ...gauges.map((g) => g.spoken),
    cost === null ? null : t("chat.usage.cost.aria", { amount: formatCost(cost) }),
  ].filter(
    (part): part is string => part !== null,
  );
  return (
    <div
      ref={tagRef}
      data-slot="model-tag"
      className="pointer-events-none absolute right-3 bottom-1 z-10 max-w-[70%] rounded-[2px] bg-background/90 px-1 text-[10px]/3 text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        {(label !== null || gauges.length > 0 || cost !== null) && (
          <span ref={ownRef} aria-hidden data-slot="usage-own" className="flex min-w-0 items-center gap-1.5">
            {label !== null && <span className="min-w-0 truncate">{label}</span>}
            {gauges.map((g) => (
              <span key={g.id} data-gauge={g.id} className="flex shrink-0 items-center gap-[3px]">
                <span>{g.short}</span>
                <Dots used={g.used} />
              </span>
            ))}
            {cost !== null && (
              <span data-slot="usage-cost" className="shrink-0 tabular-nums">
                {formatCost(cost)}
              </span>
            )}
          </span>
        )}
        {items.length > 0 && (
          <span ref={itemsRef} data-slot="usage-trick-items" className="flex items-center gap-1.5">
            {items.map((item, i) => (
              <span
                key={item.id}
                data-status-item={item.id}
                data-hidden={i >= shown || undefined}
                inert={i >= shown || undefined}
                className={cn("flex shrink-0 items-center", i >= shown && "invisible absolute right-0 bottom-0")}
              >
                {item.face}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="sr-only">{spoken.join(". ")}</span>
    </div>
  );
}
