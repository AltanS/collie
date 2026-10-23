// Stop (M68 spec 01): `POST /api/pane/:id/abort` on a pane with a screen. A running turn is stopped by
// a person's tap: one request id, two reads of the Surface, the profile's interrupt key through the key
// gate as `person_tap`, one read-back, one receipt. The harness's own key is data (`keys.interrupt`,
// `keys.interruptClearsDraft`); no harness name lives here (no-harness-names.test.ts scans this folder).
//
// Steps:
//   read     one fresh read; the Surface decides, in this order:
//              no profile (or a revoked one)      -> refused no_profile
//              turn idle                          -> refused turn_idle
//              a dialog is up (Escape would answer it) -> refused dialog_open
//              no dialog claim or no turn claim   -> refused unreadable (never pressed blind)
//              box not empty and the key clears a draft first -> refused draft_present
//   reread   one more fresh read right before the press, with the same refusals: a dialog that drew
//            after the first read is refused, so the only window left is the press itself
//   press    `keys.interrupt` through the gate as `person_tap`, in one call (opencode names Escape twice)
//   readback up to three reads, at 0.4 s, 1.4 s and 2.4 s after the press; two reads in a row that show
//            the turn idle and no modal (0.4 + 1.4, or 1.4 + 2.4): `stopped`, since one idle read may be
//            a redraw between two tool calls; else `pressed`, with reason `dialog_open` when the last
//            read shows a dialog (the key opened one, and its card is the next move)
//   told     a `stopped` receipt is told to the pane's fold (`deps.stopped`) as the stop edge a harness
//            with no stop hook on an interrupt never sends
//
// The same request id answers the same receipt and presses once; a request id still in flight is
// joined, never pressed twice. The receipts live in memory: a bridge restart forgets them, and a Stop is
// a tap, not a message, so nothing is lost but the replay. A Stop takes no pane lock: it must not wait
// behind a send, and a person's Escape never has. The audit line is the route's: request id, pane,
// keys, outcome, never a message text.

import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { liftAsk, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import type { StopReason, StopReceipt } from "../../web/src/lib/surface/stop.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import type { KeyGate } from "./key-gate.ts";

/** Rows one read asks for, as the Send Protocol reads them. */
const STOP_READ_LINES = 120;
/** The gap before the first read-back, then between the reads. */
const FIRST_GAP_MS = 400;
const NEXT_GAP_MS = 1000;
/** How many reads the read-back makes at most. The last one lands inside 3 s of the press. */
const READ_BACKS = 3;
/** How many settled receipts a bridge keeps for a replay, newest kept. */
const KEPT = 256;

/** What a Stop needs of a multiplexer besides keys (which only the gate sends). */
export interface StopMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
}

export interface StopDeps {
  readonly mux: StopMux;
  readonly gate: Pick<KeyGate, "press">;
  readonly profile: (harness: string) => Promise<ProfileMatch | null>;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Told once per `stopped` receipt, never on a replay: Collie saw the turn end. The bridge gives it
   * to the pane's fold as the stop edge a harness with no stop hook on an interrupt did not send
   * (`SurfaceShadow.stopSeen`). A throw is caught; the receipt stands.
   */
  readonly stopped?: (paneId: string) => void;
}

/** What a Stop answers: the receipt, and whether it is the stored one of an earlier tap. */
export type StopAnswer =
  | { readonly kind: "receipt"; readonly receipt: StopReceipt; readonly replayed: boolean }
  /** The request id was used on another pane. Nothing ran. */
  | { readonly kind: "id_reused" };

interface Stored {
  readonly paneId: string;
  readonly receipt: StopReceipt;
}

function refusal(requestId: string, reason: StopReason): StopReceipt {
  return { requestId, outcome: "refused", reason };
}

/**
 * Why a read refuses the press, or null when the key may go: the turn ended (`turn_idle`), a dialog
 * is up and the key would answer it (`dialog_open`), the read cannot tell a turn or a dialog
 * (`unreadable`), or the box holds text the key would clear first (`draft_present`).
 */
