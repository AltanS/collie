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
// after {@link HOLD_ENDED_KEEP_MS}, and a pane keeps at most {@link HOLD_ENDED_PANE_MAX} of them.
//
// The text is kept on disk in plain form (the file is 0600): the bridge must type it later. So the
// store bounds it: a pane waits on at most {@link HOLD_PANE_MAX} requests and the bridge on
// {@link HOLD_BRIDGE_MAX}, and on boot a file it cannot read and a `.tmp` leftover of a write cut short
// are deleted.
//
// A send its caller marks `draftHolds` (a walky talky delivery, M62 spec 02) is also held over a draft,
// and its caller names the hold's end (`expiresAt`), so one clock runs for it. Its file then carries
// what holds it now (`cause`), rewritten by the poll when that changes, so the caller can say why.
//
// No harness name lives here (bridge/surface/no-harness-names.test.ts scans this folder).

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { REQUEST_ID, SEND_MODES, SEND_OUTCOMES, SEND_REASONS, type HeldRow, type HeldState, type SendMode, type SendOutcome, type SendReason } from "../../web/src/lib/surface/send.ts";

/** How long a text stays held before it ends `expired` (decision 4). */
export const HOLD_MS = 30 * 60 * 1000;
/** How long a command stays held before it ends `expired`: a command acts on the session as it is, so it goes stale sooner. */
export const HOLD_COMMAND_MS = 10 * 60 * 1000;
/** How long an ended request keeps its text for the phone's Resend, when nobody dismisses it. */
export const HOLD_ENDED_KEEP_MS = 60 * 60 * 1000;
/** The most ended rows one pane keeps; the oldest go first. */
export const HOLD_ENDED_PANE_MAX = 50;
/** The most held requests one pane may queue. A send past it is refused `busy`, never dropped. */
export const HOLD_PANE_MAX = 32;
/** The most held requests the whole bridge may queue. A send past it is refused `busy`, never dropped. */
export const HOLD_BRIDGE_MAX = 256;

const HELD_STATES = ["held", "running", "ended"] as const satisfies readonly HeldState[];

/** What holds a marked request now: a draft in the box, or a turn (or anything else the box waits on). */
export type HoldCause = "draft_present" | "turn_running";
const HOLD_CAUSES = ["draft_present", "turn_running"] as const satisfies readonly HoldCause[];

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
  /**
   * A command whose keys could steer a turn (its Enter steers on this harness, or the version was not
   * read): it goes out only after a poll read a running turn and then a free pane, never on quiet polls.
   */
  readonly waitsForTurn?: true;
  /** The caller asked for a draft to hold this request, not refuse it (see the header). */
  readonly draftHolds?: true;
  /** On a {@link draftHolds} request: what holds it now. */
  readonly cause?: HoldCause;
}

export interface HoldInput {
  readonly id: string;
  readonly session: string;
  readonly paneId: string;
  readonly harness: string;
  readonly mode: SendMode;
  readonly text: string;
  readonly revision: number;
  /** A command (a command mode, or a text with a reserved lead): it expires after {@link HOLD_COMMAND_MS}. */
  readonly command: boolean;
  /** See {@link HeldEntry.waitsForTurn}. */
  readonly waitsForTurn?: boolean;
  /** See {@link HeldEntry.draftHolds}. */
  readonly draftHolds?: boolean;
  /** See {@link HeldEntry.cause}; kept only with {@link draftHolds}. */
  readonly cause?: HoldCause;
  /** The caller's own end of the hold, epoch ms: it replaces {@link HOLD_MS} and {@link HOLD_COMMAND_MS}. */
  readonly expiresAt?: number;
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
  if (node.waitsForTurn === true) entry = { ...entry, waitsForTurn: true };
  if (node.draftHolds === true) {
    entry = { ...entry, draftHolds: true };
    const cause = pick(node.cause, HOLD_CAUSES);
    if (cause !== undefined) entry = { ...entry, cause };
  }
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
    // Replayed on boot: every file this module wrote comes back in its order. A `.tmp` leftover of a
    // write cut short, and a file that does not read back as an entry, are deleted: both hold text.
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json.tmp")) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
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
      if (entry === null || entry.id !== stem) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
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
    const { command, waitsForTurn, draftHolds, cause, expiresAt, ...rest } = input;
    let entry: HeldEntry = { ...rest, heldAt: at, expiresAt: expiresAt ?? at + (command ? HOLD_COMMAND_MS : HOLD_MS), seq: this.nextSeq++, state: "held", tries: 0 };
    if (waitsForTurn === true) entry = { ...entry, waitsForTurn: true };
    if (draftHolds === true) entry = cause === undefined ? { ...entry, draftHolds: true } : { ...entry, draftHolds: true, cause };
    return this.write(entry);
  }

  /** What holds a marked request now: the file is written only when it changed. Null when not held or not marked. */
  setCause(id: string, cause: HoldCause): HeldEntry | null {
    const known = this.get(id);
    if (known === null || known.state === "ended" || known.draftHolds !== true) return null;
    return known.cause === cause ? known : this.write({ ...known, cause });
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

  /** How many requests wait or go out over the whole bridge. */
  waitingCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.state !== "ended") n++;
    return n;
  }

  /** The release starts: the file says so before the request runs, so a crash in between is seen on boot. */
  markRunning(id: string): HeldEntry | null {
    const known = this.get(id);
    if (known === null || known.state !== "held") return null;
    return this.write({ ...known, state: "running" });
  }

  /**
   * A release that met a pane not ready yet goes back to its place in the queue (its `seq` is kept).
   * `counted` false puts it back without spending a try: a wait the screen asks for, not a failure.
   */
  putBack(id: string, counted = true): HeldEntry | null {
    const known = this.get(id);
    if (known === null || known.state === "ended") return null;
    return this.write({ ...known, state: "held", tries: counted ? known.tries + 1 : known.tries });
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

  /** Ended entries past their keep window go, and past {@link HOLD_ENDED_PANE_MAX} per pane the oldest. Returns how many. */
  prune(keepMs = HOLD_ENDED_KEEP_MS): number {
    const now = this.now();
    let dropped = 0;
    const kept = new Map<string, HeldEntry[]>();
    for (const entry of this.list()) {
      if (entry.state !== "ended") continue;
      if (now - (entry.endedAt ?? entry.heldAt) > keepMs) {
        if (this.remove(entry.id)) dropped++;
        continue;
      }
      const key = `${entry.session}\u0000${entry.paneId}`;
      const rows = kept.get(key);
      if (rows === undefined) kept.set(key, [entry]);
      else rows.push(entry);
    }
    for (const rows of kept.values()) {
      const byEnd = rows.toSorted((a, b) => (a.endedAt ?? a.heldAt) - (b.endedAt ?? b.heldAt));
      for (const entry of byEnd.slice(0, Math.max(0, byEnd.length - HOLD_ENDED_PANE_MAX))) if (this.remove(entry.id)) dropped++;
    }
    return dropped;
  }
}
