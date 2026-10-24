// Clear (ADR 0116, the Clear paragraph): `POST /api/pane/:id/clear` on a pane with a screen. A person's
// tap empties the harness's input box in one request: one request id, a fresh read of the Surface, the
// profile's own clear key (`keys.clear`, the step the Send Protocol uses to replace a draft) pressed
// through the key gate as `person_tap`, a read-back, one receipt. The harness's key is data; no harness
// name lives here (no-harness-names.test.ts scans this folder).
//
// Steps, each round:
//   read      a fresh read; the Surface decides, in this order:
//               no profile (or a revoked one)          -> refused no_profile
//               the pane could not be read             -> refused pane_gone
//               a dialog is up                         -> refused dialog_open
//               no dialog claim, no box found, or the box is behind a panel -> refused unreadable
//               the box already reads empty            -> refused no_draft   (before any key)
//   reread    on the first round only: one more fresh read right before the press with the same refusals,
//             so a dialog that drew after the first read is never typed at
//   press     the clear key, `length + slack` times in one call (at most CLEAR_BATCH), as `person_tap`
//   readback  up to four reads after the press: the box reads empty and no dialog -> `cleared`; a dialog ->
//             refused dialog_open; else the box is read again
// A draft longer than one batch needs a second round. A second round starts only from a fresh read that
// shows the box SHORTER than before the press (it is never a blind press); a box that did not shrink, or
// that still holds text after the last round, is `press_failed` and what remains is left alone.
//
// The same request id answers the same receipt and presses once; a request id still in flight is joined,
// never pressed twice. The receipts live in memory: a bridge restart forgets them, and a Clear is a
// tap, not a message, so nothing is lost but the replay. A Clear takes no pane lock, as a Stop takes none:
// it must not wait behind a send. It never presses Escape (the profile's clear key is a key that deletes).
// The audit line is the route's: request id, pane, outcome, never the box's text.
//
// RESTORE. A one-tap Clear can lose a long draft, so a `cleared` receipt carries the text the first read
// showed in the box (`draft`, one line, at most 8 KiB): the phone offers to type it back. The text is the
// operator's own, read behind the same write gate as the tap; it is kept only in the receipt (and its
// replay), never logged, never on the audit line.

import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { boundedDraft, type ClearReason, type ClearReceipt } from "../../web/src/lib/surface/clear.ts";
import type { Frame } from "../../web/src/lib/surface/frame.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { liftAsk, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import type { KeyGate } from "./key-gate.ts";

/** Rows one read asks for, as the Send Protocol and the Stop read them. */
const CLEAR_READ_LINES = 120;
/** Keys per press, as the Send Protocol's clear batch. */
const CLEAR_BATCH = 256;
/** How many presses one Clear makes at most (a draft of about 3000 characters). */
const MAX_ROUNDS = 12;
/** The gaps before each read-back after a press. Every one is a fresh read; the first that shows an empty box ends it. */
const READ_BACK_GAPS_MS: readonly number[] = [120, 280, 500, 800];
/** How many settled receipts a bridge keeps for a replay, newest kept. */
const KEPT = 256;

/** What a Clear needs of a multiplexer besides keys (which only the gate sends). */
export interface ClearMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
}

export interface ClearDeps {
  readonly mux: ClearMux;
  readonly gate: Pick<KeyGate, "press">;
  readonly profile: (harness: string) => Promise<ProfileMatch | null>;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What a Clear answers: the receipt, whether it is the stored one of an earlier tap, and whether a key left this time. */
export type ClearAnswer =
  | { readonly kind: "receipt"; readonly receipt: ClearReceipt; readonly replayed: boolean; readonly pressed: boolean }
  /** The request id was used on another pane. Nothing ran. */
  | { readonly kind: "id_reused" };

interface Stored {
  readonly paneId: string;
  readonly receipt: ClearReceipt;
  readonly pressed: boolean;
}

interface Settled {
  readonly receipt: ClearReceipt;
  readonly pressed: boolean;
}

/** One read of the pane: its Surface, and the box it found (null when the screen shows none). */
interface Look {
  readonly surface: Surface;
  readonly frame: Frame | null;
}

function refusal(requestId: string, reason: ClearReason, pressed: boolean): Settled {
  return { receipt: { requestId, outcome: "refused", reason }, pressed };
}

/**
 * Why a read refuses the key, or null when the box holds a draft a key may clear: a dialog is up
 * (`dialog_open`), the read cannot tell a dialog, a box or its content (`unreadable`), or the box
 * reads empty (`no_draft`).
 */
function refusalOf(look: Look): ClearReason | null {
  const { surface, frame } = look;
  if (surface.modal !== "none" && surface.modal !== "unknown") return "dialog_open";
  if (surface.modal === "unknown" || frame === null) return "unreadable";
  if (surface.composer === "empty") return "no_draft";
  if (surface.composer !== "draft") return "unreadable";
  return null;
}

/** How many characters the box holds (what the clear key must delete), 0 for the placeholder. */
function draftLength(frame: Frame): number {
  return frame.placeholder ? 0 : [...frame.interior.text].length;
}

/** Whether the profile may be trusted to read a box: not on a revoked version or range. */
function readable(match: ProfileMatch | null): match is ProfileMatch {
  return match !== null && match.status !== "revoked" && match.range?.status !== "revoked";
}

export class ClearService {
  private readonly settled = new Map<string, Stored>();
  private readonly running = new Map<string, { readonly paneId: string; readonly work: Promise<Settled> }>();

