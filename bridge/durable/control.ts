// `POST /api/pane/:id/send` AND `/abort`: A CONTROL ON A SCREENLESS PANE NAMES THE TURN IT SAW
// (ADR 0101).
//
// A pane with a screen has a read-back: the bridge reads the screen before it presses Enter, and a
// screen that moved refuses the send. A durable pane has no screen, so the phone names what it
// showed instead: the newest `turnId`, or an open `askId`. The route:
//
//   1. refuses a pane whose adapter takes no guarded controls, with the mux refusal's word
//      (`unsupported`);
//   2. answers a request id it already settled from the receipt, and sends nothing (`replayed`); a
//      request id still in flight is joined, never sent twice;
//   3. writes the receipt BEFORE the control leaves (ADR 0091's store, `recordFirst`). A receipt that
//      cannot be written sends nothing;
//   4. hands ONE control to the adapter, which checks the name against its latest listing with
//      {@link namesCurrent} before anything reaches the socket (WIRE.md section 7.4). A stale name is
//      refused there and the program is never asked. The program checks again, because the turn can
//      move in between, but it is not trusted to: a program written by someone else may not.
//
// ONE REQUEST ID, ONE PAYLOAD. The receipt keeps a digest of the pane, the act, the name, the steer
// switch and the text. The same id with another payload is refused (409, `request-id-reused`).
//
// AN UNKNOWN OUTCOME KEEPS THE RECEIPT OPEN, as for an answer. "Try again" carries the same request
// id, the adapter checks the name again, and the program's own request id memory (WIRE.md section
// 7.6) answers `replayed` rather than acting twice. A send that landed and started a new turn makes
// that retry find the turn moved on, and that is `maybe-applied`: the person is told to check the
// chat, where their text is, and nothing lands twice. `pending`, `unknown` and `unsent` mean what
// they mean for an answer (bridge/durable/answer.ts).
//
// A STOP WRITES NO ITEM (WIRE.md section 7.5). The program settles the running input as unanswered
// with the reason `aborted`, and the pane log draws that one event as a "stopped" note
// (`bridge/journal/durable.ts`). Nothing here writes to the log.
//
// The handler is a pure function of its inputs and returns a status and a body; `bridge/server.ts`
// turns that into a response, so `bun test` drives it with a fake adapter.

import { join } from "node:path";

import type { AuditDetail, AuditEntry } from "../audit.ts";
import type { JsonValue } from "../json.ts";
import type { MuxAdapter, MuxControlOutcome } from "../mux/types.ts";
import type { ControlRequest, ControlResponse, ControlTarget } from "../types.ts";
import {
  DURABLE_RECEIPT_LIMITS,
  digestDiffers,
  memoryReceipts,
  payloadDigest,
  ReceiptFileStore,
  type ReceiptRetention,
  type ReceiptSurface,
  withDigest,
} from "../worktree-receipts.ts";
import { coerceControlReceipt, readControlBody } from "./parse.ts";

// ── The guard ─────────────────────────────────────────────────────────────────

/** What is current on one pane: its newest turn, and the ids of its open asks. */
export interface TurnView {
  readonly turnId: string;
  readonly askIds: readonly string[];
}

/**
 * Whether a control's name is current (ADR 0101, WIRE.md section 7.4): the newest turn of the pane,
 * or an ask still open on it. The one check both controls run, in the bridge, before the socket.
 */
export function namesCurrent(target: ControlTarget, view: TurnView): boolean {
  return target.kind === "turn" ? target.id === view.turnId : view.askIds.includes(target.id);
}

// ── The receipt ───────────────────────────────────────────────────────────────

/** The receipt file's name inside the state dir. */
export const CONTROL_RECEIPTS_FILE = "control-receipts.json";

export type ControlAct = ControlRequest["act"];

/**
 * Where a control stands. `pending` is written first and means it is on its way; `unknown`: it left
 * and nobody knows what it did; `unsent`: nothing reached the program. Those three may go again.
 */
