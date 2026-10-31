// Persisted send requests and their receipts (M56 spec 05). One JSON file per request id under
// `<stateDir>/sends/`, written before any key leaves for that request, so a restart can tell what
// happened: the same id returns the same receipt, and a request that had sent its submit key but had
// not settled when the bridge died is `unknown`, never resent.
//
// What a file holds: the id, the session and pane, the pane generation, the Surface revision seen at
// accept, a salted hash and the length of the text, the phase, and the receipt once settled. Never
// the rows: they can hold secrets. The salt is random per state directory, so a short text cannot be
// looked up from its hash in a table made elsewhere.
//
// The text, as `line`, only when Sent would keep it (`sentLineOf`, bridge/secret-line.ts, ADR 0107):
// one line, not too long, nothing that looks like a secret, nothing the outbound mask would change.
// That is what the pane's Recent sends list prints under each row, so a person can tell ten rows apart
// (Altan, 2026-10-21). A text the rule refuses is sent as usual and leaves only its hash and length.
// Unlike Sent, this is per request and per pane, kept as long as the receipt is (REQUEST_KEEP_MS),
// listed on this machine only, and it is not searched: ADR 0107's "shell lines only" stands for Sent.
//
// Ask answers (M56 spec 08) live in the same directory under `ask.<id>.json`: the ask id, the pane
// and its generation, the ask hash, the option id, the phase and the receipt. A request id cannot
// hold a dot, so a send and an ask never share a file. Never a label: labels are screen text.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { ASK_ID, ASK_OUTCOMES, ASK_REASONS, type AskReceipt } from "../../web/src/lib/surface/ask.ts";
import { ASK_CHANNELS } from "../../web/src/lib/surface/surface.ts";
import { readSendCap, readSurfaceWords, RECEIPT_DETAIL_MAX, REQUEST_ID, SEND_LATES, SEND_MODES, SEND_OUTCOMES, SEND_REASONS, type ReadMark, type SendMode, type SendReceipt, type SendStep } from "../../web/src/lib/surface/send.ts";
import { SENT_MAX_LINE, sentLineOf } from "../secret-line.ts";

/** How long a settled request is kept, so a retry after a long network gap still finds its receipt. */
export const REQUEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The most request files kept; the oldest go first. */
export const REQUEST_KEEP_FILES = 500;

/**
 * `held` (M56 spec 15): the harness could not take the request while its turn ran, and the hold queue
 * (holds.ts) keeps it. Its receipt says `held`. A restart leaves it held; the release runs it again
 * under the same id, as a fresh run.
 */
export type RequestPhase = "accepted" | "submit-sent" | "settled" | "held";

export interface SendRecord {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly surfaceRevision: number;
  readonly mode: SendMode;
  readonly textHash: string;
  readonly textLength: number;
  /** The text as the line Sent would keep (see the header), or absent when that rule refused it. */
  readonly line?: string;
  readonly acceptedAt: number;
  /**
   * The version of the Collie that accepted the request (the bridge's own bare version string), so
   * `collie doctor` can tell receipts written before an update from those after it. Absent on records
   * an older Collie wrote, and on a store built without one.
   */
  readonly collie?: string;
  readonly phase: RequestPhase;
  readonly submitSentAt?: number;
  /** When a held request's release started (M56 spec 15): its run is bounded from here, not from accept. */
  readonly runAt?: number;
  readonly receipt?: SendReceipt;
}

export interface AcceptInput {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly surfaceRevision: number;
  readonly mode: SendMode;
  readonly text: string;
}

export type AcceptResult =
  | { readonly kind: "new"; readonly record: SendRecord }
  /** The same id and the same text: the stored record, settled or still in flight. */
  | { readonly kind: "replay"; readonly record: SendRecord }
  /** The same id with another text. Refused `id_reused`; the stored record is untouched. */
  | { readonly kind: "id_reused"; readonly record: SendRecord };

/** One ask answer on disk: accepted before any key, settled with its receipt. */
export interface AskRecord {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly hash: string;
  readonly optionId: string;
  readonly acceptedAt: number;
  readonly phase: "accepted" | "settled";
  readonly receipt?: AskReceipt;
}

export interface AskAcceptInput {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly hash: string;
  readonly optionId: string;
}

