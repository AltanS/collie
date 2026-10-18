// The fold: a numbered log of inputs in, one Surface out (M56 spec 04; the contract is in the M56
// README and experiments/reader-stability/ARCHITECTURE.md section 1).
//
// The log is a list of numbered inputs, each from one source: screen reads, ticks and hook edges
// (spec 11). Each source has one step in SOURCE_STEPS, so a later source (a mux hint) is one more row
// there and one more claim rule below, not a rewrite.
//
// The rules, from the contract:
//  - Only the screen may say `modal: none` and `composer: empty | draft`.
//  - `turn`: idle when the frame is found and no running sign is in its volatile rows, running when
//    one is, unknown otherwise.
//  - `modal`: the ask a reader lifted; else `unreadable` on a strong generic cue; else `unknown` on a
//    weak one; else `unreadable` when a row of the profile's `overlayRows` stands above the frame
//    (a dialog drawn over the transcript, the box left on screen); else `none` when the frame is
//    found; else `unknown`.
//  - `composer`: empty on the placeholder or an empty interior, draft on text, unreachable when the
//    pane could not be read, unknown otherwise.
//  - `reason`: stale when the newest read is older than two poll intervals at the newest input (an
//    edge newer than the read counts only once the read is that old too); torn when the read's rows end inside a frame; no-match when there is
//    no frame, no cue and no lift; contested when the screen reads free while a running edge is
//    younger than the settle time.
//  - No clock makes a `free`. A tick can only take one away (stale).
//
// Edges (spec 11) are edges, not levels. An edge newer than the last read makes it stale only once
// that read is older than two poll intervals (2026-10-17: Claude Code fires a tool edge about once a
// second while subagents work, and each one flipped a fresh read to stale, so the composer flickered
// "Last read 0 s ago"). Below that age the read's own verdict stands, with the blocks applied, and the
// fresh read the edge asks for replaces it. A `prompt` edge opens a
// running block: the turn reads running while the screen says idle. A `dialog` edge opens a modal
// block: the modal reads `unreadable` while the screen says none. The screen lifting an ask ends a
// modal block. A block ends on a closing edge (`stop`, `start`, `end`), or on the screen reading free
// on LOST_STOP_READS reads over LOST_STOP_SPAN_MS, which counts as one lost-Stop incident. A `stop`
// edge never makes a free: after it, the turn is the screen's claim.
//
// The fold is a reduction: `stepFold` takes one input, `readFold` reads the state. The bridge keeps
// the state per pane, because a turn and its blocks outlive any short log. `foldSurface` reduces a
// whole log, for tests and traces.
//
// Pure: no DOM, no Bun API, no harness name. One log and one context always give one Surface.

import { readCuesFor, runningSign, type CueRead } from "./cues";
import { coveredFrame, findInputFrame, frameEdge, rowText, type Frame, type FrameRow, type IdleProfile } from "./frame";
import { LOST_STOP_READS, LOST_STOP_SPAN_MS, SETTLE_MS, type EdgeKind } from "./edges";
import { isFree, type Ask, type Surface, type SurfaceComposer, type SurfaceModal, type SurfaceReason, type SurfaceTurn } from "./surface";

/** The sources the fold reads. */
export const SURFACE_SOURCES = ["screen", "tick", "edge"] as const;
export type SurfaceSource = (typeof SURFACE_SOURCES)[number];

/** A screen read: the rows the multiplexer returned, or null when the pane could not be read. */
export interface ScreenInput {
  readonly seq: number;
  readonly source: "screen";
  /** Milliseconds, on the caller's clock. */
  readonly at: number;
  /** The multiplexer's revision of the read. The Surface carries it. */
  readonly revision: number;
  readonly rows: readonly FrameRow[] | null;
  /** The ask a reader lifted from these rows, or null. */
  readonly ask: Ask | null;
}

/** A tick: time passed and nothing was read. It can only make the newest read stale. */
export interface TickInput {
  readonly seq: number;
  readonly source: "tick";
  readonly at: number;
}

