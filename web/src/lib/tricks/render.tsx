// THE VIEW, DRAWN WITH COLLIE'S OWN PRIMITIVES (M94 slice 02, re-cut on the Tree UI kinds in step 3).
//
// A trick says WHAT to show in the tree's closed vocabulary (lib/tricks/schema.ts, sixteen kinds);
// this file decides HOW, so the look stays Collie's: the house corner, the tone map onto the status
// tokens, the UI face for labels, `font-content` for what the trick wrote, `font-mono` for a `line`
// and a `code`, and the 44px floor on every control (DESIGN.md sections 3, 5, 6, 13). There is no
// colour, size, font or CSS in a node, so there is none to forward. A `style` word inks through the
// same tone map (red is `danger`, green `ok`, yellow `warn`), never the terminal's palette.
//
// A VIEW IS A LIST. The part's frame draws its nodes top to bottom with the flow gap; a `card` and a
// `group` flow their kids the same way, and a `bar` is the one row.
//
// FIXED HEIGHTS. Every leaf states its own height from `layout.ts` and clips inside it: a `para` its
// lines (from its text's length), a `code` its `max` lines, a `row` one or two lines, a `number`, a
// `meter`, a `chip` and a step strip one height each. A container is the sum of its kids, so a data
// change repaints and a shape change waits while a finger is down (part-frame.tsx). In a place with
// no fixed band (`ctx.wrap`, a Decision's view on the hill) each height is a floor instead, and words
// that do not fit take another line rather than being cut (2026-11-10).
//
// A KIND THIS COLLIE DOES NOT KNOW (a crew member on a newer version) draws the one placeholder: a box
// of the tap floor's height that says "This Collie cannot draw this part".
//
// TAPS. A `button` sends its intent through `ctx.onTap` with the part's key, its `value`, and the
// CONTROL: the node's path in the view, so the busy and unknown states land on the control that was
// pressed and on no other. A `button` with `confirm` arms on the first tap and sends on the second
// (VOCABULARY.md 2.8). A `button` with `does: copy` copies its `value` on the phone and sends nothing.
// A `row` with `href` and a `link` go to `ctx.onLink`: an http(s) address opens in the browser, a
// session's scope key opens that Session. Nothing a trick draws can write into a reply box.
//
// PICTURES (2026-11-10). An `image` with a `ref` and a `compare` draw the Decision's own pictures through
// `ctx.pictures`, which the place hands in (a Decision card: the bytes come with the pairing token, and a
// tap opens them at full size). The renderer owns the layout (the frame's shape, the crop, the labels),
// the place owns the bytes and the sheet. Without `ctx.pictures` such an image draws the placeholder.

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { Icon as KeyIcon } from "../../components/icons/icon";
import type { IconKey } from "../../components/icons/keys";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Collapse } from "../../components/ui/collapse";
import { CopyableBlock } from "../../components/ui/copyable-block";
import { DiffLines } from "../../components/ui/diff-lines";
import { FocusFrame, FocusImage, type FocusCrop } from "../../components/ui/focus-image";
import { ListGroup } from "../../components/ui/list-group";
import { MiniTable, type MiniTableColumn } from "../../components/ui/mini-table";
import { OneOf } from "../../components/ui/one-of";
import { OverflowEdges } from "../../components/ui/overflow-edges";
import { Progress } from "../../components/ui/progress";
import { SectionLabel } from "../../components/ui/section-label";
import { SparkLine } from "../../components/ui/spark-line";
import { useArm } from "../../hooks/use-arm";
import { copyText } from "../clipboard";
import { t } from "../i18n";
import { setStatus } from "../status";
import { cn } from "../utils";
import { useBridgeNow } from "./clock";
import { keyGlyph, trickIconOf, type TrickGlyph } from "./icons";
import { codeLines, groupHasHead, heightCss, isStepStrip, kidsOf, LEAF_REM, paraLines, reservedHeight, stripFitsOneRow, tableGrid, textOf } from "./layout";
import {
  CUTS,
  TONES,
  isEpochMs,
  isLinkSessionKey,
  isTrickUrl,
  readFocus,
  readSparkValues,
  type BarNode,
  type ButtonNode,
  type CardNode,
  type ChipNode,
  type ChipState,
  type Clock,
  type CodeNode,
  type CompareNode,
  type DiffNode,
  type GroupNode,
  type ImageFit,
  type ImageNode,
  type LineNode,
  type LinkNode,
  type ListNode,
  type MeterNode,
  type NumberNode,
  type ParaNode,
  type RowNode,
  type RunNode,
  type SpacerNode,
  type SparkNode,
  type TableNode,
  type TapValue,
  type Tone,
  type View,
  type ViewNode,
} from "./schema";
import type { TapState } from "./store";
import { clockText } from "./time";
import { inkOf } from "./tone";

/**
 * Where a row's `href` or a link takes the person: an http(s) address, opened in the browser, or a
 * real session's scope key, opened one level down. The renderer's own, not the wire's.
 */
export type LinkTarget = { url: string; session?: undefined } | { session: string; url?: undefined };

/** One of the Decision's pictures, as the place knows it: its shape when the wire gave it, and its words. */
export interface ViewPicture {
  width: number | null;
  height: number | null;
  /** The picture's own words (its caption on the wire), or "Image 2 of 3". */
  alt: string;
}

/** What the renderer asks the place to draw for one picture: the frame's shape and the crop are the renderer's. */
export interface ViewPictureDraw {
  /** The pictures a tap pages through, by `ref`, and which of them this frame draws. */
  refs: readonly number[];
  index: number;
  fit: ImageFit;
  crop?: FocusCrop;
  /** The frame's ratio as CSS (`"600 / 360"`) and its cap, which the renderer chose. */
  ratio: string;
  maxHeight: string;
  /** The frame's own width, as CSS, when it is narrower than its column. */
  width?: string;
}

/** The Decision's pictures, which a view's `image` and `compare` name by `ref` (a Decision card hands these in). */
export interface ViewPictures {
  /** The picture at `ref`, or undefined when the Decision holds none there. */
  at: (ref: number) => ViewPicture | undefined;
  /** One picture in its frame, cropped; a tap opens it at full size, paging through `refs`. */
  draw: (picture: ViewPictureDraw) => ReactNode;
}

/** What a view needs from the place that mounts it. */
export interface RenderCtx {
  /** The `partKey` of the part this view belongs to. */
  partKey: string;
  /** The part is past its fresh window: every status tone draws grey. */
  stale: boolean;
  /** The last tap on this part, from the store. */
  tap?: TapState;
  /** A button was tapped. `control` names it inside the part, so only it draws busy. */
  onTap: (partKey: string, intent: string, value: TapValue | undefined, control: string) => void;
  /** A row's `href` or a link was tapped. */
  onLink: (target: LinkTarget) => void;
  /**
   * The bridge's URL of an image of the trick folder (`image.src`). Absent, or `undefined` for a src:
   * the image's reserved box draws its `alt` words and fetches nothing.
   */
  imageUrl?: (src: string) => string | undefined;
  /** The Decision's own pictures, for an `image` with a `ref` and a `compare`. Absent outside a Decision's view. */
  pictures?: ViewPictures;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. Absent: it ticks. */
  now?: number;
  /**
   * The host a web link or a web row goes to, drawn small after the link's words and in the row's end slot
   * (a Decision's view on the hill, where the words are the poster's and the host is the truth). Absent:
   * a link or a row draws its words alone.
   */
  hostOf?: (href: string) => string;
  /**
   * The view sits in no fixed band (a Decision's view on the hill): a leaf's reserved height is a floor,
   * not a cap, so words that do not fit take another line instead of being cut. A bar wraps its kids, a
   * step strip of words wraps as chips, a row's title, second line and `end` wrap, a para shows all its
   * lines, and a number's, a meter's, a spacer's and a group's label wrap. Absent (a trick's Session, a
   * fixed band): every leaf keeps the height `layout.ts` gives it and cuts what does not fit, with the
   * whole words in a `title`.
   */
  wrap?: boolean;
  /**
   * Turns the free text of a `line`, a `para`, a plain `run`, a `row`'s title, second line and `end`, a
   * `table` cell and a picture's caption into what the place draws for it (an agent view: web addresses and
   * printed paths as links). It returns the text itself when it has nothing to link. NO DEFAULT: absent
   * (a trick's Session, a Decision on the hill, the playground), every one of those texts draws as it
   * always did, and no text ever becomes a link on its own. It is never applied to a button, a chip, a
   * link or a run that has an `href`, nor to a row that is itself a link: an anchor does not nest.
   */
  linkText?: (text: string) => ReactNode;
  /**
   * The words an armed `confirm` button shows, in the place's own voice: given the button's label, the
   * sentence that says what the second tap does (an agent view: Collie's "Tap again", so the armed state
   * is never the agent's `confirm` word alone). NO DEFAULT: absent, an
   * armed button shows its `confirm` word, as it always did.
   */
  armedLabel?: (label: string) => string;
}