export type AskAcceptResult =
  | { readonly kind: "new"; readonly record: AskRecord }
  /** The same id with the same hash and option: the stored record, settled or still in flight. */
  | { readonly kind: "replay"; readonly record: AskRecord }
  /** The same id with another option or hash: refused `ask_answered`; the stored record is untouched. */
  | { readonly kind: "answered"; readonly record: AskRecord };

const ASK_KINDS = ["permission", "question", "menu"] as const;
const ASK_FILE = /^ask\.(ask-[0-9a-f]{14})\.json$/;

const PHASES = ["accepted", "submit-sent", "settled", "held"] as const;
const PROFILE_STATUSES = ["verified", "provisional", "revoked"] as const;
/** The longest `binary` path a stored receipt keeps; a longer one is dropped. */
const RECEIPT_BINARY_MAX = 4_096;
const STEPS = ["profile", "settle", "s0", "proof", "clear", "probe", "probeWrite", "write", "s1", "commandSettle", "commit", "s2"] as const;

function pick<const T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((word) => word === value);
}

function mark(value: JsonValue | undefined): ReadMark | null | undefined {
  if (value === null) return null;
  const node = asJsonObject(value);
  const revision = asJsonNumber(node?.revision);
  const hash = asJsonString(node?.hash);
  return revision === undefined || hash === undefined ? undefined : { revision, hash };
}

/** A receipt being finished, field by field. */
type ReceiptDraft = { -readonly [K in keyof SendReceipt]: SendReceipt[K] };

/** A receipt read back from its file, every field checked; undefined when one is not what it should be. */
function parseReceipt(value: JsonValue | undefined): SendReceipt | undefined {
  const node = asJsonObject(value);
  if (node === undefined) return undefined;
  const text = (key: string): string | undefined => asJsonString(node[key]);
  const nullableText = (key: string): string | null | undefined => (node[key] === null ? null : text(key));
  const outcome = pick(node.outcome, SEND_OUTCOMES);
  const reason = node.reason === undefined ? undefined : pick(node.reason, SEND_REASONS);
  const profileStatus = node.profileStatus === null ? null : pick(node.profileStatus, PROFILE_STATUSES);
  const [s0, s1, s2] = [mark(node.s0), mark(node.s1), mark(node.s2)];
  const gapsNode = asJsonObject(node.gapsMs);
  const keys = Array.isArray(node.keys) ? node.keys.map(asJsonString) : undefined;
  const fields = {
    requestId: text("requestId"),
    session: text("session"),
    paneId: text("paneId"),
    paneGeneration: text("paneGeneration"),
    harness: text("harness"),
    version: nullableText("version"),
    profileId: nullableText("profileId"),
    textHash: text("textHash"),
    textLength: asJsonNumber(node.textLength),
  };
  if (Object.values(fields).some((field) => field === undefined)) return undefined;
  if (outcome === undefined || profileStatus === undefined) return undefined;
  if (s0 === undefined || s1 === undefined || s2 === undefined || gapsNode === undefined || keys === undefined) return undefined;
  if (node.reason !== undefined && reason === undefined) return undefined;
  const cap = node.cap === undefined ? undefined : readSendCap(node.cap);
  if (cap === null) return undefined;
  // `queued` is true or absent; anything else is not a receipt this module wrote.
  if (node.queued !== undefined && node.queued !== true) return undefined;
  // `acknowledged` is a request id or absent (a program session's send, M56 spec 14).
  const acknowledged = node.acknowledged === undefined ? undefined : asJsonString(node.acknowledged);
  if (node.acknowledged !== undefined && (acknowledged === undefined || !REQUEST_ID.test(acknowledged))) return undefined;
  // `detail` is a short line and `saw` four words, on a refusal or a typed_not_submitted only (or absent on older receipts).
  // Both are lenient like the phone's reader: a field that is not what it should be is dropped (a
  // `detail` too long is cut), and the rest of the receipt stays. Rejecting the receipt would drop the
  // record, and the same request id would count as new.
  const storedDetail = node.detail === undefined ? undefined : asJsonString(node.detail);
  const detail = storedDetail?.slice(0, RECEIPT_DETAIL_MAX);
  const saw = node.saw === undefined ? undefined : (readSurfaceWords(node.saw) ?? undefined);
  const gapsMs: Partial<Record<SendStep, number>> = {};
  for (const step of STEPS) {
    const gap = asJsonNumber(gapsNode[step]);
    if (gap !== undefined) gapsMs[step] = gap;
  }
  const keyNames = keys.filter((key): key is string => key !== undefined);
  const receipt: SendReceipt = {
    requestId: fields.requestId!,
    session: fields.session!,
    paneId: fields.paneId!,
    paneGeneration: fields.paneGeneration!,
    harness: fields.harness!,
    version: fields.version!,
    profileId: fields.profileId!,
    profileStatus,
    textHash: fields.textHash!,
    textLength: fields.textLength!,
    s0,
    s1,
    s2,
    gapsMs,
    keys: keyNames,
    outcome,
  };
  const whole: ReceiptDraft = { ...receipt };
  // `binary` is lenient like `detail`: a value that is not a path is dropped, and the receipt stays.
  const binary = node.binary === undefined ? undefined : asJsonString(node.binary);
  if (binary !== undefined && binary.length > 0 && binary.length <= RECEIPT_BINARY_MAX) whole.binary = binary;
  if (reason !== undefined) whole.reason = reason;
  if (cap !== undefined) whole.cap = cap;
  if (node.queued === true) whole.queued = true;
  // `late` is lenient like `detail`: a word this module did not write is dropped, and the receipt stays.
  const late = node.late === undefined ? undefined : pick(node.late, SEND_LATES);
  if (late !== undefined) whole.late = late;
  if (acknowledged !== undefined) whole.acknowledged = acknowledged;
  if (detail !== undefined) whole.detail = detail;
  if (saw !== undefined) whole.saw = saw;
  return whole;
}

