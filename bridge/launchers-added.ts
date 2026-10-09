import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { harnessLaunch } from "./harness-launch.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { buildRecipe, cleanLauncherText, MAX_COMMAND_CHARS, MAX_LABEL_CHARS, scanNoPrompts } from "./launcher-recipes.ts";
import { isRequestId } from "./worktree-receipts.ts";

// ── Launcher rows added from a phone, kept on THIS machine only (M48 spec 02, ADR 0094) ─────────
//
// `launchers.toml` is the operator's file and the bridge never writes it. A row a person adds from
// the phone lives here instead, in `<stateDir>/launchers-added.json`: one file per machine, never
// forwarded, never synced to another crew member. A `?host=` add lands in THAT machine's own file
// through the ordinary forward, and every bridge checks only its own list.
//
// ── EVERY ROW IS BELIEVED ONLY AFTER IT IS CHECKED AGAIN ────────────────────────────────────────
// A row read back from disk meets the same rule the add did (bridge/launcher-recipes.ts): the
// character rule on the line and the label, and for a recipe row, the line must still equal the
// line the bridge's table builds today. A hand-edited row that fails is dropped at read, alone.
//
// ── A BAD FILE READS AS EMPTY, AND IS NOT WRITTEN OVER ──────────────────────────────────────────
// Not JSON, not an object, or a version this build does not know: the list is empty, and a write is
// REFUSED until the operator moves the file away. A newer Collie's file must survive a downgrade, and
// a torn file is the operator's to look at, not the bridge's to replace with "nothing".
//
// ── THE FILE ────────────────────────────────────────────────────────────────────────────────────
// `{ "version": 1, "rows": [...] }`, owner-only (0600), written to a temp name unique to this write
// and renamed over the target, so a reader never sees half a file. At most {@link MAX_ADDED} rows.
// `collie devices revoke` edits the same file from another process, so the store re-reads it by
// mtime and every change is a read-modify-write of what is on disk now, one at a time.

/** The file's name inside the state dir. */
export const ADDED_FILE = "launchers-added.json";
/** The file's schema version. Another number reads as empty and refuses writes. */
export const ADDED_VERSION = 1;
/** The most rows one machine keeps. */
export const MAX_ADDED = 20;

/** One row a phone added. */
export interface AddedLauncher {
  /** The add's request id, and the row's id from then on. */
  id: string;
  /** An agent row names the harness that reads it; a command row is a plain line. */
  kind: "agent" | "command";
  /** The harness id, for an agent row. */
  harness?: string;
  /** Built from a recipe, or written as free text. */
  source: "recipe" | "text";
  /** The recipe's option ids, in table order. Recipe rows only. */
  options?: string[];
  /** The line typed into the new shell. Also the allowlist key `/api/launch` matches. */
  command: string;
  label: string;
  /** True when the line skips permission prompts (a chip said so, the scan found a flag, or a tick). */
  noPrompts: boolean;
  /** The pairing label of the device that added it. */
  device: string;
  /** `local` when the phone talked to this bridge, `crew` when the lead forwarded the add. */
  via: "local" | "crew";
  /** Epoch ms of the add. */
  at: number;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/**
 * One row read off disk, or `null` when it is not one. The whole add-time rule, again: a row is never
 * believed because it is in the file.
 */
export function coerceAddedRow(raw: JsonValue | undefined): AddedLauncher | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { id, kind, harness, source, options, command, label, noPrompts, device, via, at } = r;
  if (!isRequestId(id)) return null;
  if (kind !== "agent" && kind !== "command") return null;
  if (source !== "recipe" && source !== "text") return null;
  if (typeof command !== "string" || typeof label !== "string" || typeof noPrompts !== "boolean") return null;
  if (typeof device !== "string" || device === "" || (via !== "local" && via !== "crew")) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const line = cleanLauncherText(command, MAX_COMMAND_CHARS);
  const name = cleanLauncherText(label, MAX_LABEL_CHARS);
  if (!line.ok || !name.ok || line.text !== command || name.text !== label) return null;
  const row: AddedLauncher = { id, kind, source, command, label, noPrompts, device, via, at };
  if (kind === "agent") {
    if (typeof harness !== "string" || harnessLaunch(harness) === undefined) return null;
    row.harness = harness;
  } else if (harness !== undefined) {
    return null;
  }
  if (source === "recipe") {
    if (kind !== "agent" || !Array.isArray(options) || !options.every((o) => typeof o === "string")) return null;
    // SAFETY: every element was just checked to be a string.
    const picked = options as string[];
    const built = buildRecipe(row.harness ?? "", picked);
    // The table moved under the row (a flag renamed, a chip removed): the row no longer says what it
    // would type, so it goes. So does a row whose saved "no prompts" disagrees with the chips.
    if (!built.ok || built.command !== command || built.noPrompts !== noPrompts) return null;
    row.options = built.options;
  } else {
    if (options !== undefined) return null;
    // A free line the scan finds a no-prompts flag in can never be stored as "prompts".
    if (scanNoPrompts(command) && !noPrompts) return null;
  }
  return row;
}

