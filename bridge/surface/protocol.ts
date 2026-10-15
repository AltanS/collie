// The Send Protocol v1 (M56 spec 05; the contract is in the M56 README, "Send Protocol", and the
// steps in experiments/reader-stability/ARCHITECTURE.md section 2). One request, one lock per pane,
// one receipt, a closed list of outcomes. The box is proven by what typing does, not by what it looks
// like, and the submit key leaves only through the key gate.
//
// Steps, each bounded as (max reads, max ms):
//   accept  write `<stateDir>/sends/<id>.json` before any key; the same id returns the same receipt
//   S0      (2, 1200) a fresh read after the request arrived, stable across two mux calls; the
//           Surface must be free, or unknown(no-match) with the hash of the rows the person saw
//   probe   (3, 900) on the probed path: write the probe character, require exactly that one new run
//           and no other change, Backspace through the gate, require the S0 box again
//   write   the whole text in one write per line (a bracketed paste where the multiplexer and the
//           profile allow it); a line break is the profile's newline key, through the gate
//   S1      (6, 2500) read until the box holds exactly the predicted text (or the profile's collapse
//           form) and nothing else moved; else `typed_not_submitted`
//   commit  the profile's submit keys through the gate with a 150 ms token; `submit-sent` is on disk first
//   S2      (6, 3000) read until the box is empty or a running sign shows: `sent`; else `unknown`
// A request past the sum of the bounds ends `unknown` and releases the lock. Escape is never sent.
//
// A pane whose harness has a profile is read through its input frame. A pane with no profile has no
// frame: its Surface is unknown(no-match), every send on it is probed, and the probe's own landing
// spot (the row and column where the probe character appeared) is what S1 and S2 compare against.
//
// Rows live only in the short memory ring below; the receipt and the request file hold hashes.
// No harness name lives here (no-harness-names.test.ts scans this folder).

import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { readCues, runningSign } from "../../web/src/lib/surface/cues.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { findInputFrame, rowText, type Frame, type FrameRow } from "../../web/src/lib/surface/frame.ts";
import { liftAsk, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import {
  offersFor,
  reservedLead,
  sendLines,
  wsFree,
  type ReadMark,
  type SendAnswer,
  type SendMode,
  type SendOutcome,
  type SendReason,
  type SendReceipt,
  type SendStep,
} from "../../web/src/lib/surface/send.ts";
import { isFree, shortHash, type Surface } from "../../web/src/lib/surface/surface.ts";
import type { KeyGate } from "./key-gate.ts";
import type { RequestStore, SendRecord } from "./requests.ts";

/** The step bounds, written as (max reads, max ms). */
export const BOUNDS = {
  s0: { reads: 2, ms: 1200 },
  probe: { reads: 3, ms: 900 },
  s1: { reads: 6, ms: 2500 },
  s2: { reads: 6, ms: 3000 },
} as const;

/** The session lock's bound: the sum of the step bounds. A request past it ends `unknown`. */
export const LOCK_BOUND_MS = BOUNDS.s0.ms + BOUNDS.probe.ms + BOUNDS.s1.ms + BOUNDS.s2.ms;

/** The probe character on a pane with no profile: the slice 0 lab found it inert in every hotkey dialog. */
export const GENERIC_PROBE = "⌁";
/** The submit key on a pane with no profile. */
const GENERIC_SUBMIT = ["Enter"] as const;
/** The clear key on a pane with no profile. Never Escape. */
const GENERIC_CLEAR = { key: "Backspace", slack: 16 } as const;
/** The reserved leads on a pane with no profile: a slash command, a shell line, a file mention. */
const GENERIC_LEADS = ["/", "!", "@"] as const;

/** Rows one protocol read asks for. A viewport read never moves the screen. */
export const SEND_READ_LINES = 120;
/** The bottom window the probe must land in and the rows hash covers. */
export const CLUSTER_ROWS = 24;
/** The gap before the first poll of a step; each later gap doubles. */
const FIRST_GAP_MS = 80;
/** The gap between the two S0 reads. */
const S0_GAP_MS = 120;
/** Keys per clear batch; a read sits between two batches. */
const CLEAR_BATCH = 256;
/** Texts this short take the probed path whatever the profile says. */
const SHORT_TEXT = 3;

/** Which verb route a reserved lead belongs to, for the refusal's sentence. */
const LEAD_ROUTES = new Map<string, string>(Object.entries({
  "/": "A slash command goes through the commands sheet (POST /api/pane/:id/reply), not the Send Protocol.",
  "!": "A shell line goes through the old reply route (POST /api/pane/:id/reply), not the Send Protocol.",
  "@": "A file mention at the start goes through the old reply route (POST /api/pane/:id/reply), not the Send Protocol.",
}));

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** What the protocol needs of a multiplexer besides keys (which only the gate sends). */
export interface ProtocolMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
  typeText(paneId: string, text: string): Promise<MuxAck>;
  /** A bracketed paste, where the multiplexer has one. */
  pasteText?(paneId: string, text: string): Promise<MuxAck>;
}

