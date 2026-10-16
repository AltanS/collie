// The held send (M56 spec 15): a send the harness cannot take while its turn runs is held by Collie
// and sent once the pane reads free, the way a terminal queues it. This module is the queue on disk;
// the Send Protocol (protocol.ts) decides what is held, releases it and settles its receipt.
//
// One JSON file per held request under `<stateDir>/held/`, written before the answer goes back, so a
// restart replays the queue. A pane's queue is its held files in order of `seq`, oldest first. A file
// holds the text, unlike a request file (requests.ts): the bridge must type it later, and the phone
// shows it in the queued row. The directory is 0700 and each file 0600, like the request files.
//
// A file lives through three states: `held` (waiting for a free pane), `running` (going out now, as a
// fresh run of the protocol under the same request id) and `ended` (closed without reaching the agent:
// expired, the pane gone, or a refusal at release; the text stays for the phone's Resend). A send that
// went out, and a cancelled one, leave no file. An ended file goes when the person dismisses it, or
// after {@link HOLD_ENDED_KEEP_MS}.
//
// No harness name lives here (bridge/surface/no-harness-names.test.ts scans this folder).

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { REQUEST_ID, SEND_MODES, SEND_OUTCOMES, SEND_REASONS, type HeldRow, type HeldState, type SendMode, type SendOutcome, type SendReason } from "../../web/src/lib/surface/send.ts";

/** How long a request stays held before it ends `expired` (decision 4). */
export const HOLD_MS = 30 * 60 * 1000;
/** How long an ended request keeps its text for the phone's Resend, when nobody dismisses it. */
export const HOLD_ENDED_KEEP_MS = 24 * 60 * 60 * 1000;
/** The most held requests one pane may queue. A send past it is refused `busy`, never dropped. */
export const HOLD_PANE_MAX = 32;

const HELD_STATES = ["held", "running", "ended"] as const satisfies readonly HeldState[];

/** One held request on disk. */
export interface HeldEntry {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  /** The agent string the pane carried at hold time: the release picks the profile by it. */
  readonly harness: string;
  readonly mode: SendMode;
  readonly text: string;
  readonly revision: number;
  readonly heldAt: number;
  readonly expiresAt: number;
  /** The queue order, over the whole store: a later hold has a larger number. */
  readonly seq: number;
  readonly state: HeldState;
  /** Releases that met a pane not ready yet (another send's lock, a turn that started again) and went back. */
  readonly tries: number;
  readonly outcome?: SendOutcome;
  readonly reason?: SendReason;
  readonly endedAt?: number;
}

export interface HoldInput {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly harness: string;
  readonly mode: SendMode;
  readonly text: string;
  readonly revision: number;
}

function pick<const T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((word) => word === value);
}

/** An entry read back from its file, every field checked; null when it is not one this module wrote. */
function parseEntry(raw: JsonValue | undefined): HeldEntry | null {
  const node = asJsonObject(raw);
  if (node === undefined) return null;
  const id = asJsonString(node.id);
  const session = asJsonString(node.session);
  const paneId = asJsonString(node.paneId);
  const harness = asJsonString(node.harness);
  const mode = pick(node.mode, SEND_MODES);
  const text = asJsonString(node.text);
  const revision = asJsonNumber(node.revision);
  const heldAt = asJsonNumber(node.heldAt);
  const expiresAt = asJsonNumber(node.expiresAt);
  const seq = asJsonNumber(node.seq);
  const state = pick(node.state, HELD_STATES);
  const tries = asJsonNumber(node.tries) ?? 0;
  if (id === undefined || !REQUEST_ID.test(id) || session === undefined || paneId === undefined || harness === undefined) return null;
  if (mode === undefined || text === undefined || revision === undefined || heldAt === undefined || expiresAt === undefined || seq === undefined || state === undefined) return null;
  let entry: HeldEntry = { id, session, paneId, harness, mode, text, revision, heldAt, expiresAt, seq, state, tries };
  const outcome = node.outcome === undefined ? undefined : pick(node.outcome, SEND_OUTCOMES);
  const reason = node.reason === undefined ? undefined : pick(node.reason, SEND_REASONS);
  const endedAt = asJsonNumber(node.endedAt);
  if (outcome !== undefined) entry = { ...entry, outcome };
  if (reason !== undefined) entry = { ...entry, reason };
  if (endedAt !== undefined) entry = { ...entry, endedAt };
  return entry;
}

