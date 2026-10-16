import { join } from "node:path";

import type { AuditLog } from "./audit.ts";
import { apiError, type ErrorCode } from "./error-codes.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { MuxAdapter, MuxStarterOutcome, MuxStarters } from "./mux/types.ts";
import type { CreatedPane, CreateResponse, LauncherItem } from "./types.ts";
import {
  DURABLE_RECEIPT_LIMITS,
  digestDiffers,
  isRequestId,
  memoryReceipts,
  payloadDigest,
  ReceiptFileStore,
  type ReceiptRetention,
  type ReceiptSurface,
  withDigest,
} from "./worktree-receipts.ts";

// ── Starters as launcher rows (ADR 0102) ─────────────────────────────────────────────────────────
//
// A durable program offers a few named ways to begin a conversation. They ride the routes launchers
// already use: `GET /api/launchers` lists them as items beside the other rows, and `POST /api/launch`
// with `{ starter, requestId }` runs one. No second list, no second route.
//
// A STARTER TAKES NOTHING. The body is the starter's id and the phone's request id, and a body with
// anything else in it is refused before the program hears of it. The phone never sends a command
// line, a path or a prompt to run. (`noPrompts` is a different thing: it marks a line that skips an
// agent's permission prompts. A starter says nothing about those, so it never carries the badge.)
//
// THE RECEIPT COMES FIRST. The bridge writes `{ requestId, starterId, pane: null }` before the start
// leaves for the program, and the program's `paneId` completes it. A repeat of an id with a finished
// receipt answers the stored pane and calls nothing. An id whose receipt is still unfinished (the
// reply was lost, or the program did not answer) is NOT answered from the receipt: it runs again with
// the same id, and the program replays it (WIRE.md section 7.6). So "Try again" can never double-start.
//
// ONE REQUEST ID, ONE STARTER. The receipt keeps a digest of the starter id. The same request id for
// another starter is refused (409, the reason `request-id-reused`) and starts nothing. Receipts are
// kept a week, the newest thousand, and an unfinished one at least a day.
//
// This file is the whole of the bridge's starter path. A launcher row, a harness or a shell never
// comes through it, and `launch()` in server.ts hands over here on one test of the body.

/** The receipt file's name inside the state dir. */
export const STARTER_RECEIPTS_FILE = "starter-receipts.json";

/** What a start left behind. `pane` is null until the program has answered. */
export interface StarterReceipt {
  requestId: string;
  /** Epoch ms of the start. */
  at: number;
  starterId: string;
  /** {@link starterDigest} of the starter id, so another starter under the same request id is refused. */
  digest: string;
  pane: CreatedPane | null;
}

/** What one start asks for, as a digest. */
export function starterDigest(starterId: string): string {
  return payloadDigest(["starter", starterId]);
}

/** A week, the newest thousand, and an unfinished receipt kept for at least a day (ADR 0102). */
export const STARTER_RETENTION: ReceiptRetention<StarterReceipt> = {
  ...DURABLE_RECEIPT_LIMITS,
  atOf: (receipt) => receipt.at,
  pending: (receipt) => receipt.pane === null,
};

/** What the starter path needs of its store. */
export type StarterReceiptSurface = ReceiptSurface<StarterReceipt, CreateResponse>;

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function coercePane(raw: JsonValue | undefined): CreatedPane | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { paneId, workspaceId, workspaceLabel, tabId, cwd } = r;
  if (typeof paneId !== "string" || typeof workspaceId !== "string" || typeof workspaceLabel !== "string") return null;
  if (typeof tabId !== "string" || typeof cwd !== "string") return null;
  return { paneId, workspaceId, workspaceLabel, tabId, cwd };
}

/** One receipt read off disk, or `null` when the entry is not one. */
export function coerceStarterReceipt(raw: JsonValue): StarterReceipt | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { requestId, at, starterId, digest, pane } = r;
  if (!isRequestId(requestId)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof starterId !== "string") return null;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) return null;
  if (pane === null) return { requestId, at, starterId, digest, pane: null };
  const made = coercePane(pane);
  return made === null ? null : { requestId, at, starterId, digest, pane: made };
}

