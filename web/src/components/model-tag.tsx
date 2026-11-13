import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { StatusItem } from "@/components/trick-status-item";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { hasResizeObserver } from "@/lib/env";
import { effortLabel, modelLabel } from "@/lib/model-label";
import { formatTokens } from "@/lib/token-count";
import { visibleStatusCount } from "@/lib/tricks/status";
import type { PaneUsage } from "@/lib/types";
import type { UsageRow } from "@/lib/usage-row";
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
// THE USAGE GAUGES FOLLOW THE MODEL (.adr/0115): the context use, then the 5-hour and 7-day windows of
// the subscription. Every gauge is the share USED, 0 to 100, whichever way it is drawn. Picked by Altan
// from three shapes in the playground (2026-10-23, `#usage-row`, card 2: dots); a per-device setting
// since 1.29.0 (lib/usage-row.ts) draws them as a whole percentage instead, the default: `ctx 19%`.
// THE ONE SWITCH IS {@link Meter}: every place that draws the tag (the pane's mirror, the wide layout's
// strip column) goes through it, so the choice applies to all of them.
//
// PERCENT: the figure rounded to a whole number, in tabular digits so the row does not jitter as the
// number changes. DOTS: five dots, one per fifth, lit from the left for each FULL fifth, so only 100%
// lights the fifth and 81% shows four, not five as a full window would. In both, a gauge at 80% and up
// is RED (`status-blocked`, the notice red of DESIGN.md §4: the operator must act, a window is about to
// run out): the number, or the lit dots. Altan's call, 2026-11-13, who first had it in the working
// colour. {@link isHot} is the one rule, on the whole percentage the figure is written as, so the number
// and the dots turn together. A gauge the harness did not report is not drawn, in either, and the screen
// reader gets the exact figure either way.
//
// NO WINDOW, THE COUNT (.adr/0115, amended 2026-11-13). A context whose window the harness did not state
// has no share to draw, so in Percent the context's place holds its token count instead, `ctx 222k`, in
// the same type and tabular digits (lib/token-count.ts writes it). It is a count, not a share: never red.
// In Dots it draws nothing: a dot is a fifth of a window, and there is no window to take a fifth of. The
// screen reader hears the count in both.
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

/** At or above this percentage a gauge turns red. */
export const USAGE_HOT_AT = 80;

/** The dots per gauge: one per fifth. */
const DOTS = 5;

/**
 * THE ROOM THE TAG TAKES FROM THE TAIL, in px: what a scroller under it keeps clear below its last line
 * while a tag shows (`TailRoomContext`, ui/chat/chat-message-list.tsx). The tag's 12px line box
 * (`text-[10px]/3`) stands 4px above the mirror box's bottom edge (`bottom-1`), so its top edge is 16px
 * up, and the scrollers' own 12px of `pb-3` left the newest line 4px under it (#759). Two more px of air
 * so the line does not touch the tag. Keep it in step with `bottom-1` and the line box below.
 */
export const MODEL_TAG_ROOM = 18;

/** The tag's widest share of the mirror box it floats in (`max-w-[70%]` below). */
const TAG_MAX_SHARE = 0.7;
/** The tag's own horizontal padding, `px-1` on both sides, in px. */
const TAG_PADDING = 8;
/**
 * The gap between two items in px, and the class that draws it: `gap-1.5` (6px) beside the dots, `gap-1`
 * (4px) beside the percentages. A percentage is 3px wider than its five dots, and the longest realistic
 * row (`Opus 5.5 · medium`, ctx, 5h, 7d and a cost) fits a 360px phone's 70% share by 1px with dots, so
 * the percentages take their 8px back here and the model name is cut no sooner than it was.
 */
