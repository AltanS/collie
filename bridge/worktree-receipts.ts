import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import type { WorktreeCreateResponse } from "./types.ts";

// ── One receipt per phone request, so a retried create never makes a second worktree (ADR 0089) ──
//
// A worktree create can take a minute: Herdr runs `git worktree add`, opens a workspace, and the
// bridge may then wait for the new shell and type a launcher into it. A phone on a train loses that
// reply all the time. The operator taps again, and without a receipt the second tap is a second
// worktree on a second branch, or a refusal because the path is taken, while the first one sits
// there unseen.
//
// So the phone mints a `requestId` (a UUID) per intent and sends it with the create. The bridge keeps
// the outcome of every create that SUCCEEDED under that id, in `worktree-receipts.json` beside the
// other state files, and a POST that names a known id gets the stored outcome back with
// `replayed: true` and runs nothing. A create still in flight is joined, not repeated: the second
// request waits for the first one's answer.
//
// ── WHAT IS STORED, AND WHAT IS NOT ─────────────────────────────────────────────
// Ids, the checkout path, the branch and whether the launcher started. No command line, no screen
// text. A refusal stores nothing, because nothing was made: the same id may simply be tried again.
//
// ── BOUNDED ─────────────────────────────────────────────────────────────────────
// At most {@link MAX_RECEIPTS}; the oldest goes first. A receipt only has to outlive the retry it
// guards, which is seconds to minutes, so two hundred is far past any real need and keeps the file
// small. The file is written on a create and on nothing else, so a bridge nobody asks for a worktree
// writes no file at all (solo-baseline.test.ts counts the written entries).

/** The most receipts kept. A 201st drops the oldest. */
export const MAX_RECEIPTS = 200;

/** The receipt file's name inside the state dir. */
export const RECEIPTS_FILE = "worktree-receipts.json";

/** A canonical UUID, any version, any case. What the phone mints with 128 random bits. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether `raw` is a request id the route may key a receipt on. */
export function isRequestId(raw: JsonValue | undefined): raw is string {
  return typeof raw === "string" && REQUEST_ID.test(raw);
}

/**
 * The SHA-256 of what a request asks for, hex. A receipt keeps it beside its request id, so a repeat
 * of the id with another payload is told apart from a retry of the same one without keeping the
 * payload itself (a send's text, for one).
 */