/** A hook edge, mapped to its neutral kind by the pane's profile (edges.ts). */
export interface EdgeInput {
  readonly seq: number;
  readonly source: "edge";
  /** When the bridge took the edge, on the caller's clock. */
  readonly at: number;
  readonly kind: EdgeKind;
}

export type SurfaceInput = ScreenInput | TickInput | EdgeInput;

export interface FoldContext {
  /** The pane's profile `idle` block, or null when its harness has no profile. */
  readonly idle: IdleProfile | null;
  /** The poll interval in ms. A read older than two of them is stale. */
  readonly pollMs: number;
  /** How long a running edge outvotes a free screen as `contested`. Defaults to SETTLE_MS. */
  readonly settleMs?: number;
  /**
   * The sources the fold takes. An input from any other source is skipped. Defaults to every source.
   * The CI test varies this list: every trace must stay safe with the hook source removed.
   */
  readonly sources?: readonly SurfaceSource[];
}

/** The Surface and what it was read from, for the shadow's log and the corpus table. */
export interface SurfaceRead {
  readonly surface: Surface;
  readonly frame: Frame | null;
  readonly cues: CueRead | null;
}

/** A block an edge opened: when the edge came. */
export interface EdgeBlock {
  readonly since: number;
}

/** The fold's state for one pane. Callers keep it and read the counts; only the fold changes it. */
export interface FoldState {
  readonly screen: ScreenInput | null;
  /** The Surface of `screen` alone, before time and edges, computed once per read. */
  readonly screenRead: SurfaceRead | null;
  /** The time of the newest input of any source. */
  readonly now: number;
  /** The time of the newest edge, or null. A read older than it is stale once that read is also older than two poll intervals. */
  readonly lastEdgeAt: number | null;
  /** The running block a `prompt` edge opened, or null. */
  readonly running: EdgeBlock | null;
  /** The modal block a `dialog` edge opened, or null. */
  readonly dialog: EdgeBlock | null;
  /** The times of the free screen reads in a row since a block opened. */
  readonly freeReads: readonly number[];
  /** Blocks the screen ended with free reads: lost-Stop incidents. */
  readonly lostStops: number;
}

/** The state before any input. */
export function emptyFoldState(): FoldState {
  return { screen: null, screenRead: null, now: Number.NEGATIVE_INFINITY, lastEdgeAt: null, running: null, dialog: null, freeReads: [], lostStops: 0 };
}

/** True while an edge holds a block open. */
export function hasBlock(state: FoldState): boolean {
  return state.running !== null || state.dialog !== null;
}

/**
 * A screen read: the newest read, and the block rules that only a read can apply. A read taken
 * before the one the state holds changes nothing: it can land late (a poll read behind a fresh read an
 * edge asked for), and an older idle read must never replace a newer dialog read.
 */
function stepScreen(state: FoldState, input: ScreenInput, context: FoldContext): FoldState {
  if (state.screen !== null && input.at < state.screen.at) return { ...state, now: Math.max(state.now, input.at) };
  const screenRead = surfaceOfScreen(input, context.idle);
  let next: FoldState = { ...state, screen: input, screenRead, now: Math.max(state.now, input.at) };
  // The screen lifted the ask: it carries the modal itself now, so the modal block is done.
  if (next.dialog !== null && input.ask !== null) next = { ...next, dialog: null };
  if (!hasBlock(next)) return next.freeReads.length === 0 ? next : { ...next, freeReads: [] };
  if (!isFree(screenRead.surface)) return { ...next, freeReads: [] };
  const freeReads = [...next.freeReads, input.at];
  const first = freeReads[0] ?? input.at;
  if (freeReads.length >= LOST_STOP_READS && input.at - first >= LOST_STOP_SPAN_MS) {
    return { ...next, running: null, dialog: null, freeReads: [], lostStops: next.lostStops + 1 };
  }
  return { ...next, freeReads };
}

