import { isAbsolute, join } from "node:path";

import type { AuditLog } from "./audit.ts";
import { apiError } from "./error-codes.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { cleanLauncherText, isForbiddenCodePoint, MAX_COMMAND_CHARS, MAX_LABEL_CHARS, scanNoPrompts } from "./launcher-recipes.ts";
import { memoryAddedIo, stateFileIo, type AddedFileIo } from "./launchers-added.ts";
import type { RecentRunWire, RecentRunsResponse } from "./types.ts";

// ── The one-off commands a phone ran on THIS machine, newest first (ADR 0095) ────────────────────
//
// `POST /api/launch` with `{ run }` types a line the person wrote into a fresh shell. After a run
// that worked, the line lands here, in `<stateDir>/commands-recent.json`, so the New page can offer
// it again. One file per machine: a `?host=` run records on THAT member, through the ordinary
// forward, and nothing is ever copied to another machine.
//
// ── AN ENTRY IS A LINE, NOT A GRANT ─────────────────────────────────────────────────────────────
// Running an entry again is just another one-off run, through the same route and the same gates: a
// paired device, the write gate, and the operator's `[phone] run` switch. So the history holds no
// permission of its own, and a revoke does not touch it (ADR 0095).
//
// ── EVERY ENTRY IS CHECKED AGAIN AT READ ────────────────────────────────────────────────────────
// The run's own character rule (bridge/launcher-recipes.ts) on the line, and an absolute folder or
// none. An entry that fails is dropped alone, so a hand edit can never offer a line no run accepted.
//
// ── A BAD FILE READS AS EMPTY, AND IS NOT WRITTEN OVER ──────────────────────────────────────────
// As `launchers-added.json` (ADR 0094): not JSON, not an object, or another version, and the list is
// empty and every write is refused until the operator moves the file away. A newer Collie's file
// survives a downgrade. A run itself still works; only its record is skipped, with a warning.
//
// ── THE FILE ────────────────────────────────────────────────────────────────────────────────────
// `{ "version": 1, "entries": [...] }`, owner-only (0600), written to a temp name unique to the write
// and renamed over the target. At most {@link MAX_RECENT} entries, newest first, one per exact line:
// a line run again moves to the top.

/** The file's name inside the state dir. */
export const RECENT_FILE = "commands-recent.json";
/** The file's schema version. Another number reads as empty and refuses writes. */
export const RECENT_VERSION = 1;
/** The most entries one machine keeps. */
export const MAX_RECENT = 12;
/** The longest folder an entry may name. A folder longer than this is not recorded. */
const MAX_CWD_CHARS = 4096;

/** One line a phone ran on this machine. */
export interface RecentRun {
  /** The line as it was typed, after the character rule. */
  line: string;
  /** The folder it last ran in, absolute, or `null` for home. */
  cwd: string | null;
  /** Epoch ms of the last run. */
  at: number;
  /** The line carries a flag known to skip permission prompts. */
  noPrompts: boolean;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** A folder an entry may hold: absolute, bounded, and with no character the line rule refuses. */
function cleanCwd(raw: JsonValue | undefined): string | null | false {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_CWD_CHARS || !isAbsolute(raw)) return false;
  for (const ch of raw) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return false;
  }
  return raw;
}

/** One entry read off disk, or `null` when it is not one. The run's own rule, again. */
export function coerceRecentRun(raw: JsonValue | undefined): RecentRun | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { line, cwd, at, noPrompts } = r;
  if (typeof line !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  const clean = cleanLauncherText(line, MAX_COMMAND_CHARS);
  if (!clean.ok || clean.text !== line) return null;
  const folder = cleanCwd(cwd);
  if (folder === false) return null;
  // The scan wins over the file: a line with a visible no-prompts flag never reads as "prompts".
  return { line, cwd: folder, at, noPrompts: noPrompts === true || scanNoPrompts(line) };
}

/** What a parsed file holds, or `null` when it is not a file this build may write over. */
export function coerceRecentFile(raw: JsonValue): RecentRun[] | null {
  const file = asRecord(raw);
  if (file === null || file.version !== RECENT_VERSION || !Array.isArray(file.entries)) return null;
  const out: RecentRun[] = [];
  for (const entry of file.entries) {
    const run = coerceRecentRun(entry);
    // One entry per exact line; the first wins, as the file is newest first.
    if (run === null || out.some((e) => e.line === run.line)) continue;
    out.push(run);
  }
  return out.slice(0, MAX_RECENT);
}

/** Parse a file's text: `[]` for no file, `null` for one that is not ours to write over. */
export function parseRecentText(text: string | null): RecentRun[] | null {
  if (text === null) return [];
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `coerceRecentFile` checks every field.
    return coerceRecentFile(JSON.parse(text) as JsonValue);
  } catch {
    return null;
  }
}

/** The text a list of entries is written as. */
export function formatRecentFile(entries: readonly RecentRun[]): string {
  return `${JSON.stringify({ version: RECENT_VERSION, entries }, null, 2)}\n`;
}

/** What the routes need of the history. */
export interface RecentRunSurface {
  /** The entries on disk now, newest first. A missing or bad file is an empty list. */
  list(): Promise<RecentRun[]>;
  /** Put one run at the top: a line already there moves up, the oldest past the cap goes. */
  record(run: RecentRun): Promise<"recorded" | "unwritable">;
  /** Remove the entry with exactly this line. `null` when there is none. */
  remove(line: string): Promise<RecentRun | null | "unwritable">;
  /** Remove every entry. Answers how many there were. */
  clear(): Promise<number | "unwritable">;
}

