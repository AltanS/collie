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
// ONE REQUEST ID, ONE PAYLOAD. The receipt keeps a digest of what was asked (pane, ask, revision,
// option). The same id with another payload is refused (409, `request-id-reused`), never sent.
//
// AN UNKNOWN OUTCOME KEEPS THE RECEIPT OPEN. A timeout, a dropped connection or a 5xx after the
// answer left means it may have landed. The receipt says `unknown`, the phone offers "Try again",
// and that tap carries the SAME request id, so the program's own request id memory (WIRE.md section
// 7.6) answers `replayed` rather than resolving the ask twice. The bridge never re-sends by itself.
// A retry after an unknown outcome that finds the ask closed (`too-late`) or changed (`stale`) is
// `maybe-applied`: the first try may be the one that closed it, so the phone says "check the chat"
// instead of an error.
//
// IN FLIGHT. `pending` is written before the answer leaves and means "on its way". Within this
// process a second request with the same id joins the first and never posts. A `pending` receipt
// found after a restart was cut off mid-flight, so it reads like `unknown`. `unsent` means nothing
// reached the program (it could not be dialled); a retry of that one is a plain first try.
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
import type { AnswerRequest, AnswerResponse, AnswerValues, Ask, AskDecided } from "../types.ts";
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
import { coerceAnswerReceipt, readAnswerBody } from "./parse.ts";

// ── The receipt ───────────────────────────────────────────────────────────────

/** The receipt file's name inside the state dir. */
export const ANSWER_RECEIPTS_FILE = "answer-receipts.json";

/**
 * Where an answer stands. `pending` is written first and means the answer is on its way. `unknown`:
 * it left and nobody knows what it did. `unsent`: nothing reached the program. Those three may be
 * sent again with the same id; the rest are final.
 */
export type AnswerState = "pending" | "unknown" | "unsent" | "taken" | "too-late" | "stale" | "refused" | "maybe-applied";

/** The states a retry may send again. */
const OPEN_STATES: ReadonlySet<AnswerState> = new Set(["pending", "unknown", "unsent"]);

/** One answer a phone sent, under its request id. Ids and the outcome only: no note, no ask text. */
export interface AnswerReceipt {
  requestId: string;
  /** Epoch ms of the first request with this id. */
  at: number;
  paneId: string;
  askId: string;
  revision: number;
  optionId: string;
  /** {@link answerDigest} of the four fields above, so another payload under the same id is refused. */
  digest: string;
  state: AnswerState;
  /** For `refused`: the line the refusal carried, and its word. */
  detail?: string;
  reason?: "unsupported" | "refused";
  /** For `too-late`: who decided the ask first, and when, when the program said so. A replay says it again. */
  decided?: AskDecided;
}

/** The receipt's `optionId` for an answer: the option for a permission, the options joined for a choice, and nothing for a text or a form (their words stay out of the receipt). */
export function receiptOptionId(request: AnswerRequest): string {
  if ("optionId" in request) return request.optionId;
  return "optionIds" in request ? request.optionIds.join(",") : "";
}

/** The values of a form as a stable list of `[field id, value]`, so the same form digests the same whatever order the keys came in. */
function sortedValues(values: AnswerValues): string {
  return JSON.stringify(Object.keys(values).toSorted().map((key) => [key, values[key]]));
}

/**
 * What one answer asks for, as a digest: the pane, the ask, the revision the phone saw, and what was chosen. The
 * permission digest is the one it always was. A text or a form is hashed, so the digest tells another payload under the
 * same id apart without the receipt keeping the person's words.
 */
export function answerDigest(paneId: string, request: AnswerRequest): string {
  const head = ["answer", paneId, request.askId, request.revision] as const;
  if ("optionId" in request) return payloadDigest([...head, request.optionId]);
  if ("optionIds" in request) return payloadDigest([...head, "optionIds", JSON.stringify(request.optionIds)]);
  if ("text" in request) return payloadDigest([...head, "text", request.text]);
  return payloadDigest([...head, "values", sortedValues(request.values)]);
}