export type ControlState = "pending" | "unknown" | "unsent" | "ok" | "stale" | "refused" | "maybe-applied";

const OPEN_STATES: ReadonlySet<ControlState> = new Set(["pending", "unknown", "unsent"]);

/**
 * One send or abort a phone made, under its request id. Ids and the outcome only: the text itself is
 * not kept, only inside the payload digest, so a different text under the same request id is refused.
 */
export interface ControlReceipt {
  requestId: string;
  /** Epoch ms of the first request with this id. */
  at: number;
  paneId: string;
  act: ControlAct;
  target: ControlTarget["kind"];
  targetId: string;
  /** For a send. */
  steer?: boolean;
  /** {@link controlDigest} of the request: pane, act, name, and for a send the steer switch and text. */
  digest: string;
  state: ControlState;
  /** For `refused`: the line the refusal carried, and its word. */
  detail?: string;
  reason?: "unsupported" | "refused";
  /** For `stale`: what was current when the control was refused. */
  currentTurnId?: string;
  currentAskIds?: string[];
}

/** What the routes need of the store: ADR 0091's surface, plus the write that comes first. */
export type ControlReceiptSurface = ReceiptSurface<ControlReceipt, ControlReply> & {
  /** Store one receipt and say whether it reached disk. False: nothing may be sent. */
  recordFirst(receipt: ControlReceipt): Promise<boolean>;
};

/** The file-backed store `bridge/index.ts` builds once per bridge. Written on the first control only. */
export class ControlReceiptStore extends ReceiptFileStore<ControlReceipt, ControlReply> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line), now: () => number = Date.now) {
    super(stateDir, join(stateDir, CONTROL_RECEIPTS_FILE), coerceControlReceipt, warn, "control", CONTROL_RETENTION, now);
  }
}

/** What one control asks for, as a digest. */
export function controlDigest(paneId: string, request: ControlRequest): string {
  const named = [request.act, paneId, request.target.kind, request.target.id];
  return payloadDigest(request.act === "send" ? [...named, request.steer, request.text] : named);
}

/** A week, the newest thousand, and a pending receipt kept for at least a day (ADR 0101). */
export const CONTROL_RETENTION: ReceiptRetention<ControlReceipt> = {
  ...DURABLE_RECEIPT_LIMITS,
  atOf: (receipt) => receipt.at,
  pending: (receipt) => OPEN_STATES.has(receipt.state),
};

/** A store with no file, for a server built without one. Its first write never fails. */
export function memoryControlReceipts(): ControlReceiptSurface {
  const store = memoryReceipts<ControlReceipt, ControlReply>();
  return {
    ...store,
    recordFirst: async (receipt) => {
      await store.record(receipt);
      return true;
    },
  };
}

// ── The routes ────────────────────────────────────────────────────────────────

/** A route's answer: a status and the one body shape (`ControlResponse`). */
export interface ControlReply {
  readonly status: number;
  readonly body: ControlResponse;
}

/** A body the route cannot read. Plain text, as every pane write answers one. */
export interface ControlBadBody {
  readonly status: 400;
  readonly text: string;
}

export interface ControlDeps {
  /** The pane's adapter. Without `controlTurn` it takes no guarded controls. */
  readonly adapter: Pick<MuxAdapter, "controlTurn">;
  readonly receipts: ControlReceiptSurface;
  readonly audit: { record(entry: AuditEntry): void };
  readonly device: string | null;
  readonly session: string;
  /** Called after the program accepted a control, so the next snapshot shows what it did. */
  readonly settled?: () => void;
  readonly now?: () => number;
}

/** The refusal for a pane whose adapter takes no guarded controls (ADR 0022's word, `unsupported`). */
export const NO_CONTROLS = "This pane takes no send or stop by turn.";