/** The phone's row for an entry: what the composer's queued row shows. */
export function heldRow(entry: HeldEntry): HeldRow {
  let row: HeldRow = { requestId: entry.id, mode: entry.mode, text: entry.text, heldAt: entry.heldAt, expiresAt: entry.expiresAt, state: entry.state };
  if (entry.outcome !== undefined) row = { ...row, outcome: entry.outcome };
  if (entry.reason !== undefined) row = { ...row, reason: entry.reason };
  return row;
}

/** The queue of held requests, one file per request, for the whole bridge. */
export class HoldStore {
  private readonly entries = new Map<string, HeldEntry>();
  private nextSeq = 1;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Replayed on boot: every file this module wrote comes back in its order.
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const stem = name.slice(0, -".json".length);
      if (!REQUEST_ID.test(stem)) continue;
      let entry: HeldEntry | null = null;
      try {
        // SAFETY: `JSON.parse` output IS a JsonValue; `parseEntry` checks every field.
        entry = parseEntry(JSON.parse(readFileSync(join(dir, name), "utf8")) as JsonValue);
      } catch {
        entry = null;
      }
      if (entry === null || entry.id !== stem) continue;
      this.entries.set(entry.id, entry);
      this.nextSeq = Math.max(this.nextSeq, entry.seq + 1);
    }
  }

  private path(id: string): string {
    if (!REQUEST_ID.test(id)) throw new Error(`not a request id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private write(entry: HeldEntry): HeldEntry {
    const target = this.path(entry.id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** A new request at the end of its pane's queue. */
  add(input: HoldInput): HeldEntry {
    const at = this.now();
    return this.write({ ...input, heldAt: at, expiresAt: at + HOLD_MS, seq: this.nextSeq++, state: "held", tries: 0 });
  }

  get(id: string): HeldEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** Every entry, in queue order; with a session and a pane, only that pane's. */
  list(session?: string, paneId?: string): HeldEntry[] {
    return [...this.entries.values()]
      .filter((entry) => (session === undefined || entry.session === session) && (paneId === undefined || entry.paneId === paneId))
      .toSorted((a, b) => a.seq - b.seq);
  }

  /** The requests still waiting or going out on a pane: what a new send joins the end of. */
  waiting(session: string, paneId: string): HeldEntry[] {
    return this.list(session, paneId).filter((entry) => entry.state !== "ended");
  }

  /** The release starts: the file says so before the request runs, so a crash in between is seen on boot. */
  markRunning(id: string): HeldEntry | null {
    const known = this.get(id);
    if (known === null || known.state !== "held") return null;
    return this.write({ ...known, state: "running" });
  }

  /** A release that met a pane not ready yet goes back to its place in the queue (its `seq` is kept). */
  putBack(id: string): HeldEntry | null {
    const known = this.get(id);
    if (known === null || known.state === "ended") return null;
    return this.write({ ...known, state: "held", tries: known.tries + 1 });
  }

  /** The request closed without reaching the agent: the text stays for the phone's Resend. */
  end(id: string, outcome: SendOutcome, reason?: SendReason): HeldEntry | null {
    const known = this.get(id);
    if (known === null) return null;
    const { reason: _old, ...rest } = known;
    const ended: HeldEntry = { ...rest, state: "ended", outcome, endedAt: this.now() };
    return this.write(reason === undefined ? ended : { ...ended, reason });
  }

  /** The file goes: a send that went out, a cancel, or a dismissed end. */
  remove(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    rmSync(this.path(id), { force: true });
    return true;
  }

  /** Ended entries past their keep window go. Returns how many. */
  prune(keepMs = HOLD_ENDED_KEEP_MS): number {
    const now = this.now();
    let dropped = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "ended" && now - (entry.endedAt ?? entry.heldAt) > keepMs && this.remove(entry.id)) dropped++;
    }
    return dropped;
  }
}
