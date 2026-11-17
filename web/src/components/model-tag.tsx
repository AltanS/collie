import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { StatusItem } from "@/components/trick-status-item";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { knownWindowName } from "@/lib/accounts";
import { t, type MessageKey } from "@/lib/i18n";
import { hasResizeObserver } from "@/lib/env";
import { effortLabel, modelLabel } from "@/lib/model-label";
import { USAGE_FIGURE, USAGE_TYPE } from "@/components/usage-type";
import { formatTokens } from "@/lib/token-count";
import { fitStatusRow } from "@/lib/tricks/status";
import type { PaneUsage, UsageLimit } from "@/lib/types";
import type { UsageRow } from "@/lib/usage-row";
import { cn } from "@/lib/utils";

// THE PANE'S MODEL, SMALL, ABOVE THE BELT. Altan asked for the selected model "somewhere subtle and
// super small above the belt, floating and at all times": which brain is answering is a fact he
// checks before he sends, and until now it was one tap away inside the Model command.
//
// IT FLOATS ON THE MIRROR'S BOTTOM EDGE, one row with two ends, inside the same `relative` box the terminal-draft
// notice's slot pins to (agent-chat.tsx). Absolute, so it changes the height of nothing: not the
// scroller, not the card dock, not the chrome block (DESIGN.md §2). It is not a floating LAYER in the
// sense of ui/sheet.tsx: it is anchored to the pane, scrolls with nothing, takes no touch
// (`pointer-events-none`, so a tap on it reaches the mirror under it) and holds no control. The
// model and the usage end the row at the RIGHT, because terminal and chat text both start at the left and
// the centre belongs to the jump-to-latest button; the tricks' status chips start it at the LEFT (below).
// Each end is its own small ground, so the empty space between them shows the mirror, not a bar. Under the
// notice slot's `z-20`, so a draft notice covers it while it shows.
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
// THE TRICKS' STATUS ITEMS START THE ROW AT THE LEFT (M94 re-cut, the `status` place; the left end since
// 2026-11-18, the operator: "there is some empty space as it is"): one chip per trick, in manifest order, in
// the same type and the same gap (components/trick-status-item.tsx). The right end never moves when a chip
// comes, goes or changes width: it is pinned to the right edge, and the chips take the room to its left.
// The empty space between the two ends gives way first, down to {@link BETWEEN} px.
// A chip KEEPS ITS PLACE (the operator, 2026-11-17: his Claude rows are full at 360px, and the chip he
// asked for was always the one hidden). When the row is full, the MODEL NAME gives way first: `Opus 5.5 · medium`, then `Opus 5.5`, then the name cut with an ellipsis. The figures keep
// their own rule (the window count). Only when the chips are more than the row holds, with the name down
// to its floor, does the last chip hide, then the one before it (lib/tricks/status.ts holds the rule,
// {@link useStatusFit} measures). A hidden item stays in the tree, invisible and inert and out of the
// reading order, so its width is still measured and it returns the moment there is room. A trick item
// may take a tap, so it takes touches back the way the notice slot does; the tag itself still takes none.

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

// The right end's widest share of the mirror box it floats in is 70% of the box: `max-w-[calc((100%+24px)*0.7)]` below, since the row is 24px less than the box.
/** The row's inset from the mirror box on each side, `inset-x-3`, in px. */
const ROW_INSET = 24;
/** The padding of the two ends, `px-1` on both sides of each, in px. Counted for both even when the left end is empty. */
const ENDS_PADDING = 16;
/** The least gap between the chips at the left end and the model and usage at the right end, in px (`gap-2`). */
const BETWEEN = 8;
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

/** What the measure decides: how many trick items show, and which form of the model name (0 is the full one). */
interface StatusFitState {
  shown: number;
  form: number;
}

/**
 * How the row fits, measured from the DOM after every render and, where there is a `ResizeObserver` (not
 * jsdom), whenever the mirror box, the Collie group or an item changes size. `key` names the items, so the
 * observer follows them when they change. Returns the trick items to show, from the first, and the form of
 * the model name. Both forms of the name stay in the tree (the hidden one invisible), so each width is
 * known whichever is drawn.
 */