/** The words of a free text as the place draws them: through `ctx.linkText` when it has one, else as they are. */
function wordsOf(ctx: RenderCtx, text: string): ReactNode {
  return ctx.linkText === undefined ? text : ctx.linkText(text);
}

/** A row's or a link's `href` as a target, or `undefined` for one this Collie cannot open (the bridge checked it). */
export function linkTargetOf(href: string): LinkTarget | undefined {
  if (isTrickUrl(href)) return { url: href };
  if (isLinkSessionKey(href)) return { session: href };
  return undefined;
}

/** The placeholder's words, in the one box every undrawable node gets. */
export function Placeholder({ kind }: { kind?: string }) {
  return (
    <div
      data-trick-node="placeholder"
      data-kind={kind}
      style={{ height: `${LEAF_REM.tap}rem` }}
      className="flex min-w-0 items-center rounded-sm border border-border px-3 text-xs text-muted-foreground"
    >
      <span className="truncate">{t("tricks.placeholder")}</span>
    </div>
  );
}

/** The props of a leaf's own box. */
interface LeafBoxProps {
  "data-trick-node": string;
  style: CSSProperties;
}

/** A leaf's own box: its kind for a test and a reader, and its reserved height. */
function leafBox(node: ViewNode): LeafBoxProps {
  return { "data-trick-node": node.kind, style: { height: heightCss(reservedHeight(node)) } };
}

/** A leaf's box in a view that wraps: its reserved height as a floor, so its words may take more lines. */
function floorBox(node: ViewNode, ctx: RenderCtx): LeafBoxProps {
  const box = leafBox(node);
  return ctx.wrap === true ? { ...box, style: { minHeight: box.style.height } } : box;
}

/** Collie's enter for a node that arrives in a list or a flow: fade and rise, 160 ms (VOCABULARY.md 6). */
const ENTER = "animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none";

// ── style words ───────────────────────────────────────────────────────────────────────────────

/** The `fg-*` words, inked through the tone map: a trick's red is the danger token, never the terminal's red. */
const FG_TONE = new Map<string, Tone>([
  ["fg-red", "danger"],
  ["fg-bright-red", "danger"],
  ["fg-green", "ok"],
  ["fg-bright-green", "ok"],
  ["fg-yellow", "warn"],
  ["fg-bright-yellow", "warn"],
  ["fg-bright-black", "muted"],
]);

/** The syntax inks, onto the syntax tokens the Files view draws code with. */
const SYN_CLASS = new Map<string, string>([
  ["syn-keyword", "text-syntax-keyword"],
  ["syn-string", "text-syntax-string"],
  ["syn-number", "text-syntax-constant"],
  ["syn-const", "text-syntax-constant"],
  ["syn-type", "text-syntax-entity"],
  ["syn-func", "text-syntax-property"],
  ["syn-comment", "text-syntax-comment"],
  ["syn-punct", "text-muted-foreground"],
]);

const MARK_CLASS = new Map<string, string>([
  ["bold", "font-semibold"],
  ["dim", "opacity-70"],
  ["italic", "italic"],
  ["underline", "underline underline-offset-2"],
  ["strike", "line-through"],
]);

/**
 * The classes of a `style`. A word with no drawing here (a `bg-*`, `inverse`, `box`, an `fg-*` with no
 * tone) draws as the surface's ink: the terminal palette is the mirror's, authored for a dark ground.
 */
function styleClass(style: string | undefined, stale: boolean): string {
  if (style === undefined) return "";
  return cn(
    style.split(" ").map((word) => {
      const tone = FG_TONE.get(word);
      if (tone !== undefined) return inkOf(tone, stale);
      return SYN_CLASS.get(word) ?? MARK_CLASS.get(word) ?? "";
    }),
  );
}

// ── the busy and unknown states of a control ──────────────────────────────────────────────────

type ControlState = "rest" | "busy" | "unknown";

function controlState(ctx: RenderCtx, control: string): ControlState {
  if (ctx.tap?.control !== control) return "rest";
  if (ctx.tap.phase === "busy") return "busy";
  if (ctx.tap.phase === "unknown") return "unknown";
  return "rest";
}

/** The part is busy on SOME control: a second tap anywhere in it does nothing until the reply lands. */
function partBusy(ctx: RenderCtx): boolean {
  return ctx.tap?.phase === "busy";
}

/** Collie's busy glyph: the spinner, in the glyph's own box (the belt's busy state, components/harness-bar.tsx). */
function Spinner() {
  return <KeyIcon name="busy" aria-hidden data-slot="trick-button-busy" className="size-4 shrink-0 animate-spin" />;
}

// ── badge ─────────────────────────────────────────────────────────────────────────────────────

/** A `badge`: a count, or a dot when the value is empty. In the ink of what it sits on, never a status colour. */
function BadgeMark({ badge }: { badge: string | undefined }) {
  if (badge === undefined) return null;
  if (badge === "") return <span aria-hidden data-slot="trick-badge" data-dot="" className="size-1.5 shrink-0 rounded-full bg-current" />;
  return (
    <span data-slot="trick-badge" className="shrink-0 text-[11px] leading-none font-semibold tabular-nums">
      {badge}
    </span>
  );
}

// ── clocks ────────────────────────────────────────────────────────────────────────────────────

/** A tree clock (`at` and `clock`), ticking on the bridge's clock. Its own component, so only a clock subscribes. */
export function TrickClock({ at, clock, now }: { at: string; clock: Clock; now?: number }) {
  const ticking = useBridgeNow(now);
  const text = clockText(at, clock, ticking);
  // An instant past the schema's bound throws a RangeError in `toISOString`: it draws an empty clock.
  const iso = isEpochMs(at) ? new Date(Number(at)).toISOString() : undefined;
  return (
    <time dateTime={iso} data-clock={clock} className="tabular-nums">
      {text ?? ""}
    </time>
  );
}

// ── button ────────────────────────────────────────────────────────────────────────────────────

/** Copy a button's `value` on the phone. Called straight from the tap, inside the user gesture. */
function copyValue(value: string): void {
  copyText(value).then(
    () => setStatus(t("tricks.copied"), "success"),
    () => setStatus(t("tricks.copyFailed"), "error"),
  );
}

