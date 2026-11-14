import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { LAUNCH_BUDGET_MS } from "./create-confirm.ts";
import type { CreateResponse } from "./types.ts";
import { type ForgettingReceiptSurface, isRequestId, memoryReceipts, ReceiptFileStore } from "./worktree-receipts.ts";

// ── One receipt per launch request, so a retried Start never opens a second pane (ADR 0091) ──────
//
// The worktree create's pattern (ADR 0089, `worktree-receipts.ts`), for `POST /api/launch`: the phone
// mints a UUID per intent, the bridge keeps the outcome of every launch that SUCCEEDED under it in
// `launch-receipts.json`, and a POST that names a known id gets the stored pane back with
// `replayed: true` and runs nothing. A launch still in flight is joined. A launch that failed stores
// nothing: its pane was closed again, so the same id may simply run again.
//
// A PENDING RECEIPT GOES FIRST (M100 spec 04). The receipt is written BEFORE the multiplexer is asked for
// the pane, as `pending`, and settles after: to the full receipt when the pane stands, to nothing when the
// create did not happen (the id may run again), and to `unknown` when the create may have made a pane that
// nobody could confirm. Without it, a bridge that stopped between the pane and its receipt left a pane no
// retry could find, and the retry made a second one. On start a pending receipt older than the launch
// budget ({@link LAUNCH_BUDGET_MS}) becomes `unknown`: its run is over, nothing can settle it, and no pane is
// closed or adopted on a guess. A retry of a `pending` or `unknown` id with no run in flight starts nothing
// and answers that the outcome is unknown (bridge/server.ts), which is what "never a second pane" means.
//
// Ids, the pane and space it made and the folder. No command line. Written on a launch with an id
// and on nothing else, so a bridge nobody launches on writes no file (solo-baseline.test.ts).

/** The receipt file's name inside the state dir. */
export const LAUNCH_RECEIPTS_FILE = "launch-receipts.json";

/** What one successful launch left behind. */
export interface LaunchReceipt {
  requestId: string;
  /** Epoch ms of the launch. */
  at: number;
  workspaceId: string;
  workspaceLabel: string;
  paneId: string;
  tabId: string;
  /** The folder the new pane opened in, as the multiplexer reported it. */
  cwd: string;
}

/**
 * A launch that has no pane to name: `pending` while its create runs (or ran, and the bridge stopped),
 * `unknown` once nothing can say whether it made one. Written by a bridge that knows this state; an older
 * bridge reads neither as a receipt, which costs the replay and nothing else.
 */
export interface LaunchUnsettled {
  requestId: string;
  /** Epoch ms the create began. */
  at: number;
  state: "pending" | "unknown";
  /**
   * The sentence an `unknown` launch ended with, when it is not {@link LAUNCH_UNKNOWN_TEXT}: a retap
   * answers the same words the first answer gave. Absent: the general sentence.
   */
  text?: string;
}

/** What one id holds: the pane a launch made, or the open question of one that has none to name. */
export type LaunchEntry = LaunchReceipt | LaunchUnsettled;

/** Whether `entry` is a launch with no pane to name. */
export function isUnsettled(entry: LaunchEntry): entry is LaunchUnsettled {
  return "state" in entry;
}

/**
 * What a launch answers when it cannot say whether a pane was made: the 504 shape of a forwarded write
 * the lead could not hear back (`write_outcome_unknown`, bridge/crew/forward.ts), so the phone reads one
 * rule for both. Never a second create under the same id.
 */
export interface LaunchUnknown {
  ok: false;
  code: "write_outcome_unknown";
  error: string;
}

/** What a launch, a tab create or a space create answers. */
export type LaunchAnswer = CreateResponse | LaunchUnknown;

/**
 * The sentence for a launch whose pane the look FOUND (a positive match by folder or label), and in which no
 * shell prompt showed inside the bound: the pane is there and nothing was typed. Only a launch that has a line
 * to type can end this way; a plain shell, a tab and a space type nothing and never read a prompt.
 */
export const LAUNCH_NO_PROMPT_TEXT = "The pane opened, but Collie could not see a shell prompt in it, so it typed nothing. Start the agent there yourself.";

/** The sentence a retry of an unsettled id answers, and the member's answer past its deadline. For a person on a phone. */
export const LAUNCH_UNKNOWN_TEXT = "Collie started this once and cannot tell if it worked. Check your panes before you start it again.";

/** What the launch route needs of the store. */
export type LaunchReceiptSurface = ForgettingReceiptSurface<LaunchEntry, LaunchAnswer>;

function asRecord(value: JsonValue): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** One receipt read off disk, or `null` when the entry is not one. A pane's receipt, or a launch with none ({@link LaunchUnsettled}). */
export function coerceLaunchReceipt(raw: JsonValue): LaunchEntry | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { requestId, at, workspaceId, workspaceLabel, paneId, tabId, cwd, state, text } = r;
  if (!isRequestId(requestId)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  // Only a sentence this build knows is read back: a file is not a source of words for the phone.
  if (state === "unknown" && text === LAUNCH_NO_PROMPT_TEXT) return { requestId, at, state, text };
  if (state === "pending" || state === "unknown") return { requestId, at, state };
  if (typeof workspaceId !== "string" || typeof workspaceLabel !== "string") return null;
  if (typeof paneId !== "string" || typeof tabId !== "string" || typeof cwd !== "string") return null;
  return { requestId, at, workspaceId, workspaceLabel, paneId, tabId, cwd };
}

/** The answer a replay gives: the pane the first request made. */
export function launchReplay(receipt: LaunchReceipt): CreateResponse {
  return {
    ok: true,
    replayed: true,
    pane: {
      paneId: receipt.paneId,
      workspaceId: receipt.workspaceId,
      workspaceLabel: receipt.workspaceLabel,
      tabId: receipt.tabId,
      cwd: receipt.cwd,
    },
  };
}

/** The file-backed store `bridge/index.ts` builds once per bridge. */
export class LaunchReceiptStore extends ReceiptFileStore<LaunchEntry, LaunchAnswer> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line)) {
    super(stateDir, join(stateDir, LAUNCH_RECEIPTS_FILE), coerceLaunchReceipt, warn, "launch");
  }

  /**
   * On start: a `pending` receipt older than the launch budget becomes `unknown`. Its create ended with
   * the process that ran it, whatever it made. Writes the file only when one changed; returns how many.
   */
  expirePending(now: number = Date.now()): Promise<number> {
    return this.amend((entry) =>
      isUnsettled(entry) && entry.state === "pending" && now - entry.at > LAUNCH_BUDGET_MS ? { ...entry, state: "unknown" } : entry,
    );
  }
}

/** A store with no file, for a server built without one. */
export function memoryLaunchReceipts(): LaunchReceiptSurface {
  return memoryReceipts<LaunchEntry, LaunchAnswer>();
}