/**
 * A record read back from its file, every field checked; null when it is not one this module wrote.
 * Pure, so a reader that must not write (`cli/send-findings.ts`, `collie doctor`) parses the same
 * files without a store: the store's constructor creates the folder and its salt.
 */
export function parseSendRecord(raw: JsonValue | undefined): SendRecord | null {
  const node = asJsonObject(raw);
  if (node === undefined) return null;
  const id = asJsonString(node.id);
  const session = asJsonString(node.session);
  const paneId = asJsonString(node.paneId);
  const paneGeneration = asJsonString(node.paneGeneration);
  const surfaceRevision = asJsonNumber(node.surfaceRevision);
  const mode = pick(node.mode, SEND_MODES);
  const textHash = asJsonString(node.textHash);
  const textLength = asJsonNumber(node.textLength);
  const acceptedAt = asJsonNumber(node.acceptedAt);
  const phase = pick(node.phase, PHASES);
  if (id === undefined || session === undefined || paneId === undefined || paneGeneration === undefined) return null;
  if (surfaceRevision === undefined || mode === undefined || textHash === undefined || textLength === undefined) return null;
  if (acceptedAt === undefined || phase === undefined) return null;
  let record: SendRecord = { id, session, paneId, paneGeneration, surfaceRevision, mode, textHash, textLength, acceptedAt, phase };
  // Lenient like `detail`: a line that is not what it should be is dropped, and the record stays.
  const line = asJsonString(node.line);
  if (line !== undefined && line !== "" && line.length <= SENT_MAX_LINE) record = { ...record, line };
  const collie = asJsonString(node.collie);
  if (collie !== undefined && collie !== "") record = { ...record, collie };
  const submitSentAt = asJsonNumber(node.submitSentAt);
  if (submitSentAt !== undefined) record = { ...record, submitSentAt };
  const runAt = asJsonNumber(node.runAt);
  if (runAt !== undefined) record = { ...record, runAt };
  if (node.receipt !== undefined) {
    const receipt = parseReceipt(node.receipt);
    if (receipt === undefined) return null;
    record = { ...record, receipt };
  }
  return record;
}