function ButtonView({ node, ctx, path, compact = false }: { node: ButtonNode; ctx: RenderCtx; path: string; compact?: boolean }) {
  const { attrs } = node;
  const state = controlState(ctx, path);
  const busy = state === "busy";
  // ARM, THEN ACT: the shared second-tap confirm (hooks/use-arm.ts), so a trick's button keeps the
  // belt's Stop window and its dwell; one key, as the button holds one confirm.
  const arm = useArm<"confirm">();
  const armed = arm.armed === "confirm";
  const Icon = attrs.icon === undefined ? null : trickIconOf(attrs.icon);
  const armedWords = attrs.confirm === undefined ? undefined : (ctx.armedLabel?.(attrs.label) ?? attrs.confirm);
  const label = armed && armedWords !== undefined ? armedWords : attrs.label;
  const ink = armed ? inkOf("danger", false) : inkOf(attrs.tone, ctx.stale);
  const disabled = attrs.disabled !== undefined;
  const onClick = () => {
    if (attrs.does === "copy") {
      if (attrs.value !== undefined) copyValue(attrs.value);
      return;
    }
    if (attrs.intent === undefined) return;
    if (attrs.confirm !== undefined && arm.tap("confirm") !== "fire") return;
    ctx.onTap(ctx.partKey, attrs.intent, attrs.value, path);
  };
  // THE LABEL STAYS WHILE BUSY: a person reads what is running, not a lone spinner. With a glyph, the
  // glyph turns into the spinner in its own box. Without one, the busy cell is the spinner AND the
  // label in one grid cell with the label alone (ui/one-of.tsx), so the button never moves. "Unknown"
  // and the armed `confirm` label take the same cell.
  const words = (
    <OneOf
      active={state === "unknown" ? "unknown" : busy && Icon === null ? "busy" : armed ? "confirm" : "label"}
      className="min-w-0 justify-items-center"
      options={[
        { key: "label", node: <span className="truncate">{attrs.label}</span> },
        ...(armedWords === undefined ? [] : [{ key: "confirm", node: <span className="truncate">{armedWords}</span> }]),
        { key: "unknown", node: <span className="truncate">{t("tricks.tap.unknown")}</span> },
        ...(Icon === null
          ? [
              {
                key: "busy",
                node: (
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Spinner />
                    <span className="truncate">{attrs.label}</span>
                  </span>
                ),
              },
            ]
          : []),
      ]}
    />
  );
  const name = state === "unknown" ? `${label}, ${t("tricks.tap.unknown")}` : armed ? label : undefined;
  return (
    <div {...leafBox(node)} className={cn("flex min-w-0 items-center", compact && "shrink-0")}>
      <Button
        type="button"
        variant="outline"
        aria-busy={busy}
        aria-label={name}
        aria-pressed={attrs.pressed === undefined ? undefined : attrs.pressed}
        title={disabled && attrs.disabled !== "" ? attrs.disabled : attrs.hint}
        data-armed={armed ? "" : undefined}
        disabled={disabled || (partBusy(ctx) && attrs.does === undefined)}
        onClick={onClick}
        className={cn("h-11 min-w-0 transition-colors", compact ? "px-3" : "w-full px-4", attrs.hint !== undefined && "h-full flex-col gap-0 py-1.5", ink)}
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-2">
          {Icon !== null && (busy ? <Spinner /> : <Icon aria-hidden />)}
          {words}
          <BadgeMark badge={attrs.badge} />
        </span>
        {attrs.hint !== undefined && <span className="max-w-full truncate text-xs font-normal text-muted-foreground">{attrs.hint}</span>}
      </Button>
    </div>
  );
}

// ── chip and the step strip ───────────────────────────────────────────────────────────────────

/** A chip state as a glyph, never a status shape: a trick's chip is not "an agent needs you" (ADR 0063). */
const STATE_KEY = {
  done: "mod-step-done",
  working: "mod-step-running",
  waiting: "mod-paused",
  idle: "mod-step-todo",
  gone: "mod-step-failed",
} as const satisfies { readonly [S in ChipState]: IconKey };
const STATE_GLYPH = {
  done: keyGlyph(STATE_KEY.done),
  working: keyGlyph(STATE_KEY.working),
  waiting: keyGlyph(STATE_KEY.waiting),
  idle: keyGlyph(STATE_KEY.idle),
  gone: keyGlyph(STATE_KEY.gone),
} as const satisfies { readonly [S in ChipState]: TrickGlyph };
/** A chip state's ink when the chip names no tone. */
const STATE_TONE = { done: "ok", working: "accent", waiting: "warn", idle: "muted", gone: "muted" } as const satisfies { readonly [S in ChipState]: string };

function chipTone(node: ChipNode): string | undefined {
  return node.attrs?.tone ?? (node.attrs?.state === undefined ? undefined : STATE_TONE[node.attrs.state]);
}

/**
 * One chip. `step` is a chip on the strip's one row: its words are never cut (the strip scrolls
 * sideways instead), it fills its step's column, and it sits closer to its glyph, so the Tag trick's
 * seven numbered gates fit a 360 px phone.
 */
function ChipView({ node, ctx, step = false }: { node: ChipNode; ctx: RenderCtx; step?: boolean }) {
  const attrs = node.attrs;
  const [full, setFull] = useState(false);
  const ink = inkOf(chipTone(node), ctx.stale);
  const Glyph = attrs?.icon !== undefined ? trickIconOf(attrs.icon) : attrs?.state === undefined ? null : STATE_GLYPH[attrs.state];
  const text = node.text ?? "";
  const short = attrs?.short;
  const shown = short !== undefined && !full ? short : text;
  const body = (
    <>
      {Glyph !== null && <Glyph aria-hidden className={cn("size-3 shrink-0", ink)} />}
      {shown !== "" && <span className={step ? "whitespace-nowrap" : "min-w-0 truncate"}>{shown}</span>}
      {attrs?.at !== undefined && attrs.clock !== undefined && <TrickClock at={attrs.at} clock={attrs.clock} now={ctx.now} />}
    </>
  );
  const frame = cn(
    "inline-flex h-6 items-center rounded-sm border text-xs transition-colors",
    step ? "w-full justify-center gap-0.5 px-1" : "max-w-full min-w-0 gap-1 px-2",
    attrs?.current === undefined ? "border-border" : "border-current font-semibold",
    ink,
    ENTER,
  );
  // `short` is the chip's narrow words; the full `text` shows on a tap (VOCABULARY.md 2).
  if (short !== undefined) {
    return (
      <button
        type="button"
        data-trick-node="chip"
        aria-label={text}
        aria-current={attrs?.current === undefined ? undefined : "step"}
        aria-expanded={full}
        onClick={() => setFull((was) => !was)}
        className={frame}
      >
        {body}
      </button>
    );
  }
  return (
    <span data-trick-node="chip" aria-current={attrs?.current === undefined ? undefined : "step"} className={frame}>
      {body}
    </span>
  );
}

const STATE_WORD = {
  done: "tricks.state.done",
  working: "tricks.state.working",
  waiting: "tricks.state.waiting",
  idle: "tricks.state.idle",
  gone: "tricks.state.gone",
} as const satisfies { readonly [S in ChipState]: string };

/** A step's segment of the track: full when done or waiting, half when working, the bare track when idle or gone. */
function StepSegment({ chip, ctx }: { chip: ChipNode; ctx: RenderCtx }) {
  const state = chip.attrs?.state ?? "idle";
  const filled = state === "done" || state === "working" || state === "waiting";
  return (
    <span data-slot="trick-strip-segment" data-state={state} className={cn("block h-1 overflow-hidden rounded-sm bg-muted", inkOf(chipTone(chip), ctx.stale))}>
      {filled && <span className={cn("block h-full rounded-sm bg-current transition-transform", state === "working" ? "w-1/2" : "w-full")} />}
    </span>
  );
}

/** The steps in words, for a screen reader: each step with its state, and which one is current. */
function StepWords({ chips }: { chips: readonly ChipNode[] }) {
  const steps = chips.filter((chip) => chip.attrs?.state !== undefined);
  const current = steps.findIndex((chip) => chip.attrs?.current !== undefined);
  return (
    <ol className="sr-only">
      {steps.map((chip, i) => (
        <li key={i} aria-current={i === current ? "step" : undefined}>
          {textOf(chip)}: {t(STATE_WORD[chip.attrs?.state ?? "idle"])}
        </li>
      ))}
      {current >= 0 && <li>{t("tricks.steps.of", { n: current + 1, m: steps.length })}</li>}
    </ol>
  );
}

function stripChips(node: BarNode): ChipNode[] {
  return kidsOf(node).filter((kid): kid is ChipNode => kid.kind === "chip");
}

/**
 * THE STEP STRIP: a `bar` of `chip` with `state` and `current` (the first schema's `steps`), in one
 * fixed height whatever its number. Each step is a column: its chip, and under it its segment of the
 * track, so a segment always sits under its own chip. A done segment is full, a working one half full,
 * a waiting one full in the warn ink, an idle or gone one the bare track; the chip's own `tone` wins
 * (a red step is `danger`). The columns share the width and each is at least as wide as its chip's
 * words: a chip is never cut, and a row wider than the place scrolls sideways inside its own height.
 * The whole list, with every state in words and the current step, is there for a screen reader.
 */
function StripView({ node, ctx }: { node: BarNode; ctx: RenderCtx }) {
  const chips = stripChips(node);
  return (
    <div
      {...leafBox(node)}
      data-strip=""
      role="group"
      aria-label={node.attrs?.label}
      className="min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div aria-hidden className="flex h-full w-max min-w-full gap-1">
        {chips.map((chip, i) => (
          <div key={i} data-slot="trick-strip-step" className="flex min-w-max flex-1 basis-0 flex-col justify-between">
            <ChipView node={chip} ctx={ctx} step />
            {chip.attrs?.state === undefined ? <span className="h-1" /> : <StepSegment chip={chip} ctx={ctx} />}
          </div>
        ))}
      </div>
      <StepWords chips={chips} />
    </div>
  );
}

