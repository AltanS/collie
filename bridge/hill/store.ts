// The decisions of the hill (M96), kept on the machine whose bridge took the post.
//
//   <stateDir>/hill/decisions.json
//   { "v": 1, "decisions": [ HillDecision, ... ] }
//
// Every open decision, plus the {@link HILL_CLOSED_KEPT} newest closed ones; an older closed one goes at
// the next write. The folder is 0700 and the file 0600, written whole to a temp file and renamed over
// the old one, so a crash leaves the old file or the new one. Nothing else in the state dir changes
// shape, and a build without the hill never looks in the folder. A decision's images live beside it in
// `media/<decision id>/` (media.ts) and go when it goes: `dropped` hears every id a write lets go.
//
// ONE WRITER, SYNCHRONOUS. The bridge is the only process that writes the file, and every write is
// `writeFileSync` then `renameSync` with no await between a read of memory and the write of the new
// list, so two requests never interleave.
//
// THE REVISION. A number that rides on the snapshot as `hillRev` and on `GET /api/hill` as `rev`, so the
// phone refetches the list when it moves. It starts at the clock when the file is read at boot and moves
// on every write. It is undefined until the file exists: a bridge that never took a post serves the
// same snapshot bytes as a build without the hill.
//
// A FILE THAT DOES NOT READ (not JSON, another version, not a list, a read the OS refused) is set aside
// as `decisions.json.bad-<ms>` and the store starts empty, with one warning. Such a store is not
// `cleanlyLoaded`, and the service then never prunes the image folders: the set-aside file may still
// name them, and the operator may put it back.
//
// CLEARED DECISIONS (the phone's and the CLI's Clear). A person may clear the closed ones: the decision
// and its images go, and a TOMBSTONE stays in the same file, under `cleared`: the id, the request id and
// sender key it was posted under, the post's digest, the state it closed in and when. It holds none of the
// person's or the agent's words. Two rules read it: a post that repeats a cleared request id is not taken
// a second time, and a late answer to a cleared id still reads `gone, the decision is <state>`, as it did
// before the clear. The trick map (tricks/hill.ts) reads the state too, so an answered key stays closed.
// The newest {@link HILL_CLEARED_KEPT} are kept. A build from before Clear reads the file without them.
//
// AN ENTRY THIS BUILD CANNOT READ (a newer build wrote it, before a rollback) is kept as the raw value
// it was, never listed and never served, and written back unchanged on every write, so a build that
// can read it finds it again after the next update. Its `id`, when it has a string one, stays taken.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { HILL_CLOSED_SERVED, HILL_STATES, type HillDecision, type HillList, type HillState } from "../../web/src/lib/hill/wire.ts";
import { readDecision } from "./parse.ts";

/** The hill's folder inside a state dir. */
export function hillDir(stateDir: string): string {
  return join(stateDir, "hill");
}

/** The decisions file's name inside the hill folder. */
export const DECISIONS_FILE = "decisions.json";

/** How many closed decisions the file keeps, newest first. Every open one is kept. */
export const HILL_CLOSED_KEPT = 100;

/** How many tombstones of cleared decisions the file keeps, newest last. */
export const HILL_CLEARED_KEPT = 500;

/** What stays of a cleared decision: enough to keep a retry and a trick's answered key as they were. */
export interface HillTombstone {
  readonly id: string;
  /** The request id the decision was posted under. */
  readonly requestId: string;
  /** The sender's key (an agent's walky address, or `trick:<id>`), as the service files decisions under it. */
  readonly key: string;
  /** The post's digest, or null for a decision stored before digests. */
  readonly digest: string | null;
  /** The closed state it was cleared in. */
  readonly state: Exclude<HillState, "open">;
  readonly closedAt: number;
}

function readTombstone(raw: JsonValue): HillTombstone | null {
  const row = asJsonObject(raw);
  const id = asJsonString(row?.id);
  const requestId = asJsonString(row?.requestId);
  const key = asJsonString(row?.key);
  const state = HILL_STATES.find((candidate) => candidate === asJsonString(row?.state));
  const closedAt = asJsonNumber(row?.closedAt);
  const digest = row?.digest === null ? null : asJsonString(row?.digest);
  if (id === undefined || requestId === undefined || key === undefined || state === undefined || state === "open" || closedAt === undefined || digest === undefined) return null;
  return { id, requestId, key, digest, state, closedAt };
}