export function payloadDigest(parts: readonly (string | number | boolean)[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/**
 * How long a store keeps its receipts, for a store that keeps more than {@link MAX_RECEIPTS} (the
 * durable answer, control and starter stores). A receipt older than `maxAgeMs` goes, and past
 * `maxCount` the oldest go first, but a receipt still `pending` and younger than `pendingGraceMs` is
 * never let go: its request may still be retried, and without it a retry would act twice.
 */
export interface ReceiptRetention<R> {
  readonly maxCount: number;
  readonly maxAgeMs: number;
  readonly pendingGraceMs: number;
  /** When the receipt was written, epoch ms. */
  readonly atOf: (receipt: R) => number;
  /** Whether the request behind the receipt has no final outcome yet. */
  readonly pending: (receipt: R) => boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The numbers every durable receipt store keeps to: a week, the newest thousand, a day for a pending one. */
export const DURABLE_RECEIPT_LIMITS = { maxCount: 1000, maxAgeMs: 7 * DAY_MS, pendingGraceMs: DAY_MS } as const;

/** `receipts` pruned by `policy` at `now`, in the order they came. */
export function retainReceipts<R>(receipts: readonly R[], policy: ReceiptRetention<R>, now: number): R[] {
  const guarded = (receipt: R): boolean => policy.pending(receipt) && now - policy.atOf(receipt) < policy.pendingGraceMs;
  const fresh = receipts.filter((receipt) => guarded(receipt) || now - policy.atOf(receipt) <= policy.maxAgeMs);
  if (fresh.length <= policy.maxCount) return fresh;
  const droppable = fresh.filter((receipt) => !guarded(receipt)).toSorted((a, b) => policy.atOf(a) - policy.atOf(b));
  const drop = new Set(droppable.slice(0, fresh.length - policy.maxCount));
  return fresh.filter((receipt) => !drop.has(receipt));
}

/** The record inside a parsed JSON value, or null when it is not one (a scalar, an array). */
function asJsonRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/** What one successful create left behind. */
export interface WorktreeReceipt {
  requestId: string;
  /** Epoch ms of the create. */
  at: number;
  workspaceId: string;
  paneId: string;
  /** The checkout path, as the multiplexer reported the new pane's cwd. */
  path: string;
  branch: string;
  launcherStarted: boolean;
}

/**
 * What a route needs of a receipt store: one stored receipt per request id, and the answer still
 * being worked out for an id. Generic so a launch (ADR 0091) keeps its receipts on the same pattern
 * a worktree create does, in a file of its own.
 */
export interface ReceiptSurface<R extends { requestId: string }, A> {
  /** The receipt stored under `requestId`, if any. */
  get(requestId: string): R | undefined;
  /** Store one receipt. Never throws: a failed write costs the replay, never the create. */
  record(receipt: R): Promise<void>;
  /** The answer a request with this id is still working on, if one is. */
  inflight(requestId: string): Promise<A> | undefined;
  /** Mark `answer` as the request in flight for `requestId` until it settles. */
  track(requestId: string, answer: Promise<A>): void;
}

/** What the worktree route needs of the store. `bridge/server.ts` holds this, never the class. */
export type WorktreeReceiptSurface = ReceiptSurface<WorktreeReceipt, WorktreeCreateResponse>;

/** One receipt read off disk, or `null` when the entry is not one. */
function coerceReceipt(raw: JsonValue): WorktreeReceipt | null {
  const r = asJsonRecord(raw);
  if (r === null) return null;
  const { requestId, at, workspaceId, paneId, path, branch, launcherStarted } = r;
  if (!isRequestId(requestId)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof workspaceId !== "string" || typeof paneId !== "string") return null;
  if (typeof path !== "string" || typeof branch !== "string") return null;
  if (typeof launcherStarted !== "boolean") return null;
  return { requestId, at, workspaceId, paneId, path, branch, launcherStarted };
}

/** The receipts a parsed file holds, oldest first, capped at `cap`, each read by `coerce`. */
export function coerceReceiptList<R>(raw: JsonValue, coerce: (entry: JsonValue) => R | null, cap: number = MAX_RECEIPTS): R[] {
  const list = asJsonRecord(raw)?.receipts;
  if (!Array.isArray(list)) return [];
  const out: R[] = [];
  for (const entry of list) {
    const receipt = coerce(entry);
    if (receipt !== null) out.push(receipt);
  }
  return out.slice(-cap);
}

/** The receipts a file holds, oldest first, capped. Anything that is not a receipt is dropped. */
export function coerceReceipts(raw: JsonValue): WorktreeReceipt[] {
  return coerceReceiptList(raw, coerceReceipt);
}

/** `receipts` with `receipt` appended (replacing an entry under the same id), capped oldest-first at `cap`. */
export function withReceipt<R extends { requestId: string }>(receipts: readonly R[], receipt: R, cap: number = MAX_RECEIPTS): R[] {
  const next = receipts.filter((r) => r.requestId !== receipt.requestId);
  next.push(receipt);
  return next.slice(-cap);
}

/**
 * The payload digest of each request still in flight, keyed on its promise. A second request with
 * the same id joins the first only when it asks for the same thing; the receipt on disk may not be
 * written yet, so the digest has to travel with the promise.
 */
const inflightDigests = new WeakMap<Promise<unknown>, string>();

/** Tie `digest` to an in-flight `answer`, before it is tracked. Returns `answer`. */
export function withDigest<A>(answer: Promise<A>, digest: string): Promise<A> {
  inflightDigests.set(answer, digest);
  return answer;
}

/** Whether an in-flight `answer` was asked with a different payload than `digest`. */
export function digestDiffers(answer: Promise<unknown>, digest: string): boolean {
  const known = inflightDigests.get(answer);
  return known !== undefined && known !== digest;
}

/** The in-flight half, shared by every store: it never touches a file. */
class Inflight<A> {
  private readonly running = new Map<string, Promise<A>>();

  get(requestId: string): Promise<A> | undefined {
    return this.running.get(requestId);
  }

  track(requestId: string, answer: Promise<A>): void {
    this.running.set(requestId, answer);
    const clear = () => {
      if (this.running.get(requestId) === answer) this.running.delete(requestId);
    };
    answer.then(clear, clear);
  }
}

/**
 * A file-backed receipt store. Writes are atomic and owner-only (a fresh 0600 temp file renamed over
 * the target, so a crash leaves the old file or the new one, never half of one) and queued, so two
 * requests finishing together cannot interleave their writes.
 */
export class ReceiptFileStore<R extends { requestId: string }, A> implements ReceiptSurface<R, A> {
  private receipts: R[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly running = new Inflight<A>();
  private readonly file: string;

  /**
   * `file` is the full path, built by the subclass so each names its own `<stateDir>` entry. With a
   * `retention`, the store keeps what it says instead of the newest {@link MAX_RECEIPTS}.
   */
  constructor(
    private readonly stateDir: string,
    file: string,
    private readonly coerce: (entry: JsonValue) => R | null,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
    private readonly tag = "receipts",
    private readonly retention: ReceiptRetention<R> | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.file = file;
  }

  /** Read the file once at start. A missing or broken file is an empty list, and nothing is written. */
  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; `coerce` checks every field.
      const raw = (await Bun.file(this.file).json()) as JsonValue;
      this.receipts = this.retention === null ? coerceReceiptList(raw, this.coerce) : this.retain(coerceReceiptList(raw, this.coerce, Number.POSITIVE_INFINITY));
    } catch {
      /* nothing recorded yet, or a file that is not JSON; asking must not create the file */
    }
  }

  /** The list with `receipt` in it, held to this store's limits. */
  private including(receipt: R, receipts: readonly R[] = this.receipts): R[] {
    if (this.retention === null) return withReceipt(receipts, receipt);
    return this.retain(withReceipt(receipts, receipt, Number.POSITIVE_INFINITY));
  }

  private retain(receipts: readonly R[]): R[] {
    return this.retention === null ? [...receipts] : retainReceipts(receipts, this.retention, this.now());
  }

  get(requestId: string): R | undefined {
    return this.receipts.find((r) => r.requestId === requestId);
  }

  async record(receipt: R): Promise<void> {
    this.receipts = this.including(receipt);
    try {
      await this.save();
    } catch (err) {
      // The thing exists; the receipt is a convenience for a retry. It stays in memory, so a retry
      // against this process still replays, and reaches disk with the next write that works.
      this.warn(`[${this.tag}] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Store one receipt and say whether it reached disk. For a route that writes its receipt BEFORE it
   * acts (ADR 0100): a failed write takes the receipt back out, so nothing is promised that a restart
   * would forget, and the caller sends nothing. `record` stays the call for a route that writes after.
   */
  async recordFirst(receipt: R): Promise<boolean> {
    const earlier = this.get(receipt.requestId);
    this.receipts = this.including(receipt);
    try {
      await this.save();
      return true;
    } catch (err) {
      const rest = this.receipts.filter((r) => r !== receipt);
      this.receipts = earlier === undefined ? rest : this.including(earlier, rest);
      this.warn(`[${this.tag}] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  inflight(requestId: string): Promise<A> | undefined {
    return this.running.get(requestId);
  }

  track(requestId: string, answer: Promise<A>): void {
    this.running.track(requestId, answer);
  }

  /** Queue one write of whatever the list holds when its turn comes. */
  private save(): Promise<void> {
    const run = this.queue.then(() => this.write());
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ receipts: this.receipts }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/** The worktree store `bridge/index.ts` builds once per bridge. */
export class WorktreeReceiptStore extends ReceiptFileStore<WorktreeReceipt, WorktreeCreateResponse> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line)) {
    super(stateDir, join(stateDir, RECEIPTS_FILE), coerceReceipt, warn, "worktree");
  }
}

/**
 * A store with no file: the default when the server is built without one, which is every test that
 * builds a server by hand. Replays work for the life of the process and are lost on restart.
 */
export function memoryReceipts<R extends { requestId: string }, A>(): ReceiptSurface<R, A> {
  let receipts: R[] = [];
  const running = new Inflight<A>();
  return {
    get: (requestId) => receipts.find((r) => r.requestId === requestId),
    record: (receipt) => {
      receipts = withReceipt(receipts, receipt);
      return Promise.resolve();
    },
    inflight: (requestId) => running.get(requestId),
    track: (requestId, answer) => running.track(requestId, answer),
  };
}

/** {@link memoryReceipts} for the worktree route. */
export function memoryWorktreeReceipts(): WorktreeReceiptSurface {
  return memoryReceipts<WorktreeReceipt, WorktreeCreateResponse>();
}