  constructor(private readonly deps: ClearDeps) {}

  /** One Clear. `harness` is the agent string the multiplexer reports for the pane; "" for a bare shell. */
  async handle(requestId: string, paneId: string, harness: string): Promise<ClearAnswer> {
    const stored = this.settled.get(requestId);
    if (stored !== undefined) {
      return stored.paneId === paneId ? { kind: "receipt", receipt: stored.receipt, replayed: true, pressed: stored.pressed } : { kind: "id_reused" };
    }
    const inflight = this.running.get(requestId);
    if (inflight !== undefined) {
      if (inflight.paneId !== paneId) return { kind: "id_reused" };
      const joined = await inflight.work;
      return { kind: "receipt", receipt: joined.receipt, replayed: true, pressed: joined.pressed };
    }
    // Synchronous from the look above to this registration: two taps with one id must not both press.
    const work = this.run(requestId, paneId, harness);
    this.running.set(requestId, { paneId, work });
    try {
      const done = await work;
      this.keep(requestId, { paneId, receipt: done.receipt, pressed: done.pressed });
      return { kind: "receipt", receipt: done.receipt, replayed: false, pressed: done.pressed };
    } finally {
      this.running.delete(requestId);
    }
  }

  private keep(requestId: string, stored: Stored): void {
    this.settled.set(requestId, stored);
    if (this.settled.size <= KEPT) return;
    const oldest = this.settled.keys().next();
    if (!oldest.done) this.settled.delete(oldest.value);
  }

  private async run(requestId: string, paneId: string, harness: string): Promise<Settled> {
    const match = harness === "" ? null : await this.deps.profile(harness);
    if (!readable(match)) return refusal(requestId, "no_profile", false);
    const clearKey = match.profile.keys.clear;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let pressed = false;
    let before = Number.POSITIVE_INFINITY;
    // The draft the first read showed, for the receipt's Restore. Later rounds read what is left of it.
    let draft = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Two reads before the first key, each with the same refusals: the second is taken right before the
      // press, so a dialog that drew in between is never typed at. A later round starts from the read-back.
      let look: Look | null = null;
      for (let read = 0; read < (round === 0 ? 2 : 1); read++) {
        look = await this.look(paneId, harness, match);
        const refused = look === null ? "pane_gone" : refusalOf(look);
        if (refused !== null) return refusal(requestId, refused, pressed);
      }
      const length = draftLength(look!.frame!);
      if (round === 0 && !look!.frame!.placeholder) draft = boundedDraft(look!.frame!.interior.text);
      // A box that did not shrink since the last press is left alone: no second blind press.
      if (length >= before) return refusal(requestId, "press_failed", pressed);
      before = length;
      const count = Math.min(CLEAR_BATCH, length + clearKey.slack);
      const sent: MuxAck = await this.deps.gate.press(paneId, Array.from({ length: count }, () => clearKey.key), "person_tap");
      if (!sent.ok) return refusal(requestId, "press_failed", pressed);
      pressed = true;
      // A draft longer than one batch is not cleared by this press alone: once the box shrank, the next round reads it fresh.
      const capped = length + clearKey.slack > CLEAR_BATCH;
      for (const gap of READ_BACK_GAPS_MS) {
        await sleep(gap);
        const after = await this.look(paneId, harness, match);
        if (after === null) return refusal(requestId, "pane_gone", pressed);
        if (after.surface.modal !== "none" && after.surface.modal !== "unknown") return refusal(requestId, "dialog_open", pressed);
        if (after.frame !== null && after.surface.modal === "none" && after.surface.composer === "empty") {
          return { receipt: draft === "" ? { requestId, outcome: "cleared" } : { requestId, outcome: "cleared", draft }, pressed };
        }
        if (capped && after.frame !== null && draftLength(after.frame) < length) break;
      }
    }
    return refusal(requestId, "press_failed", pressed);
  }

  /** One fresh read of the pane, folded into its Surface. Null when the multiplexer could not read it. */
  private async look(paneId: string, harness: string, match: ProfileMatch): Promise<Look | null> {
    const grid = await this.deps.mux.readGrid(paneId, { scope: "viewport", lines: CLEAR_READ_LINES, styling: "preserve" });
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const ask = liftAsk(readerBlocks(rows, harness), grid.value.revision);
    const read = surfaceOfScreen({ seq: 0, source: "screen", at: Date.now(), revision: grid.value.revision, rows, ask }, match.profile.idle);
    return { surface: read.surface, frame: read.frame };
  }
}