/** When a closed decision closed, for its place among the closed. */
function closedOrder(decision: HillDecision): number {
  return decision.closedAt ?? decision.at;
}

/** Every open decision, then the newest closed ones up to the cap; accepted order, oldest first. */
export function pruned(decisions: readonly HillDecision[], keep = HILL_CLOSED_KEPT): HillDecision[] {
  const closed = decisions.filter((decision) => decision.state !== "open").toSorted((a, b) => closedOrder(b) - closedOrder(a));
  const kept = new Set(closed.slice(0, keep).map((decision) => decision.id));
  return decisions.filter((decision) => decision.state === "open" || kept.has(decision.id));
}

/** The `id` of a raw entry, when it has a string one; null when it has none this build can tell. */
function rawId(entry: JsonValue): string | null {
  return asJsonString(asJsonObject(entry)?.id) ?? null;
}

export class HillStore {
  private decisions: HillDecision[] = [];
  /** The entries this build could not read, as they were, in file order. Written back on every write. */
  private opaque: JsonValue[] = [];
  /** The tombstones of cleared decisions, oldest first. */
  private tombstones: HillTombstone[] = [];
  private revision: number | undefined;
  private readonly path: string | null;
  private clean = true;

  /**
   * `dir` null keeps the decisions in memory only (a test); the revision still moves. `dropped` hears
   * the ids of the decisions a write let go (an old closed one past the cap), after the write, so their
   * images go with them.
   */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
    private readonly dropped?: (ids: readonly string[]) => void,
  ) {
    this.path = dir === null ? null : join(dir, DECISIONS_FILE);
    this.load();
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    let raw: string | null;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      raw = null;
    }
    const file = raw === null ? undefined : parseJsonObject(raw);
    if (file?.v !== 1 || !Array.isArray(file.decisions)) {
      this.clean = false;
      this.setAside();
      return;
    }
    const read: HillDecision[] = [];
    const opaque: JsonValue[] = [];
    for (const entry of file.decisions) {
      // This bridge's own file: the one place a Decision of Collie's own reads (parse.ts `collie`).
      const decision = readDecision(entry, { collie: true });
      if (decision === null) opaque.push(entry);
      // A second entry under a held id is a duplicate this build wrote; the first one stands.
      else if (!read.some((held) => held.id === decision.id)) read.push(decision);
    }
    this.decisions = read;
    this.opaque = opaque;
    this.tombstones = Array.isArray(file.cleared) ? file.cleared.flatMap((entry) => readTombstone(entry) ?? []).slice(-HILL_CLEARED_KEPT) : [];
    this.revision = this.now();
  }

  /**
   * Whether the file read as a whole (or there was none): false after a file was set aside. The image
   * folders are then never pruned in this process, because a set-aside file may still name them.
   */
  cleanlyLoaded(): boolean {
    return this.clean;
  }

  /**
   * The decision ids whose image folders must stay: every held decision and every unread entry's id.
   * Null when an unread entry has no id this build can tell, or the file did not load cleanly: then
   * nothing may be pruned.
   */
  mediaKeep(): ReadonlySet<string> | null {
    if (!this.clean) return null;
    const keep = new Set(this.decisions.map((decision) => decision.id));
    for (const entry of this.opaque) {
      const id = rawId(entry);
      if (id === null) return null;
      keep.add(id);
    }
    return keep;
  }

  /** Whether `id` names a held decision or an unread entry, so a new decision must not take it. */
  taken(id: string): boolean {
    return this.get(id) !== undefined || this.tombstone(id) !== undefined || this.opaque.some((entry) => rawId(entry) === id);
  }

  /** The tombstone of a cleared decision by id. */
  tombstone(id: string): HillTombstone | undefined {
    return this.tombstones.find((stone) => stone.id === id);
  }

  /** The tombstone of a cleared decision a sender posted under this request id. */
  tombstoneOfRequest(requestId: string, key: string): HillTombstone | undefined {
    return this.tombstones.find((stone) => stone.requestId === requestId && stone.key === key);
  }

  /** Move a file that does not read out of the way, so the next write starts a good one. */
  private setAside(): void {
    if (this.path === null) return;
    const aside = `${this.path}.bad-${String(this.now())}`;
    try {
      renameSync(this.path, aside);
      this.warn(`[hill] ${this.path} did not read; set aside as ${aside}, starting with no decisions`);
    } catch (err) {
      this.warn(`[hill] ${this.path} did not read and could not be set aside: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The revision, or undefined while no decisions file exists. */
  rev(): number | undefined {
    return this.revision;
  }

  /** One decision by id. */
  get(id: string): HillDecision | undefined {
    return this.decisions.find((decision) => decision.id === id);
  }

  /** Every decision held, in accepted order. */
  all(): readonly HillDecision[] {
    return this.decisions;
  }

  /**
   * What `GET /api/hill` serves: every open decision, the {@link HILL_CLOSED_SERVED} newest closed,
   * newest first, and how many closed ones the store holds (`closedTotal`, for the phone's Clear). Rev 0 while no file exists: the phone then shows an empty hill.
   */
  list(): HillList {
    const open = this.decisions.filter((decision) => decision.state === "open");
    const allClosed = this.decisions.filter((decision) => decision.state !== "open").toSorted((a, b) => closedOrder(b) - closedOrder(a));
    const closed = allClosed.slice(0, HILL_CLOSED_SERVED);
    return { rev: this.revision ?? 0, open, closed, closedTotal: allClosed.length };
  }

  /**
   * Store decisions, each new or replacing the one with its id, in one write. False when the write
   * failed: memory stays as it was, so nothing is claimed that a restart would lose.
   */
  put(...changed: HillDecision[]): boolean {
    let next = [...this.decisions];
    for (const decision of changed) {
      const at = next.findIndex((held) => held.id === decision.id);
      if (at < 0) next.push(decision);
      else next = next.with(at, decision);
    }
    next = pruned(next);
    if (!this.write(next)) return false;
    const kept = new Set(next.map((decision) => decision.id));
    const gone = this.decisions.filter((decision) => !kept.has(decision.id)).map((decision) => decision.id);
    this.decisions = next;
    this.revision = Math.max((this.revision ?? 0) + 1, this.now());
    if (gone.length > 0) this.dropped?.(gone);
    return true;
  }

  /**
   * Remove closed decisions and keep a tombstone for each, in one write. An id that is not held, or is
   * open, is left alone: the store never drops an open decision this way. Answers the ids it removed, or
   * null when the write failed (memory stays as it was). The images go with them, as with an old closed one.
   */
  forget(stones: readonly HillTombstone[]): string[] | null {
    const removable = new Set(stones.filter((stone) => this.decisions.some((held) => held.id === stone.id && held.state !== "open")).map((stone) => stone.id));
    if (removable.size === 0) return [];
    const next = this.decisions.filter((held) => !removable.has(held.id));
    const marked = [...this.tombstones.filter((old) => !removable.has(old.id)), ...stones.filter((stone) => removable.has(stone.id))].slice(-HILL_CLEARED_KEPT);
    if (!this.write(next, marked)) return null;
    this.decisions = next;
    this.tombstones = marked;
    this.revision = Math.max((this.revision ?? 0) + 1, this.now());
    const gone = [...removable];
    this.dropped?.(gone);
    return gone;
  }

  private write(decisions: readonly HillDecision[], tombstones: readonly HillTombstone[] = this.tombstones): boolean {
    if (this.path === null || this.dir === null) return true;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      // The entries this build could not read go back as they came, after the ones it can.
      writeFileSync(temp, `${JSON.stringify(tombstones.length === 0 ? { v: 1, decisions: [...decisions, ...this.opaque] } : { v: 1, decisions: [...decisions, ...this.opaque], cleared: tombstones })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
      return true;
    } catch (err) {
      this.warn(`[hill] could not save ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
