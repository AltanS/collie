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
// change repaints and a shape change waits while a finger is down (part-frame.tsx).
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

import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { Icon as KeyIcon } from "../../components/icons/icon";
import type { IconKey } from "../../components/icons/keys";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Collapse } from "../../components/ui/collapse";
import { CopyableBlock } from "../../components/ui/copyable-block";
import { ListGroup } from "../../components/ui/list-group";
import { OneOf } from "../../components/ui/one-of";
import { Progress } from "../../components/ui/progress";
import { SectionLabel } from "../../components/ui/section-label";
import { useArm } from "../../hooks/use-arm";
import { copyText } from "../clipboard";
import { t } from "../i18n";
import { setStatus } from "../status";
import { cn } from "../utils";
import { useBridgeNow } from "./clock";
import { keyGlyph, trickIconOf, type TrickGlyph } from "./icons";
import { codeLines, groupHasHead, heightCss, isStepStrip, kidsOf, LEAF_REM, paraLines, reservedHeight, textOf } from "./layout";
import {
  CUTS,
  TONES,
  isEpochMs,
  isLinkSessionKey,
  isTrickUrl,
  type BarNode,
  type ButtonNode,
  type CardNode,
  type ChipNode,
  type ChipState,
  type Clock,
  type CodeNode,
  type GroupNode,
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
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. Absent: it ticks. */
  now?: number;
  /**
   * The host a web link or a web row goes to, drawn small after the link's words and in the row's end slot
   * (a Decision's view on the hill, where the words are the poster's and the host is the truth). Absent:
   * a link or a row draws its words alone.
   */
  hostOf?: (href: string) => string;
  /**
   * A bar wraps its kids onto more lines instead of clipping them (a Decision's view, which sits in no
   * fixed band, so seven chips on a 390 px phone keep their words). Absent: a bar is one line.
   */
  wrapBars?: boolean;
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
  const label = armed && attrs.confirm !== undefined ? attrs.confirm : attrs.label;
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
        ...(attrs.confirm === undefined ? [] : [{ key: "confirm", node: <span className="truncate">{attrs.confirm}</span> }]),
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

function ChipView({ node, ctx }: { node: ChipNode; ctx: RenderCtx }) {
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
      {shown !== "" && <span className="min-w-0 truncate">{shown}</span>}
      {attrs?.at !== undefined && attrs.clock !== undefined && <TrickClock at={attrs.at} clock={attrs.clock} now={ctx.now} />}
    </>
  );
  const frame = cn(
    "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm border px-2 text-xs transition-colors",
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

/**
 * THE STEP STRIP: a `bar` of `chip` with `state` and `current` (the first schema's `steps`), in one
 * fixed height whatever its number: the chips on one line, and under them a track of one segment per
 * chip with a state. A done segment is full, a working one half full, a waiting one full in the warn
 * ink, an idle or gone one the bare track; the chip's own `tone` wins (a red step is `danger`). The
 * whole list, with every state in words and the current step, is there for a screen reader.
 */
function StripView({ node, ctx }: { node: BarNode; ctx: RenderCtx }) {
  const chips = kidsOf(node).filter((kid): kid is ChipNode => kid.kind === "chip");
  const steps = chips.filter((chip) => chip.attrs?.state !== undefined);
  const current = steps.findIndex((chip) => chip.attrs?.current !== undefined);
  return (
    <div {...leafBox(node)} data-strip="" role="group" aria-label={node.attrs?.label} className="flex min-w-0 flex-col justify-between overflow-hidden">
      <div aria-hidden className="flex h-6 min-w-0 items-center gap-1.5 overflow-hidden">
        {chips.map((chip, i) => (
          <ChipView key={i} node={chip} ctx={ctx} />
        ))}
      </div>
      <div aria-hidden data-slot="trick-strip-track" className="flex h-1 gap-0.5">
        {steps.map((chip, i) => {
          const state = chip.attrs?.state ?? "idle";
          const filled = state === "done" || state === "working" || state === "waiting";
          return (
            <span key={i} data-state={state} className={cn("h-full flex-1 overflow-hidden rounded-sm bg-muted", inkOf(chipTone(chip), ctx.stale))}>
              {filled && <span className={cn("block h-full rounded-sm bg-current transition-transform", state === "working" ? "w-1/2" : "w-full")} />}
            </span>
          );
        })}
      </div>
      <ol className="sr-only">
        {steps.map((chip, i) => (
          <li key={i} aria-current={i === current ? "step" : undefined}>
            {textOf(chip)}: {t(STATE_WORD[chip.attrs?.state ?? "idle"])}
          </li>
        ))}
        {current >= 0 && <li>{t("tricks.steps.of", { n: current + 1, m: steps.length })}</li>}
      </ol>
    </div>
  );
}

// ── bar ───────────────────────────────────────────────────────────────────────────────────────

function BarView({ node, ctx, path }: { node: BarNode; ctx: RenderCtx; path: string }) {
  if (isStepStrip(node)) return <StripView node={node} ctx={ctx} />;
  const scroll = node.attrs?.scroll === "x";
  const wrap = !scroll && ctx.wrapBars === true;
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

function LinkView({ node, ctx, block = false }: { node: LinkNode; ctx: RenderCtx; block?: boolean }) {
  const Icon = node.attrs.icon === undefined ? null : trickIconOf(node.attrs.icon);
  const host = ctx.hostOf?.(node.attrs.href) ?? "";
  const link = (
    <Target
      href={node.attrs.href}
      ctx={ctx}
      className={cn(LINK_INK, block ? "inline-flex h-11 shrink-0 items-center gap-1.5 px-1 text-sm" : "inline items-baseline")}
    >
      {Icon !== null && <Icon aria-hidden className={cn("inline size-3.5 shrink-0", !block && "mr-1 align-[-2px]")} />}
      <span data-trick-node="link">{node.text}</span>
      {node.attrs.badge !== undefined && (
        <span className="ml-1 inline-flex align-middle">
          <BadgeMark badge={node.attrs.badge} />
        </span>
      )}
    </Target>
  );
  if (host === "") return link;
  return (
    <>
      {link}
      <span data-trick-link-host="" className="ml-1.5 font-mono text-[11px] text-muted-foreground">
        {host}
      </span>
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
      {words}
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
  const lines = paraLines(node);
  // One line truncates; more lines clamp at their count, so a long text never grows the box.
  const clamp: CSSProperties = lines === 1 ? {} : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines };
  const role = attrs?.role ?? "body";
  return (
    <div {...leafBox(node)} className="flex min-w-0 gap-1.5 overflow-hidden">
      {attrs?.bullet !== undefined && <span className="w-4 shrink-0 font-content text-sm leading-5 text-muted-foreground tabular-nums">{attrs.bullet}</span>}
      <p style={clamp} className={cn(PARA_ROLE_CLASS[role], "min-w-0 flex-1 overflow-hidden", lines === 1 ? "truncate" : "break-words whitespace-pre-line")}>
        {attrs?.term !== undefined && <span className="font-semibold not-italic">{attrs.term} </span>}
        {node.text ?? <Inline kids={node.kids} ctx={ctx} />}
      </p>
    </div>
  );
}

const LINE_ROLE_CLASS = { text: "", status: "font-semibold", note: "italic text-muted-foreground" } as const;

function LineBody({ node, ctx }: { node: LineNode; ctx: RenderCtx }) {
  return (
    <span className={cn("block truncate whitespace-pre [tab-size:4]", styleClass(node.attrs?.style, ctx.stale), LINE_ROLE_CLASS[node.attrs?.role ?? "text"])}>
      {node.text ?? <Inline kids={node.kids} ctx={ctx} />}
    </span>
  );
}

function LineView({ node, ctx }: { node: LineNode; ctx: RenderCtx }) {
  return (
    <div {...leafBox(node)} className={cn("min-w-0 overflow-hidden font-mono text-xs leading-4", ENTER)}>
      <LineBody node={node} ctx={ctx} />
    </div>
  );
}

/**
 * A code block: its lines in mono, `max` lines reserved, scrolling on its own past them, and the
 * phone's copy button on it (`ui/copyable-block.tsx`), as every `code` has (VOCABULARY.md 2).
 */
function CodeView({ node, ctx }: { node: CodeNode; ctx: RenderCtx }) {
  const lines = kidsOf(node).filter((kid): kid is LineNode => kid.kind === "line");
  const scrolls = lines.length > codeLines(node);
  return (
    <div {...leafBox(node)} data-lang={node.attrs?.lang} className="min-w-0">
      <CopyableBlock text={lines.map(textOf).join("\n")} className="h-full">
        <pre className={cn("h-full rounded-sm border border-border bg-muted/40 py-2 pr-9 pl-3 font-mono text-xs leading-4", scrolls ? "overflow-y-auto overscroll-contain" : "overflow-hidden")}>
          {lines.map((line, i) => (
            <div key={i} className="h-4 min-w-0">
              <LineBody node={line} ctx={ctx} />
            </div>
          ))}
        </pre>
      </CopyableBlock>
    </div>
  );
}

// ── image, meter, number, spacer ──────────────────────────────────────────────────────────────

/**
 * An image of the trick folder, its box reserved from `w` and `h` before a byte arrives, so nothing
 * below it moves when it loads. It loads lazily from the bridge's URL; with no URL the box keeps its
 * size and says its `alt`.
 */
function ImageView({ node, ctx }: { node: ImageNode; ctx: RenderCtx }) {
  const { src, alt, w, h } = node.attrs;
  const url = ctx.imageUrl?.(src);
  return (
    <div
      data-trick-node="image"
      style={{ aspectRatio: `${w} / ${h}`, maxWidth: `${w}px` }}
      className="flex w-full min-w-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted"
    >
      {url === undefined ? (
        <span className="line-clamp-3 px-3 text-center text-xs text-muted-foreground">{alt}</span>
      ) : (
        <img src={url} alt={alt} width={Number(w)} height={Number(h)} loading="lazy" decoding="async" className="size-full object-contain" />
      )}
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
  return (
    <div {...leafBox(node)} data-role={attrs?.role ?? "meter"} className="flex min-w-0 flex-col justify-between overflow-hidden">
      <div className="flex h-5 min-w-0 items-center justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
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
  return (
    <div {...leafBox(node)} className="flex min-w-0 flex-col overflow-hidden">
      <span className="flex h-8 min-w-0 items-baseline gap-1.5">
        <span className={cn("truncate text-2xl leading-8 font-semibold tabular-nums transition-colors", inkOf(attrs?.tone, ctx.stale))}>{node.text}</span>
        {attrs?.unit !== undefined && <span className="shrink-0 text-sm text-muted-foreground">{attrs.unit}</span>}
      </span>
      {/* The label's line is reserved even when the number has none, so adding one moves nothing. */}
      <span className="h-4 truncate text-xs leading-4 text-muted-foreground">{attrs?.label ?? ""}</span>
    </div>
  );
}

function SpacerView({ node }: { node: SpacerNode }) {
  const label = node.attrs?.label;
  if (label === undefined) return <div {...leafBox(node)} aria-hidden />;
  return (
    <div {...leafBox(node)} role="separator" aria-label={label} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="shrink truncate">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

// ── row, list, group, card ────────────────────────────────────────────────────────────────────

/** A long title cut in the middle: the head truncates, the last characters stay. */
const MID_TAIL = 10;

function RowTitle({ text, cut }: { text: string; cut: (typeof CUTS)[number] | undefined }) {
  if (cut === "mid" && text.length > MID_TAIL * 2) {
    return (
      <span className="flex min-w-0 font-content text-sm leading-5">
        <span className="truncate">{text.slice(0, -MID_TAIL)}</span>
        <span className="shrink-0 whitespace-pre">{text.slice(-MID_TAIL)}</span>
      </span>
    );
  }
  return <span className="truncate font-content text-sm leading-5">{text}</span>;
}

const ROW_PAD = "flex min-w-0 items-center gap-3 px-3.5";

/**
 * One row: a title, at most one `para` (its second line), any `chip`, `end` (a quiet trailing value),
 * a `badge`, and at most one trailing `button`. With `href` the row is a control that opens a page or a
 * Session. With a trailing button the row is TWO tap targets side by side, never one inside the other.
 */
function RowView({ node, ctx, path }: { node: RowNode; ctx: RenderCtx; path: string }) {
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
  // Where a web row goes, when the place asks for it (a Decision's view): the host, small, in the end
  // slot beside `end`. One line, so the row keeps its height; a session target has no host to show.
  const host = target?.url === undefined ? "" : (ctx.hostOf?.(target.url) ?? "");
  const body = (
    <>
      {Icon !== null && <Icon aria-hidden className={cn("size-4 shrink-0 transition-colors", ink)} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <RowTitle text={node.text} cut={attrs?.cut} />
        {second !== undefined && <span className="truncate font-content text-xs leading-4 text-muted-foreground">{textOf(second)}</span>}
      </span>
      {chips.map((chip, i) => (
        <ChipView key={i} node={chip} ctx={ctx} />
      ))}
      <BadgeMark badge={attrs?.badge} />
      {host !== "" && (
        <span data-trick-link-host="" className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
          {host}
        </span>
      )}
      {attrs?.end !== undefined && <span className={cn("max-w-[40%] shrink-0 truncate text-xs tabular-nums transition-colors", ink === "" ? "text-muted-foreground" : ink)}>{attrs.end}</span>}
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
    <div {...leafBox(node)} data-slot="trick-row" className={cn("flex min-w-0 items-stretch", ENTER)}>
      {head}
      {button?.kind === "button" && (
        <div className="flex shrink-0 items-center pr-1.5">
          <ButtonView node={button} ctx={ctx} path={`${path}/${buttonAt}`} compact />
        </div>
      )}
    </div>
  );
}

/** A run of kids inside a list or a group: rows framed together, the rest in the flow. */
function FlowKids({ kids, ctx, path, framed }: { kids: readonly ViewNode[]; ctx: RenderCtx; path: string; framed: boolean }) {
  const out: ReactNode[] = [];
  let rows: ReactNode[] = [];
  const flush = (key: string) => {
    if (rows.length === 0) return;
    out.push(framed ? <ListGroup key={key} className="min-w-0 overflow-hidden">{rows}</ListGroup> : rows);
    rows = [];
  };
  kids.forEach((kid, i) => {
    const at = `${path}/${i}`;
    if (kid.kind === "row") {
      rows.push(<RowView key={i} node={kid} ctx={ctx} path={at} />);
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
  return (
    <ListGroup data-trick-node="list" className="min-w-0 overflow-hidden">
      {kids.map((kid, i) => {
        const at = `${path}/${i}`;
        if (kid.kind === "row") return <RowView key={i} node={kid} ctx={ctx} path={at} />;
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
  const headWords = (
    <>
      {attrs?.label !== undefined && <SectionLabel>{attrs.label}</SectionLabel>}
      <span className="text-muted-foreground">
        <BadgeMark badge={attrs?.badge} />
      </span>
    </>
  );
  const headClass = cn("flex h-6 min-w-0 items-center gap-2", inList && "px-3.5");
  const head = !headed ? null : foldable ? (
    <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} className={cn(headClass, "w-full text-left")}>
      {headWords}
      <KeyIcon name="expand" aria-hidden className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
    </button>
  ) : (
    <div className={headClass}>{headWords}</div>
  );
  return (
    <div data-trick-node="group" className={cn("flex min-w-0 flex-col", !inList && "gap-2")}>
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
      return <SpacerView node={node} />;
    case "number":
      return <NumberView node={node} ctx={ctx} />;
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
export function renderView(view: View, ctx: RenderCtx): ReactNode {
  // A view that is no list draws the placeholder. A node with no `attrs` or `kids` was made whole at the
  // door the store reads through (lib/tricks/read.ts), and `kidsOf` reads the rest.
  if (!Array.isArray(view)) return <Placeholder />;
  return (
    <div data-trick-view="" className="flex min-w-0 flex-col gap-2">
      {view.map((node, i) => (
        <div key={i} className={cn("min-w-0", ENTER)}>
          {renderNode(node, ctx, `v/${i}`)}
        </div>
      ))}
    </div>
  );
}