/** What a parsed file holds, or `null` when it is not a file this build may write over. */
export function coerceAddedFile(raw: JsonValue): AddedLauncher[] | null {
  const file = asRecord(raw);
  if (file === null || file.version !== ADDED_VERSION || !Array.isArray(file.rows)) return null;
  const out: AddedLauncher[] = [];
  for (const entry of file.rows) {
    const row = coerceAddedRow(entry);
    if (row === null) continue;
    // One id and one line once each; the first wins, as it was the first added.
    if (out.some((r) => r.id === row.id || r.command === row.command)) continue;
    out.push(row);
  }
  return out.slice(0, MAX_ADDED);
}

/** What the routes need of the store. */
export interface AddedLauncherSurface {
  /** The rows on disk now. A missing or bad file is an empty list. */
  list(): Promise<AddedLauncher[]>;
  /** The row with this id, if any. */
  get(id: string): Promise<AddedLauncher | undefined>;
  /**
   * Add one row. A row under the same id answers `replayed`. The cap and a line already present are
   * refusals; so is a file this build may not write over.
   */
  add(row: AddedLauncher): Promise<AddOutcome>;
  /** Remove one row. `null` when there is no such row. */
  remove(id: string): Promise<AddedLauncher | null | "unwritable">;
  /** Rename one row. `null` when there is no such row. */
  rename(id: string, label: string): Promise<AddedLauncher | null | "unwritable">;
  /** Remove every row `drop` picks. Answers the rows it removed (empty when it could not write). */
  removeWhere(drop: (row: AddedLauncher) => boolean): Promise<AddedLauncher[]>;
}

export type AddOutcome =
  | { ok: true; row: AddedLauncher; replayed: boolean }
  | { ok: false; reason: "full" | "duplicate" | "unwritable" };

/** The disk half, kept behind an interface so the store is testable without the real state dir. */
export interface AddedFileIo {
  /** The file's mtime in ms, or null when it is absent. */
  mtime(): Promise<number | null>;
  /** The file's text, or null when it is absent. Throws on another read failure. */
  read(): Promise<string | null>;
  /** Replace the file atomically, owner-only. */
  write(text: string): Promise<void>;
}

