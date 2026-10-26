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
//               an unreadable screen whose box holds text and whose only cues are on the box's own rows
//               (the box shape could not be read)      -> refused unreadable
//               no dialog claim, no box found, or the box is behind a panel -> refused unreadable
//               the box already reads empty            -> refused no_draft   (before any key)
//   reread    on the first round only: one more fresh read right before the press with the same refusals,
//             so a dialog that drew after the first read is never typed at
//   probe     on the first round only (2026-10-25): the profile's probe character, typed; it must land in
//             the box after the draft, and one Backspace takes it out again. Where it lands elsewhere it
//             is taken back with one Backspace, and where it shows nowhere it is left alone: the box is a
//             stale image of an earlier layout. The box is read once more after one gap (Collie never
//             redraws a pane, ADR 0008): an empty box -> refused no_draft; other rows whose draft takes a
//             second probe go on; else -> refused stale_screen. Nothing is deleted on a box that did not
//             take the probe
//   press     the clear key, `length + slack` times in one call (at most CLEAR_BATCH), as `person_tap`;
//             a box that holds only Collie's own probe characters gets one Backspace each, and its
//             `cleared` receipt carries no draft to restore (probe-marker.ts)
//   readback  up to four reads after the press: the box reads empty and no dialog -> `cleared`; a dialog ->
//             refused dialog_open; else the box is read again
// A profile with `keys.clearAll` (a key that empties a box the clear key cannot, such as a draft the
// harness rewrites after every Backspace) gets that key once, in the round where the box did not shrink,
// after a fresh read showed a draft; then the same read-back. Never on a box that reads empty, never twice.
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
import { wsFree } from "../../web/src/lib/surface/send.ts";
import { frameImageKey } from "../../web/src/lib/surface/surface.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { boundedDraft, type ClearReason, type ClearReceipt } from "../../web/src/lib/surface/clear.ts";
import { findInputFrame, rowText, type Frame } from "../../web/src/lib/surface/frame.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { liftAsk, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import type { KeyGate } from "./key-gate.ts";
import { probeCharOf, probeResidue } from "./probe-marker.ts";

/** Rows one read asks for, as the Send Protocol and the Stop read them. */
const CLEAR_READ_LINES = 120;
/** Keys per press, as the Send Protocol's clear batch. */
const CLEAR_BATCH = 256;
/** How many presses one Clear makes at most (a draft of about 3000 characters). */
const MAX_ROUNDS = 12;
/** The gaps before each read-back after a press. Every one is a fresh read; the first that shows an empty box ends it. */
const READ_BACK_GAPS_MS: readonly number[] = [120, 280, 500, 800];
/** The gaps before each read after the probe character or its Backspace. */
const PROBE_GAPS_MS: readonly number[] = [80, 160, 320];
/** The wait before a stale box is read once more. */
const REREAD_GAP_MS = 120;
/** How many settled receipts a bridge keeps for a replay, newest kept. */
const KEPT = 256;

/** What a Clear needs of a multiplexer besides keys (which only the gate sends). */
export interface ClearMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
  /** The probe character goes in as text. */
  typeText(paneId: string, text: string): Promise<MuxAck>;
}