/** The refusal `/reply` and `/keys` answer on a pane that takes guarded controls instead (ADR 0101). */
export const NO_RAW_INPUT = "This conversation has no terminal. Send text with the turn you saw instead of typed keys.";

function refused(reason: "unsupported" | "refused" | "request-id-reused", detail: string, status = 409): ControlReply {
  return { status, body: { ok: false, outcome: "refused", reason, detail } };
}

/**
 * The answer `/reply` and `/keys` give a pane whose adapter takes guarded controls, or null for every
 * other pane, whose routes run as before. Such a pane has no screen to type into and no read-back to
 * guard a send, so the only text path is the guarded send (ADR 0101, rule 7).
 */
export function rawInputRefusal(adapter: Pick<MuxAdapter, "controlTurn">): ControlReply | null {
  return adapter.controlTurn === undefined ? null : refused("unsupported", NO_RAW_INPUT);
}

/** The refusal for a request id already used for another payload. Nothing is sent. */
export const CONTROL_ID_REUSED = "This request id was already used for another send or stop.";

/** The reply a settled receipt gives again. `null` for an open one: that one is sent again. */
function replayOf(receipt: ControlReceipt): ControlReply | null {
  switch (receipt.state) {
    case "pending":
    case "unknown":
    case "unsent":
      return null;
    case "maybe-applied":
      return { status: 200, body: { ok: false, outcome: "maybe-applied", replayed: true } };
    case "ok":
      return { status: 200, body: { ok: true, outcome: "ok", replayed: true } };
    case "stale":
      // What was current then. The turn may have moved again since; the phone reloads the pane.
      return {
        status: 409,
        body: { ok: false, outcome: "stale", turnId: receipt.currentTurnId ?? "", askIds: receipt.currentAskIds ?? [], replayed: true },
      };
    case "refused":
      return {
        status: 409,
        body: { ok: false, outcome: "refused", reason: receipt.reason ?? "refused", detail: receipt.detail ?? "", replayed: true },
      };
  }
}

/** What an adapter outcome means: the reply for the phone, and what the receipt keeps. */
interface Settled {
  readonly reply: ControlReply;
  readonly state: ControlState;
  readonly reason?: "unsupported" | "refused";
  readonly detail?: string;
  readonly current?: TurnView;
}

/**
 * What an adapter outcome means. `afterUnknown`: an earlier try with this id may have landed, so a
 * turn that moved on is `maybe-applied`, not an error.
 */
function settle(outcome: MuxControlOutcome, afterUnknown: boolean): Settled {
  if (afterUnknown && outcome.kind === "stale") {
    return { reply: { status: 200, body: { ok: false, outcome: "maybe-applied" } }, state: "maybe-applied" };
  }
  return settleOnce(outcome);
}

function settleOnce(outcome: MuxControlOutcome): Settled {
  switch (outcome.kind) {
    case "ok":
      return { reply: { status: 200, body: outcome.replayed ? { ok: true, outcome: "ok", replayed: true } : { ok: true, outcome: "ok" } }, state: "ok" };
    case "stale":
      return {
        reply: { status: 409, body: { ok: false, outcome: "stale", turnId: outcome.turnId, askIds: [...outcome.askIds] } },
        state: "stale",
        current: { turnId: outcome.turnId, askIds: outcome.askIds },
      };
    // Nothing reached the program, or it may have: either way the same request id may go again.
    case "unreachable":
      return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: outcome.detail } }, state: "unsent" };
    case "unknown":
      return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: outcome.detail } }, state: "unknown" };
    case "unsupported":
    case "refused":
      return { reply: refused(outcome.kind, outcome.detail), state: "refused", reason: outcome.kind, detail: outcome.detail };
    // The conversation left the program's layout: there is no turn to act on, and there never will be.
    case "gone":
      return { reply: refused("refused", outcome.detail), state: "refused", reason: "refused", detail: outcome.detail };
  }
}