function useStatusFit(key: string, gap: number, count: number, tagRef: RefObject<HTMLDivElement | null>, ownRef: RefObject<HTMLSpanElement | null>, itemsRef: RefObject<HTMLSpanElement | null>): StatusFitState {
  const [fit, setFit] = useState<StatusFitState>({ shown: count, form: 0 });
  const measure = useCallback(() => {
    const box = tagRef.current?.parentElement;
    const items = itemsRef.current;
    if (box === null || box === undefined || items === null) return;
    const room = box.clientWidth - ROW_INSET - ENDS_PADDING;
    const mine = ownRef.current === null ? [] : [...ownRef.current.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    const others = mine.filter((el) => el.dataset.slot !== "usage-label");
    const fixed = others.reduce((sum, el) => sum + naturalWidth(el), 0) + gap * Math.max(0, others.length - 1);
    const name = ownRef.current?.querySelector<HTMLElement>("[data-slot='usage-name']");
    const effort = ownRef.current?.querySelector<HTMLElement>("[data-slot='usage-effort']");
    const forms = name === null || name === undefined ? [] : effort === null || effort === undefined ? [name.offsetWidth] : [name.offsetWidth + effort.offsetWidth, name.offsetWidth];
    const widths = [...items.children].filter((el): el is HTMLElement => el instanceof HTMLElement).map((el) => el.offsetWidth);
    const next = fitStatusRow({ room, fixed, gap, forms, widths, between: BETWEEN });
    setFit((was) => (was.shown === next.count && was.form === next.form ? was : { shown: next.count, form: next.form }));
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
  return { shown: Math.min(fit.shown, count), form: count === 0 ? 0 : fit.form };
}

/** The short label and the spoken sentence of the two windows this build words itself. */
const WINDOW_KEYS = new Map<string, { short: MessageKey; spoken: MessageKey }>([
  ["5h", { short: "chat.usage.window.5h", spoken: "chat.usage.window.5h.aria" }],
  ["7d", { short: "chat.usage.window.7d", spoken: "chat.usage.window.7d.aria" }],
]);

/** The key prefix of a weekly window scoped to a model: `7d:opus`. Mirrors `scopedWindowKey` in bridge/usage.ts. */
const SCOPED_PREFIX = "7d:";

/**
 * Windows drawn in the row, after the context. A fourth would take the model name's room on a 360px
 * phone, so the rest are counted (`+1`) and the screen reader still hears every one.
 */
const WINDOWS_DRAWN = 3;

/** The longest harness label drawn beside a window, in characters; a longer one ends in an ellipsis. */
const LABEL_DRAWN_MAX = 10;

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
  /** True for a subscription window, false for the context. */
  window: boolean;
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

/** A harness label cut to what the row draws. */
function drawnLabel(label: string): string {
  return label.length > LABEL_DRAWN_MAX ? `${label.slice(0, LABEL_DRAWN_MAX - 1)}\u2026` : label;
}

/**
 * The gauge of one window the harness reported. `5h` and `7d` keep their own words; a `7d:<scope>`
 * window is the `7d` text and its label (`7d Opus`); any other window shows its label, else its key.
 * Every window is drawn, none is skipped for being unknown (an older phone skipped them).
 */
function windowGauge(limit: UsageLimit): Gauge {
  const percent = wholePercent(limit.used);
  const keys = WINDOW_KEYS.get(limit.window);
  if (keys !== undefined) return { id: limit.window, window: true, short: t(keys.short), spoken: t(keys.spoken, { percent }), used: limit.used };
  if (limit.window.startsWith(SCOPED_PREFIX)) {
    const label = limit.label ?? limit.window.slice(SCOPED_PREFIX.length);
    const week = WINDOW_KEYS.get("7d");
    const short = week === undefined ? "7d" : t(week.short);
    return { id: limit.window, window: true, short: `${short} ${drawnLabel(label)}`, spoken: t("chat.usage.window.7d.scoped.aria", { label, percent }), used: limit.used };
  }
  const label = limit.label ?? knownWindowName(limit.window) ?? limit.window;
  return { id: limit.window, window: true, short: drawnLabel(label), spoken: t("chat.usage.window.other.aria", { label, percent }), used: limit.used };
}

/** The gauges, in order: the context, then every window the harness reported. */
function gaugesOf(usage: PaneUsage | undefined): Gauge[] {
  if (usage === undefined) return [];
  const gauges: Gauge[] = [];
  if (isReading(usage.context)) {
    gauges.push({ id: "context", window: false, short: t("chat.usage.context"), spoken: t("chat.usage.context.aria", { percent: wholePercent(usage.context) }), used: usage.context });
  }
  for (const limit of usage.limits ?? []) {
    if (!isReading(limit.used) || limit.window === "") continue;
    gauges.push(windowGauge(limit));
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
    <span data-slot="usage-percent" data-hot={hot || undefined} className={cn(USAGE_FIGURE, hot && "text-status-blocked")}>
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
  const { shown, form } = useStatusFit(items.map((item) => item.id).join(" "), ITEM_GAPS[usageRow].px, items.length, tagRef, ownRef, itemsRef);
  const name = modelLabel(model);
  const heard = gaugesOf(usage);
  // The row draws the context and the first few windows; the rest are counted, and every one is still spoken.
  const windows = heard.filter((g) => g.window);
  const gauges = [...heard.filter((g) => !g.window), ...windows.slice(0, WINDOWS_DRAWN)];
  const more = windows.length - WINDOWS_DRAWN;
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
  const spoken = [label === null ? null : t("chat.model.aria", { name: label }), tokens?.spoken ?? null, ...heard.map((g) => g.spoken),
    cost === null ? null : t("chat.usage.cost.aria", { amount: formatCost(cost) }),
  ].filter(
    (part): part is string => part !== null,
  );
  return (
    <div
      ref={tagRef}
      data-slot="model-tag"
      className={cn("pointer-events-none absolute inset-x-3 bottom-1 z-10", USAGE_TYPE)}
    >
      <span className="flex items-center justify-between gap-2 whitespace-nowrap">
        {items.length > 0 && (
          <span ref={itemsRef} data-slot="usage-trick-items" className={cn("flex min-w-0 items-center overflow-x-clip rounded-[2px]", shown > 0 && "bg-background/90 px-1", ITEM_GAPS[usageRow].className)}>
            {items.map((item, i) => (
              <span
                key={item.id}
                data-status-item={item.id}
                data-hidden={i >= shown || undefined}
                inert={i >= shown || undefined}
                className={cn("flex shrink-0 items-center", i >= shown && "invisible absolute bottom-0 left-0")}
              >
                {item.face}
              </span>
            ))}
          </span>
        )}
        {(label !== null || gauges.length > 0 || drawnTokens !== null || cost !== null) && (
          <span ref={ownRef} aria-hidden data-slot="usage-own" className={cn("ml-auto flex max-w-[calc((100%+24px)*0.7)] shrink-0 items-center rounded-[2px] bg-background/90 px-1", ITEM_GAPS[usageRow].className)}>
            {name !== null && (
              <span data-slot="usage-label" className="min-w-0 truncate">
                <span data-slot="usage-name">{name}</span>
                {level !== null && (
                  <span data-slot="usage-effort" data-hidden={form > 0 || undefined} className={cn(form > 0 && "invisible absolute")}>
                    {` · ${level}`}
                  </span>
                )}
              </span>
            )}
            {drawnTokens !== null && (
              <span data-gauge="context" data-slot="usage-tokens" className="flex shrink-0 items-center gap-0.5">
                <span>{drawnTokens.short}</span>
                <span className={USAGE_FIGURE}>{drawnTokens.text}</span>
              </span>
            )}
            {gauges.map((g) => (
              <span key={g.id} data-gauge={g.id} className={cn("flex shrink-0 items-center", usageRow === "percent" ? "gap-0.5" : "gap-[3px]")}>
                <span>{g.short}</span>
                <Meter used={g.used} mode={usageRow} />
              </span>
            ))}
            {more > 0 && (
              <span data-slot="usage-more" aria-hidden className={cn("shrink-0", USAGE_FIGURE)}>
                +{more}
              </span>
            )}
            {cost !== null && (
              <span data-slot="usage-cost" className={cn("shrink-0", USAGE_FIGURE)}>
                {formatCost(cost)}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="sr-only">{spoken.join(". ")}</span>
    </div>
  );
}
