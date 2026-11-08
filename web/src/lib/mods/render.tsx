// THE VIEW TREE, DRAWN WITH COLLIE'S OWN PRIMITIVES (M94 slice 02, the design's section 5).
//
// A mod says WHAT to show in a closed vocabulary of nodes; this file decides HOW, so the look stays
// Collie's: the house 2px corner, the tone map onto the status tokens, the UI face for labels,
// `font-content` for what the mod wrote, `font-mono` for its `mono` role, and the 44px floor on every
// control (DESIGN.md sections 3, 5, 6, 13). There is no colour, size, font or CSS in a node, so there
// is none to forward.
//
// FIXED HEIGHTS. Every leaf states its own height from `layout.ts` and clips inside it, and every
// layout node is the sum or the tallest of its children, so a node's height is a fact about its form
// and a data change repaints (DESIGN.md section 2). A text reserves its lines, a list its rows and
// draws "+n more" past them; a number, a progress, a steps and a time are one height each.
//
// SLICE 02 DRAWS THE CORE KINDS. The kinds slice 08 adds, and a kind this Collie does not know at all
// (a crew member on a newer version), draw the one placeholder: a box of the tap floor's height that
// says "This Collie cannot draw this part".
//
// TAPS. A `button`, a list row with an `intent` and a `mark` with an `intent` call `ctx.onTap` with
// the part's key, the intent, its args, and the CONTROL: the node's path in the tree, so the busy and
// unknown states land on the control that was pressed and on no other. Collie's busy state is the
// belt's: the glyph turns into the spinner in its own box (components/harness-bar.tsx).

import { Check, Loader2, Minus, Play, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { ListGroup } from "../../components/ui/list-group";
import { OneOf } from "../../components/ui/one-of";
import { Progress } from "../../components/ui/progress";
import { t } from "../i18n";
import type { JsonObject } from "../json";
import { cn } from "../utils";
import { useBridgeNow } from "./clock";
import { modIconOf } from "./icons";
import { clampCount, GAP_REM, heightCss, LEAF_REM, reservedHeight } from "./layout";
import { ModMark } from "./mark";
import {
  CORE_NODE_KINDS,
  VIEW_LIMITS,
  type Align,
  type ButtonNode,
  type FigureStepState,
  type KvNode,
  type ListItem,
  type ListNode,
  type MarkNode,
  type NumberNode,
  type OpenTarget,
  type ProgressNode,
  type StepsNode,
  type TextNode,
  type TextRole,
  type TimeNode,
  type ViewNode,
} from "./schema";
import type { DraftRequest, TapState } from "./store";
import { modTimeText } from "./time";
import { inkOf } from "./tone";

/** What a view needs from the place that mounts it. Slice 03 wires the callbacks. */
export interface RenderCtx {
  /** The `partKey` of the part this view belongs to. */
  partKey: string;
  /** The mod's name, for a mark's accessible name. */
  modName: string;
  /** The part is past its fresh window: every status tone draws grey. */
  stale: boolean;
  /** The last tap on this part, from the store. */
  tap?: TapState;
  /** A control was tapped. `control` names it inside the part, so only it draws busy. */
  onTap: (partKey: string, intent: string, args: JsonObject | undefined, control: string) => void;
  /** A draft for a reply box: a tap's reply, or the frame's fix button. */
  onDraft: (draft: DraftRequest) => void;
  /** A tap's reply opens a session or a URL. */
  onOpen: (target: OpenTarget) => void;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. Absent: it ticks. */
  now?: number;
}

const CORE: ReadonlySet<string> = new Set(CORE_NODE_KINDS);

/** The placeholder's words, in the one box every undrawable part gets. */
export function Placeholder({ kind }: { kind?: string }) {
  return (
    <div
      data-mod-node="placeholder"
      data-kind={kind}
      style={{ height: `${LEAF_REM.tap}rem` }}
      className="flex min-w-0 items-center rounded-sm border border-border px-3 text-xs text-muted-foreground"
    >
      <span className="truncate">{t("mods.placeholder")}</span>
    </div>
  );
}

/** A leaf's own box: its kind for a test and a reader, and its reserved height, clipped. */
interface LeafBox {
  "data-mod-node": string;
  style: CSSProperties;
}

function leafBox(node: ViewNode): LeafBox {
  return { "data-mod-node": node.kind, style: { height: heightCss(reservedHeight(node)) } };
}

// ── text ──────────────────────────────────────────────────────────────────────────────────────

const ROLE_CLASS = {
  display: "text-2xl leading-8 font-semibold tracking-tight",
  title: "text-sm leading-5 font-semibold",
  body: "font-content text-sm leading-5",
  caption: "font-content text-xs leading-4",
  mono: "font-mono text-xs leading-4",
} as const satisfies { readonly [R in TextRole]: string };

function isRole(role: string): role is TextRole {
  return Object.hasOwn(ROLE_CLASS, role);
}

function roleOf(role: string | undefined): TextRole {
  return role !== undefined && isRole(role) ? role : "body";
}

function TextView({ node, ctx }: { node: TextNode; ctx: RenderCtx }) {
  const role = roleOf(node.role);
  const lines = clampCount(node.lines, VIEW_LIMITS.textLines, 1);
  // A caption with no tone of its own is the muted ink; every other role is the surface's ink.
  const ink = node.tone === undefined && role === "caption" ? "text-muted-foreground" : inkOf(node.tone, ctx.stale);
  // One line truncates; more lines clamp at their count, so a long text never grows the box.
  const clamp: CSSProperties = lines === 1 ? {} : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines };
  return (
    <div {...leafBox(node)} className="min-w-0 overflow-hidden">
      <p
        style={clamp}
        className={cn(
          ROLE_CLASS[role],
          ink,
          "overflow-hidden",
          lines === 1 ? "truncate" : role === "mono" ? "break-all whitespace-pre-wrap" : "break-words whitespace-pre-line",
        )}
      >
        {node.text}
      </p>
    </div>
  );
}