const ITEM_GAPS = { dots: { px: 6, className: "gap-1.5" }, percent: { px: 4, className: "gap-1" } } as const satisfies Record<UsageRow, { px: number; className: string }>;

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
function useStatusFit(key: string, gap: number, count: number, tagRef: RefObject<HTMLDivElement | null>, ownRef: RefObject<HTMLSpanElement | null>, itemsRef: RefObject<HTMLSpanElement | null>): number {
  const [shown, setShown] = useState(count);
  const measure = useCallback(() => {
    const box = tagRef.current?.parentElement;
    const items = itemsRef.current;
    if (box === null || box === undefined || items === null) return;
    const room = Math.floor(box.clientWidth * TAG_MAX_SHARE) - TAG_PADDING;
    const mine = ownRef.current === null ? [] : [...ownRef.current.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    const own = mine.reduce((sum, el) => sum + naturalWidth(el), 0) + gap * Math.max(0, mine.length - 1);
    const widths = [...items.children].filter((el): el is HTMLElement => el instanceof HTMLElement).map((el) => el.offsetWidth);
    const next = visibleStatusCount({ room, own, gap, widths });
    setShown((was) => (was === next ? was : next));
  }, [gap, tagRef, ownRef, itemsRef]);
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

/** The context's token count, drawn where its share would be when no window was stated. */
interface TokenFigure {
  short: string;
  spoken: string;
  text: string;
}

/** The token count to draw in the context's place, or null: a share is there to draw, or no count is. */
function tokensOf(usage: PaneUsage | undefined): TokenFigure | null {
  if (usage === undefined || isReading(usage.context) || usage.contextTokens === undefined) return null;
  const text = formatTokens(usage.contextTokens);
  if (text === null) return null;
  return { short: t("chat.usage.context"), spoken: t("chat.usage.context.tokens.aria", { tokens: text }), text };
}

/** A reading a gauge can draw: a finite number. Anything else is "not reported", so no `NaN%` is ever drawn. */
function isReading(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/** The whole percentage a reading is written as, held to 0 to 100 like the dots' fill. */
function wholePercent(used: number): number {
  return Math.min(100, Math.max(0, Math.round(used)));
}

/** Whether a gauge is hot: the whole percentage it is written as is {@link USAGE_HOT_AT} or more. The one rule, for the number and the dots. */
export function isHot(used: number): boolean {
  return wholePercent(used) >= USAGE_HOT_AT;
}

/** The gauges to draw, in order: the context, then each window this build knows. */
function gaugesOf(usage: PaneUsage | undefined): Gauge[] {
  if (usage === undefined) return [];
  const gauges: Gauge[] = [];
  if (isReading(usage.context)) {
    gauges.push({ id: "context", short: t("chat.usage.context"), spoken: t("chat.usage.context.aria", { percent: wholePercent(usage.context) }), used: usage.context });
  }
  for (const limit of usage.limits ?? []) {
    const keys = WINDOW_KEYS.get(limit.window);
    if (keys === undefined || !isReading(limit.used)) continue;
    gauges.push({ id: limit.window, short: t(keys.short), spoken: t(keys.spoken, { percent: wholePercent(limit.used) }), used: limit.used });
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
  return hasGauge(usage) || tokensOf(usage) !== null || costOf(usage) !== null;
}

/** Five 3px dots, lit from the left, one per full fifth. A dot is as wide as it is tall, so it may be round (DESIGN.md §3). */
function Dots({ used }: { used: number }) {
  const lit = Math.min(DOTS, Math.max(0, Math.floor(used / (100 / DOTS))));
  const hot = isHot(used);
  return (
    <span data-slot="usage-dots" data-lit={lit} data-hot={hot || undefined} className="inline-flex items-center gap-px">
      {Array.from({ length: DOTS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-[3px] rounded-full",
            i < lit ? (hot ? "bg-status-blocked" : "bg-muted-foreground") : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

/** The gauge as a whole percentage, `19%`. The tone follows the number as written: 80 and up is red. */
function Percent({ used }: { used: number }) {
  const percent = wholePercent(used);
  const hot = isHot(used);
  return (
    <span data-slot="usage-percent" data-hot={hot || undefined} className={cn("tabular-nums", hot && "text-status-blocked")}>
      {percent}%
    </span>
  );
}

/** One gauge's figure, drawn the way the device chose (lib/usage-row.ts). The only place that decides. */
export function Meter({ used, mode }: { used: number; mode: UsageRow }) {
  return mode === "dots" ? <Dots used={used} /> : <Percent used={used} />;
}

/**
 * Whether {@link ModelTag} draws anything for these props, so the caller can reserve {@link MODEL_TAG_ROOM}
 * for the scrollers under it only while there is a tag. It mirrors the tag's own "nothing to say" test.
 */
export function modelTagShows({
  model,
  usage,
  trailing,
}: {
  model: string | undefined;
  usage?: PaneUsage | undefined;
  trailing?: readonly StatusItem[] | undefined;
}): boolean {
  return modelLabel(model) !== null || hasFigure(usage) || (trailing?.length ?? 0) > 0;
}

export function ModelTag({
  model,
  effort,
  usage,
  trailing,
  usageRow: forced,
}: {
  model: string | undefined;
  effort?: string | undefined;
  usage?: PaneUsage | undefined;
  /** The tricks' status items, in manifest order, drawn after Collie's own and hidden first when the row overflows. */
  trailing?: readonly StatusItem[] | undefined;
  /** Draws the gauges this way whatever the device chose. For the playground, which shows both modes side by side; the app passes none. */
  usageRow?: UsageRow | undefined;
}) {
  useLocale();
  const chosen = useDashPrefs().prefs.usageRow;
  const usageRow = forced ?? chosen;
  const tagRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLSpanElement>(null);
  const itemsRef = useRef<HTMLSpanElement>(null);
  const items = trailing ?? [];
  const shown = useStatusFit(items.map((item) => item.id).join(" "), ITEM_GAPS[usageRow].px, items.length, tagRef, ownRef, itemsRef);
  const name = modelLabel(model);
  const gauges = gaugesOf(usage);
  const tokens = tokensOf(usage);
  // A dot is a fifth of a window: with no window there is no dot to draw, so Dots leaves the count out.
  const drawnTokens = usageRow === "percent" ? tokens : null;
  const cost = costOf(usage);
  if (name === null && gauges.length === 0 && drawnTokens === null && cost === null && items.length === 0) return null;
  // THE EFFORT FOLLOWS THE MODEL, in the harness's own word (#463): "Opus 5.5 · high". It never draws
  // alone, and it goes with the model when the screen already names it, because the caller passes
  // neither then. The same model at `high` and at `low` is a different trade-off in time and cost.
  const level = name === null ? null : effortLabel(effort);
  const label = name === null ? null : level === null ? name : `${name} · ${level}`;
  const spoken = [label === null ? null : t("chat.model.aria", { name: label }), tokens?.spoken ?? null, ...gauges.map((g) => g.spoken),
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
      <span className={cn("flex min-w-0 items-center whitespace-nowrap", ITEM_GAPS[usageRow].className)}>
        {(label !== null || gauges.length > 0 || drawnTokens !== null || cost !== null) && (
          <span ref={ownRef} aria-hidden data-slot="usage-own" className={cn("flex min-w-0 items-center", ITEM_GAPS[usageRow].className)}>
            {label !== null && <span className="min-w-0 truncate">{label}</span>}
            {drawnTokens !== null && (
              <span data-gauge="context" data-slot="usage-tokens" className="flex shrink-0 items-center gap-0.5">
                <span>{drawnTokens.short}</span>
                <span className="tabular-nums">{drawnTokens.text}</span>
              </span>
            )}
            {gauges.map((g) => (
              <span key={g.id} data-gauge={g.id} className={cn("flex shrink-0 items-center", usageRow === "percent" ? "gap-0.5" : "gap-[3px]")}>
                <span>{g.short}</span>
                <Meter used={g.used} mode={usageRow} />
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
          <span ref={itemsRef} data-slot="usage-trick-items" className={cn("flex items-center", ITEM_GAPS[usageRow].className)}>
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