/** The pane a request is for, as the bridge's own snapshot names it. */
export interface SendTarget {
  readonly session: string;
  readonly paneId: string;
  /** The agent string the multiplexer reports; it picks the profile by id. */
  readonly harness: string;
}

export interface SendDeps {
  readonly mux: ProtocolMux;
  readonly gate: KeyGate;
  readonly store: RequestStore;
  readonly locks: SessionLocks;
  readonly ring: RowRing;
  /** The harness's profile at its binary's version, or null when the harness has no profile. */
  readonly profile: (harness: string) => Promise<ProfileMatch | null>;
  /** The pane's generation now, or null when the pane is gone. */
  readonly generation: (paneId: string) => string | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A request as the route checked it. */
export interface SendRequest {
  readonly id: string;
  readonly text: string;
  readonly mode: SendMode;
  readonly rowsHash?: string;
  /** The Surface revision the phone showed when the person tapped, or 0. */
  readonly revision?: number;
}

// ── The lock and the ring ────────────────────────────────────────────────────────────────────────

/** One lock per pane, held by one request until it settles or its bound passes. */
export class SessionLocks {
  private readonly held = new Map<string, { owner: string; until: number }>();

  /** Take the lock, or false when another request holds it inside its bound. A lock past its bound is free. */
  acquire(key: string, owner: string, until: number, now: number): boolean {
    const current = this.held.get(key);
    if (current !== undefined && current.owner !== owner && current.until >= now) return false;
    this.held.set(key, { owner, until });
    return true;
  }

  /** Whether `owner` still holds the lock inside its bound. */
  owns(key: string, owner: string, now: number): boolean {
    const current = this.held.get(key);
    return current !== undefined && current.owner === owner && current.until >= now;
  }

  release(key: string, owner: string): void {
    if (this.held.get(key)?.owner === owner) this.held.delete(key);
  }
}

/** One read's rows, kept in memory only: they can hold secrets. */
export interface RingEntry {
  readonly requestId: string;
  readonly step: string;
  readonly at: number;
  readonly rows: readonly string[];
}

/** The short memory ring of rows the protocol read. Never written to disk, never on the wire. */
export class RowRing {
  private readonly entries: RingEntry[] = [];
  constructor(private readonly capacity = 32) {}

