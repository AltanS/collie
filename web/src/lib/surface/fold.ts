// The fold: a numbered log of inputs in, one Surface out (M56 spec 04; the contract is in the M56
// README and experiments/reader-stability/ARCHITECTURE.md section 1).
//
// The log is a list of numbered inputs, each from one source. Version 1 has two sources: screen reads
// and ticks. Each source has one step in SOURCE_STEPS, so a later source (a hook edge, a mux hint) is
// one more row there and one more claim rule below, not a rewrite.
//
// The rules, from the contract:
//  - Only the screen may say `modal: none` and `composer: empty | draft`.
//  - `turn`: idle when the frame is found and no running sign is in its volatile rows, running when
//    one is, unknown otherwise.
//  - `modal`: the ask a reader lifted; else `unreadable` on a strong generic cue; else `unknown` on a
//    weak one; else `none` when the frame is found; else `unknown`.
//  - `composer`: empty on the placeholder or an empty interior, draft on text, unreachable when the
//    pane could not be read, unknown otherwise.
//  - `reason`: stale when the newest read is older than two poll intervals at the newest input; torn
//    when the read's rows end inside a frame; no-match when there is no frame, no cue and no lift.
//    `contested` waits for a second source.
//  - No clock makes a `free`. A tick can only take one away (stale).
//
// Pure: no DOM, no Bun API, no harness name. One log and one context always give one Surface.

import { readCues, runningSign, type CueRead } from "./cues";
import { findInputFrame, frameEdge, rowText, type Frame, type FrameRow, type IdleProfile } from "./frame";
import type { Ask, Surface, SurfaceComposer, SurfaceModal, SurfaceReason, SurfaceTurn } from "./surface";

/** The sources the fold reads, in version 1. */
export const SURFACE_SOURCES = ["screen", "tick"] as const;
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

export type SurfaceInput = ScreenInput | TickInput;

export interface FoldContext {
  /** The pane's profile `idle` block, or null when its harness has no profile. */
  readonly idle: IdleProfile | null;
  /** The poll interval in ms. A read older than two of them is stale. */
  readonly pollMs: number;
}

/** The Surface and what it was read from, for the shadow's log and the corpus table. */
export interface SurfaceRead {
  readonly surface: Surface;
  readonly frame: Frame | null;
  readonly cues: CueRead | null;
}

interface FoldState {
  readonly screen: ScreenInput | null;
  /** The time of the newest input of any source. */
  readonly now: number;
}

/** One step per source. A new source adds a row here. */
const SOURCE_STEPS = {
  screen: (state: FoldState, input: ScreenInput): FoldState => ({ screen: input, now: Math.max(state.now, input.at) }),
  tick: (state: FoldState, input: TickInput): FoldState => ({ ...state, now: Math.max(state.now, input.at) }),
} satisfies { readonly [K in SurfaceSource]: (state: FoldState, input: Extract<SurfaceInput, { source: K }>) => FoldState };

function step(state: FoldState, input: SurfaceInput): FoldState {
  switch (input.source) {
    case "screen":
      return SOURCE_STEPS.screen(state, input);
    case "tick":
      return SOURCE_STEPS.tick(state, input);
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
  const frame = idle === null ? null : findInputFrame(rows, idle);
  const cues = readCues(rows, frame);

  const turn: SurfaceTurn = frame === null ? "unknown" : runningSign(rows, frame) ? "running" : "idle";

  let modal: SurfaceModal;
  if (input.ask !== null) modal = { ask: input.ask };
  else if (cues.strength === "strong") modal = "unreadable";
  else if (cues.strength === "weak") modal = "unknown";
  else if (frame !== null) modal = "none";
  else modal = "unknown";

  const composer: SurfaceComposer =
    frame === null ? "unknown" : frame.placeholder || frame.interior.text.length === 0 ? "empty" : "draft";

  let reason: SurfaceReason | undefined;
  if (frame === null && idle !== null && endsInsideFrame(rows, idle)) reason = "torn";
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
 * Fold a numbered log into a Surface. Inputs are taken in `seq` order (ties keep their place in the
 * list), whatever order the list holds them in. With no screen read in the log the Surface is all
 * unknown, revision 0, reason stale: nothing fresh has been read.
 */
export function foldSurface(log: readonly SurfaceInput[], context: FoldContext): SurfaceRead {
  const ordered = log.map((input, index) => ({ input, index })).toSorted((a, b) => a.input.seq - b.input.seq || a.index - b.index);
  let state: FoldState = { screen: null, now: Number.NEGATIVE_INFINITY };
  for (const { input } of ordered) state = step(state, input);

  if (state.screen === null) {
    return { surface: { revision: 0, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" }, frame: null, cues: null };
  }
  const read = surfaceOfScreen(state.screen, context.idle);
  if (state.now - state.screen.at > 2 * context.pollMs) return { ...read, surface: staled(read.surface) };
  return read;
}