/** An edge: the read goes stale, and the kind opens or closes a block. */
function stepEdge(state: FoldState, input: EdgeInput): FoldState {
  const lastEdgeAt = Math.max(state.lastEdgeAt ?? Number.NEGATIVE_INFINITY, input.at);
  const base: FoldState = { ...state, now: Math.max(state.now, input.at), lastEdgeAt };
  switch (input.kind) {
    case "prompt":
      return { ...base, running: { since: input.at }, freeReads: [] };
    case "dialog":
      return { ...base, dialog: { since: input.at }, freeReads: [] };
    case "stop":
    case "start":
    case "end":
      return { ...base, running: null, dialog: null, freeReads: [] };
    case "reread":
    case "tool":
      return base;
  }
}

/** One step per source. A new source adds a row here. */
const SOURCE_STEPS = {
  screen: (state: FoldState, input: ScreenInput, context: FoldContext): FoldState => stepScreen(state, input, context),
  tick: (state: FoldState, input: TickInput): FoldState => ({ ...state, now: Math.max(state.now, input.at) }),
  edge: (state: FoldState, input: EdgeInput): FoldState => stepEdge(state, input),
} satisfies { readonly [K in SurfaceSource]: (state: FoldState, input: Extract<SurfaceInput, { source: K }>, context: FoldContext) => FoldState };

/** One input into the state. An input from a source outside `context.sources` changes nothing. */
export function stepFold(state: FoldState, input: SurfaceInput, context: FoldContext): FoldState {
  if (context.sources !== undefined && !context.sources.includes(input.source)) return state;
  switch (input.source) {
    case "screen":
      return SOURCE_STEPS.screen(state, input, context);
    case "tick":
      return SOURCE_STEPS.tick(state, input);
    case "edge":
      return SOURCE_STEPS.edge(state, input);
  }
}

/**
 * Whether the rows end inside a frame: no frame closed, but walking up from the last row through rows
 * that are no edge reaches the profile's prompt row with a top edge over it. A read cut under a live
 * box looks like this.
 */
export function endsInsideFrame(rows: readonly FrameRow[], idle: IdleProfile): boolean {
  const texts = rows.map(rowText);
  let i = texts.length - 1;
  while (i >= 0 && texts[i]!.trim().length === 0) i--;
  let crossed = 0;
  while (i >= 0 && frameEdge(texts[i]!, idle) === null && crossed < idle.frame.maxDraftRows) {
    crossed++;
    i--;
  }
  if (i < 0 || frameEdge(texts[i]!, idle) !== "prompt") return false;
  i--;
  while (i >= 0 && texts[i]!.trim().length === 0) i--;
  if (i < 0) return false;
  const edge = frameEdge(texts[i]!, idle);
  return edge === "top" || edge === "bottom";
}

/** The Surface of one screen read, before time is applied. */
export function surfaceOfScreen(input: ScreenInput, idle: IdleProfile | null): SurfaceRead {
  if (input.rows === null) {
    return { surface: { revision: input.revision, turn: "unknown", modal: "unknown", composer: "unreachable" }, frame: null, cues: null };
  }
  const rows = input.rows;
  const found = idle === null ? null : findInputFrame(rows, idle);
  const cues = readCuesFor(rows, found, idle);
  // A dialog drawn in the box's place (`idle.dialogsInBox`) hides the box: the screen makes no claim about it.
  const frame = idle?.dialogsInBox === true && cues.strength === "strong" ? null : found;

  const turn: SurfaceTurn = frame === null || idle === null ? "unknown" : runningSign(rows, frame, idle.runningRows) ? "running" : "idle";

  // A dialog the profile names drawn over the screen above a live box (`idle.overlayRows`).
  const covered = frame !== null && idle !== null && coveredFrame(rows, frame, idle);
  let modal: SurfaceModal;
  if (input.ask !== null) modal = { ask: input.ask };
  else if (cues.strength === "strong") modal = "unreadable";
  else if (cues.strength === "weak") modal = "unknown";
  else if (covered) modal = "unreadable";
  else if (frame !== null) modal = "none";
  else modal = "unknown";

  // Under a panel that takes the keys the box is not what a key reaches, so the screen claims nothing
  // of it: a panel's dismiss hint over the box, or a dialog the profile names over it.
  const composer: SurfaceComposer =
    frame === null || cues.panelFoot === true || covered ? "unknown" : frame.placeholder || frame.interior.text.length === 0 ? "empty" : "draft";

  let reason: SurfaceReason | undefined;
  // Torn is a read cut inside the box. A whole box the dialog rule hid above is not one: its strong cue
  // already keeps it from free, and the person may check the screen and confirm.
  if (found === null && idle !== null && endsInsideFrame(rows, idle)) reason = "torn";
  else if (frame === null && input.ask === null && cues.strength === "none") reason = "no-match";

  const surface: Surface = reason === undefined ? { revision: input.revision, turn, modal, composer } : { revision: input.revision, turn, modal, composer, reason };
  return { surface, frame, cues };
}

