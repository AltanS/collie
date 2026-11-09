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
// A FILE THAT DOES NOT READ (not JSON, another version, not a list) is set aside as
// `decisions.json.bad-<ms>` and the store starts empty, with one warning. A single entry that fails its
// reader is dropped at the next write.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonObject } from "../../web/src/lib/json.ts";
import { HILL_CLOSED_SERVED, type HillDecision, type HillList } from "../../web/src/lib/hill/wire.ts";
import { readDecision } from "./parse.ts";

/** The hill's folder inside a state dir. */
export function hillDir(stateDir: string): string {
  return join(stateDir, "hill");
}

/** The decisions file's name inside the hill folder. */
export const DECISIONS_FILE = "decisions.json";

/** How many closed decisions the file keeps, newest first. Every open one is kept. */
export const HILL_CLOSED_KEPT = 100;

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

export class HillStore {
  private decisions: HillDecision[] = [];
  private revision: number | undefined;
  private readonly path: string | null;

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
      this.setAside();
      return;
    }
    const read: HillDecision[] = [];
    for (const entry of file.decisions) {
      const decision = readDecision(entry);
      if (decision !== null && !read.some((held) => held.id === decision.id)) read.push(decision);
    }
    this.decisions = read;
    this.revision = this.now();
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
   * newest first. Rev 0 while no file exists: the phone then shows an empty hill.
   */
  list(): HillList {
    const open = this.decisions.filter((decision) => decision.state === "open");
    const closed = this.decisions
      .filter((decision) => decision.state !== "open")
      .toSorted((a, b) => closedOrder(b) - closedOrder(a))
      .slice(0, HILL_CLOSED_SERVED);
    return { rev: this.revision ?? 0, open, closed };
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

  private write(decisions: readonly HillDecision[]): boolean {
    if (this.path === null || this.dir === null) return true;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, decisions })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
      return true;
    } catch (err) {
      this.warn(`[hill] could not save ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