/** An ask receipt read back from its file, every field checked; undefined when one is not what it should be. */
function parseAskReceipt(value: JsonValue | undefined): AskReceipt | undefined {
  const node = asJsonObject(value);
  if (node === undefined) return undefined;
  const text = (key: string): string | undefined => asJsonString(node[key]);
  const kind = pick(node.kind, ASK_KINDS);
  const outcome = pick(node.outcome, ASK_OUTCOMES);
  const reason = node.reason === undefined ? undefined : pick(node.reason, ASK_REASONS);
  const [check, readBack, after] = [mark(node.check), mark(node.readBack), mark(node.after)];
  const keys = Array.isArray(node.keys) ? node.keys.map(asJsonString) : undefined;
  const fields = {
    askId: text("askId"),
    session: text("session"),
    paneId: text("paneId"),
    paneGeneration: text("paneGeneration"),
    harness: text("harness"),
    hash: text("hash"),
    optionId: text("optionId"),
  };
  if (Object.values(fields).some((field) => field === undefined)) return undefined;
  if (kind === undefined || outcome === undefined || node.origin !== "person_tap") return undefined;
  if (check === undefined || readBack === undefined || after === undefined || keys === undefined || keys.some((key) => key === undefined)) return undefined;
  if (node.reason !== undefined && reason === undefined) return undefined;
  const channel = node.channel === undefined ? undefined : pick(node.channel, ASK_CHANNELS);
  if (node.channel !== undefined && channel === undefined) return undefined;
  const receipt: AskReceipt = {
    askId: fields.askId!,
    session: fields.session!,
    paneId: fields.paneId!,
    paneGeneration: fields.paneGeneration!,
    harness: fields.harness!,
    kind,
    hash: fields.hash!,
    optionId: fields.optionId!,
    origin: "person_tap",
    check,
    readBack,
    after,
    keys: keys.filter((key): key is string => key !== undefined),
    outcome,
  };
  const withReason = reason === undefined ? receipt : { ...receipt, reason };
  const withChannel = channel === undefined ? withReason : { ...withReason, channel };
  // A hook-held ask (M56 spec 12) also names the decision it sent.
  const decision = node.decision === "allow" || node.decision === "deny" ? node.decision : undefined;
  return channel === "hook" && decision !== undefined ? { ...withChannel, decision } : withChannel;
}

/** An ask record read back from its file, every field checked; null when it is not one this module wrote. */
function parseAskRecord(raw: JsonValue | undefined): AskRecord | null {
  const node = asJsonObject(raw);
  if (node === undefined) return null;
  const id = asJsonString(node.id);
  const session = asJsonString(node.session);
  const paneId = asJsonString(node.paneId);
  const paneGeneration = asJsonString(node.paneGeneration);
  const hash = asJsonString(node.hash);
  const optionId = asJsonString(node.optionId);
  const acceptedAt = asJsonNumber(node.acceptedAt);
  const phase = pick(node.phase, ["accepted", "settled"] as const);
  if (id === undefined || session === undefined || paneId === undefined || paneGeneration === undefined) return null;
  if (hash === undefined || optionId === undefined || acceptedAt === undefined || phase === undefined) return null;
  const record: AskRecord = { id, session, paneId, paneGeneration, hash, optionId, acceptedAt, phase };
  if (node.receipt === undefined) return record;
  const receipt = parseAskReceipt(node.receipt);
  return receipt === undefined ? null : { ...record, receipt };
}