/** The real io over `<stateDir>/launchers-added.json`. */
export function addedFileIo(stateDir: string): AddedFileIo {
  const file = join(stateDir, ADDED_FILE);
  let seq = 0;
  return {
    async mtime() {
      try {
        return (await stat(file)).mtimeMs;
      } catch {
        return null;
      }
    },
    async read() {
      try {
        return await readFile(file, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(text) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      // Unique per write: `collie devices revoke` may write this file from another process.
      const tmp = `${file}.${process.pid}.${++seq}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      try {
        await rename(tmp, file);
      } catch (err) {
        try {
          await unlink(tmp);
        } catch {
          /* already gone */
        }
        throw err;
      }
    },
  };
}

/** What one read of the file found. `rows: null` is a file this build may not write over. */
interface Loaded {
  rows: AddedLauncher[] | null;
}

/** Parse a file's text: `[]` for no file, `null` rows for one that is not ours to write. */
export function parseAddedText(text: string | null): Loaded {
  if (text === null) return { rows: [] };
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `coerceAddedFile` checks every field.
    return { rows: coerceAddedFile(JSON.parse(text) as JsonValue) };
  } catch {
    return { rows: null };
  }
}

/** The text a list of rows is written as. */
export function formatAddedFile(rows: readonly AddedLauncher[]): string {
  return `${JSON.stringify({ version: ADDED_VERSION, rows }, null, 2)}\n`;
}

/** The file-backed store `bridge/index.ts` builds once. */
export class AddedLauncherStore implements AddedLauncherSurface {
  private cache: { mtime: number | null; loaded: Loaded } | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly io: AddedFileIo,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** The file as it is now, behind an mtime check. */
  private async load(): Promise<Loaded> {
    const mtime = await this.io.mtime();
    if (this.cache !== null && this.cache.mtime === mtime && mtime !== null) return this.cache.loaded;
    let loaded: Loaded;
    try {
      loaded = parseAddedText(await this.io.read());
    } catch (err) {
      this.warn(`[launchers] could not read ${ADDED_FILE}: ${err instanceof Error ? err.message : String(err)}`);
      loaded = { rows: null };
    }
    if (loaded.rows === null && (this.cache === null || this.cache.mtime !== mtime)) {
      this.warn(`[launchers] ${ADDED_FILE} is not a version ${ADDED_VERSION} file: no phone-added rows, and none can be added until it is moved away`);
    }
    this.cache = { mtime, loaded };
    return loaded;
  }

  async list(): Promise<AddedLauncher[]> {
    return [...((await this.load()).rows ?? [])];
  }

  async get(id: string): Promise<AddedLauncher | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }

  /** Run one read-modify-write after every earlier one, on the file as it is when its turn comes. */
  private change<T>(edit: (rows: AddedLauncher[]) => { rows: AddedLauncher[] | null; answer: T }, unwritable: T): Promise<T> {
    const run = this.queue.then(async () => {
      // Always the disk, never the cache: another process may have written since the last look.
      this.cache = null;
      const { rows } = await this.load();
      if (rows === null) return unwritable;
      const out = edit(rows);
      if (out.rows !== null) {
        await this.io.write(formatAddedFile(out.rows));
        this.cache = null;
      }
      return out.answer;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  add(row: AddedLauncher): Promise<AddOutcome> {
    return this.change<AddOutcome>((rows) => {
      const same = rows.find((r) => r.id === row.id);
      if (same !== undefined) return { rows: null, answer: { ok: true, row: same, replayed: true } };
      if (rows.some((r) => r.command === row.command)) return { rows: null, answer: { ok: false, reason: "duplicate" } };
      if (rows.length >= MAX_ADDED) return { rows: null, answer: { ok: false, reason: "full" } };
      return { rows: [...rows, row], answer: { ok: true, row, replayed: false } };
    }, { ok: false, reason: "unwritable" });
  }

  remove(id: string): Promise<AddedLauncher | null | "unwritable"> {
    return this.change<AddedLauncher | null | "unwritable">((rows) => {
      const gone = rows.find((r) => r.id === id);
      if (gone === undefined) return { rows: null, answer: null };
      return { rows: rows.filter((r) => r.id !== id), answer: gone };
    }, "unwritable");
  }

  rename(id: string, label: string): Promise<AddedLauncher | null | "unwritable"> {
    return this.change<AddedLauncher | null | "unwritable">((rows) => {
      const at = rows.findIndex((r) => r.id === id);
      const old = rows[at];
      if (old === undefined) return { rows: null, answer: null };
      const renamed = { ...old, label };
      const next = [...rows];
      next[at] = renamed;
      return { rows: next, answer: renamed };
    }, "unwritable");
  }

  removeWhere(drop: (row: AddedLauncher) => boolean): Promise<AddedLauncher[]> {
    return this.change<AddedLauncher[]>((rows) => {
      const gone = rows.filter(drop);
      if (gone.length === 0) return { rows: null, answer: [] };
      return { rows: rows.filter((r) => !drop(r)), answer: gone };
    }, []);
  }
}

/** An in-memory io: the default for a server built without a state dir, which is every route test. */
export function memoryAddedIo(initial: string | null = null): AddedFileIo & { text: string | null; writes: number } {
  let tick = 0;
  const io = {
    text: initial,
    writes: 0,
    mtime: () => Promise.resolve(io.text === null ? null : tick),
    read: () => Promise.resolve(io.text),
    write: (text: string) => {
      io.text = text;
      io.writes++;
      tick++;
      return Promise.resolve();
    },
  };
  return io;
}

/** A store over {@link memoryAddedIo}. */
export function memoryAddedLaunchers(): AddedLauncherStore {
  return new AddedLauncherStore(memoryAddedIo(), () => {});
}