// ── number ────────────────────────────────────────────────────────────────────────────────────

function NumberView({ node, ctx }: { node: NumberNode; ctx: RenderCtx }) {
  return (
    <div {...leafBox(node)} className="flex min-w-0 flex-col overflow-hidden">
      <span className={cn("truncate text-2xl leading-8 font-semibold tabular-nums", inkOf(node.tone, ctx.stale))}>{String(node.value)}</span>
      {/* The label's line is reserved even when the number has none, so adding one moves nothing. */}
      <span className="h-4 truncate text-xs leading-4 text-muted-foreground">{node.label ?? ""}</span>
    </div>
  );
}

// ── kv ────────────────────────────────────────────────────────────────────────────────────────

function KvView({ node, ctx }: { node: KvNode; ctx: RenderCtx }) {
  const rows = Array.isArray(node.rows) ? node.rows.slice(0, VIEW_LIMITS.kvRows.max) : [];
  if (node.cols === 2) {
    return (
      <dl {...leafBox(node)} className="grid min-w-0 grid-cols-2 gap-x-4 overflow-hidden">
        {rows.map((row, i) => (
          <div key={i} className="flex h-9 min-w-0 flex-col">
            <dt className="truncate text-xs leading-4 text-muted-foreground">{row.label}</dt>
            <dd className={cn("truncate font-content text-sm leading-5", inkOf(row.tone, ctx.stale))}>{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl {...leafBox(node)} className="flex min-w-0 flex-col overflow-hidden">
      {rows.map((row, i) => (
        <div key={i} className="flex h-6 min-w-0 items-center justify-between gap-3">
          <dt className="shrink-0 text-xs text-muted-foreground">{row.label}</dt>
          <dd className={cn("min-w-0 truncate text-right font-content text-sm", inkOf(row.tone, ctx.stale))}>{row.value}</dd>
        </div>
      ))}
    </dl>
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

const SPINNER = "size-4 shrink-0 animate-spin";

// ── list ──────────────────────────────────────────────────────────────────────────────────────

function ListRowBody({ item, ctx, state }: { item: ListItem; ctx: RenderCtx; state: ControlState }) {
  const ink = inkOf(item.tone, ctx.stale);
  const Icon = item.icon === undefined ? null : modIconOf(item.icon);
  const tappable = item.intent !== undefined;
  const trailing = item.trailing ?? "";
  return (
    <>
      {Icon !== null && <Icon aria-hidden className={cn("size-4 shrink-0", ink)} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-content text-sm leading-5">{item.text}</span>
        {item.detail !== undefined && <span className="truncate font-content text-xs leading-4 text-muted-foreground">{item.detail}</span>}
      </span>
      {tappable ? (
        // The end slot holds the trailing word, the spinner and "unknown" in one cell, sized by the
        // widest, so the row's text keeps its right edge whichever is shown (ui/one-of.tsx).
        <OneOf
          active={state === "rest" ? "word" : state}
          className="shrink-0 justify-items-end"
          options={[
            { key: "word", node: <span className={cn("text-xs tabular-nums", ink)}>{trailing}</span> },
            { key: "busy", node: <Loader2 aria-hidden className={cn(SPINNER, "text-muted-foreground")} /> },
            { key: "unknown", node: <span className="text-xs text-muted-foreground">{t("mods.tap.unknown")}</span> },
          ]}
        />
      ) : (
        trailing !== "" && <span className={cn("shrink-0 text-xs tabular-nums", ink)}>{trailing}</span>
      )}
    </>
  );
}

const LIST_ROW = "flex h-11 w-full min-w-0 items-center gap-3 px-3.5 text-left";

function ListView({ node, ctx, path }: { node: ListNode; ctx: RenderCtx; path: string }) {
  const rows = clampCount(node.rows, VIEW_LIMITS.listRows, 1);
  const items = Array.isArray(node.items) ? node.items : [];
  // Past the reserved rows, the last row says how many more there are, so the list never grows. One
  // reserved row has no room for both, so it shows the first item and puts the count in its end slot.
  const over = items.length > rows;
  const shown = over ? items.slice(0, Math.max(1, rows - 1)) : items;
  const more = items.length - shown.length;
  const slots: ReactNode[] = shown.map((original, i) => {
    const control = `${path}/${i}`;
    const state = controlState(ctx, control);
    const item = over && rows === 1 ? { ...original, trailing: t("mods.list.more", { count: more }) } : original;
    if (item.intent === undefined) {
      return (
        <div key={i} data-slot="mod-list-row" className={LIST_ROW}>
          <ListRowBody item={item} ctx={ctx} state="rest" />
        </div>
      );
    }
    const intent = item.intent;
    return (
      <button
        key={i}
        type="button"
        data-slot="mod-list-row"
        aria-busy={state === "busy"}
        disabled={partBusy(ctx)}
        onClick={() => ctx.onTap(ctx.partKey, intent, item.args, control)}
        className={cn(LIST_ROW, "transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default")}
      >
        <ListRowBody item={item} ctx={ctx} state={state} />
      </button>
    );
  });
  if (over && rows > 1) {
    slots.push(
      <div key="more" data-slot="mod-list-more" className={cn(LIST_ROW, "text-xs text-muted-foreground tabular-nums")}>
        {t("mods.list.more", { count: more })}
      </div>,
    );
  }
  // THE ROWS NOBODY FILLS (slice 03, a look fix). They keep the list's height at its `rows`, not its
  // items, but they draw as hairline rows under the group, not as blank boxes inside its frame: each is
  // a 44px row whose only mark is one line in the border token, inset to the rows' text. Each takes the
  // theme's row gap above it, as a row of the group does, so a list that gains or loses an item is the
  // same height under every `rows` word. A list with no item at all keeps the frame's two lines of
  // height as air, so it is the same height as one with items.
  const filled = slots.length;
  const empties: ReactNode[] = [];
  for (let i = filled; i < rows; i += 1) {
    empties.push(
      <div
        key={`empty-${i}`}
        aria-hidden
        data-slot="mod-list-empty"
        style={i === 0 ? undefined : { marginTop: "var(--row-gap)" }}
        className="mx-3.5 h-11 border-b border-border"
      />,
    );
  }
  return (
    <div data-mod-node="list" className="flex min-w-0 flex-col">
      {filled > 0 ? (
        <ListGroup className="min-w-0 overflow-hidden">{slots}</ListGroup>
      ) : (
        <div aria-hidden style={{ height: "calc(2 * var(--row-rule))" }} />
      )}
      {empties}
    </div>
  );
}

// ── button ────────────────────────────────────────────────────────────────────────────────────

function ButtonView({ node, ctx, path }: { node: ButtonNode; ctx: RenderCtx; path: string }) {
  const state = controlState(ctx, path);
  const busy = state === "busy";
  const Icon = node.icon === undefined ? null : modIconOf(node.icon);
  // THE LABEL STAYS WHILE BUSY (slice 03, a look fix): a person reads what is running, not a lone
  // spinner. With a glyph, the glyph turns into the spinner in its own box, as the belt's actions do.
  // Without one, the busy cell is the spinner AND the label, stacked in one grid cell with the label
  // alone (ui/one-of.tsx), so the button is as wide as the busy cell at rest too and never moves.
  // "Unknown" takes the same cell.
  const label = (
    <OneOf
      active={state === "unknown" ? "unknown" : busy && Icon === null ? "busy" : "label"}
      className="min-w-0 justify-items-center"
      options={[
        { key: "label", node: <span className="truncate">{node.label}</span> },
        { key: "unknown", node: <span className="truncate">{t("mods.tap.unknown")}</span> },
        ...(Icon === null
          ? [
              {
                key: "busy",
                node: (
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Loader2 aria-hidden data-slot="mod-button-busy" className={SPINNER} />
                    <span className="truncate">{node.label}</span>
                  </span>
                ),
              },
            ]
          : []),
      ]}
    />
  );
  return (
    <div {...leafBox(node)} className="flex min-w-0 items-center">
      <Button
        type="button"
        variant={node.primary === true ? "default" : "outline"}
        aria-busy={busy}
        aria-label={state === "unknown" ? `${node.label}, ${t("mods.tap.unknown")}` : undefined}
        disabled={node.disabled === true || partBusy(ctx)}
        onClick={() => ctx.onTap(ctx.partKey, node.intent, node.args, path)}
        className="h-11 w-full min-w-0 px-4"
      >
        {Icon !== null && (busy ? <Loader2 aria-hidden data-slot="mod-button-busy" className={SPINNER} /> : <Icon aria-hidden />)}
        {label}
      </Button>
    </div>
  );
}

// ── progress and steps ────────────────────────────────────────────────────────────────────────

function ProgressView({ node }: { node: ProgressNode }) {
  let words = "";
  let figure = "";
  let value = 0;
  if (node.steps !== undefined) {
    const steps = node.steps.slice(0, VIEW_LIMITS.steps.max);
    const done = steps.filter((step) => step.state === "done").length;
    const running = steps.findIndex((step) => step.state === "running");
    const todo = steps.findIndex((step) => step.state === "todo");
    const at = running >= 0 ? running : todo >= 0 ? todo : steps.length - 1;
    words = steps[at]?.label ?? "";
    figure = t("mods.steps.of", { n: at + 1, m: steps.length });
    value = steps.length === 0 ? 0 : (done / steps.length) * 100;
  }
  if (node.steps === undefined) {
    value = Math.min(100, Math.max(0, Number.isFinite(node.value) ? node.value : 0));
    words = node.label ?? "";
    figure = t("chat.progress.percent", { value: Math.round(value) });
  }
  return (
    <div {...leafBox(node)} className="flex min-w-0 flex-col justify-between overflow-hidden">
      <div className="flex h-5 min-w-0 items-center justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{words}</span>
        <span className="shrink-0 tabular-nums">{figure}</span>
      </div>
      <Progress value={value} label={words === "" ? t("chat.progress.aria") : words} />
    </div>
  );
}

const STEP_GLYPH = { done: Check, failed: X, running: Play, todo: Minus } as const satisfies { readonly [S in FigureStepState]: typeof Check };
const STEP_TONE = { done: "ok", failed: "error", running: "working", todo: "muted" } as const satisfies { readonly [S in FigureStepState]: string };
const STEP_WORD = {
  done: "mods.steps.done",
  failed: "mods.steps.failed",
  running: "mods.steps.running",
  todo: "mods.steps.todo",
} as const satisfies { readonly [S in FigureStepState]: string };

function stepStateOf(state: string): FigureStepState {
  return state === "done" || state === "failed" || state === "running" ? state : "todo";
}

/**
 * Steps, in one fixed height whatever their number: the step that matters most named on one line (the
 * first failed one, else the running one, else the next to do, else the last), and a bar of one
 * segment per step. A done segment is full, a running one half full, a failed one full in the error
 * tone, and one to do is the bare track; the line's glyph says the state by shape too. The whole list,
 * with every state in words, is there for a screen reader.
 */
function StepsView({ node, ctx }: { node: StepsNode; ctx: RenderCtx }) {
  const steps = node.steps.slice(0, VIEW_LIMITS.steps.max).map((step) => ({ label: step.label, state: stepStateOf(step.state) }));
  const failed = steps.findIndex((step) => step.state === "failed");
  const running = steps.findIndex((step) => step.state === "running");
  const todo = steps.findIndex((step) => step.state === "todo");
  const at = failed >= 0 ? failed : running >= 0 ? running : todo >= 0 ? todo : steps.length - 1;
  const focus = steps[at];
  const Glyph = focus === undefined ? Minus : STEP_GLYPH[focus.state];
  return (
    <div {...leafBox(node)} className="flex min-w-0 flex-col justify-between overflow-hidden">
      <div aria-hidden className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
        <Glyph className={cn("size-3.5 shrink-0", focus === undefined ? "" : inkOf(STEP_TONE[focus.state], ctx.stale))} />
        <span className="min-w-0 flex-1 truncate">{focus?.label ?? ""}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{t("mods.steps.of", { n: at + 1, m: steps.length })}</span>
      </div>
      <div aria-hidden data-slot="mod-steps-bar" className="flex h-1 gap-0.5">
        {steps.map((step, i) => (
          <span key={i} data-state={step.state} className={cn("h-full flex-1 overflow-hidden rounded-sm bg-muted", inkOf(STEP_TONE[step.state], ctx.stale))}>
            {step.state !== "todo" && <span className={cn("block h-full rounded-sm bg-current", step.state === "running" ? "w-1/2" : "w-full")} />}
          </span>
        ))}
      </div>
      <ol className="sr-only">
        {steps.map((step, i) => (
          <li key={i}>
            {step.label}: {t(STEP_WORD[step.state])}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── mark ──────────────────────────────────────────────────────────────────────────────────────

function MarkView({ node, ctx, path }: { node: MarkNode; ctx: RenderCtx; path: string }) {
  const state = controlState(ctx, path);
  const intent = node.intent;
  return (
    <div {...leafBox(node)} className="flex min-w-0 items-center">
      <ModMark
        mark={node}
        modName={ctx.modName}
        stale={ctx.stale}
        busy={state === "busy"}
        unknown={state === "unknown"}
        onTap={intent === undefined || partBusy(ctx) ? undefined : () => ctx.onTap(ctx.partKey, intent, node.args, path)}
      />
    </div>
  );
}

// ── time ──────────────────────────────────────────────────────────────────────────────────────

/** A moment's words, ticking on the bridge's clock. Its own component, so only a time subscribes. */
export function ModTime({ at, style, now }: { at: string; style?: TimeNode["style"]; now?: number }) {
  const clock = useBridgeNow(now);
  const text = modTimeText(at, style, clock);
  return (
    <time dateTime={at} className="tabular-nums">
      {text ?? ""}
    </time>
  );
}

function TimeView({ node, ctx }: { node: TimeNode; ctx: RenderCtx }) {
  return (
    <div {...leafBox(node)} className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {node.label !== undefined && <span className="truncate text-xs text-muted-foreground">{node.label}</span>}
      <span className="shrink-0 text-sm leading-5">
        <ModTime at={node.at} style={node.style} now={ctx.now} />
      </span>
    </div>
  );
}

// ── layout ────────────────────────────────────────────────────────────────────────────────────

const GAP_CLASS = { tight: "gap-1", normal: "gap-2", loose: "gap-4" } as const satisfies { readonly [G in keyof typeof GAP_REM]: string };
const STACK_ALIGN = { start: "items-start", center: "items-center", end: "items-end", between: "items-stretch" } as const satisfies { readonly [A in Align]: string };
const ROW_ALIGN = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" } as const satisfies { readonly [A in Align]: string };

function gapClass(gap: string | undefined): string {
  return gap === "tight" || gap === "loose" ? GAP_CLASS[gap] : GAP_CLASS.normal;
}

function alignOf(align: string | undefined): Align | undefined {
  return align === "start" || align === "center" || align === "end" || align === "between" ? align : undefined;
}

function LayoutView({ node, ctx, path }: { node: Extract<ViewNode, { kind: "stack" | "row" }>; ctx: RenderCtx; path: string }) {
  const align = alignOf(node.align);
  const children = Array.isArray(node.children) ? node.children.slice(0, VIEW_LIMITS.children.max) : [];
  const row = node.kind === "row";
  return (
    <div
      data-mod-node={node.kind}
      className={cn(
        "flex min-w-0",
        row ? "flex-row items-center" : "flex-col",
        gapClass(node.gap),
        row ? (align === undefined ? "" : ROW_ALIGN[align]) : align === undefined ? "items-stretch" : STACK_ALIGN[align],
      )}
    >
      {children.map((child, i) => (
        <div key={i} className={cn("min-w-0 max-w-full", row && child.kind === "text" && "flex-1")}>
          {renderNode(child, ctx, `${path}/${i}`)}
        </div>
      ))}
    </div>
  );
}

// ── the switch ────────────────────────────────────────────────────────────────────────────────

function renderNode(node: ViewNode, ctx: RenderCtx, path: string): ReactNode {
  if (!CORE.has(node.kind)) return <Placeholder kind={node.kind} />;
  switch (node.kind) {
    case "stack":
    case "row":
      return <LayoutView node={node} ctx={ctx} path={path} />;
    case "text":
      return <TextView node={node} ctx={ctx} />;
    case "number":
      return <NumberView node={node} ctx={ctx} />;
    case "kv":
      return <KvView node={node} ctx={ctx} />;
    case "list":
      return <ListView node={node} ctx={ctx} path={path} />;
    case "button":
      return <ButtonView node={node} ctx={ctx} path={path} />;
    case "progress":
      return <ProgressView node={node} />;
    case "steps":
      return <StepsView node={node} ctx={ctx} />;
    case "mark":
      return <MarkView node={node} ctx={ctx} path={path} />;
    case "time":
      return <TimeView node={node} ctx={ctx} />;
    default:
      return <Placeholder kind={node.kind} />;
  }
}

/** Draw a view tree. The root's path is `v`; a control's path is its place in the tree below it. */
export function renderView(node: ViewNode, ctx: RenderCtx): ReactNode {
  return renderNode(node, ctx, "v");
}