export class RequestStore {
  private readonly salt: string;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
    /** The bridge's own version string, written into every record this store accepts. */
    private readonly collie?: string,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const saltPath = join(dir, ".salt");
    if (existsSync(saltPath)) {
      this.salt = readFileSync(saltPath, "utf8").trim();
    } else {
      this.salt = randomBytes(16).toString("hex");
      writeFileSync(saltPath, `${this.salt}\n`, { mode: 0o600 });
    }
  }

  /** The salted hash of a text, as every record and receipt names it. */
  hashText(text: string): string {
    return createHash("sha256").update(this.salt).update("\u0000").update(text).digest("hex");
  }

  private path(id: string): string {
    if (!REQUEST_ID.test(id)) throw new Error(`not a request id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private write(record: SendRecord): void {
    const target = this.path(record.id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  }

  /** The stored record, or null. */
  get(id: string): SendRecord | null {
    const target = this.path(id);
    if (!existsSync(target)) return null;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue; `parseSendRecord` checks every field.
      return parseSendRecord(JSON.parse(readFileSync(target, "utf8")) as JsonValue);
    } catch {
      return null;
    }
  }

  /**
   * Accept a request: write its file before anything is sent. The same id with the same text is a
   * replay of the stored record; with another text it is `id_reused`.
   */
  accept(input: AcceptInput): AcceptResult {
    const textHash = this.hashText(input.text);
    const known = this.get(input.id);
    if (known !== null) return known.textHash === textHash ? { kind: "replay", record: known } : { kind: "id_reused", record: known };
    let record: SendRecord = {
      id: input.id,
      session: input.session,
      paneId: input.paneId,
      paneGeneration: input.paneGeneration,
      surfaceRevision: input.surfaceRevision,
      mode: input.mode,
      textHash,
      textLength: [...input.text].length,
      acceptedAt: this.now(),
      phase: "accepted",
    };
    const line = sentLineOf(input.text);
    if (line !== null) record = { ...record, line };
    if (this.collie !== undefined) record = { ...record, collie: this.collie };
    this.write(record);
    return { kind: "new", record };
  }

  /** Written before the submit key goes out, so a crash after it reads as `unknown`, never as "not sent". */
  markSubmitSent(id: string): void {
    const known = this.get(id);
    if (known === null || known.phase === "settled") return;
    this.write({ ...known, phase: "submit-sent", submitSentAt: this.now() });
  }

  /**
   * A settled `sent` or `unknown` that a matching prompt edge confirmed (M56 spec 11) becomes
   * `effective`, its reason dropped. That and {@link markReturned} are the changes a settled record can
   * take, each once. Returns the outcome it had, or null when the record is not one a prompt edge may close.
   */
  markEffective(id: string): "sent" | "unknown" | null {
    const known = this.get(id);
    const receipt = known?.receipt;
    if (known === null || known.phase !== "settled" || receipt === undefined) return null;
    if (receipt.outcome !== "sent" && receipt.outcome !== "unknown") return null;
    const { reason: _dropped, ...rest } = receipt;
    this.write({ ...known, receipt: { ...rest, outcome: "effective" } });
    return receipt.outcome;
  }

  /**
   * A settled `sent` receipt that said `queued`, or a `steered` one, gets `late: "returned"` (ADR 0122):
   * the harness put its text back into the input box, and it never became a prompt. The outcome and
   * `queued` stay, since both were true when it settled; the mark says what happened after. Taken once.
   * Returns whether the record took it.
   */
  markReturned(id: string): boolean {
    const known = this.get(id);
    const receipt = known?.receipt;
    if (known === null || known.phase !== "settled" || receipt === undefined) return false;
    const waited = (receipt.outcome === "sent" && receipt.queued === true) || receipt.outcome === "steered";
    if (!waited || receipt.late !== undefined) return false;
    this.write({ ...known, receipt: { ...receipt, late: "returned" } });
    return true;
  }

  /**
   * The request is held (M56 spec 15): its receipt says `held`, and the hold queue keeps the text. A
   * held record is not settled: a restart does not end it, and the release runs it again.
   */
  hold(id: string, receipt: SendReceipt): SendRecord | null {
    const known = this.get(id);
    if (known === null || known.phase === "settled") return null;
    const { submitSentAt: _never, ...rest } = known;
    const held: SendRecord = { ...rest, phase: "held", receipt };
    this.write(held);
    return held;
  }

  /** A held request's pane moved to an agent its own profile names: the record takes the pane's new generation. */
  moveHeld(id: string, paneGeneration: string): void {
    const known = this.get(id);
    if (known === null || known.phase !== "held" || known.paneGeneration === paneGeneration) return;
    this.write({ ...known, paneGeneration });
  }

  /** A held request's release starts: it runs again as accepted, bounded from now. Null when it is not held. */
  rearm(id: string, paneGeneration?: string): SendRecord | null {
    const known = this.get(id);
    if (known === null || known.phase !== "held") return null;
    const { receipt: _held, ...rest } = known;
    // The pane's generation now, when the caller read one: the release runs against the pane as it is.
    const armed: SendRecord = { ...rest, phase: "accepted", runAt: this.now(), paneGeneration: paneGeneration ?? known.paneGeneration };
    this.write(armed);
    return armed;
  }

  /** The request's end: its receipt. A settled record changes once at most after this (`markEffective`, or `markReturned`). */
  settle(id: string, receipt: SendReceipt): SendRecord | null {
    const known = this.get(id);
    if (known === null) return null;
    if (known.phase === "settled") return known;
    const settled: SendRecord = { ...known, phase: "settled", receipt };
    this.write(settled);
    return settled;
  }

  /** Every record on disk, oldest first. */
  list(): SendRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: SendRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json") || ASK_FILE.test(name)) continue;
      const stem = name.slice(0, -".json".length);
      if (!REQUEST_ID.test(stem)) continue;
      const record = this.get(stem);
      if (record !== null) out.push(record);
    }
    return out.toSorted((a, b) => a.acceptedAt - b.acceptedAt);
  }

  /**
   * After a start: every request that had not settled ends `unknown` (`crash`), with the receipt it
   * would have had and no read. Whether it had sent its submit key or not, the text may be in the box;
   * the person reads the pane and resends under a new id. Returns the records it settled.
   */
  recover(unsettled: (record: SendRecord) => SendReceipt): SendRecord[] {
    const settled: SendRecord[] = [];
    for (const record of this.list()) {
      // A held request waits for its release; the hold queue replays it.
      if (record.phase === "settled" || record.phase === "held") continue;
      const done = this.settle(record.id, unsettled(record));
      if (done !== null) settled.push(done);
    }
    return settled;
  }

  /** Drop settled records older than the keep window, then the oldest past the file cap. */
  prune(keepMs = REQUEST_KEEP_MS, keepFiles = REQUEST_KEEP_FILES): number {
    const all = this.list();
    const now = this.now();
    let dropped = 0;
    const drop = (record: SendRecord): void => {
      rmSync(this.path(record.id), { force: true });
      dropped++;
    };
    const kept: SendRecord[] = [];
    for (const record of all) {
      if (record.phase === "settled" && now - record.acceptedAt > keepMs) drop(record);
      else kept.push(record);
    }
    const settledKept = kept.filter((record) => record.phase === "settled");
    for (let i = 0; i < kept.length - keepFiles && i < settledKept.length; i++) drop(settledKept[i]!);
    // Ask answers keep by the same rules, counted on their own.
    const asks = this.listAsks();
    const askKept: AskRecord[] = [];
    for (const record of asks) {
      if (record.phase === "settled" && now - record.acceptedAt > keepMs) {
        rmSync(this.askPath(record.id), { force: true });
        dropped++;
      } else askKept.push(record);
    }
    const askSettled = askKept.filter((record) => record.phase === "settled");
    for (let i = 0; i < askKept.length - keepFiles && i < askSettled.length; i++) {
      rmSync(this.askPath(askSettled[i]!.id), { force: true });
      dropped++;
    }
    return dropped;
  }

  // ── Ask answers (M56 spec 08) ──

  private askPath(id: string): string {
    if (!ASK_ID.test(id)) throw new Error(`not an ask id: ${id}`);
    return join(this.dir, `ask.${id}.json`);
  }

  private writeAsk(record: AskRecord): void {
    const target = this.askPath(record.id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  }

  /** The stored answer of an ask id, or null. */
  getAsk(id: string): AskRecord | null {
    const target = this.askPath(id);
    if (!existsSync(target)) return null;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue; `parseAskRecord` checks every field.
      return parseAskRecord(JSON.parse(readFileSync(target, "utf8")) as JsonValue);
    } catch {
      return null;
    }
  }

  /**
   * Accept an answer: write its file before any key. The id is spent from here on: the same hash and
   * option replay the stored record, another one is `answered`.
   */
  acceptAsk(input: AskAcceptInput): AskAcceptResult {
    const known = this.getAsk(input.id);
    if (known !== null) {
      const same = known.hash === input.hash && known.optionId === input.optionId;
      return same ? { kind: "replay", record: known } : { kind: "answered", record: known };
    }
    const record: AskRecord = { ...input, acceptedAt: this.now(), phase: "accepted" };
    this.writeAsk(record);
    return { kind: "new", record };
  }

  /** The answer's end: its receipt. A settled record never changes again. */
  settleAsk(id: string, receipt: AskReceipt): AskRecord | null {
    const known = this.getAsk(id);
    if (known === null) return null;
    if (known.phase === "settled") return known;
    const settled: AskRecord = { ...known, phase: "settled", receipt };
    this.writeAsk(settled);
    return settled;
  }

  /** Every ask answer on disk, oldest first. */
  listAsks(): AskRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: AskRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      const id = ASK_FILE.exec(name)?.[1];
      if (id === undefined) continue;
      const record = this.getAsk(id);
      if (record !== null) out.push(record);
    }
    return out.toSorted((a, b) => a.acceptedAt - b.acceptedAt);
  }

  /** After a start: every answer that had not settled ends `unknown` (`crash`). Returns the records it settled. */
  recoverAsks(unsettled: (record: AskRecord) => AskReceipt): AskRecord[] {
    const settled: AskRecord[] = [];
    for (const record of this.listAsks()) {
      if (record.phase === "settled") continue;
      const done = this.settleAsk(record.id, unsettled(record));
      if (done !== null) settled.push(done);
    }
    return settled;
  }
}
