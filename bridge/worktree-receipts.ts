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

/** What the route needs of the store. `bridge/server.ts` holds this, never the class. */
export interface WorktreeReceiptSurface {
  /** The receipt stored under `requestId`, if any. */
  get(requestId: string): WorktreeReceipt | undefined;
  /** Store one receipt. Never throws: a failed write costs the replay, never the create. */
  record(receipt: WorktreeReceipt): Promise<void>;
  /** The answer a create with this id is still working on, if one is. */
  inflight(requestId: string): Promise<WorktreeCreateResponse> | undefined;
  /** Mark `answer` as the create in flight for `requestId` until it settles. */
  track(requestId: string, answer: Promise<WorktreeCreateResponse>): void;
}

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

/** The receipts a file holds, oldest first, capped. Anything that is not a receipt is dropped. */
export function coerceReceipts(raw: JsonValue): WorktreeReceipt[] {
  const list = asJsonRecord(raw)?.receipts;
  if (!Array.isArray(list)) return [];
  const out: WorktreeReceipt[] = [];
  for (const entry of list) {
    const receipt = coerceReceipt(entry);
    if (receipt !== null) out.push(receipt);
  }
  return out.slice(-MAX_RECEIPTS);
}

/** `receipts` with `receipt` appended (replacing an entry under the same id), capped oldest-first. */
export function withReceipt(receipts: readonly WorktreeReceipt[], receipt: WorktreeReceipt): WorktreeReceipt[] {
  const next = receipts.filter((r) => r.requestId !== receipt.requestId);
  next.push(receipt);
  return next.slice(-MAX_RECEIPTS);
}

/** The in-flight half, shared by both stores: it never touches a file. */
class Inflight {
  private readonly running = new Map<string, Promise<WorktreeCreateResponse>>();

  get(requestId: string): Promise<WorktreeCreateResponse> | undefined {
    return this.running.get(requestId);
  }

  track(requestId: string, answer: Promise<WorktreeCreateResponse>): void {
    this.running.set(requestId, answer);
    const clear = () => {
      if (this.running.get(requestId) === answer) this.running.delete(requestId);
    };
    answer.then(clear, clear);
  }
}

/**
 * The file-backed store `bridge/index.ts` builds once per bridge.
 *
 * Writes are atomic and owner-only (a fresh 0600 temp file renamed over the target) and queued, so
 * two creates finishing together cannot interleave their writes.
 */
export class WorktreeReceiptStore implements WorktreeReceiptSurface {
  private receipts: WorktreeReceipt[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly running = new Inflight();
  private readonly file: string;

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.file = join(stateDir, RECEIPTS_FILE);
  }

  /** Read the file once at start. A missing or broken file is an empty list, and nothing is written. */
  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; coerceReceipts checks every field.
      this.receipts = coerceReceipts((await Bun.file(this.file).json()) as JsonValue);
    } catch {
      /* nothing recorded yet, or a file that is not JSON; asking must not create the file */
    }
  }

  get(requestId: string): WorktreeReceipt | undefined {
    return this.receipts.find((r) => r.requestId === requestId);
  }

  async record(receipt: WorktreeReceipt): Promise<void> {
    this.receipts = withReceipt(this.receipts, receipt);
    try {
      await this.save();
    } catch (err) {
      // The worktree exists; the receipt is a convenience for a retry. It stays in memory, so a
      // retry against this process still replays, and reaches disk with the next write that works.
      this.warn(`[worktree] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  inflight(requestId: string): Promise<WorktreeCreateResponse> | undefined {
    return this.running.get(requestId);
  }

  track(requestId: string, answer: Promise<WorktreeCreateResponse>): void {
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

/**
 * A store with no file: the default when the server is built without one, which is every test that
 * builds a server by hand. Replays work for the life of the process and are lost on restart.
 */
export function memoryWorktreeReceipts(): WorktreeReceiptSurface {
  let receipts: WorktreeReceipt[] = [];
  const running = new Inflight();
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
