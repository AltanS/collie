// Persisted send requests and their receipts (M56 spec 05). One JSON file per request id under
// `<stateDir>/sends/`, written before any key leaves for that request, so a restart can tell what
// happened: the same id returns the same receipt, and a request that had sent its submit key but had
// not settled when the bridge died is `unknown`, never resent.
//
// What a file holds: the id, the session and pane, the pane generation, the Surface revision seen at
// accept, a salted hash and the length of the text, the phase, and the receipt once settled. Never
// the text and never the rows: both can hold secrets. The salt is random per state directory, so a
// short text cannot be looked up from its hash in a table made elsewhere.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { REQUEST_ID, SEND_MODES, SEND_OUTCOMES, SEND_REASONS, type ReadMark, type SendMode, type SendReceipt, type SendStep } from "../../web/src/lib/surface/send.ts";

/** How long a settled request is kept, so a retry after a long network gap still finds its receipt. */
export const REQUEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The most request files kept; the oldest go first. */
export const REQUEST_KEEP_FILES = 500;

export type RequestPhase = "accepted" | "submit-sent" | "settled";

export interface SendRecord {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly surfaceRevision: number;
  readonly mode: SendMode;
  readonly textHash: string;
  readonly textLength: number;
  readonly acceptedAt: number;
  readonly phase: RequestPhase;
  readonly submitSentAt?: number;
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

const PHASES = ["accepted", "submit-sent", "settled"] as const;
const PROFILE_STATUSES = ["verified", "provisional", "revoked"] as const;
const STEPS = ["s0", "probe", "write", "s1", "commit", "s2"] as const;

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

/** A receipt read back from its file, every field checked; undefined when one is not what it should be. */
function parseReceipt(value: JsonValue | undefined): SendReceipt | undefined {
  const node = asJsonObject(value);
  if (node === undefined) return undefined;
  const text = (key: string): string | undefined => asJsonString(node[key]);
  const nullableText = (key: string): string | null | undefined => (node[key] === null ? null : text(key));
  const outcome = pick(node.outcome, SEND_OUTCOMES);
  const mode = pick(node.mode, SEND_MODES);
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
  if (outcome === undefined || mode === undefined || profileStatus === undefined || (node.probed !== true && node.probed !== false)) return undefined;
  if (s0 === undefined || s1 === undefined || s2 === undefined || gapsNode === undefined || keys === undefined) return undefined;
  if (node.reason !== undefined && reason === undefined) return undefined;
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
    mode,
    textHash: fields.textHash!,
    textLength: fields.textLength!,
    probed: node.probed === true,
    s0,
    s1,
    s2,
    gapsMs,
    keys: keyNames,
    outcome,
  };
  return reason === undefined ? receipt : { ...receipt, reason };
}

/** A record read back from its file, every field checked; null when it is not one this module wrote. */
function parseRecord(raw: JsonValue | undefined): SendRecord | null {
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
  const submitSentAt = asJsonNumber(node.submitSentAt);
  if (submitSentAt !== undefined) record = { ...record, submitSentAt };
  if (node.receipt !== undefined) {
    const receipt = parseReceipt(node.receipt);
    if (receipt === undefined) return null;
    record = { ...record, receipt };
  }
  return record;
}

export class RequestStore {
  private readonly salt: string;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
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
      // SAFETY: `JSON.parse` output IS a JsonValue; `parseRecord` checks every field.
      return parseRecord(JSON.parse(readFileSync(target, "utf8")) as JsonValue);
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
    const record: SendRecord = {
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
    this.write(record);
    return { kind: "new", record };
  }

  /** Written before the submit key goes out, so a crash after it reads as `unknown`, never as "not sent". */
  markSubmitSent(id: string): void {
    const known = this.get(id);
    if (known === null || known.phase === "settled") return;
    this.write({ ...known, phase: "submit-sent", submitSentAt: this.now() });
  }

  /** The request's end: its receipt. A settled record never changes again. */
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
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -".json".length));
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
      if (record.phase === "settled") continue;
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
    return dropped;
  }
}