function refusalOf(surface: Surface, clearsDraft: boolean): StopReason | null {
  if (surface.turn === "idle") return "turn_idle";
  if (surface.modal !== "none" && surface.modal !== "unknown") return "dialog_open";
  if (surface.modal === "unknown" || surface.turn !== "running") return "unreadable";
  if (clearsDraft && surface.composer !== "empty") return "draft_present";
  return null;
}

/** Whether the profile may be trusted to read a turn: not on a revoked version or range. */
function readable(match: ProfileMatch | null): match is ProfileMatch {
  return match !== null && match.status !== "revoked" && match.range?.status !== "revoked";
}

export class StopService {
  private readonly settled = new Map<string, Stored>();
  private readonly running = new Map<string, { readonly paneId: string; readonly work: Promise<StopReceipt> }>();

  constructor(private readonly deps: StopDeps) {}

  /** One Stop. `harness` is the agent string the multiplexer reports for the pane; "" for a bare shell. */
  async handle(requestId: string, paneId: string, harness: string): Promise<StopAnswer> {
    const stored = this.settled.get(requestId);
    if (stored !== undefined) {
      return stored.paneId === paneId ? { kind: "receipt", receipt: stored.receipt, replayed: true } : { kind: "id_reused" };
    }
    const inflight = this.running.get(requestId);
    if (inflight !== undefined) {
      if (inflight.paneId !== paneId) return { kind: "id_reused" };
      return { kind: "receipt", receipt: await inflight.work, replayed: true };
    }
    // Synchronous from the look above to this registration: two taps with one id must not both press.
    const work = this.run(requestId, paneId, harness);
    this.running.set(requestId, { paneId, work });
    try {
      const receipt = await work;
      this.keep(requestId, { paneId, receipt });
      return { kind: "receipt", receipt, replayed: false };
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

  private async run(requestId: string, paneId: string, harness: string): Promise<StopReceipt> {
    const match = harness === "" ? null : await this.deps.profile(harness);
    if (!readable(match)) return refusal(requestId, "no_profile");
    const { keys } = match.profile;
    // Two reads before the key, each with the same refusals: the first decides, the second is taken
    // right before the press, so a dialog that drew in between is never answered by the key.
    for (let read = 0; read < 2; read++) {
      const before = await this.look(paneId, harness, match);
      const refused = before === null ? "pane_gone" : refusalOf(before, keys.interruptClearsDraft === true);
      if (refused !== null) return refusal(requestId, refused);
    }
    const pressed = [...keys.interrupt];
    const sent: MuxAck = await this.deps.gate.press(paneId, pressed, "person_tap");
    if (!sent.ok) return refusal(requestId, "press_failed");
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let opened = false;
    let idleBefore = false;
    for (let read = 0; read < READ_BACKS; read++) {
      await sleep(read === 0 ? FIRST_GAP_MS : NEXT_GAP_MS);
      const after = await this.look(paneId, harness, match);
      const idle = after !== null && after.turn === "idle" && after.modal === "none";
      // One idle read may be a redraw between two tool calls: two in a row say the turn ended.
      if (idle && idleBefore) {
        this.tellStopped(paneId);
        return { requestId, outcome: "stopped", keys: pressed };
      }
      idleBefore = idle;
      if (after !== null) opened = after.modal !== "none" && after.modal !== "unknown";
    }
    // The key went in, so the outcome stays `pressed`; a dialog the key opened is told, so the person is sent to its card.
    return opened ? { requestId, outcome: "pressed", reason: "dialog_open", keys: pressed } : { requestId, outcome: "pressed", keys: pressed };
  }

  private tellStopped(paneId: string): void {
    try {
      this.deps.stopped?.(paneId);
    } catch (err) {
      console.warn(`[stop] stopped hook for ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One fresh read of the pane, folded into its Surface. Null when the multiplexer could not read it. */
  private async look(paneId: string, harness: string, match: ProfileMatch): Promise<Surface | null> {
    const grid = await this.deps.mux.readGrid(paneId, { scope: "viewport", lines: STOP_READ_LINES, styling: "preserve" });
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const ask = liftAsk(readerBlocks(rows, harness), grid.value.revision);
    return surfaceOfScreen({ seq: 0, source: "screen", at: Date.now(), revision: grid.value.revision, rows, ask }, match.profile.idle).surface;
  }
}