export interface ClearDeps {
  readonly mux: ClearMux;
  readonly gate: Pick<KeyGate, "press">;
  /** The harness's profile; with `paneId`, at the version of the pane's own program when the bridge can see it (SendDeps.profile). */
  readonly profile: (harness: string, paneId?: string) => Promise<ProfileMatch | null>;
  /** A box proven stale (as the Send Protocol's `staleFrame`): the bridge's Surface marks it until its rows change. */
  readonly staleFrame?: (paneId: string, frame: string) => void;
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

/** One read of the pane: its Surface, the box it found (null when the screen shows none), and its rows' text. */
interface Look {
  readonly surface: Surface;
  readonly frame: Frame | null;
  readonly texts: readonly string[];
  /**
   * The box holds text, and every cue that made the Surface claim a dialog stands on a row of the box
   * itself: the box's own rows look like a list (a composer shape that puts a prompt glyph on the first
   * row of a two-line draft). Nothing may have opened; the box shape could not be read.
   */
  readonly cuesInBox: boolean;
}

/** The probe's verdict on a box: the read the clear goes on from, or the refusal. `probed` says a key left (the probe or a Backspace). */
type Proof = { readonly look: Look; readonly probed: boolean } | { readonly refused: ClearReason; readonly probed: boolean };

/** Where a probe character went: into the box after the draft, onto the screen elsewhere, or nowhere a read showed. */
type Landing = "box" | "away" | "nowhere";

function countIn(texts: readonly string[], probe: string): number {
  let n = 0;
  for (const text of texts) n += text.split(probe).length - 1;
  return n;
}

function boxOf(frame: Frame): string {
  return frame.placeholder ? "" : frame.interior.text;
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
  // A dialog Collie could not read, whose only cues stand on the box's own rows, may be no dialog at all: the
  // box shape could not be read, and that is what the receipt says. A dialog it lifted (an ask) is one.
  if (surface.modal !== "none" && surface.modal !== "unknown") return surface.modal === "unreadable" && look.cuesInBox ? "unreadable" : "dialog_open";
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
    const match = harness === "" ? null : await this.deps.profile(harness, paneId);
    if (!readable(match)) return refusal(requestId, "no_profile", false);
    const clearKey = match.profile.keys.clear;
    const clearAll = match.profile.keys.clearAll;
    let allPressed = false;
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
      if (round === 0) {
        // The draft is a reading until the probe proves the box takes keys (2026-10-25).
        const proven = await this.prove(paneId, harness, match, look!, sleep);
        if (proven.probed) pressed = true;
        if ("refused" in proven) return refusal(requestId, proven.refused, pressed);
        look = proven.look;
      }
      const length = draftLength(look!.frame!);
      // A box whose whole text is Collie's own probe characters (probe-marker.ts) is no draft of the
      // person's: one Backspace each takes exactly them out, and there is nothing to restore.
      const residue = round === 0 && !look!.frame!.placeholder ? probeResidue(look!.frame!.interior.text, probeCharOf(match)) : 0;
      if (round === 0 && !look!.frame!.placeholder && residue === 0) draft = boundedDraft(look!.frame!.interior.text);
      // A box that did not shrink since the last press is left alone: no second blind press. The one
      // exception is the profile's own stroke key (`keys.clearAll`): the box is a draft on a read taken
      // just now (an empty box was refused above), and it goes at most once per request.
      const unmoved = length >= before;
      if (unmoved && (clearAll === undefined || allPressed)) return refusal(requestId, "press_failed", pressed);
      if (!unmoved) before = length;
      const count = Math.min(CLEAR_BATCH, length + clearKey.slack);
      const keys = residue > 0 ? Array.from({ length: residue }, () => "Backspace") : unmoved ? [clearAll!.key] : Array.from({ length: count }, () => clearKey.key);
      const sent: MuxAck = await this.deps.gate.press(paneId, keys, "person_tap");
      if (!sent.ok) return refusal(requestId, "press_failed", pressed);
      pressed = true;
      if (unmoved) allPressed = true;
      // A draft longer than one batch is not cleared by this press alone: once the box shrank, the next round reads it fresh.
      const capped = !unmoved && length + clearKey.slack > CLEAR_BATCH;
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

  /**
   * The probe before the first clear key: the read the clear goes on from, or the refusal. A box that
   * takes the probe goes on from `look`. A box that does not is read once more: a box that then reads
   * empty is `no_draft`, other rows whose draft takes a second probe go on, anything else is `stale_screen`.
   * `probed` says a key left (the probe or a Backspace).
   */
  private async prove(paneId: string, harness: string, match: ProfileMatch, look: Look, sleep: (ms: number) => Promise<void>): Promise<Proof> {
    const probe = match.profile.probe.char;
    const before = countIn(look.texts, probe);
    const first = await this.probeBox(paneId, harness, match, look, probe, sleep);
    if ("refused" in first) return { refused: first.refused, probed: true };
    if (first.landing === "box") return { look, probed: true };
    const stale = (at: Look): Proof => {
      if (at.frame !== null) {
        try {
          this.deps.staleFrame?.(paneId, frameImageKey(at.texts, at.frame.top, at.frame.bottom));
        } catch (err) {
          console.warn(`[clear] stale frame note failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { refused: "stale_screen", probed: true };
    };
    await sleep(REREAD_GAP_MS);
    let fresh = await this.look(paneId, harness, match);
    if (fresh === null) return { refused: "pane_gone", probed: true };
    if (first.landing === "nowhere") {
      // The screen may show where the character went now; one Backspace takes it back, or nothing is pressed.
      if (countIn(fresh.texts, probe) !== before + 1) return stale(fresh);
      const back = await this.takeBack(paneId, harness, match, before, probe, sleep);
      if (back === null) return stale(fresh);
      fresh = back;
    }
    const refused = refusalOf(fresh);
    if (refused !== null) return { refused, probed: true };
    const { frame } = fresh;
    if (frame === null || look.frame === null) return { refused: "unreadable", probed: true };
    if (frameImageKey(fresh.texts, frame.top, frame.bottom) === frameImageKey(look.texts, look.frame.top, look.frame.bottom)) return stale(fresh);
    const again = await this.probeBox(paneId, harness, match, fresh, probe, sleep);
    if ("refused" in again) return { refused: again.refused, probed: true };
    return again.landing === "box" ? { look: fresh, probed: true } : stale(fresh);
  }

  /**
   * One probe of the box `look` shows: `box` when the character landed after the draft and one Backspace
   * gave the box back; `away` when it stood elsewhere and one Backspace took it back; `nowhere` when no
   * read showed it (no key follows). A probe that changed the box some other way, or a Backspace that did
   * not give it back, is a refusal (`unreadable`, `press_failed`).
   */
  private async probeBox(paneId: string, harness: string, match: ProfileMatch, look: Look, probe: string, sleep: (ms: number) => Promise<void>): Promise<{ readonly landing: Landing } | { readonly refused: ClearReason }> {
    const draft = look.frame === null ? "" : boxOf(look.frame);
    const before = countIn(look.texts, probe);
    const typed = await this.deps.mux.typeText(paneId, probe);
    if (!typed.ok) return { refused: "press_failed" };
    for (const gap of PROBE_GAPS_MS) {
      await sleep(gap);
      const now = await this.look(paneId, harness, match);
      if (now === null) return { refused: "pane_gone" };
      if (now.frame === null) continue;
      const box = boxOf(now.frame);
      if (wsFree(box) === wsFree(draft) + probe) {
        if (!(await this.deps.gate.press(paneId, ["Backspace"], "person_tap")).ok) return { refused: "press_failed" };
        for (const again of PROBE_GAPS_MS) {
          await sleep(again);
          const back = await this.look(paneId, harness, match);
          if (back?.frame != null && boxOf(back.frame) === draft) return { landing: "box" };
        }
        return { refused: "press_failed" };
      }
      if (box !== draft) return { refused: "unreadable" };
      if (countIn(now.texts, probe) !== before + 1) continue;
      return (await this.takeBack(paneId, harness, match, before, probe, sleep)) === null ? { refused: "press_failed" } : { landing: "away" };
    }
    return { landing: "nowhere" };
  }

  /** One Backspace for a probe character outside the box, then reads until the screen holds as many as before; the read, or null. */
  private async takeBack(paneId: string, harness: string, match: ProfileMatch, before: number, probe: string, sleep: (ms: number) => Promise<void>): Promise<Look | null> {
    if (!(await this.deps.gate.press(paneId, ["Backspace"], "person_tap")).ok) return null;
    for (const gap of PROBE_GAPS_MS) {
      await sleep(gap);
      const back = await this.look(paneId, harness, match);
      if (back !== null && countIn(back.texts, probe) === before) return back;
    }
    return null;
  }

  /** One fresh read of the pane, folded into its Surface. Null when the multiplexer could not read it. */
  private async look(paneId: string, harness: string, match: ProfileMatch): Promise<Look | null> {
    const grid = await this.deps.mux.readGrid(paneId, { scope: "viewport", lines: CLEAR_READ_LINES, styling: "preserve" });
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const ask = liftAsk(readerBlocks(rows, harness), grid.value.revision);
    const read = surfaceOfScreen({ seq: 0, source: "screen", at: Date.now(), revision: grid.value.revision, rows, ask }, match.profile.idle);
    // The Surface drops the box of a profile whose dialogs draw in it once a strong cue stands (`dialogsInBox`),
    // so the box is looked for again here, to tell a dialog from a box whose own rows read as a list.
    const box = findInputFrame(rows, match.profile.idle);
    const cues = read.cues?.cues ?? [];
    const cuesInBox = box !== null && !box.placeholder && box.interior.text.length > 0 && cues.length > 0 && cues.every((cue) => cue.row >= box.top && cue.row <= box.bottom);
    return { surface: read.surface, frame: read.frame, texts: rows.map((row) => rowText(row)), cuesInBox };
  }
}