/**
 * A step strip of WORDS in a view that wraps (a Decision's view): the chips wrap onto more rows as
 * plain chips with their state glyph, and no track, because a segment line under chips of different
 * widths on different rows would say nothing. One row stays the strip only for short labels
 * (`stripFitsOneRow`): "s…" and "qu…" were the defect this fixes (2026-11-10).
 */
function StepChipsView({ node, ctx }: { node: BarNode; ctx: RenderCtx }) {
  const chips = stripChips(node);
  return (
    <div data-trick-node="bar" data-steps-wrap="" role="group" aria-label={node.attrs?.label} style={{ minHeight: `${LEAF_REM.chip}rem` }} className="min-w-0">
      <div aria-hidden className="flex min-w-0 flex-wrap items-center gap-1.5">
        {chips.map((chip, i) => (
          <ChipView key={i} node={chip} ctx={ctx} />
        ))}
      </div>
      <StepWords chips={chips} />
    </div>
  );
}

// ── bar ───────────────────────────────────────────────────────────────────────────────────────

function BarView({ node, ctx, path }: { node: BarNode; ctx: RenderCtx; path: string }) {
  if (isStepStrip(node)) {
    // Words on a strip wrap where the place may grow; in a fixed band the strip keeps its row and scrolls.
    if (ctx.wrap === true && !stripFitsOneRow(node)) return <StepChipsView node={node} ctx={ctx} />;
    return <StripView node={node} ctx={ctx} />;
  }
  const scroll = node.attrs?.scroll === "x";
  const wrap = !scroll && ctx.wrap === true;
  const box = leafBox(node);
  // A bar that wraps reserves its one line as a floor and grows past it; one that does not keeps its line.
  const style = wrap ? { minHeight: box.style.height } : box.style;
  return (
    <div
      {...box}
      style={style}
      role="group"
      aria-label={node.attrs?.label}
      className={cn(
        "flex min-w-0 items-center gap-2",
        scroll && "overflow-x-auto overscroll-x-contain",
        wrap && "flex-wrap",
        !scroll && !wrap && "overflow-hidden",
        node.attrs?.role === "strip" && "border-y border-border",
      )}
    >
      {kidsOf(node).map((kid, i) => {
        const at = `${path}/${i}`;
        if (kid.kind === "button") {
          return (
            <div key={i} className={cn("min-w-0", scroll ? "shrink-0" : "flex-1")}>
              <ButtonView node={kid} ctx={ctx} path={at} />
            </div>
          );
        }
        if (kid.kind === "chip") return <ChipView key={i} node={kid} ctx={ctx} />;
        if (kid.kind === "link") return <LinkView key={i} node={kid} ctx={ctx} block />;
        return <Placeholder key={i} kind={kid.kind} />;
      })}
    </div>
  );
}

// ── link and run ──────────────────────────────────────────────────────────────────────────────

/**
 * An http(s) address as a real anchor (a long press can copy it), and a session as a button; both go
 * through `ctx.onLink`, so the place decides how a page and a Session open. An `href` this Collie
 * cannot read (another version's) draws as plain words.
 */