/** The file-backed store `bridge/index.ts` builds once per bridge. */
export class StarterReceiptStore extends ReceiptFileStore<StarterReceipt, CreateResponse> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line), now: () => number = Date.now) {
    super(stateDir, join(stateDir, STARTER_RECEIPTS_FILE), coerceStarterReceipt, warn, "starter", STARTER_RETENTION, now);
  }
}

/** A store with no file, for a server built without one. */
export function memoryStarterReceipts(): StarterReceiptSurface {
  return memoryReceipts<StarterReceipt, CreateResponse>();
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

/** The word in a row key when the program gave its machine no name. */
const NAMELESS_HOST = "program";

/**
 * The New page items for what a program offers: one per starter, in the program's order.
 *
 * The key is `starter:<machine>:<starter id>`: stable, and never equal to another machine's row. The
 * machine is the name the program gave its own host. On a lead, the rows of a member arrive through
 * the `?host=` forward of `GET /api/launchers`, so each machine answers for its own and the phone
 * tags them with the host it asked, as it does every per-machine row.
 */
export function starterItems(offered: MuxStarters): LauncherItem[] {
  const machine = offered.hostName === "" ? NAMELESS_HOST : offered.hostName;
  return offered.starters.map((starter) => ({
    key: `starter:${machine}:${starter.id}`,
    start: { starter: starter.id },
    group: "agents",
    label: starter.label === "" ? starter.id : starter.label,
    source: "program",
    noPrompts: false,
    takesPrompt: false,
    branch: false,
    available: true,
  }));
}

// ── The start ────────────────────────────────────────────────────────────────────────────────────

/** The keys a starter's body may carry. `cwd` is accepted and ignored: a starter has no folder. */
const STARTER_BODY_KEYS: ReadonlySet<string> = new Set(["starter", "requestId", "cwd"]);

/** What the starter path needs beyond the body. */
export interface StarterLaunch {
  mux: MuxAdapter;
  receipts: StarterReceiptSurface;
  audit: AuditLog;
  device: string | null;
  session: string;
  /** The response encoder of `bridge/server.ts`, so a reply is gzipped as every other one is. */
  json: (body: CreateResponse, status?: number) => Response;
  /** The plain-text refusal of `bridge/server.ts`. */
  text: (message: string, status: number) => Response;
}

/** Whether a launch body is a starter's. A body that names `starter` at all is, whatever else it names. */
export function isStarterBody(fields: JsonObject): boolean {
  return fields.starter !== undefined;
}

function refuse(job: StarterLaunch, code: ErrorCode, status: number, detail?: Record<string, string | number>): Response {
  return job.json({ ok: false, ...apiError(code, detail) }, status);
}

/** The refusal for a request id that already named another starter. */
const STARTER_ID_REUSED = "request-id-reused: this request id already started another starter";

/**
 * The answer an earlier request with this id gave, or the one it is still working on; `null` for a
 * new id; `"reused"` when that earlier request named another starter. SYNCHRONOUS.
 */
function earlierStart(receipts: StarterReceiptSurface, requestId: string, digest: string): Promise<CreateResponse> | "reused" | null {
  const stored = receipts.get(requestId);
  if (stored !== undefined && stored.digest !== digest) return "reused";
  if (stored?.pane) return Promise.resolve({ ok: true, replayed: true, pane: stored.pane });
  const running = receipts.inflight(requestId);
  if (running === undefined) return null;
  if (digestDiffers(running, digest)) return "reused";
  return running.then((answer) => (answer.ok ? { ...answer, replayed: true } : answer));
}

/**
 * `POST /api/launch` with `{ starter, requestId }`. The order is the safety:
 *
 *   1. the body holds only the starter and the request id (no text);
 *   2. a finished receipt, or a start in flight, answers without calling the program;
 *   3. the starter is on the program's own current list, else it is refused here;
 *   4. the receipt is written, THEN the program is called with the same request id.
 */
export async function launchStarter(fields: JsonObject, job: StarterLaunch): Promise<Response> {
  const stray = Object.keys(fields).find((key) => !STARTER_BODY_KEYS.has(key));
  if (stray !== undefined) return refuse(job, "launch.bad_line", 400, { problem: "a starter takes no text", max: 0 });
  const starterId = fields.starter;
  if (typeof starterId !== "string" || starterId === "") return job.text("bad body", 400);
  if (!isRequestId(fields.requestId)) return job.text("bad requestId", 400);
  const requestId = fields.requestId;
  const digest = starterDigest(starterId);
  const reused = (): Response => refuse(job, "workspace.create_failed", 409, { reason: STARTER_ID_REUSED });

  const replay = earlierStart(job.receipts, requestId, digest);
  if (replay === "reused") return reused();
  if (replay !== null) return job.json(await replay);

  const { mux } = job;
  if (mux.listStarters === undefined || mux.startStarter === undefined) return refuse(job, "launch.not_allowlisted", 400);
  const offered = await mux.listStarters();
  // A program that could not be asked has no list to check against. Nothing has reached it.
  if (!offered.reachable) return refuse(job, "workspace.create_failed", 503, { reason: "the durable agent cannot be reached" });
  if (!offered.starters.some((starter) => starter.id === starterId)) return refuse(job, "launch.not_allowlisted", 400);

  // Checked again with no await between it and `track`, so two requests with one id that both got
  // past the check above cannot both start.
  const again = earlierStart(job.receipts, requestId, digest);
  if (again === "reused") return reused();
  if (again !== null) return job.json(await again);

  const start = mux.startStarter.bind(mux);
  const work = (async (): Promise<StarterAnswer> => {
    // The receipt first (ADR 0102): it exists before the start leaves for the program.
    await job.receipts.record({ requestId, at: Date.now(), starterId, digest, pane: null });
    const outcome = await start(starterId, requestId);
    return answerFor(job, starterId, requestId, outcome);
  })();
  const settled = withDigest(work.then((done) => done.answer), digest);
  job.receipts.track(requestId, settled);
  const done = await work;
  return job.json(done.answer, done.status);
}

/** What the phone is told, and the status that says whether it may offer "Try again". */
interface StarterAnswer {
  answer: CreateResponse;
  status: number;
}

function failure(reason: string, status: number): StarterAnswer {
  return { answer: { ok: false, ...apiError("workspace.create_failed", { reason }) }, status };
}

/** The phone's answer for what the program did. */
async function answerFor(job: StarterLaunch, starterId: string, requestId: string, outcome: MuxStarterOutcome): Promise<StarterAnswer> {
  job.audit.record({
    action: "starter.start",
    session: job.session,
    device: job.device,
    detail: { starterId, requestId, outcome: outcome.kind },
  });
  switch (outcome.kind) {
    case "started": {
      const pane = await paneFor(job.mux, outcome.paneId);
      await job.receipts.record({ requestId, at: Date.now(), starterId, digest: starterDigest(starterId), pane });
      return { answer: outcome.replayed ? { ok: true, pane, replayed: true } : { ok: true, pane }, status: 200 };
    }
    // The program ran it and said no. Nothing was stored for the id, so the same id may run again.
    case "failed":
      return failure(outcome.message, 200);
    case "unsupported":
    case "refused":
      return failure(outcome.detail, 200);
    // Nothing reached the program.
    case "unreachable":
      return failure(outcome.detail, 503);
    // It may have run. The receipt stays unfinished, so "Try again" sends the same id and the program replays it.
    case "unknown":
      return failure(outcome.detail, 502);
  }
}

/** The pane a start made, as the multiplexer reports it now; the id alone when the census does not hold it yet. */
async function paneFor(mux: MuxAdapter, paneId: string): Promise<CreatedPane> {
  const snapshot = await mux.snapshot().catch(() => null);
  const found = snapshot?.panes.find((pane) => pane.paneId === paneId);
  if (found === undefined) return { paneId, workspaceId: "", workspaceLabel: "", tabId: "", cwd: "" };
  return { paneId, workspaceId: found.spaceId, workspaceLabel: found.spaceLabel, tabId: found.tabId, cwd: found.cwd };
}
