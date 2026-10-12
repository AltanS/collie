// `POST /api/pane/:id/answer`: A PERSON'S TAP ANSWERS ONE ASK, BY ID, ONCE (ADR 0100).
//
// The phone names the ask it saw (`askId`, `revision`), the option the person chose, and a request
// id it minted for the tap. The route:
//
//   1. refuses a pane whose adapter takes no answers, with the mux refusal's word (`unsupported`);
//   2. answers a request id it already settled from the receipt, and sends nothing (`replayed`);
//      a request id still in flight is joined, never sent twice;
//   3. writes the receipt BEFORE the answer leaves (ADR 0091's store, `recordFirst`). A receipt that
//      cannot be written sends nothing;
//   4. sends ONE answer through the adapter, and keeps what came back on the receipt.
//
// AN UNKNOWN OUTCOME KEEPS THE RECEIPT OPEN. A timeout, a dropped connection or a 5xx after the
// answer left means it may have landed. The receipt stays `pending`, the phone offers "Try again",
// and that tap carries the SAME request id, so the program's own request id memory (WIRE.md section
// 7.6) answers `replayed` rather than resolving the ask twice. The bridge never re-sends by itself.
//
// A PERSON'S TAP ONLY. This is the one caller of `MuxAdapter.answerAsk`. It runs for a paired device
// behind the write gate, like every pane write, and nothing in the bridge calls it for a program,
// a hook or a model output (ADR 0024).
//
// The handler is a pure function of its inputs and returns a status and a body; `bridge/server.ts`
// turns that into a response, so `bun test` drives it with a fake adapter.

import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { JsonValue } from "../json.ts";
import type { MuxAdapter, MuxAnswerResult, MuxOutcome } from "../mux/types.ts";
import type { AnswerRequest, AnswerResponse, Ask } from "../types.ts";
import { memoryReceipts, ReceiptFileStore, type ReceiptSurface } from "../worktree-receipts.ts";
import { coerceAnswerReceipt, readAnswerBody } from "./parse.ts";

// ── The receipt ───────────────────────────────────────────────────────────────

/** The receipt file's name inside the state dir. */
export const ANSWER_RECEIPTS_FILE = "answer-receipts.json";

/** Where an answer stands. `pending` is written first, and stays when the outcome is unknown. */
export type AnswerState = "pending" | "taken" | "too-late" | "stale" | "refused";

/** One answer a phone sent, under its request id. Ids and the outcome only: no note, no ask text. */
export interface AnswerReceipt {
  requestId: string;
  /** Epoch ms of the first request with this id. */
  at: number;
  paneId: string;
  askId: string;
  revision: number;
  optionId: string;
  state: AnswerState;
  /** For `refused`: the line the refusal carried, and its word. */
  detail?: string;
  reason?: "unsupported" | "refused";
}

/** What the route needs of the store: ADR 0091's surface, plus the write that comes first. */
export type AnswerReceiptSurface = ReceiptSurface<AnswerReceipt, AnswerReply> & {
  /** Store one receipt and say whether it reached disk. False: nothing may be sent. */
  recordFirst(receipt: AnswerReceipt): Promise<boolean>;
};

/** The file-backed store `bridge/index.ts` builds once per bridge. Written on the first answer only. */
export class AnswerReceiptStore extends ReceiptFileStore<AnswerReceipt, AnswerReply> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line)) {
    super(stateDir, join(stateDir, ANSWER_RECEIPTS_FILE), coerceAnswerReceipt, warn, "answer");
  }
}

/** A store with no file, for a server built without one. Its first write never fails. */
export function memoryAnswerReceipts(): AnswerReceiptSurface {
  const store = memoryReceipts<AnswerReceipt, AnswerReply>();
  return {
    ...store,
    recordFirst: async (receipt) => {
      await store.record(receipt);
      return true;
    },
  };
}

// ── The route ─────────────────────────────────────────────────────────────────

/** The route's answer: a status and the one body shape (`AnswerResponse`). */
export interface AnswerReply {
  readonly status: number;
  readonly body: AnswerResponse;
}

/** A body the route cannot read. Plain text, as every pane write answers one. */
export interface AnswerBadBody {
  readonly status: 400;
  readonly text: string;
}

export interface AnswerDeps {
  /** The pane's adapter. Without `answerAsk` it takes no answers. */
  readonly adapter: Pick<MuxAdapter, "answerAsk">;
  readonly receipts: AnswerReceiptSurface;
  readonly audit: { record(entry: AuditEntry): void };
  readonly device: string | null;
  readonly session: string;
  /** Called after an answer was taken, so the next snapshot drops the ask. */
  readonly settled?: () => void;
  readonly now?: () => number;
}

/** The refusal for a pane whose adapter takes no answers (ADR 0022's word, `unsupported`). */
export const NO_ANSWERS = "This pane takes no answers.";

/** Whether a stored receipt is for this same answer: one request id, one pane, one ask, one choice. */
function sameAnswer(receipt: AnswerReceipt, paneId: string, request: AnswerRequest): boolean {
  return (
    receipt.paneId === paneId &&
    receipt.askId === request.askId &&
    receipt.revision === request.revision &&
    receipt.optionId === request.optionId
  );
}