/** The file-backed history `bridge/index.ts` builds once. */
export class RecentRunStore implements RecentRunSurface {
  private cache: { mtime: number | null; entries: RecentRun[] | null } | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly io: AddedFileIo,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** The file as it is now, behind an mtime check. */
  private async load(): Promise<RecentRun[] | null> {
    const mtime = await this.io.mtime();
    if (this.cache !== null && this.cache.mtime === mtime && mtime !== null) return this.cache.entries;
    let entries: RecentRun[] | null;
    try {
      entries = parseRecentText(await this.io.read());
    } catch (err) {
      this.warn(`[launch] could not read ${RECENT_FILE}: ${err instanceof Error ? err.message : String(err)}`);
      entries = null;
    }
    if (entries === null && (this.cache === null || this.cache.mtime !== mtime)) {
      this.warn(`[launch] ${RECENT_FILE} is not a version ${RECENT_VERSION} file: no command history, and none is kept until it is moved away`);
    }
    this.cache = { mtime, entries };
    return entries;
  }

  async list(): Promise<RecentRun[]> {
    return [...((await this.load()) ?? [])];
  }

  /** Run one read-modify-write after every earlier one, on the file as it is when its turn comes. */
  private change<T>(edit: (entries: RecentRun[]) => { entries: RecentRun[] | null; answer: T }, unwritable: T): Promise<T> {
    const run = this.queue.then(async () => {
      this.cache = null;
      const entries = await this.load();
      if (entries === null) return unwritable;
      const out = edit(entries);
      if (out.entries !== null) {
        await this.io.write(formatRecentFile(out.entries));
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

  record(run: RecentRun): Promise<"recorded" | "unwritable"> {
    return this.change<"recorded" | "unwritable">(
      (entries) => ({ entries: [run, ...entries.filter((e) => e.line !== run.line)].slice(0, MAX_RECENT), answer: "recorded" }),
      "unwritable",
    );
  }

  remove(line: string): Promise<RecentRun | null | "unwritable"> {
    return this.change<RecentRun | null | "unwritable">((entries) => {
      const gone = entries.find((e) => e.line === line);
      if (gone === undefined) return { entries: null, answer: null };
      return { entries: entries.filter((e) => e.line !== line), answer: gone };
    }, "unwritable");
  }

  clear(): Promise<number | "unwritable"> {
    return this.change<number | "unwritable">((entries) => ({ entries: entries.length === 0 ? null : [], answer: entries.length }), "unwritable");
  }
}

/** The real history over `<stateDir>/commands-recent.json`. */
export function recentRunFileIo(stateDir: string): AddedFileIo {
  return stateFileIo(stateDir, join(stateDir, RECENT_FILE));
}

/** A history over an in-memory file: the default for a server built without a state dir. */
export function memoryRecentRuns(initial: string | null = null): RecentRunStore {
  return new RecentRunStore(memoryAddedIo(initial), () => {});
}

/**
 * The command word of a line, for a space's label and the audit line: the first word after any
 * leading `NAME=value` assignments, at most a label's length. An assignment is skipped because its
 * value is exactly where a person puts a token (`TOKEN=… deploy`), and neither place may hold one.
 */
export function runProgram(line: string): string {
  const words = line.trim().split(/\s+/);
  const word = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
  const program = [...word].slice(0, MAX_LABEL_CHARS).join("");
  return program === "" ? "shell" : program;
}

/** The history as `GET /api/launchers` carries it: every entry, unavailable while `[phone] run` is off. */
export function recentRunsWire(entries: readonly RecentRun[], runOn: boolean): RecentRunWire[] {
  return entries.map((e) => {
    const wire: RecentRunWire = { line: e.line, cwd: e.cwd, at: e.at, noPrompts: e.noPrompts, available: runOn };
    if (!runOn) wire.reason = "run_off";
    return wire;
  });
}

// ── The two routes that change the history ──────────────────────────────────────────────────────
//
// Pure, as bridge/launcher-adds.ts's are: bridge/server.ts owns the write gate, the `?host=` forward
// and the response; these take the parsed body and answer a status and a body.

/** A route's answer, for bridge/server.ts to send. */
export interface RecentRouteAnswer {
  status: number;
  body: RecentRunsResponse;
}

/** Who is asking, and where the audit line goes. */
export interface RecentRouteContext {
  recent: RecentRunSurface;
  device: string | null;
  audit: AuditLog;
  session?: string;
}

/**
 * `POST /api/launch/recent/remove` `{ line }`. Any paired write device on this machine may remove an
 * entry. The audit line names the command word and the length, never the line (ADR 0095).
 */
export async function removeRecentRun(body: JsonValue, ctx: RecentRouteContext): Promise<RecentRouteAnswer> {
  const line = asRecord(body)?.line;
  if (typeof line !== "string" || line === "") return { status: 400, body: { ok: false, ...apiError("launch.recent_unknown") } };
  const gone = await ctx.recent.remove(line);
  if (gone === "unwritable") return { status: 503, body: { ok: false, ...apiError("launch.recent_unreadable") } };
  if (gone === null) return { status: 404, body: { ok: false, ...apiError("launch.recent_unknown") } };
  ctx.audit.record({
    action: "launch.recent.remove",
    session: ctx.session,
    device: ctx.device,
    detail: { program: runProgram(gone.line), length: [...gone.line].length },
  });
  return { status: 200, body: { ok: true, removed: 1 } };
}

/** `POST /api/launch/recent/clear` `{}`. Removes every entry on this machine. */
export async function clearRecentRuns(_body: JsonValue, ctx: RecentRouteContext): Promise<RecentRouteAnswer> {
  const removed = await ctx.recent.clear();
  if (removed === "unwritable") return { status: 503, body: { ok: false, ...apiError("launch.recent_unreadable") } };
  ctx.audit.record({ action: "launch.recent.clear", session: ctx.session, device: ctx.device, detail: { removed } });
  return { status: 200, body: { ok: true, removed } };
}