/** A week, the newest thousand, and a pending receipt kept for at least a day (ADR 0100). */
export const ANSWER_RETENTION: ReceiptRetention<AnswerReceipt> = {
  ...DURABLE_RECEIPT_LIMITS,
  atOf: (receipt) => receipt.at,
  pending: (receipt) => OPEN_STATES.has(receipt.state),
};

/** What the route needs of the store: ADR 0091's surface, plus the write that comes first. */
export type AnswerReceiptSurface = ReceiptSurface<AnswerReceipt, AnswerReply> & {
  /** Store one receipt and say whether it reached disk. False: nothing may be sent. */
  recordFirst(receipt: AnswerReceipt): Promise<boolean>;
};

/** The file-backed store `bridge/index.ts` builds once per bridge. Written on the first answer only. */
export class AnswerReceiptStore extends ReceiptFileStore<AnswerReceipt, AnswerReply> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line), now: () => number = Date.now) {
    super(stateDir, join(stateDir, ANSWER_RECEIPTS_FILE), coerceAnswerReceipt, warn, "answer", ANSWER_RETENTION, now);
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

/** The refusal for a request id already used for another payload. Nothing is sent. */
export const REQUEST_ID_REUSED = "This request id was already used for another answer.";

/** The reply a settled receipt gives again. `null` for an open one: that one is sent again. */
function replayOf(receipt: AnswerReceipt): AnswerReply | null {
  switch (receipt.state) {
    case "pending":
    case "unknown":
    case "unsent":
      return null;
    case "maybe-applied":
      return { status: 200, body: { ok: false, outcome: "maybe-applied", replayed: true } };
    case "taken":
      return { status: 200, body: { ok: true, outcome: "taken", replayed: true } };
    case "too-late":
      return { status: 200, body: receipt.decided === undefined ? { ok: false, outcome: "too-late", replayed: true } : { ok: false, outcome: "too-late", decided: receipt.decided, replayed: true } };
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

function refused(reason: "unsupported" | "refused" | "request-id-reused", detail: string, status = 409): AnswerReply {
  return { status, body: { ok: false, outcome: "refused", reason, detail } };
}

/** What an adapter outcome means: the reply for the phone, and what the receipt keeps. */
interface Settled {
  readonly reply: AnswerReply;
  readonly state: AnswerState;
  readonly reason?: "unsupported" | "refused";
  readonly detail?: string;
  /** For `too-late`: the first decision, as the program told it. */
  readonly decided?: AskDecided;
}

/** The reply for a retry that may have been the one to land: the phone says "check the chat". */
const MAYBE_APPLIED: Settled = { reply: { status: 200, body: { ok: false, outcome: "maybe-applied" } }, state: "maybe-applied" };

/**
 * What the adapter's outcome means for the phone, and for the receipt. `afterUnknown`: an earlier try
 * with this id may have landed, so a closed or changed ask is `maybe-applied`, not an error.
 */
function settle(outcome: MuxOutcome<MuxAnswerResult>, afterUnknown: boolean): Settled {
  const plain = settleOnce(outcome);
  const closedOrMoved = plain.state === "too-late" || plain.state === "stale";
  return afterUnknown && closedOrMoved && !replayedByProgram(outcome) ? MAYBE_APPLIED : plain;
}

/** The program said it saw this request id before: its answer IS the first try's, so it stands. */
function replayedByProgram(outcome: MuxOutcome<MuxAnswerResult>): boolean {
  return outcome.ok && (outcome.value.kind === "taken" || outcome.value.kind === "too-late") && outcome.value.replayed;
}

function settleOnce(outcome: MuxOutcome<MuxAnswerResult>): Settled {
  if (!outcome.ok) {
    switch (outcome.reason) {
      // No such pane in the program's layout: there is nothing left to answer.
      case "gone":
        return { reply: { status: 200, body: { ok: false, outcome: "too-late" } }, state: "too-late" };
      // Nothing was sent, but the program may take the same answer later: the receipt stays open.
      case "unreachable":
        return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: outcome.detail } }, state: "unsent" };
      // It left and was not confirmed: it may have landed, so the receipt keeps it as unknown.
      case "unconfirmed":
        return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: outcome.detail } }, state: "unknown" };
      case "unsupported":
      case "refused":
        return { reply: refused(outcome.reason, outcome.detail), state: "refused", reason: outcome.reason, detail: outcome.detail };
    }
  }
  const result = outcome.value;
  switch (result.kind) {
    case "taken":
      return { reply: { status: 200, body: result.replayed ? { ok: true, outcome: "taken", replayed: true } : { ok: true, outcome: "taken" } }, state: "taken" };
    case "too-late": {
      const body: AnswerResponse = { ok: false, outcome: "too-late" };
      if (result.decided !== undefined) body.decided = { by: result.decided.by, at: result.decided.at };
      if (result.replayed) body.replayed = true;
      return result.decided === undefined ? { reply: { status: 200, body }, state: "too-late" } : { reply: { status: 200, body }, state: "too-late", decided: body.decided };
    }
    case "stale": {
      const body: AnswerResponse = result.ask === null ? { ok: false, outcome: "stale" } : { ok: false, outcome: "stale", ask: result.ask satisfies Ask };
      return { reply: { status: 409, body }, state: "stale" };
    }
    case "unknown":
      return { reply: { status: 504, body: { ok: false, outcome: "unknown", detail: result.detail } }, state: "unknown" };
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
  if (stored !== undefined && stored.digest !== answerDigest(paneId, request)) {
    return Promise.resolve(refused("request-id-reused", REQUEST_ID_REUSED));
  }
  const replay = stored === undefined ? null : replayOf(stored);
  if (replay !== null) return Promise.resolve(replay);
  const running = receipts.inflight(request.requestId);
  if (running !== undefined && digestDiffers(running, answerDigest(paneId, request))) {
    return Promise.resolve(refused("request-id-reused", REQUEST_ID_REUSED));
  }
  if (running !== undefined) return running;

  const work = withDigest(send(paneId, request, stored, answerAsk, deps), answerDigest(paneId, request));
  receipts.track(request.requestId, work);
  return work;
}

