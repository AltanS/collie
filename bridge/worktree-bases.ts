import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";

// ── Which ref each new worktree was cut from (ADR 0089, amended) ─────────────────────────────────
//
// A worktree made from the phone starts from a ref the operator chose: the repo's default branch or
// the branch of the pane they came from. A later step ("vs base" in Changes) will diff the worktree
// against that ref, and the checkout itself does not remember it, so the bridge writes it down at
// the moment it is known: after the multiplexer reported the create succeeded, and not before.
//
// ── WHAT IS STORED, AND WHAT IS NOT ─────────────────────────────────────────────
// Per checkout folder: the ref that was passed to the multiplexer and when. Nothing else, no branch
// name, no request id, no launcher. A create that sent no ref (no `base` in the body, or a repo with
// no default branch to name) stores nothing, because there is no base to remember.
//
// ── THE FILE ────────────────────────────────────────────────────────────────────
// `<stateDir>/worktree-bases.json`, 0600, `{ "version": 1, "bases": { "<folder>": { base, createdAt } } }`.
// Written atomically (a fresh temp file renamed over the target), queued so two creates finishing
// together cannot interleave, and only by a create: loading writes nothing, so a bridge nobody asks
// for a worktree writes no file at all (solo-baseline.test.ts counts the written entries). Read
// tolerantly: a missing, broken or foreign-version file is an empty map, and an entry that is not
// `{ base: string, createdAt: number }` is dropped. Nothing reads it yet.
//
// ── BOUNDED ─────────────────────────────────────────────────────────────────────
// At most {@link MAX_BASES}; the oldest `createdAt` goes first. A removed worktree leaves its entry
// behind until then, which costs a few bytes and answers nothing wrong: the folder is gone.

/** The most entries kept. A 501st drops the oldest. */
export const MAX_BASES = 500;

/** The file's name inside the state dir. */
export const BASES_FILE = "worktree-bases.json";

/** The file's schema version. A file with another number reads as empty rather than being guessed at. */
export const BASES_VERSION = 1;

/** What one create left behind. */
export interface WorktreeBase {
  /** The ref handed to the multiplexer as the new branch's starting point. */
  base: string;
  /** Epoch ms of the create. */
  createdAt: number;
}

/** The folder → base map, as a plain record. */
export type WorktreeBases = Record<string, WorktreeBase>;

/** What the route needs of the store. `bridge/server.ts` holds this, never the class. */
export interface WorktreeBaseSurface {
  /** The base stored for a checkout folder, if any. */
  get(folder: string): WorktreeBase | undefined;
  /** Remember `base` for `folder`. Never throws: a failed write costs the memory, never the create. */
  record(folder: string, base: WorktreeBase): Promise<void>;
}

/** The record inside a parsed JSON value, or null when it is not one (a scalar, an array). */
function asJsonRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/** One entry read off disk, or `null` when it is not one. */
function coerceBase(raw: JsonValue | undefined): WorktreeBase | null {
  const r = asJsonRecord(raw);
  if (r === null) return null;
  const { base, createdAt } = r;
  if (typeof base !== "string" || base === "") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { base, createdAt };
}

/** The entries a file holds. Anything that is not an entry is dropped; a foreign version is empty. */
export function coerceBases(raw: JsonValue): WorktreeBases {
  const file = asJsonRecord(raw);
  if (file === null || file.version !== BASES_VERSION) return {};
  const map = asJsonRecord(file.bases);
  if (map === null) return {};
  const out: WorktreeBases = {};
  for (const [folder, entry] of Object.entries(map)) {
    const base = coerceBase(entry);
    // `__proto__` would assign a prototype, not an entry; a checkout folder is never named that.
    if (folder !== "" && folder !== "__proto__" && base !== null) out[folder] = base;
  }
  return capBases(out);
}

/** `bases` with the oldest entries dropped past {@link MAX_BASES}. */
export function capBases(bases: WorktreeBases): WorktreeBases {
  const entries = Object.entries(bases);
  if (entries.length <= MAX_BASES) return bases;
  entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
  return Object.fromEntries(entries.slice(entries.length - MAX_BASES));
}

/** `bases` with `base` stored for `folder` (replacing an older entry for it), capped oldest-first. */
export function withBase(bases: WorktreeBases, folder: string, base: WorktreeBase): WorktreeBases {
  return capBases({ ...bases, [folder]: base });
}

/** The file-backed store `bridge/index.ts` builds once per bridge. */
export class WorktreeBaseStore implements WorktreeBaseSurface {
  private bases: WorktreeBases = {};
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(
    private readonly stateDir: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.file = join(stateDir, BASES_FILE);
  }

  /** Read the file once at start. A missing or broken file is an empty map, and nothing is written. */
  async load(): Promise<void> {
    try {
      // SAFETY: `Bun.file().json()` output IS a JsonValue by construction; coerceBases checks every field.
      this.bases = coerceBases((await Bun.file(this.file).json()) as JsonValue);
    } catch {
      /* nothing recorded yet, or a file that is not JSON; asking must not create the file */
    }
  }

  get(folder: string): WorktreeBase | undefined {
    return Object.hasOwn(this.bases, folder) ? this.bases[folder] : undefined;
  }

  async record(folder: string, base: WorktreeBase): Promise<void> {
    this.bases = withBase(this.bases, folder, base);
    try {
      await this.save();
    } catch (err) {
      // The worktree exists; the base is a note for a later view. It stays in memory and reaches
      // disk with the next write that works.
      this.warn(`[worktree] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Queue one write of whatever the map holds when its turn comes. */
  private save(): Promise<void> {
    const run = this.queue.then(() => this.write());
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: BASES_VERSION, bases: this.bases }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/**
 * A store with no file: the default when the server is built without one, which is every test that
 * builds a server by hand. Entries live for the life of the process.
 */
export function memoryWorktreeBases(): WorktreeBaseSurface {
  let bases: WorktreeBases = {};
  return {
    get: (folder) => (Object.hasOwn(bases, folder) ? bases[folder] : undefined),
    record: (folder, base) => {
      bases = withBase(bases, folder, base);
      return Promise.resolve();
    },
  };
}