  push(entry: RingEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  of(requestId: string): RingEntry[] {
    return this.entries.filter((entry) => entry.requestId === requestId);
  }

  get size(): number {
    return this.entries.length;
  }
}

// ── One read ─────────────────────────────────────────────────────────────────────────────────────

/** One screen read as the protocol sees it. */
interface Snap {
  readonly revision: number;
  /** The gate's revision for the pane, taken with this read. */
  readonly gateRevision: number;
  readonly rows: readonly FrameRow[];
  /** Row texts, trailing blanks cut. */
  readonly texts: readonly string[];
  /** Row texts with faint (SGR 2) runs dropped, trailing blanks cut: a placeholder is faint. */
  readonly plain: readonly string[];
  readonly frame: Frame | null;
  readonly surface: Surface;
  readonly cueStrength: "none" | "weak" | "strong";
  /** The generic cues of the bottom cluster read as if no frame were found: a popup under the box
   *  that walks like a status row escapes the framed read, never this one. Compared with S0's. */
  readonly bareCues: "none" | "weak" | "strong";
  /** A short hash of the whole read. */
  readonly hash: string;
  /** A short hash of the bottom window, the rows a person checks before a two-tap send. */
  readonly rowsHash: string;
}

function plainOf(row: FrameRow): string {
  let out = "";
  for (const run of row.segments) if (run.dim !== true) out += run.text;
  return out.trimEnd();
}

/** The index past the last non-blank row. */
function contentEnd(texts: readonly string[]): number {
  let end = texts.length;
  while (end > 0 && texts[end - 1]!.trim().length === 0) end--;
  return end;
}

/** A run of rows: `first` included, `end` not. */
interface RowWindow {
  readonly first: number;
  readonly end: number;
}

function bottomWindow(texts: readonly string[]): RowWindow {
  const end = contentEnd(texts);
  return { first: Math.max(0, end - CLUSTER_ROWS), end };
}

function mark(snap: Snap | null): ReadMark | null {
  return snap === null ? null : { revision: snap.revision, hash: snap.hash };
}

/** What a frame says about the box: its text, or "" when it shows the placeholder. */
function boxText(frame: Frame): string {
  return frame.placeholder ? "" : frame.interior.text;
}

const CUE_RANK = { none: 0, weak: 1, strong: 2 } as const;

/** Whether the generic cues of the bottom cluster grew stronger since `before`. */
function cueAppeared(before: Snap, after: Snap): boolean {
  return CUE_RANK[after.bareCues] > CUE_RANK[before.bareCues];
}

/** The non-blank rows under a frame's bottom edge. */
function rowsBelow(snap: Snap, frame: Frame): number {
  let n = 0;
  for (let i = frame.bottom + 1; i < snap.texts.length; i++) if (snap.texts[i]!.trim().length > 0) n++;
  return n;
}

/** The rows above a frame, the volatile band over the top edge left out, trailing blanks cut. */
function transcriptAbove(snap: Snap, frame: Frame): string[] {
  const end = frame.volatile.above === null ? frame.top : frame.volatile.above.first;
  const rows = snap.texts.slice(0, end).map((t) => t.trimEnd());
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  return rows;
}

/**
 * Whether everything outside the box stayed put between two reads of a framed pane: the transcript
 * above (it may scroll up by as many rows as the box grew, plus one), the same count of rows under
 * the box (a popup adds rows there), and no modal cue. The volatile band over the box may change.
 */
function outsideUnchanged(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  if (after.cueStrength !== "none" || cueAppeared(before, after)) return false;
  if (rowsBelow(before, before.frame) !== rowsBelow(after, after.frame)) return false;
  const a = transcriptAbove(before, before.frame);
  const b = transcriptAbove(after, after.frame);
  const grew = after.frame.bottom - after.frame.top - (before.frame.bottom - before.frame.top);
  for (let shift = 0; shift <= Math.max(0, grew) + 1; shift++) {
    const tail = a.slice(shift);
    if (tail.length === b.length && tail.every((row, i) => row === b[i])) return true;
  }
  return false;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

/**
 * Whether the box text equals `prefix` then each line, white space and wrapping ignored. A line may
 * also show as the profile's collapse form (a long paste the harness folded), whose line count, if it
 * carries one, must say one line: each written line is its own write.
 */
export function boxMatches(box: string, prefix: string, lines: readonly string[], collapse: RegExp | null): boolean {
  let p = 0;
  const skip = (): void => {
    while (isSpace(box[p])) p++;
  };
  const eat = (part: string): boolean => {
    let q = p;
    for (const ch of wsFree(part)) {
      while (isSpace(box[q])) q++;
      if (!box.startsWith(ch, q)) return false;
      q += ch.length;
    }
    p = q;
    return true;
  };
  const eatCollapse = (): boolean => {
    if (collapse === null) return false;
    skip();
    collapse.lastIndex = p;
    const m = collapse.exec(box);
    if (m === null || m.index !== p) return false;
    const lineCount = m.groups?.lines;
    if (lineCount !== undefined && Number(lineCount) > 1) return false;
    p += m[0].length;
    return true;
  };
  if (!eat(prefix)) return false;
  for (const line of lines) {
    const at = p;
    if (eat(line)) continue;
    p = at;
    if (!eatCollapse()) return false;
  }
  skip();
  return p === box.length;
}

/** Where the probe character landed on a pane with no frame: the row and the index in its plain text. */
interface Landing {
  readonly row: number;
  readonly index: number;
  /** The plain text of that row with the probe in it. */
  readonly probed: string;
  /** The probe's length in UTF-16 units. */
  readonly width: number;
}

/** The part of the probed row after the probe: what stays right of the typed text. */
function afterProbe(landing: Landing): string {
  return landing.probed.slice(landing.index + landing.width);
}

/**
 * The probe's landing on a pane with no frame: exactly one row of the read changed, inside the bottom
 * window, and the change is the probe character put in (blanks next to it may appear where a faint
 * placeholder stood). Null on anything else.
 */
export function probeLanding(before: readonly string[], after: readonly string[], probe: string): Landing | null {
  const endA = contentEnd(before);
  const endB = contentEnd(after);
  const end = Math.max(endA, endB);
  let changed = -1;
  for (let i = 0; i < end; i++) {
    if ((before[i] ?? "") === (after[i] ?? "")) continue;
    if (changed >= 0) return null;
    changed = i;
  }
  if (changed < 0 || changed < end - CLUSTER_ROWS) return null;
  const was = before[changed] ?? "";
  const now = after[changed] ?? "";
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  if (was.length - head - tail !== 0) return null;
  const put = now.slice(head, now.length - tail);
  if (put.trim() !== probe) return null;
  return { row: changed, index: head + put.indexOf(probe), probed: now, width: probe.length };
}

/** The whole read as one compare string, white space dropped. */
/** The index of the last row with any non-blank character, or -1. */
function lastFilled(rows: readonly string[]): number {
  return rows.findLastIndex((row) => row.trim().length > 0);
}

function flat(rows: readonly string[]): string {
  return wsFree(rows.join(""));
}

/** On a pane with no frame: the rows as they should read once `typed` stands where the probe stood. */
function predictedRows(base: readonly string[], landing: Landing, typed: string): string[] {
  const rows = [...base];
  rows[landing.row] = landing.probed.slice(0, landing.index) + typed + afterProbe(landing);
  return rows;
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

interface RunState {
  readonly request: SendRequest;
  readonly record: SendRecord;
  readonly target: SendTarget;
  readonly match: ProfileMatch | null;
  readonly lockKey: string;
  readonly deadline: number;
  readonly marks: { s0: Snap | null; s1: Snap | null; s2: Snap | null };
  readonly gaps: Partial<Record<SendStep, number>>;
  readonly keys: string[];
  probed: boolean;
  stepStart: number;
}

type Verdict = "pass" | "wait" | "fail";

/** What an end carries besides its outcome: the screen it saw, the rows hash, a sentence, and whether the pane had a frame. */
interface EndNote {
  surface?: Surface;
  rowsHash?: string;
  detail?: string;
  framed?: boolean;
}

/** An answer being built, field by field. */
type AnswerDraft = { -readonly [K in keyof SendAnswer]: SendAnswer[K] };

/** The note of an end that saw `snap`, when it saw one. */
function sawNote(snap: Snap | null, note: EndNote): EndNote {
  if (snap !== null) note.surface = snap.surface;
  return note;
}

/** An answer with the note's screen, rows hash and sentence copied on where they are set. */
function answerWith(draft: AnswerDraft, note: EndNote): SendAnswer {
  if (note.surface !== undefined) draft.surface = note.surface;
  if (note.rowsHash !== undefined) draft.rowsHash = note.rowsHash;
  if (note.detail !== undefined) draft.detail = note.detail;
  return draft;
}

class Ended extends Error {
  constructor(
    readonly outcome: SendOutcome,
    readonly reason: SendReason | undefined,
    readonly extra: EndNote = {},
  ) {
    super(`${outcome}${reason === undefined ? "" : `(${reason})`}`);
  }
}

/**
 * The Send Protocol for one bridge session. Holds no state of its own beyond what its ports hold: the
 * lock map, the gate's revisions, the request files and the ring.
 */
export class SendProtocol {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<SendAnswer>>();

  constructor(private readonly deps: SendDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** One request, start to receipt. Never throws for a pane's state; every end is an answer. */
  async handle(request: SendRequest, target: SendTarget): Promise<SendAnswer> {
    if (request.mode === "prepare") return this.prepare(target);
    const running = this.inFlight.get(request.id);
    if (running !== undefined) {
      // The same id while it runs: wait for it, then answer the stored receipt.
      await running;
      return this.handle(request, target);
    }
    const generation = this.deps.generation(target.paneId) ?? "gone";
    const accepted = this.deps.store.accept({
      id: request.id,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: generation,
      surfaceRevision: request.revision ?? 0,
      mode: request.mode,
      text: request.text,
    });
    if (accepted.kind === "id_reused") {
      // The stored request is someone else's; this refusal is not stored under its id.
      const receipt = this.receiptOf(this.bareState(request, accepted.record, target, null), "refused", "id_reused");
      return { receipt, offers: [], detail: "This request id was already used for another text." };
    }
    if (accepted.kind === "replay") {
      const stored = accepted.record.receipt;
      if (stored !== undefined) return { receipt: stored, offers: offersFor(stored.outcome, stored.reason, stored.profileId !== null), replayed: true };
      // Unsettled and not running here: the bridge died while it ran, and the start-up recovery has
      // not seen it. It ends `unknown` now, like recovery would end it.
      const receipt = this.receiptOf(this.bareState(request, accepted.record, target, null), "unknown", "crash");
      this.deps.store.settle(request.id, receipt);
      return { receipt, offers: offersFor("unknown", "crash", false), replayed: true };
    }
    const work = this.run(request, accepted.record, target);
    this.inFlight.set(request.id, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  /** The receipt a request that never settled gets after a restart (RequestStore.recover). */
  static crashReceipt(record: SendRecord): SendReceipt {
    return {
      requestId: record.id,
      session: record.session,
      paneId: record.paneId,
      paneGeneration: record.paneGeneration,
      harness: "-",
      version: null,
      profileId: null,
      profileStatus: null,
      mode: record.mode,
      textHash: record.textHash,
      textLength: record.textLength,
      probed: false,
      s0: null,
      s1: null,
      s2: null,
      gapsMs: {},
      keys: [],
      outcome: "unknown",
      reason: "crash",
    };
  }

  private bareState(request: SendRequest, record: SendRecord, target: SendTarget, match: ProfileMatch | null): RunState {
    const at = this.now();
    return {
      request,
      record,
      target,
      match,
      lockKey: `${target.session}\u0000${target.paneId}`,
      deadline: record.acceptedAt + LOCK_BOUND_MS,
      marks: { s0: null, s1: null, s2: null },
      gaps: {},
      keys: [],
      probed: false,
      stepStart: at,
    };
  }

  private receiptOf(state: RunState, outcome: SendOutcome, reason: SendReason | undefined): SendReceipt {
    const { record, target, match } = state;
    const base: SendReceipt = {
      requestId: record.id,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: record.paneGeneration,
      harness: target.harness,
      version: match?.version ?? null,
      profileId: match?.profile.id ?? null,
      profileStatus: match?.status ?? null,
      mode: record.mode,
      textHash: record.textHash,
      textLength: record.textLength,
      probed: state.probed,
      s0: mark(state.marks.s0),
      s1: mark(state.marks.s1),
      s2: mark(state.marks.s2),
      gapsMs: { ...state.gaps },
      keys: [...state.keys],
      outcome,
    };
    return reason === undefined ? base : { ...base, reason };
  }

  private async prepare(target: SendTarget): Promise<SendAnswer> {
    const match = await this.deps.profile(target.harness);
    const state = this.bareState({ id: "prepare", text: "", mode: "prepare" }, prepareRecord(target, this.now()), target, match);
    try {
      const snap = await this.stableRead(state, "prepare");
      return { surface: snap.surface, rowsHash: snap.rowsHash, offers: isFree(snap.surface) ? [] : ["commit", "keys"] };
    } catch (err) {
      if (err instanceof Ended) return answerWith({ offers: ["keys"] }, { ...err.extra, detail: err.extra.detail ?? err.message });
      throw err;
    }
  }

  private async run(request: SendRequest, record: SendRecord, target: SendTarget): Promise<SendAnswer> {
    const match = await this.deps.profile(target.harness);
    const state = this.bareState(request, record, target, match);
    const { locks } = this.deps;
    if (!locks.acquire(state.lockKey, record.id, state.deadline, this.now())) {
      return this.settle(state, new Ended("refused", "busy", { detail: "Another send on this pane is still running." }));
    }
    try {
      await this.steps(state);
      return this.settle(state, new Ended("sent", record.mode === "discard" ? "discarded" : undefined, { framed: true }));
    } catch (err) {
      if (err instanceof Ended) return this.settle(state, err);
      throw err;
    } finally {
      locks.release(state.lockKey, record.id);
    }
  }

  private settle(state: RunState, end: Ended): SendAnswer {
    const receipt = this.receiptOf(state, end.outcome, end.reason);
    this.deps.store.settle(state.record.id, receipt);
    const framed = end.extra.framed ?? (state.marks.s0?.frame ?? null) !== null;
    return answerWith({ receipt, offers: offersFor(end.outcome, end.reason, framed) }, end.extra);
  }

  // ── The steps ──

  private async steps(state: RunState): Promise<void> {
    const { request, match } = state;
    const profile = match?.profile ?? null;
    const lines = sendLines(request.text);
    const leads = profile?.reservedLeads ?? GENERIC_LEADS;
    const writes = request.mode === "send" || request.mode === "append" || request.mode === "replace";

    if (writes) {
      const lead = reservedLead(lines[0] ?? "", leads);
      if (lead !== null) throw new Ended("refused", "reserved_lead", { detail: LEAD_ROUTES.get(lead) ?? `A text that starts with ${lead} has its own route.` });
      if (lines.length > 1 && profile === null) {
        throw new Ended("refused", "not_free", { detail: "This harness has no profile, so its newline key is unknown; send one line at a time." });
      }
    }

    this.begin(state);
    let s0 = await this.stableRead(state, "s0");
    state.marks.s0 = s0;
    this.checkGeneration(state, "refused");

    switch (request.mode) {
      case "submit": {
        const frame = this.draftFrame(s0);
        if (!boxMatches(boxText(frame), "", lines, collapseOf(match))) throw new Ended("refused", "not_free", { surface: s0.surface, detail: "The box no longer holds this text." });
        this.lap(state, "s0");
        state.marks.s1 = s0;
        await this.commit(state, s0);
        await this.awaitSent(state, s0, null, lines);
        return;
      }
      case "discard": {
        const frame = this.draftFrame(s0);
        if (!boxMatches(boxText(frame), "", lines, collapseOf(match))) throw new Ended("refused", "not_free", { surface: s0.surface, detail: "The box no longer holds this text." });
        this.lap(state, "s0");
        await this.clear(state, s0);
        return;
      }
      case "replace": {
        const frame = this.draftFrame(s0);
        if (boxText(frame).length > 0) {
          s0 = await this.clear(state, s0);
          state.marks.s0 = s0;
        }
        break;
      }
      case "append":
        this.draftFrame(s0);
        break;
      case "send":
        this.gateSend(state, s0);
        break;
      case "prepare":
        return;
    }
    this.lap(state, "s0");

    const prefix = request.mode === "append" && s0.frame !== null ? boxText(s0.frame) : "";
    const text = lines.join("");
    state.probed =
      s0.frame === null || match === null || match.status !== "verified" || ([...text].length >= 1 && [...text].length <= SHORT_TEXT);
    let landing: Landing | null = null;
    if (state.probed) landing = await this.probe(state, s0, prefix);
    this.lap(state, "probe");

    await this.write(state, lines);
    this.lap(state, "write");

    const s1 = await this.awaitTyped(state, s0, landing, prefix, lines);
    state.marks.s1 = s1;
    this.lap(state, "s1");
    this.checkGeneration(state, "typed_not_submitted");

    await this.commit(state, s1);
    this.lap(state, "commit");
    await this.awaitSent(state, s0, landing, lines);
    this.lap(state, "s2");
  }

  /** The S0 rule for a plain send: free goes ahead; a draft is refused with the offers; unknown(no-match) needs the person's rows hash. */
  private gateSend(state: RunState, s0: Snap): void {
    const { surface } = s0;
    if (isFree(surface)) return;
    if (surface.turn === "idle" && surface.modal === "none" && surface.composer === "draft") {
      throw new Ended("refused", "draft_present", { surface, framed: s0.frame !== null, detail: "The box already holds a draft." });
    }
    if (surface.reason === "no-match" && surface.modal === "unknown") {
      if (state.request.rowsHash === undefined) {
        throw new Ended("refused", "unconfirmed", { surface, rowsHash: s0.rowsHash, detail: "Collie cannot read this screen. Check the rows, then tap again to type." });
      }
      if (state.request.rowsHash !== s0.rowsHash) {
        throw new Ended("refused", "stale_surface", { surface, rowsHash: s0.rowsHash, detail: "The screen moved since you looked." });
      }
      return;
    }
    throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
  }

  /** The frame of a box that may hold a draft (append, replace, submit, discard), or a refusal. */
  private draftFrame(s0: Snap): Frame {
    const { surface, frame } = s0;
    if (frame === null || surface.turn !== "idle" || surface.modal !== "none" || (surface.composer !== "draft" && surface.composer !== "empty")) {
      throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
    }
    return frame;
  }

  private checkGeneration(state: RunState, outcome: "refused" | "typed_not_submitted"): void {
    const now = this.deps.generation(state.target.paneId);
    if (now === state.record.paneGeneration) return;
    throw new Ended(outcome, outcome === "refused" ? "pane_gone" : "changed", { detail: "The pane holds another program now." });
  }

  private begin(state: RunState): void {
    state.stepStart = this.now();
  }

  private lap(state: RunState, step: SendStep): void {
    const now = this.now();
    state.gaps[step] = now - state.stepStart;
    state.stepStart = now;
  }

  /** Ends the request when its bound passed or another request took the lock after it. */
  private guard(state: RunState): void {
    const now = this.now();
    if (now > state.deadline) throw new Ended("unknown", "bound", { detail: "The send ran past its bound." });
    if (!this.deps.locks.owns(state.lockKey, state.record.id, now) && state.record.id !== "prepare") {
      throw new Ended("unknown", "lost_lock", { detail: "The send lost its lock." });
    }
  }

  /** A promise that loses to the request's deadline. */
  private async within<T>(state: RunState, work: Promise<T>): Promise<T> {
    const left = state.deadline - this.now();
    if (left <= 0) throw new Ended("unknown", "bound");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Ended("unknown", "bound", { detail: "The multiplexer did not answer inside the bound." })), left);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async read(state: RunState, step: string): Promise<Snap | null> {
    this.guard(state);
    const { paneId, harness } = state.target;
    const grid = await this.within(state, this.deps.mux.readGrid(paneId, { scope: "viewport", lines: SEND_READ_LINES, styling: "preserve" }));
    const gateRevision = this.deps.gate.noteRead(paneId);
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const idle = state.match?.profile.idle ?? null;
    const frame = idle === null ? null : findInputFrame(rows, idle);
    const ask = liftAsk(readerBlocks(rows, harness), grid.value.revision);
    const { surface } = surfaceOfScreen({ seq: 0, source: "screen", at: this.now(), revision: grid.value.revision, rows, ask }, idle);
    const texts = rows.map((row) => rowText(row).trimEnd());
    const plain = rows.map(plainOf);
    const win = bottomWindow(texts);
    this.deps.ring.push({ requestId: state.record.id, step, at: this.now(), rows: texts });
    return {
      revision: grid.value.revision,
      gateRevision,
      rows,
      texts,
      plain,
      frame,
      surface,
      cueStrength: readCues(rows, frame).strength,
      // The box's own rows are cut out first: they hold the person's text, which may look like a list.
      bareCues: readCues(frame === null ? rows : [...rows.slice(0, frame.interior.first), ...rows.slice(frame.interior.last + 1)], null).strength,
      hash: shortHash(texts.join("\n")),
      rowsHash: shortHash(plain.slice(win.first, win.end).join("\n")),
    };
  }

  /** S0: two reads in separate mux calls; the box (or the bottom window, with no frame) must be identical. */
  private async stableRead(state: RunState, step: string): Promise<Snap> {
    const first = await this.read(state, step);
    await this.sleep(S0_GAP_MS);
    const second = await this.read(state, step);
    if (first === null || second === null) throw new Ended("refused", "pane_gone", { detail: "The pane could not be read." });
    const key = (snap: Snap): string => {
      if (snap.frame !== null) return snap.texts.slice(snap.frame.top, snap.frame.bottom + 1).join("\n");
      const win = bottomWindow(snap.plain);
      return snap.plain.slice(win.first, win.end).join("\n");
    };
    if ((first.frame === null) !== (second.frame === null) || key(first) !== key(second)) {
      throw new Ended("refused", "not_free", { surface: second.surface, detail: "The input box moved between two reads." });
    }
    return second;
  }

  /** Reads until the test passes or fails, inside the step's (reads, ms) bound. Null when the bound ran out. */
  private async poll(
    state: RunState,
    step: string,
    bound: { reads: number; ms: number },
    test: (snap: Snap) => Verdict,
  ): Promise<{ snap: Snap | null; verdict: Verdict; reads: number }> {
    const until = Math.min(this.now() + bound.ms, state.deadline);
    let gap = FIRST_GAP_MS;
    let last: Snap | null = null;
    let reads = 0;
    while (reads < bound.reads) {
      const left = until - this.now();
      if (left <= 0) break;
      await this.sleep(Math.min(gap, left));
      gap *= 2;
      reads++;
      const snap = await this.read(state, step);
      if (snap === null) continue;
      last = snap;
      const verdict = test(snap);
      if (verdict !== "wait") return { snap, verdict, reads };
    }
    return { snap: last, verdict: "wait", reads };
  }

  /** Writes text into the pane: a bracketed paste where both sides allow it, else typed. Noted on the gate. */
  private async writeText(state: RunState, text: string, allowPaste: boolean): Promise<void> {
    this.guard(state);
    const { mux } = this.deps;
    const paste = allowPaste && state.match?.profile.paste?.bracketed === true && mux.pasteText !== undefined;
    const ack = await this.within(state, paste ? mux.pasteText!(state.target.paneId, text) : mux.typeText(state.target.paneId, text));
    this.deps.gate.noteWrite(state.target.paneId);
    if (!ack.ok) throw new Ended("refused", "write_failed", { detail: ack.detail });
  }

  /** Keys through the gate on the newest revision. `outcome` is what a refusal turns into. */
  private async keysThroughGate(state: RunState, keys: readonly string[], outcome: "typed_not_submitted" | "refused" | "unknown"): Promise<void> {
    this.guard(state);
    const { gate } = this.deps;
    const token = gate.mint(state.target.paneId, keys, gate.revision(state.target.paneId));
    const result = await this.within(state, gate.commit(token));
    if (result.ok) {
      state.keys.push(...keys);
      return;
    }
    const reason: SendReason = result.reason === "mux" ? (outcome === "refused" ? "write_failed" : "submit_failed") : result.reason;
    throw new Ended(outcome === "refused" ? "refused" : outcome, outcome === "unknown" ? "no_evidence" : reason, {
      detail: result.reason === "mux" ? result.refusal.detail : result.detail,
    });
  }

  /** The probe: the character, then Backspace; the box must take exactly it and give it back. */
  private async probe(state: RunState, s0: Snap, prefix: string): Promise<Landing | null> {
    const probe = state.match?.profile.probe.char ?? GENERIC_PROBE;
    const failed = (detail: string, snap: Snap | null): Ended => new Ended("refused", "probe_failed", sawNote(snap, { detail, framed: s0.frame !== null }));
    // Reads are shared across the two halves: the character may take two, Backspace gets the rest.
    const budget = { reads: BOUNDS.probe.reads, ms: BOUNDS.probe.ms };
    const started = this.now();

    await this.writeText(state, probe, false);
    state.keys.push("probe");
    let landing: Landing | null = null;
    const typed = await this.poll(state, "probe", { reads: budget.reads - 1, ms: budget.ms }, (snap) => {
      if (s0.frame !== null) {
        if (snap.frame === null) return "wait";
        if (boxText(snap.frame) === boxText(s0.frame)) return "wait";
        return wsFree(boxText(snap.frame)) === wsFree(prefix) + probe && outsideUnchanged(s0, snap) ? "pass" : "fail";
      }
      if (snap.plain.join("\n") === s0.plain.join("\n")) return "wait";
      landing = probeLanding(s0.plain, snap.plain, probe);
      return landing !== null && snap.cueStrength === "none" && !cueAppeared(s0, snap) ? "pass" : "fail";
    });
    if (typed.verdict !== "pass") throw failed(typed.verdict === "wait" ? "The probe character did not show in the box." : "The probe character changed more than the box.", typed.snap);

    try {
      await this.keysThroughGate(state, ["Backspace"], "refused");
    } catch (err) {
      // The probe character is in the box and its Backspace was refused: no other key follows.
      if (err instanceof Ended && err.outcome === "refused") throw failed(`Backspace after the probe was refused: ${err.extra.detail ?? err.message}`, typed.snap);
      throw err;
    }
    const readsLeft = Math.max(1, budget.reads - typed.reads);
    const back = await this.poll(state, "probe", { reads: readsLeft, ms: Math.max(FIRST_GAP_MS, budget.ms - (this.now() - started)) }, (snap) => {
      if (s0.frame !== null) {
        if (snap.frame === null) return "wait";
        return boxText(snap.frame) === boxText(s0.frame) ? "pass" : "wait";
      }
      return snap.plain.join("\n") === s0.plain.join("\n") ? "pass" : "wait";
    });
    if (back.verdict !== "pass") throw failed("Backspace did not give the box back as it was.", back.snap);
    return landing;
  }

  /** The write: each line in one write, the profile's newline key between lines. */
  private async write(state: RunState, lines: readonly string[]): Promise<void> {
    const newline = state.match?.profile.keys.newline ?? null;
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        if (newline === null) throw new Ended("typed_not_submitted", "changed");
        await this.keysThroughGate(state, newline, "typed_not_submitted");
      }
      const line = lines[i]!;
      if (line.length === 0) continue;
      try {
        await this.writeText(state, line, true);
      } catch (err) {
        // Nothing of the text is in the box when the first write fails; after that, part of it is.
        if (err instanceof Ended && i > 0) throw new Ended("typed_not_submitted", "changed", err.extra);
        throw err;
      }
    }
  }

  /** S1: the box holds exactly the text, and nothing else moved. */
  private async awaitTyped(state: RunState, s0: Snap, landing: Landing | null, prefix: string, lines: readonly string[]): Promise<Snap> {
    const collapse = collapseOf(state.match);
    let why: SendReason = "mismatch";
    const result = await this.poll(state, "s1", BOUNDS.s1, (snap) => {
      if (snap.cueStrength !== "none" || cueAppeared(s0, snap)) {
        why = "modal_cue";
        return "fail";
      }
      if (s0.frame !== null) {
        if (snap.frame === null) return "wait";
        if (!boxMatches(boxText(snap.frame), prefix, lines, collapse)) {
          why = "mismatch";
          return "wait";
        }
        if (!outsideUnchanged(s0, snap)) {
          why = "changed";
          return "wait";
        }
        return "pass";
      }
      if (landing === null) return "fail";
      const predicted = flat(predictedRows(s0.plain, landing, lines.join("")));
      const actual = flat(snap.plain);
      const typedTail = flat([lines.join(""), afterProbe(landing), ...s0.plain.slice(landing.row + 1)]);
      if (predicted.endsWith(actual) && actual.length >= typedTail.length) return "pass";
      why = "mismatch";
      return "wait";
    });
    if (result.verdict === "pass" && result.snap !== null) return result.snap;
    state.marks.s1 = result.snap;
    throw new Ended("typed_not_submitted", why, sawNote(result.snap, { framed: s0.frame !== null }));
  }

  /** Commit: `submit-sent` on disk, then the submit keys through the gate on S1's revision. */
  private async commit(state: RunState, s1: Snap): Promise<void> {
    this.guard(state);
    const keys = state.match?.profile.keys.submit ?? GENERIC_SUBMIT;
    const { gate, store } = this.deps;
    const token = gate.mint(state.target.paneId, keys, s1.gateRevision);
    store.markSubmitSent(state.record.id);
    const result = await this.within(state, gate.commit(token));
    if (!result.ok) {
      const reason: SendReason = result.reason === "mux" ? "submit_failed" : result.reason;
      throw new Ended("typed_not_submitted", reason, { framed: s1.frame !== null, detail: result.reason === "mux" ? result.refusal.detail : result.detail });
    }
    state.keys.push(...keys);
  }

  /** S2: the box emptied or a running sign showed. Anything else after the bound is `unknown`. */
  private async awaitSent(state: RunState, s0: Snap, landing: Landing | null, lines: readonly string[]): Promise<void> {
    const result = await this.poll(state, "s2", BOUNDS.s2, (snap) => {
      if (s0.frame !== null) {
        if (snap.frame === null) return "wait";
        return boxText(snap.frame).length === 0 || runningSign(snap.rows, snap.frame) ? "pass" : "wait";
      }
      if (landing === null) return "wait";
      // No frame: the landing row, found at its S0 distance from the last non-blank row, reads as it
      // did at S0 again, and the typed text no longer stands there. The rows under it may change (a
      // status row counting tokens does, live on pi 0.87.1); a popup that moves the rows does not pass.
      const actual = flat(snap.plain);
      const typedTail = flat([lines.join(""), afterProbe(landing), ...s0.plain.slice(landing.row + 1)]);
      const row = lastFilled(snap.plain) - (lastFilled(s0.plain) - landing.row);
      const boxBack = row >= 0 && wsFree(snap.plain[row] ?? "") === wsFree(s0.plain[landing.row] ?? "");
      return !actual.endsWith(typedTail) && boxBack ? "pass" : "wait";
    });
    state.marks.s2 = result.snap;
    if (result.verdict !== "pass") throw new Ended("unknown", "no_evidence", { detail: "The submit key went out, but the box did not show it was taken." });
  }

  /** Empties a framed box with the profile's clear key, in batches with a read between. Never Escape. */
  private async clear(state: RunState, from: Snap): Promise<Snap> {
    const clearKey = state.match?.profile.keys.clear ?? GENERIC_CLEAR;
    let snap = from;
    for (let round = 0; round < BOUNDS.s2.reads; round++) {
      if (snap.frame === null || snap.cueStrength !== "none") throw new Ended("unknown", "no_evidence", { detail: "The box went away while it was being emptied." });
      const left = [...boxText(snap.frame)].length;
      if (left === 0) return snap;
      const count = Math.min(CLEAR_BATCH, left + clearKey.slack);
      await this.keysThroughGate(state, Array.from({ length: count }, () => clearKey.key), "unknown");
      await this.sleep(FIRST_GAP_MS);
      const next = await this.read(state, "clear");
      if (next === null) throw new Ended("unknown", "no_evidence", { detail: "The pane could not be read while it was being emptied." });
      snap = next;
    }
    if (snap.frame !== null && boxText(snap.frame).length === 0) return snap;
    throw new Ended("unknown", "no_evidence", { detail: "The box did not empty inside the bound." });
  }
}

function collapseOf(match: ProfileMatch | null): RegExp | null {
  return match === null ? null : new RegExp(match.profile.collapse.pattern, "uy");
}

function prepareRecord(target: SendTarget, at: number): SendRecord {
  return {
    id: "prepare",
    session: target.session,
    paneId: target.paneId,
    paneGeneration: "-",
    surfaceRevision: 0,
    mode: "prepare",
    textHash: "-",
    textLength: 0,
    acceptedAt: at,
    phase: "accepted",
  };
}