/**
 * One send or one abort, from the phone. `body` is the parsed JSON, or undefined when it was not JSON.
 */
export function controlPane(
  act: ControlRequest["act"],
  paneId: string,
  body: JsonValue | undefined,
  deps: ControlDeps,
): Promise<ControlReply | ControlBadBody> {
  const request = readControlBody(act, body);
  if (request === null) return Promise.resolve({ status: 400, text: "bad body" });
  // Bound: a raw adapter keeps its methods on a prototype, and they read `this`.
  const controlTurn = deps.adapter.controlTurn?.bind(deps.adapter);
  if (controlTurn === undefined) return Promise.resolve(refused("unsupported", NO_CONTROLS));

  // SYNCHRONOUS from here to `track`: two taps with one request id must not both get past the look.
  const { receipts } = deps;
  const stored = receipts.get(request.requestId);
  if (stored !== undefined && stored.digest !== controlDigest(paneId, request)) {
    return Promise.resolve(refused("request-id-reused", CONTROL_ID_REUSED));
  }
  const replay = stored === undefined ? null : replayOf(stored);
  if (replay !== null) return Promise.resolve(replay);
  const running = receipts.inflight(request.requestId);
  if (running !== undefined && digestDiffers(running, controlDigest(paneId, request))) {
    return Promise.resolve(refused("request-id-reused", CONTROL_ID_REUSED));
  }
  if (running !== undefined) return running;

  const work = withDigest(send(paneId, request, stored, controlTurn, deps), controlDigest(paneId, request));
  receipts.track(request.requestId, work);
  return work;
}

function firstReceipt(paneId: string, request: ControlRequest, at: number): ControlReceipt {
  const receipt: ControlReceipt = {
    requestId: request.requestId,
    at,
    paneId,
    act: request.act,
    target: request.target.kind,
    targetId: request.target.id,
    digest: controlDigest(paneId, request),
    state: "pending",
  };
  if (request.act === "send") receipt.steer = request.steer;
  return receipt;
}

async function send(
  paneId: string,
  request: ControlRequest,
  stored: ControlReceipt | undefined,
  controlTurn: NonNullable<MuxAdapter["controlTurn"]>,
  deps: ControlDeps,
): Promise<ControlReply> {
  const { receipts } = deps;
  // An earlier try may have landed: it left with no answer, or this bridge stopped mid-flight.
  const afterUnknown = stored?.state === "pending" || stored?.state === "unknown";
  const base: ControlReceipt = { ...(stored ?? firstReceipt(paneId, request, (deps.now ?? Date.now)())), state: "pending" };
  // The receipt first, marked on its way. A retry of a pending one is already on disk as such.
  if (stored?.state !== "pending" && !(await receipts.recordFirst(base))) {
    return refused("refused", "The request could not be recorded on this machine, so it was not sent.", 503);
  }
  const settled = settle(await controlTurn(paneId, request), afterUnknown);
  const receipt: ControlReceipt = { ...base, state: settled.state };
  if (settled.detail !== undefined) receipt.detail = settled.detail;
  if (settled.reason !== undefined) receipt.reason = settled.reason;
  if (settled.current !== undefined) {
    receipt.currentTurnId = settled.current.turnId;
    receipt.currentAskIds = [...settled.current.askIds];
  }
  await receipts.record(receipt);
  const detail: AuditDetail = { requestId: request.requestId, outcome: settled.reply.body.outcome };
  if (request.target.kind === "turn") detail.turnId = request.target.id;
  else detail.askId = request.target.id;
  // The text a person sent, as the reply route records it. The receipt keeps only its hash.
  if (request.act === "send") {
    detail.text = request.text;
    detail.steer = request.steer;
  }
  deps.audit.record({ action: request.act, paneId, session: deps.session, device: deps.device, detail });
  if (settled.state === "ok") deps.settled?.();
  return settled.reply;
}