/** The reply a settled receipt gives again. `null` for a `pending` one: that one is sent again. */
function replayOf(receipt: AnswerReceipt): AnswerReply | null {
  switch (receipt.state) {
    case "pending":
      return null;
    case "taken":
      return { status: 200, body: { ok: true, outcome: "taken", replayed: true } };
    case "too-late":
      return { status: 200, body: { ok: false, outcome: "too-late", replayed: true } };
    case "stale":
      // The ask it carried then may have moved again since. The phone reads the pane for the current one.
      return { status: 409, body: { ok: false, outcome: "stale", replayed: true } };
    case "refused":
      return {
        status: 409,
        body: { ok: false, outcome: "refused", reason: receipt.reason ?? "refused", detail: receipt.detail ?? "", replayed: true },
      };
  }
}

function refused(reason: "unsupported" | "refused", detail: string, status = 409): AnswerReply {
  return { status, body: { ok: false, outcome: "refused", reason, detail } };
}

/** What an adapter outcome means: the reply for the phone, and what the receipt keeps. */
interface Settled {
  readonly reply: AnswerReply;
  readonly state: AnswerState;
  readonly reason?: "unsupported" | "refused";
  readonly detail?: string;
}

/** What the adapter's outcome means for the phone, and for the receipt. */
function settle(outcome: MuxOutcome<MuxAnswerResult>): Settled {
  if (!outcome.ok) {
    switch (outcome.reason) {
      // No such pane in the program's layout: there is nothing left to answer.
      case "gone":
        return { reply: { status: 200, body: { ok: false, outcome: "too-late" } }, state: "too-late" };
      // Nothing was sent, but the program may take the same answer later: the receipt stays open.
      case "unreachable":
        return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: outcome.detail } }, state: "pending" };
      case "unsupported":
      case "refused":
        return { reply: refused(outcome.reason, outcome.detail), state: "refused", reason: outcome.reason, detail: outcome.detail };
    }
  }
  const result = outcome.value;
  switch (result.kind) {
    case "taken":
      return { reply: { status: 200, body: result.replayed ? { ok: true, outcome: "taken", replayed: true } : { ok: true, outcome: "taken" } }, state: "taken" };
    case "too-late":
      return { reply: { status: 200, body: result.replayed ? { ok: false, outcome: "too-late", replayed: true } : { ok: false, outcome: "too-late" } }, state: "too-late" };
    case "stale": {
      const body: AnswerResponse = result.ask === null ? { ok: false, outcome: "stale" } : { ok: false, outcome: "stale", ask: result.ask satisfies Ask };
      return { reply: { status: 409, body }, state: "stale" };
    }
    case "unknown":
      return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: result.detail } }, state: "pending" };
  }
}

/**
 * One answer, from the phone's tap. `body` is the parsed JSON, or undefined when it was not JSON.
 */
export function answerPane(paneId: string, body: JsonValue | undefined, deps: AnswerDeps): Promise<AnswerReply | AnswerBadBody> {
  const request = readAnswerBody(body);
  if (request === null) return Promise.resolve({ status: 400, text: "bad body" });
  // Bound: a raw adapter keeps its methods on a prototype, and they read `this`.
  const answerAsk = deps.adapter.answerAsk?.bind(deps.adapter);
  if (answerAsk === undefined) return Promise.resolve(refused("unsupported", NO_ANSWERS));

  // SYNCHRONOUS from here to `track`: two taps with one request id must not both get past the look.
  const { receipts } = deps;
  const stored = receipts.get(request.requestId);
  if (stored !== undefined && !sameAnswer(stored, paneId, request)) {
    return Promise.resolve(refused("refused", "This request id was already used for another answer."));
  }
  const replay = stored === undefined ? null : replayOf(stored);
  if (replay !== null) return Promise.resolve(replay);
  const running = receipts.inflight(request.requestId);
  if (running !== undefined) return running;

  const work = send(paneId, request, stored, answerAsk, deps);
  receipts.track(request.requestId, work);
  return work;
}

async function send(
  paneId: string,
  request: AnswerRequest,
  stored: AnswerReceipt | undefined,
  answerAsk: NonNullable<MuxAdapter["answerAsk"]>,
  deps: AnswerDeps,
): Promise<AnswerReply> {
  const { receipts } = deps;
  const base: AnswerReceipt = stored ?? {
    requestId: request.requestId,
    at: (deps.now ?? Date.now)(),
    paneId,
    askId: request.askId,
    revision: request.revision,
    optionId: request.optionId,
    state: "pending",
  };
  // The receipt first. A retry of a pending one is already on disk.
  if (stored === undefined && !(await receipts.recordFirst(base))) {
    return refused("refused", "The answer could not be recorded on this machine, so it was not sent.", 503);
  }
  const outcome = await answerAsk(paneId, request);
  const settled = settle(outcome);
  if (settled.state !== "pending") {
    const receipt: AnswerReceipt = { ...base, state: settled.state };
    if (settled.detail !== undefined) receipt.detail = settled.detail;
    if (settled.reason !== undefined) receipt.reason = settled.reason;
    await receipts.record(receipt);
  }
  deps.audit.record({
    action: "answer",
    paneId,
    session: deps.session,
    device: deps.device,
    detail: {
      requestId: request.requestId,
      askId: request.askId,
      revision: request.revision,
      optionId: request.optionId,
      outcome: settled.reply.body.outcome,
    },
  });
  if (settled.state === "taken") deps.settled?.();
  return settled.reply;
}