function Target({ href, ctx, className, children }: { href: string; ctx: RenderCtx; className: string; children: ReactNode }) {
  const target = linkTargetOf(href);
  if (target === undefined) return <span className={className}>{children}</span>;
  if (target.url !== undefined) {
    const open = (event: MouseEvent) => {
      event.preventDefault();
      ctx.onLink(target);
    };
    return (
      <a href={target.url} target="_blank" rel="noopener noreferrer" onClick={open} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={() => ctx.onLink(target)} className={cn(className, "text-left")}>
      {children}
    </button>
  );
}

const LINK_INK = "text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary";

/** A host in two pieces: the head that may give way, and the tail that always shows. */
export interface HostParts {
  head: string;
  tail: string;
}

/**
 * A host split where it may give way: the head (the sub-names) and the tail, the last two names
 * ("colliepwa.dev", "github.com"), which say where a tap goes. A host of two names or fewer is all tail.
 */
export function hostParts(host: string): HostParts {
  const names = host.split(".");
  if (names.length <= 2) return { head: "", tail: host };
  const tail = names.slice(-2).join(".");
  return { head: host.slice(0, host.length - tail.length), tail };
}

/**
 * A web link's host on one line, small and mono, in a box that may be narrower than it (a row's end
 * slot, a link in a bar). Only its HEAD gives way ("release-no…colliepwa.dev"); the tail always shows
 * whole, and the whole host is its `title`.
 */
function HostText({ host, className }: { host: string; className?: string }) {
  const { head, tail } = hostParts(host);
  return (
    <span data-trick-link-host="" title={host} className={cn("flex min-w-0 overflow-hidden font-mono text-[11px] text-muted-foreground", className)}>
      {/* At least the ellipsis' width, so a head with no room left reads "…" and never a stray letter. */}
      {head !== "" && <span className="min-w-[1ch] truncate">{head}</span>}
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}

/**
 * A host as words: it may break after each dot, and anywhere only when a name is longer than the line.
 * Inline after a link's words in a para, or `line`: a line of its own under a row's title.
 */
function HostWords({ host, line = false }: { host: string; line?: boolean }) {
  const names = host.split(".");
  return (
    <span data-trick-link-host="" title={host} className={cn("font-mono text-[11px] break-words text-muted-foreground", line ? "block leading-4" : "ml-1.5")}>
      {names.map((name, i) => (
        <span key={i}>
          {name}
          {i < names.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </span>
      ))}
    </span>
  );
}

function LinkView({ node, ctx, block = false }: { node: LinkNode; ctx: RenderCtx; block?: boolean }) {
  const Icon = node.attrs.icon === undefined ? null : trickIconOf(node.attrs.icon);
  const host = ctx.hostOf?.(node.attrs.href) ?? "";
  const link = (
    <Target
      href={node.attrs.href}
      ctx={ctx}
      className={cn(LINK_INK, block ? "inline-flex h-11 min-w-0 items-center gap-1.5 px-1 text-sm" : "inline items-baseline")}
    >
      {Icon !== null && <Icon aria-hidden className={cn("inline size-3.5 shrink-0", !block && "mr-1 align-[-2px]")} />}
      <span data-trick-node="link" className={block ? "truncate" : undefined}>
        {node.text}
      </span>
      {node.attrs.badge !== undefined && (
        <span className="ml-1 inline-flex align-middle">
          <BadgeMark badge={node.attrs.badge} />
        </span>
      )}
    </Target>
  );
  if (host === "") return link;
  // A link that is a box of its own keeps its host beside it on one line; the link's words give way
  // first, the host keeps at least its tail. Inside a para the host is words and may break anywhere.
  if (block) {
    return (
      <span className="flex max-w-full min-w-0 items-center gap-1">
        {link}
        <HostText host={host} className="max-w-[50%] shrink-0" />
      </span>
    );
  }
  return (
    <>
      {link}
      <HostWords host={host} />
    </>
  );
}

function RunView({ node, ctx }: { node: RunNode; ctx: RenderCtx }) {
  const attrs = node.attrs;
  const className = cn(styleClass(attrs?.style, ctx.stale), attrs?.code !== undefined && "rounded-sm bg-muted px-1 font-mono text-[0.9em]");
  const words = attrs?.at !== undefined && attrs.clock !== undefined ? <TrickClock at={attrs.at} clock={attrs.clock} now={ctx.now} /> : node.text;
  if (attrs?.href !== undefined) {
    return (
      <Target href={attrs.href} ctx={ctx} className={cn(className, LINK_INK)}>
        {words}
      </Target>
    );
  }
  return (
    <span data-trick-node="run" className={className}>
      {attrs?.at === undefined || attrs.clock === undefined ? wordsOf(ctx, node.text) : words}
    </span>
  );
}

/** A para's or a line's inline kids: runs and links. */
function Inline({ kids, ctx }: { kids: readonly ViewNode[] | undefined; ctx: RenderCtx }) {
  return (
    <>
      {(kids ?? []).map((kid, i) => {
        if (kid.kind === "run") return <RunView key={i} node={kid} ctx={ctx} />;
        if (kid.kind === "link") return <LinkView key={i} node={kid} ctx={ctx} />;
        return null;
      })}
    </>
  );
}

// ── para, line, code ──────────────────────────────────────────────────────────────────────────

const PARA_ROLE_CLASS = {
  body: "font-content text-sm leading-5",
  heading: "text-sm leading-5 font-semibold",
  quote: "font-content text-sm leading-5 italic text-muted-foreground border-l-2 border-border pl-3",
} as const;

function ParaView({ node, ctx }: { node: ParaNode; ctx: RenderCtx }) {
  const attrs = node.attrs;
  // In a view that wraps every line shows (the reserve is a floor). Else one line truncates and more
  // lines clamp at their count, so a long text never grows the box.
  const lines = ctx.wrap === true ? 0 : paraLines(node);
  const clamp: CSSProperties = lines <= 1 ? {} : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines };
  const role = attrs?.role ?? "body";
  return (
    <div {...floorBox(node, ctx)} className="flex min-w-0 gap-1.5 overflow-hidden">
      {attrs?.bullet !== undefined && <span className="w-4 shrink-0 font-content text-sm leading-5 text-muted-foreground tabular-nums">{attrs.bullet}</span>}
      <p style={clamp} className={cn(PARA_ROLE_CLASS[role], "min-w-0 flex-1 overflow-hidden", lines === 1 ? "truncate" : "break-words whitespace-pre-line")}>
        {attrs?.term !== undefined && <span className="font-semibold not-italic">{attrs.term} </span>}
        {node.text === undefined ? <Inline kids={node.kids} ctx={ctx} /> : wordsOf(ctx, node.text)}
      </p>
    </div>
  );
}

const LINE_ROLE_CLASS = { text: "", status: "font-semibold", note: "italic text-muted-foreground" } as const;

/** A box that scrolls sideways on its own, with no scrollbar drawn. */
const SIDEWAYS = "overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One screen line. `cut`: it truncates at its box; else it keeps its whole width and the box around it scrolls sideways. */
function LineBody({ node, ctx, cut = true }: { node: LineNode; ctx: RenderCtx; cut?: boolean }) {
  return (
    <span className={cn("block whitespace-pre [tab-size:4]", cut && "truncate", styleClass(node.attrs?.style, ctx.stale), LINE_ROLE_CLASS[node.attrs?.role ?? "text"])}>
      {node.text === undefined ? <Inline kids={node.kids} ctx={ctx} /> : wordsOf(ctx, node.text)}
    </span>
  );
}

/** A screen line is never wrapped (it is the screen's). In a view that wraps it scrolls sideways instead of being cut. */
function LineView({ node, ctx }: { node: LineNode; ctx: RenderCtx }) {
  if (ctx.wrap !== true) {
    return (
      <div {...leafBox(node)} className={cn("min-w-0 overflow-hidden font-mono text-xs leading-4", ENTER)}>
        <LineBody node={node} ctx={ctx} />
      </div>
    );
  }
  return (
    <div {...leafBox(node)} className={cn("flex min-w-0 font-mono text-xs leading-4", ENTER)}>
      <OverflowEdges cue="none">
        {(scroller) => (
          <div ref={scroller} className={cn("min-w-0 flex-1", SIDEWAYS)}>
            <LineBody node={node} ctx={ctx} cut={false} />
          </div>
        )}
      </OverflowEdges>
    </div>
  );
}

/**
 * A code block: its lines in mono, `max` lines reserved, scrolling on its own past them, and the
 * phone's copy button on it (`ui/copyable-block.tsx`), as every `code` has (VOCABULARY.md 2). A line
 * wider than the block is never cut: the block scrolls sideways inside its own frame, so the code is
 * whole and the card around it never grows wider than the screen.
 */
function CodeView({ node, ctx }: { node: CodeNode; ctx: RenderCtx }) {
  const lines = kidsOf(node).filter((kid): kid is LineNode => kid.kind === "line");
  const scrolls = lines.length > codeLines(node);
  return (
    <div {...leafBox(node)} data-lang={node.attrs?.lang} className="min-w-0">
      <CopyableBlock text={lines.map(textOf).join("\n")} className="h-full">
        {/* The sideways scroller ends at the gutter the copy button sits in, so no line runs under it. */}
        <pre
          className={cn(
            "flex h-full rounded-sm border border-border bg-muted/40 py-2 pr-9 pl-3 font-mono text-xs leading-4",
            scrolls ? "overflow-y-auto overscroll-contain" : "overflow-hidden",
          )}
        >
          <OverflowEdges cue="none" className="self-start">
            {(scroller) => (
              <div ref={scroller} data-slot="trick-code-lines" className={cn("min-w-0 flex-1", SIDEWAYS)}>
                {lines.map((line, i) => (
                  <div key={i} className="h-4 w-max min-w-full">
                    <LineBody node={line} ctx={ctx} cut={false} />
                  </div>
                ))}
              </div>
            )}
          </OverflowEdges>
        </pre>
      </CopyableBlock>
    </div>
  );
}

// ── image, meter, number, spacer ──────────────────────────────────────────────────────────────

/** The tallest a Decision's picture draws: a phone screenshot stops here and keeps its shape. */
const PICTURE_MAX_PX = 220;
/** The shape of a picture whose size the wire did not give. */
const UNKNOWN_RATIO = "16 / 10";

/** A picture's ratio as CSS, and as a number (height over width) to compare two by. */
interface PictureRatio {
  css: string;
  tall: number;
}

/** A picture's ratio, from its size when the wire gave one. */
function ratioOf(picture: Pick<ViewPicture, "width" | "height"> | undefined): PictureRatio {
  if (picture === undefined || picture.width === null || picture.height === null || picture.width <= 0 || picture.height <= 0) return { css: UNKNOWN_RATIO, tall: 10 / 16 };
  return { css: `${String(picture.width)} / ${String(picture.height)}`, tall: picture.height / picture.width };
}

/** An image's crop and fit, from its attributes. A `focus` this Collie cannot read is no crop. */
function cropOf(node: ImageNode): { fit: ImageFit; crop?: FocusCrop } {
  const crop = node.attrs.focus === undefined ? undefined : readFocus(node.attrs.focus);
  const fit: ImageFit = node.attrs.fit === "cover" ? "cover" : "contain";
  return crop === undefined ? { fit } : { fit, crop };
}

/** A caption under a picture: up to two lines, the whole words in `title`. */
function PictureCaption({ text, ctx }: { text: string; ctx: RenderCtx }) {
  return (
    <figcaption title={text} className="font-content line-clamp-2 text-[11px] leading-4 break-words text-muted-foreground">
      {wordsOf(ctx, text)}
    </figcaption>
  );
}

/** An image with its caption taken off: in a `compare` the caption is the label under the frame. */
function withoutCaption(node: ImageNode): ImageNode {
  const { caption: _caption, ...attrs } = node.attrs;
  return { kind: "image", attrs };
}

/** An image's `ref` as an index, or undefined. */
function refOf(node: ImageNode): number | undefined {
  const ref = node.attrs.ref;
  return ref !== undefined && /^\d+$/.test(ref) ? Number(ref) : undefined;
}

/**
 * One of the Decision's pictures among the facts: its own shape, never taller than PICTURE_MAX_PX and
 * never wider than the column, cropped by `focus`, its caption under it. A tap opens it at full size.
 */
function DecisionImageView({ node, at: ref, ctx }: { node: ImageNode; at: number; ctx: RenderCtx }) {
  const picture = ctx.pictures?.at(ref);
  if (ctx.pictures === undefined || picture === undefined) return <Placeholder kind="image" />;
  const { css } = ratioOf(picture);
  const draw: ViewPictureDraw = { refs: [ref], index: 0, ...cropOf(node), ratio: css, maxHeight: `${String(PICTURE_MAX_PX)}px`, width: `min(100%, calc(${String(PICTURE_MAX_PX)}px * ${css}))` };
  return (
    <figure data-trick-node="image" className="flex min-w-0 flex-col gap-1">
      {ctx.pictures.draw(draw)}
      {node.attrs.caption !== undefined && <PictureCaption text={node.attrs.caption} ctx={ctx} />}
    </figure>
  );
}

/**
 * An image of the trick folder, its box reserved from `w` and `h` before a byte arrives, so nothing
 * below it moves when it loads. It loads lazily from the bridge's URL, cropped by `focus`; with no URL
 * the box keeps its size and says its `alt`.
 */
function PartImageView({ node, ctx }: { node: ImageNode; ctx: RenderCtx }) {
  const { src = "", alt = "", w = "1", h = "1", caption } = node.attrs;
  const url = src === "" ? undefined : ctx.imageUrl?.(src);
  const { fit, crop } = cropOf(node);
  return (
    <figure data-trick-node="image" className="flex min-w-0 flex-col gap-1">
      <FocusFrame ratio={`${w} / ${h}`} style={{ maxWidth: `${w}px` }}>
        {url === undefined ? (
          <span className="line-clamp-3 px-3 text-center text-xs text-muted-foreground">{alt}</span>
        ) : (
          <FocusImage src={url} alt={alt} fit={fit} crop={crop} />
        )}
      </FocusFrame>
      {caption !== undefined && <PictureCaption text={caption} ctx={ctx} />}
    </figure>
  );
}

function ImageView({ node, ctx }: { node: ImageNode; ctx: RenderCtx }) {
  const ref = refOf(node);
  return ref === undefined ? <PartImageView node={node} ctx={ctx} /> : <DecisionImageView node={node} at={ref} ctx={ctx} />;
}

/**
 * Two pictures side by side at one height, each with its label under it ("Before" and "After" unless
 * its caption names it). Both frames take the taller of the two shapes, so they are one height and a
 * picture of another shape sits whole on the muted ground. Below 300 px of column they stack. A tap on
 * either opens it at full size, and the sheet pages to the other one.
 */
function CompareView({ node, ctx }: { node: CompareNode; ctx: RenderCtx }) {
  const images = kidsOf(node).filter((kid): kid is ImageNode => kid.kind === "image");
  if (images.length !== 2) return <Placeholder kind="compare" />;
  const refs = images.map(refOf);
  const labels = [t("tricks.compare.before"), t("tricks.compare.after")];
  const pictures = refs.map((ref) => (ref === undefined ? undefined : ctx.pictures?.at(ref)));
  // The taller shape of the two, so both frames share one height and neither picture is cut.
  const ratios = images.map((image, i) => (refs[i] === undefined ? ratioOf({ width: Number(image.attrs.w), height: Number(image.attrs.h) }) : ratioOf(pictures[i])));
  const tallest = ratios.reduce((a, b) => (b.tall > a.tall ? b : a));
  const known = refs.filter((ref): ref is number => ref !== undefined);
  return (
    <div data-trick-node="compare" className="@container min-w-0">
      <div className="grid grid-cols-2 gap-2 @max-[299px]:grid-cols-1">
        {images.map((image, i) => {
          const ref = refs[i];
          const label = image.attrs.caption ?? labels[i] ?? "";
          let frame: ReactNode;
          if (ref === undefined) frame = <PartImageView node={withoutCaption(image)} ctx={ctx} />;
          else if (ctx.pictures === undefined || pictures[i] === undefined) frame = <Placeholder kind="image" />;
          else frame = ctx.pictures.draw({ refs: known, index: known.indexOf(ref), ...cropOf(image), ratio: tallest.css, maxHeight: `${String(PICTURE_MAX_PX)}px` });
          return (
            <figure key={i} data-slot="trick-compare-side" className="flex min-w-0 flex-col gap-1">
              {frame}
              <figcaption title={label} className="truncate text-xs font-medium text-muted-foreground">
                {label}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A small table: its heads, then its rows. A column whose cells all read as figures keeps the end side
 * and tabular figures unless its head says `align`; a cell takes at most two lines and its tone's ink.
 * In a fixed band each row keeps two lines' height; in a view that wraps a row is as tall as its words.
 */
function TableView({ node, ctx }: { node: TableNode; ctx: RenderCtx }) {
  const grid = tableGrid(node);
  if (grid === undefined) return <Placeholder kind="table" />;
  const columns: MiniTableColumn[] = grid.cols.map((col) => ({ label: col.text, align: col.align }));
  const rows = grid.rows.map((row) => row.map((cell) => ({ text: cell.text ?? "", words: ctx.linkText === undefined ? undefined : wordsOf(ctx, cell.text ?? ""), className: inkOf(cell.attrs?.tone, ctx.stale) })));
  const fixed = ctx.wrap !== true;
  return (
    // In a view that wraps the rows take their words' height, so no floor is set at all.
    <div {...(fixed ? leafBox(node) : { "data-trick-node": "table" })} className="min-w-0 overflow-hidden">
      <MiniTable columns={columns} rows={rows} rowClassName={fixed ? "h-10" : undefined} />
    </div>
  );
}

/** A hunk of a diff, as the Changes view tints one: mono, scrolling sideways inside its own frame, or soft-wrapped with a mark in a view that wraps (a Decision's card). */
function DiffView({ node, ctx }: { node: DiffNode; ctx: RenderCtx }) {
  return (
    <div {...floorBox(node, ctx)} className="min-w-0">
      <DiffLines lines={node.text.split("\n")} file={node.attrs?.file} wrap={ctx.wrap === true} prose={node.attrs?.file?.endsWith(".md") === true} />
    </div>
  );
}

/** A number as a spark's screen reader says it: as written, up to six places, no trailing zeros. */
function figure(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * A trend: its label and its last figure on one line, the line under them, the last point marked. A
 * screen reader hears the label with the lowest, the highest and the last figure.
 */
function SparkView({ node, ctx }: { node: SparkNode; ctx: RenderCtx }) {
  const values = readSparkValues(node.attrs.values);
  if (values === undefined) return <Placeholder kind="spark" />;
  const label = node.attrs.label;
  const last = values.at(-1) ?? 0;
  const ink = inkOf(node.attrs.tone, ctx.stale);
  const aria = t("tricks.spark.aria", { label: label ?? t("tricks.spark.trend"), min: figure(Math.min(...values)), max: figure(Math.max(...values)), last: figure(last) });
  return (
    <div {...leafBox(node)} className="flex min-w-0 flex-col">
      <div aria-hidden className="flex h-4 min-w-0 items-center justify-between gap-3 text-xs leading-4">
        <span title={label} className="min-w-0 truncate text-muted-foreground">
          {label ?? ""}
        </span>
        <span className={cn("shrink-0 tabular-nums", ink)}>{figure(last)}</span>
      </div>
      <SparkLine values={values} label={aria} className={ink === "" ? "text-foreground" : ink} />
    </div>
  );
}

/**
 * A meter: a measure (`role` `meter`) or a task (`role` `progress`), its label and its percent on one
 * line over Collie's bar. A progress with no `value` is indeterminate: the track, no fill, no figure.
 */
function MeterView({ node, ctx }: { node: MeterNode; ctx: RenderCtx }) {
  const attrs = node.attrs;
  const max = Number(attrs?.max ?? "1");
  const value = attrs?.value === undefined ? null : Number(attrs.value);
  const percent = value === null || !Number.isFinite(value) || !(max > 0) ? null : Math.min(100, Math.max(0, (value / max) * 100));
  const label = attrs?.label ?? "";
  const wrap = ctx.wrap === true;
  return (
    <div {...floorBox(node, ctx)} data-role={attrs?.role ?? "meter"} className={cn("flex min-w-0 flex-col justify-between overflow-hidden", wrap && "gap-2")}>
      <div className={cn("flex min-w-0 justify-between gap-3 text-xs", wrap ? "min-h-5 items-start leading-5" : "h-5 items-center")}>
        <span title={wrap ? undefined : label} className={cn("min-w-0 text-muted-foreground", wrap ? "break-words" : "truncate")}>
          {label}
        </span>
        <span className={cn("shrink-0 tabular-nums transition-colors", inkOf(attrs?.tone, ctx.stale))}>
          {percent === null ? "" : t("chat.progress.percent", { value: Math.round(percent) })}
        </span>
      </div>
      <Progress value={percent} label={label === "" ? t("chat.progress.aria") : label} />
    </div>
  );
}

function NumberView({ node, ctx }: { node: NumberNode; ctx: RenderCtx }) {
  const attrs = node.attrs;
  const wrap = ctx.wrap === true;
  return (
    <div {...floorBox(node, ctx)} className="flex min-w-0 flex-col overflow-hidden">
      <span className="flex h-8 min-w-0 items-baseline gap-1.5">
        <span className={cn("truncate text-2xl leading-8 font-semibold tabular-nums transition-colors", inkOf(attrs?.tone, ctx.stale))}>{node.text}</span>
        {attrs?.unit !== undefined && <span className="shrink-0 text-sm text-muted-foreground">{attrs.unit}</span>}
      </span>
      {/* The label's line is reserved even when the number has none, so adding one moves nothing. */}
      <span title={wrap ? undefined : attrs?.label} className={cn("text-xs leading-4 text-muted-foreground", wrap ? "min-h-4 break-words" : "h-4 truncate")}>
        {attrs?.label ?? ""}
      </span>
    </div>
  );
}

function SpacerView({ node, ctx }: { node: SpacerNode; ctx: RenderCtx }) {
  const label = node.attrs?.label;
  if (label === undefined) return <div {...leafBox(node)} aria-hidden />;
  const wrap = ctx.wrap === true;
  return (
    <div {...floorBox(node, ctx)} role="separator" aria-label={label} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span title={wrap ? undefined : label} className={cn("min-w-0 shrink", wrap ? "text-center break-words" : "truncate")}>
        {label}
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

// ── row, list, group, card ────────────────────────────────────────────────────────────────────

/** A long title cut in the middle: the head truncates, the last characters stay. */
const MID_TAIL = 10;

/**
 * A row's title. `cut: mid` (a path) keeps its tail on one line. Otherwise, in a view that wraps it
 * shows every word; in a fixed band it takes two lines when the row has no second line (two 20px lines
 * fit the 44px row) and one when it has, and cuts the rest with the whole title in `title`.
 */
function RowTitle({ text, cut, wrap, lines, words }: { text: string; cut: (typeof CUTS)[number] | undefined; wrap: boolean; lines: 1 | 2; words?: ReactNode }) {
  // A title the place linked is drawn whole, so the link is one anchor: the middle cut, which splits the
  // path in two boxes, waits for a title with nothing to link.
  const linked = words !== undefined && words !== text;
  if (linked) {
    return (
      <span title={text} className={cn("font-content text-sm leading-5", wrap ? "break-words" : lines === 2 ? "line-clamp-2 break-words" : "truncate")}>
        {words}
      </span>
    );
  }
  if (cut === "mid" && text.length > MID_TAIL * 2) {
    return (
      <span title={text} className="flex min-w-0 font-content text-sm leading-5">
        <span className="truncate">{text.slice(0, -MID_TAIL)}</span>
        <span className="shrink-0 whitespace-pre">{text.slice(-MID_TAIL)}</span>
      </span>
    );
  }
  if (wrap) return <span className="font-content text-sm leading-5 break-words">{text}</span>;
  return (
    <span title={text} className={cn("font-content text-sm leading-5", lines === 2 ? "line-clamp-2 break-words" : "truncate")}>
      {text}
    </span>
  );
}

const ROW_PAD = "flex min-w-0 items-center gap-3 px-3.5";

/** An `end` this short fits beside any title as it is ("34 of 34", "+12 −3"); a longer one keeps a floor. */
const END_SHORT = 8;

/**
 * One row: a title, at most one `para` (its second line), any `chip`, `end` (a quiet trailing value),
 * a `badge`, and at most one trailing `button`. With `href` the row is a control that opens a page or a
 * Session. With a trailing button the row is TWO tap targets side by side, never one inside the other.
 *
 * THE TITLE KEEPS ITS ROOM. The title and `end` share the row by their lengths, inside floors: the
 * title's column never narrower than 40% of the row, `end` never wider than 60%; an `end` of at most
 * END_SHORT characters never wraps, and a longer one is never narrower than 30%.
 * A short title leaves a long `end` its one line; a long `end` beside a long title wraps onto a second
 * line (two 16px lines fit the 44px row) instead of pushing the title down to one word per line, and
 * what still does not fit is cut with the whole words in `title`. A web row's host is a line of its own
 * under the title.
 */
function RowView({ node, ctx, path, iconLane = false }: { node: RowNode; ctx: RenderCtx; path: string; iconLane?: boolean }) {
  const attrs = node.attrs;
  const kids = node.kids ?? [];
  const second = kids.find((kid): kid is ParaNode => kid.kind === "para");
  const chips = kids.filter((kid): kid is ChipNode => kid.kind === "chip");
  const buttonAt = kids.findIndex((kid) => kid.kind === "button");
  const button = kids[buttonAt];
  const ink = inkOf(attrs?.tone, ctx.stale);
  const Icon = attrs?.icon === undefined ? null : trickIconOf(attrs.icon);
  const disabled = attrs?.disabled !== undefined;
  const target = attrs?.href === undefined || disabled ? undefined : linkTargetOf(attrs.href);
  // Where a web row goes, when the place asks for it (a Decision's view): the host, small, as a line of
  // its own under the title, so it never takes the title's or `end`'s room on a narrow phone. A session
  // target has no host to show.
  const host = target?.url === undefined ? "" : (ctx.hostOf?.(target.url) ?? "");
  const wrap = ctx.wrap === true;
  // The row's own body is an anchor or a button when it has a target: nothing in it is linked then.
  const linkable = target === undefined;
  const secondText = second === undefined ? undefined : textOf(second);
  const body = (
    <>
      {Icon !== null && <Icon aria-hidden className={cn("size-4 shrink-0 transition-colors", ink)} />}
      {Icon === null && iconLane && <span aria-hidden data-slot="trick-row-icon-lane" className="size-4 shrink-0" />}
      <span data-slot="trick-row-text" className={cn("flex min-w-[40%] flex-auto flex-col", wrap && "py-2.5")}>
        <RowTitle text={node.text} cut={attrs?.cut} wrap={wrap} lines={second === undefined && host === "" ? 2 : 1} words={linkable ? wordsOf(ctx, node.text) : undefined} />
        {secondText !== undefined && (
          <span title={wrap ? undefined : secondText} className={cn("font-content text-xs leading-4 text-muted-foreground", wrap ? "break-words" : "truncate")}>
            {linkable ? wordsOf(ctx, secondText) : secondText}
          </span>
        )}
        {host !== "" && <HostWords host={host} line />}
      </span>
      {chips.map((chip, i) => (
        <ChipView key={i} node={chip} ctx={ctx} />
      ))}
      <BadgeMark badge={attrs?.badge} />
      {attrs?.end !== undefined && (
        <span
          data-slot="trick-row-end"
          title={wrap ? undefined : attrs.end}
          className={cn(
            "max-w-[60%] text-right text-xs leading-4 tabular-nums break-words transition-colors",
            // A short end never wraps; a long one keeps a floor, so a long title beside it never squeezes it to a word a line.
            [...attrs.end].length > END_SHORT ? "min-w-[30%]" : "shrink-0 whitespace-nowrap",
            !wrap && "line-clamp-2",
            ink === "" ? "text-muted-foreground" : ink,
          )}
        >
          {linkable ? wordsOf(ctx, attrs.end) : attrs.end}
        </span>
      )}
    </>
  );
  const main = cn(ROW_PAD, "h-full flex-1 text-left", disabled && "opacity-60");
  let head: ReactNode = (
    <div className={main} aria-disabled={disabled || undefined} title={disabled && attrs?.disabled !== "" ? attrs?.disabled : undefined}>
      {body}
    </div>
  );
  if (target !== undefined) {
    head = (
      <Target
        href={target.url ?? target.session}
        ctx={ctx}
        className={cn(main, "transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring")}
      >
        {body}
      </Target>
    );
  }
  return (
    <div {...floorBox(node, ctx)} data-slot="trick-row" className={cn("flex min-w-0 items-stretch", ENTER)}>
      {head}
      {button?.kind === "button" && (
        <div className="flex shrink-0 items-center pr-1.5">
          <ButtonView node={button} ctx={ctx} path={`${path}/${buttonAt}`} compact />
        </div>
      )}
    </div>
  );
}

/**
 * In a view that wraps (a Decision's), rows that stand together line up: when any of them has an icon,
 * the others keep its lane empty, so every title starts on one edge. A Session's rows keep their own.
 */
function iconLaneOf(kids: readonly ViewNode[], ctx: RenderCtx): boolean {
  return ctx.wrap === true && kids.some((kid) => kid.kind === "row" && kid.attrs?.icon !== undefined);
}

/** A run of kids inside a list or a group: rows framed together, the rest in the flow. */
function FlowKids({ kids, ctx, path, framed }: { kids: readonly ViewNode[]; ctx: RenderCtx; path: string; framed: boolean }) {
  const out: ReactNode[] = [];
  const iconLane = iconLaneOf(kids, ctx);
  let rows: ReactNode[] = [];
  const flush = (key: string) => {
    if (rows.length === 0) return;
    out.push(framed ? <ListGroup key={key} className="min-w-0 overflow-hidden">{rows}</ListGroup> : rows);
    rows = [];
  };
  kids.forEach((kid, i) => {
    const at = `${path}/${i}`;
    if (kid.kind === "row") {
      rows.push(<RowView key={i} node={kid} ctx={ctx} path={at} iconLane={iconLane} />);
      return;
    }
    flush(`rows-${i}`);
    out.push(<div key={i} className="min-w-0">{renderNode(kid, ctx, at)}</div>);
  });
  flush("rows-end");
  return <>{out}</>;
}

function ListView({ node, ctx, path }: { node: ListNode; ctx: RenderCtx; path: string }) {
  const kids = kidsOf(node);
  // A list reserves its kids. One with none keeps the frame's two lines as air, so it is the height of
  // an empty frame and not a box with nothing in it.
  if (kids.length === 0) return <div data-trick-node="list" aria-hidden style={{ height: "calc(2 * var(--row-rule))" }} />;
  const iconLane = iconLaneOf(kids, ctx);
  return (
    <ListGroup data-trick-node="list" className="min-w-0 overflow-hidden">
      {kids.map((kid, i) => {
        const at = `${path}/${i}`;
        if (kid.kind === "row") return <RowView key={i} node={kid} ctx={ctx} path={at} iconLane={iconLane} />;
        if (kid.kind === "group") return <GroupView key={i} node={kid} ctx={ctx} path={at} inList />;
        return <Placeholder key={i} kind={kid.kind} />;
      })}
    </ListGroup>
  );
}

/**
 * A labelled section. Its head is a label and a badge, never a control, except that a group that
 * names a `fold` folds: the head then toggles it, and the phone owns the toggle after the first draw.
 * Its kids grow and shrink through `Collapse`, the one sanctioned way in-flow content appears.
 */
function GroupView({ node, ctx, path, inList = false }: { node: GroupNode; ctx: RenderCtx; path: string; inList?: boolean }) {
  const attrs = node.attrs;
  const foldable = attrs?.fold !== undefined;
  const [open, setOpen] = useState(attrs?.fold !== "closed");
  const headed = groupHasHead(node);
  const wrap = ctx.wrap === true;
  // The label gives way before the badge and the chevron: it wraps where the view may grow, and is cut
  // with its words in `title` in a fixed band. Never pushed past the frame.
  const headWords = (
    <>
      {attrs?.label !== undefined && (
        <SectionLabel className={cn("min-w-0 shrink", wrap ? "break-words" : "truncate")}>
          <span title={wrap ? undefined : attrs.label}>{attrs.label}</span>
        </SectionLabel>
      )}
      <span className="shrink-0 text-muted-foreground">
        <BadgeMark badge={attrs?.badge} />
      </span>
    </>
  );
  const headClass = cn("flex min-w-0 items-center gap-2", wrap ? "min-h-6 py-0.5" : "h-6", inList && "px-3.5");
  const head = !headed ? null : foldable ? (
    <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} className={cn(headClass, "w-full text-left")}>
      {headWords}
      <KeyIcon name="expand" aria-hidden className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
    </button>
  ) : (
    <div className={headClass}>{headWords}</div>
  );
  return (
    // In a view that wraps a labelled group reads as a section: its head sits closer to its own kids
    // (gap-1.5) than to what came before it (renderView's section space).
    <div data-trick-node="group" className={cn("flex min-w-0 flex-col", !inList && (wrap && headed ? "gap-1.5" : "gap-2"))}>
      {head}
      <Collapse open={!foldable || open}>
        <div className={cn("flex min-w-0 flex-col", !inList && "gap-2")}>
          <FlowKids kids={kidsOf(node)} ctx={ctx} path={path} framed={!inList} />
        </div>
      </Collapse>
    </div>
  );
}

/** A card's tone as Collie's marked-row edge (`--edge-accent`): a bar under the sharp corner, a ring under a round one. */
const CARD_EDGE = {
  plain: "",
  muted: "",
  ok: "shadow-[var(--edge-accent)_var(--status-done)]",
  warn: "shadow-[var(--edge-accent)_var(--status-working)]",
  accent: "shadow-[var(--edge-accent)_var(--status-working)]",
  danger: "shadow-[var(--edge-accent)_var(--status-blocked)]",
  unknown: "shadow-[var(--edge-accent)_var(--status-unknown)]",
} as const;

function isTone(word: string): word is (typeof TONES)[number] {
  return TONES.some((tone) => tone === word);
}

function cardEdge(tone: string | undefined, stale: boolean): string {
  if (tone === undefined || !isTone(tone)) return "";
  if (stale && CARD_EDGE[tone] !== "") return CARD_EDGE.unknown;
  return CARD_EDGE[tone];
}

function CardView({ node, ctx, path }: { node: CardNode; ctx: RenderCtx; path: string }) {
  return (
    <Card data-trick-node="card" className={cn("min-w-0 gap-2 px-3.5 py-3 shadow-none transition-shadow", cardEdge(node.attrs?.tone, ctx.stale))}>
      <FlowKids kids={kidsOf(node)} ctx={ctx} path={path} framed />
    </Card>
  );
}

// ── the switch ────────────────────────────────────────────────────────────────────────────────

function renderNode(node: ViewNode, ctx: RenderCtx, path: string): ReactNode {
  switch (node.kind) {
    case "card":
      return <CardView node={node} ctx={ctx} path={path} />;
    case "group":
      return <GroupView node={node} ctx={ctx} path={path} />;
    case "list":
      return <ListView node={node} ctx={ctx} path={path} />;
    case "row":
      return (
        <ListGroup className="min-w-0 overflow-hidden">
          <RowView node={node} ctx={ctx} path={path} />
        </ListGroup>
      );
    case "bar":
      return <BarView node={node} ctx={ctx} path={path} />;
    case "chip":
      return <ChipView node={node} ctx={ctx} />;
    case "button":
      return <ButtonView node={node} ctx={ctx} path={path} />;
    case "para":
      return <ParaView node={node} ctx={ctx} />;
    case "line":
      return <LineView node={node} ctx={ctx} />;
    case "run":
      return <RunView node={node} ctx={ctx} />;
    case "code":
      return <CodeView node={node} ctx={ctx} />;
    case "link":
      return <LinkView node={node} ctx={ctx} block />;
    case "image":
      return <ImageView node={node} ctx={ctx} />;
    case "meter":
      return <MeterView node={node} ctx={ctx} />;
    case "spacer":
      return <SpacerView node={node} ctx={ctx} />;
    case "number":
      return <NumberView node={node} ctx={ctx} />;
    case "compare":
      return <CompareView node={node} ctx={ctx} />;
    case "table":
      return <TableView node={node} ctx={ctx} />;
    case "diff":
      return <DiffView node={node} ctx={ctx} />;
    case "spark":
      return <SparkView node={node} ctx={ctx} />;
    case "col":
    case "cell":
      // A table's own kids: drawn by the table, never on their own.
      return <Placeholder kind={node.kind} />;
    default: {
      // A kind this Collie has never heard of: a crew member on a newer version sent it.
      const stray: { kind: string } = node;
      return <Placeholder kind={stray.kind} />;
    }
  }
}

/**
 * Draw a view: its nodes top to bottom with the flow gap. The first node's path is `v/0`; a control's
 * path is its place in the view below it, so a tap names the control that was pressed.
 */
/**
 * THE RHYTHM OF A VIEW THAT WRAPS (a Decision's, 2026-11-10). Facts that belong together (a number, a
 * meter, a spark, a row) stand at the flow gap; a labelled group after them opens a section, with twice
 * the space above it. A Session's view keeps the one gap: its height is reserved from it (layout.ts).
 */
function sectionBreak(view: View, i: number, ctx: RenderCtx): boolean {
  const node = view[i];
  return ctx.wrap === true && i > 0 && node?.kind === "group" && groupHasHead(node);
}

export function renderView(view: View, ctx: RenderCtx): ReactNode {
  // A view that is no list draws the placeholder. A node with no `attrs` or `kids` was made whole at the
  // door the store reads through (lib/tricks/read.ts), and `kidsOf` reads the rest.
  if (!Array.isArray(view)) return <Placeholder />;
  return (
    <div data-trick-view="" className="flex min-w-0 flex-col gap-2">
      {view.map((node, i) => {
        const section = sectionBreak(view, i, ctx);
        return (
          <div key={i} data-trick-section={section ? "" : undefined} className={cn("min-w-0", ENTER, section && "pt-2")}>
            {renderNode(node, ctx, `v/${i}`)}
          </div>
        );
      })}
    </div>
  );
}
