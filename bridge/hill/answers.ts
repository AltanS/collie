// One Send per session (Asks, 2026-11-22): the pure parts of `POST /api/hill/answers`. The service
// (service.ts `answerAsks`) claims each ask in the answer lane, closes each as answered with its own
// receipt, and types ONE WalkyTalky message (web/src/lib/hill/answers-message.ts).
//
// THE RECEIPTS. Each ask's answer gets a receipt of its own in the Hill's receipt file, under a request id
// derived from the Send's `rid` and the ask's id ({@link askAnswerRid}), so it is the same on every retry
// and never a UUID a phone could mint for another answer by chance. The Send itself gets one record under
// its `rid` ({@link sendRecord}): a repeat of that `rid` with the same answers is answered from these
// records and runs nothing; with other answers it is refused (409), as a reused answer `rid` is.

import { createHash } from "node:crypto";

import type { HillAnswersItem, HillAnswersRequest, HillAnswersResult, HillReceipt } from "../../web/src/lib/hill/wire.ts";
import { payloadDigest } from "../worktree-receipts.ts";
import type { HillReceiptRecord } from "./receipts.ts";

/**
 * The request id of one ask's answer inside a Send: a version-5-shaped UUID from SHA-256 over the Send's
 * `rid` and the ask's id. The same on every retry of the Send; another Send names other ones.
 */
export function askAnswerRid(rid: string, id: string): string {
  const hex = createHash("sha256").update(`collie asks send\u0000${rid.toLowerCase()}\u0000${id}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** What a Send asks for, as a digest: every answer's id, intent and text, in order. The text itself is not kept. */
export function sendDigest(request: HillAnswersRequest): string {
  return payloadDigest(["collie asks send", JSON.stringify(request.answers.map((answer) => [answer.id, answer.intent, answer.text ?? ""]))]);
}

/** The words a Send's own record keeps in `reason` when the typed message's write was not confirmed. */
export const SEND_UNCONFIRMED = "unconfirmed";

/** The record a Send keeps under its own `rid`: ok or rejected, and what walky said of the one message. */
export function sendRecord(rid: string, digest: string, at: number, code: "ok" | "rejected", delivery: HillAnswersResult["delivery"], unconfirmed: boolean, reason: string | null = null): HillReceiptRecord {
  const receipt: HillReceipt = { rid, code, reason: unconfirmed ? SEND_UNCONFIRMED : reason, state: null, delivery, trick: null, at };
  return { requestId: rid, payloadDigest: digest, receipt };
}

/** One ask's item as its receipt says it: `ok` when it closed as answered in this Send, else `gone` with the reason. */
export function itemOf(id: string, receipt: HillReceipt | undefined): HillAnswersItem {
  if (receipt === undefined) return { id, code: "gone", reason: "no receipt of this ask in this Send", state: null };
  return receipt.code === "ok" ? { id, code: "ok", reason: null, state: receipt.state } : { id, code: "gone", reason: receipt.reason, state: receipt.state };
}

/** The result of a Send rebuilt from its records, for a repeat of its `rid`. */
export function resultOf(request: HillAnswersRequest, send: HillReceipt, receipt: (rid: string) => HillReceipt | undefined): HillAnswersResult {
  const items = request.answers.map((answer) => itemOf(answer.id, receipt(askAnswerRid(request.rid, answer.id))));
  const base: HillAnswersResult = { rid: request.rid, items, delivery: send.delivery ?? "none", at: send.at };
  return send.reason === SEND_UNCONFIRMED ? { ...base, unconfirmed: true } : base;
}