/** A stale Surface: every claim only the screen may make becomes unknown. An ask or `unreadable`
 *  stays, since neither is ever free. */
function staled(surface: Surface): Surface {
  const modal: SurfaceModal = surface.modal === "none" ? "unknown" : surface.modal;
  const composer: SurfaceComposer = surface.composer === "unreachable" ? "unreachable" : "unknown";
  return { revision: surface.revision, turn: "unknown", modal, composer, reason: "stale" };
}

/**
 * The edges' claims on a fresh read. A running block makes an idle turn `running`, or `unknown`
 * with reason `contested` when the screen reads free and the edge is younger than the settle time.
 * A modal block makes `modal: none` read `unreadable`. Neither can make a claim free.
 */
function withBlocks(surface: Surface, state: FoldState, context: FoldContext): Surface {
  let out = surface;
  if (state.running !== null && out.turn === "idle") {
    const young = state.now - state.running.since < (context.settleMs ?? SETTLE_MS);
    out = young && isFree(out) ? { ...out, turn: "unknown", reason: "contested" } : { ...out, turn: "running" };
  }
  if (state.dialog !== null && out.modal === "none") out = { ...out, modal: "unreadable" };
  return out;
}

/** The Surface the state reads as now. */
export function readFold(state: FoldState, context: FoldContext): SurfaceRead {
  if (state.screen === null || state.screenRead === null) {
    return { surface: { revision: 0, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" }, frame: null, cues: null };
  }
  const read = state.screenRead;
  // Stale: the read is older than two poll intervals at the newest input. An edge newer than the read
  // moves the newest input on, so an edged read goes stale at that same age and not before: a young
  // edged read keeps its verdict (with the edges' blocks) until the fresh read the edge asked for.
  const old = state.now - state.screen.at > 2 * context.pollMs;
  if (old) return { ...read, surface: staled(read.surface) };
  const surface = withBlocks(read.surface, state, context);
  return surface === read.surface ? read : { ...read, surface };
}

/** Inputs in `seq` order (ties keep their place in the list), whatever order the list holds them in. */
function inSeqOrder(log: readonly SurfaceInput[]): SurfaceInput[] {
  return log
    .map((input, index) => ({ input, index }))
    .toSorted((a, b) => a.input.seq - b.input.seq || a.index - b.index)
    .map(({ input }) => input);
}

/** The state a whole log folds to. */
export function foldState(log: readonly SurfaceInput[], context: FoldContext): FoldState {
  let state = emptyFoldState();
  for (const input of inSeqOrder(log)) state = stepFold(state, input, context);
  return state;
}

/**
 * Fold a numbered log into a Surface. Inputs are taken in `seq` order (ties keep their place in the
 * list), whatever order the list holds them in. With no screen read in the log the Surface is all
 * unknown, revision 0, reason stale: nothing fresh has been read.
 */
export function foldSurface(log: readonly SurfaceInput[], context: FoldContext): SurfaceRead {
  return readFold(foldState(log, context), context);
}