/** What the audit line says was chosen: the option ids, never a person's typed words. */
function auditChoice(request: AnswerRequest) {
  if ("optionId" in request) return { optionId: request.optionId };
  if ("optionIds" in request) return { answer: "optionIds", optionIds: request.optionIds };
  return { answer: "text" in request ? "text" : "values" };
}

async function send(
  paneId: string,
  request: AnswerRequest,
  stored: AnswerReceipt | undefined,
  answerAsk: NonNullable<MuxAdapter["answerAsk"]>,
  deps: AnswerDeps,
): Promise<AnswerReply> {
  const { receipts } = deps;
  // An earlier try may have landed: it left with no answer (`unknown`), or this bridge stopped while
  // it was on its way (`pending` with nothing in flight here).
  const afterUnknown = stored?.state === "pending" || stored?.state === "unknown";
  const base: AnswerReceipt = {
    ...(stored ?? {
      requestId: request.requestId,
      at: (deps.now ?? Date.now)(),
      paneId,
      askId: request.askId,
      revision: request.revision,
      optionId: receiptOptionId(request),
      digest: answerDigest(paneId, request),
    }),
    state: "pending",
  };
  // The receipt first, marked on its way. A retry of a pending one is already on disk as such.
  if (stored?.state !== "pending" && !(await receipts.recordFirst(base))) {
    return refused("refused", "The answer could not be recorded on this machine, so it was not sent.", 503);
  }
  const outcome = await answerAsk(paneId, request);
  const settled = settle(outcome, afterUnknown);
  const receipt: AnswerReceipt = { ...base, state: settled.state };
  if (settled.detail !== undefined) receipt.detail = settled.detail;
  if (settled.reason !== undefined) receipt.reason = settled.reason;
  if (settled.decided !== undefined) receipt.decided = settled.decided;
  await receipts.record(receipt);
  deps.audit.record({
    action: "answer",
    paneId,
    session: deps.session,
    device: deps.device,
    detail: {
      requestId: request.requestId,
      askId: request.askId,
      revision: request.revision,
      ...auditChoice(request),
      outcome: settled.reply.body.outcome,
    },
  });
  if (settled.state === "taken") deps.settled?.();
  return settled.reply;
}
