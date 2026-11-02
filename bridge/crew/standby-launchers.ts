import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import type { MergedLaunchers } from "../launcher-adds.ts";
import { isForbiddenCodePoint } from "../launcher-recipes.ts";
import type { Launcher } from "../types.ts";
import { expandHome } from "../worktree-folder.ts";
import { folderQuestion } from "./launcher-rows.ts";

// The lead's launcher rows, kept on the DEPUTY as a read-only copy (ADR 0127 point 5, CREW_PROTOCOL
// §18.14). The device registry beside it (`standby-devices.ts`) is what lets the deputy's door take
// the phone; this copy is what lets the New screen keep the crew's rows after a takeover.
//
// ── A COPY, AND NOTHING ELSE ──────────────────────────────────────────────────────────────────────
// It lands in `standby-launchers.json`, its own file. It is never merged into `launchers.toml` or
// `launchers-added.json`: those are the deputy's own lists, its operator's word and its phones' adds.
// The copy is SERVED, not adopted, and only while this machine leads in its old lead's place. While
// the deputy is cold it holds the copy and its own answers stay exactly its own. So a demotion leaves
// nothing behind to unpick: the file is removed, and the machine's own lists never saw a row of it.
//
// ── WHAT CROSSES ──────────────────────────────────────────────────────────────────────────────────
// The fields a launch matches and runs on: the line, its label, its kind, its harness, its pinned
// folder and its no-prompts mark. Not the added-row bookkeeping (id, device, time): the copy cannot
// be renamed or removed here, so it carries nothing those verbs would need. A pinned folder under the
// lead's home crosses as `~/rel` (`folderQuestion`, spec 03's carry), so it is read under the
// deputy's home when the deputy serves it.
//
// ── A REPORT, NOT A MEMORY ────────────────────────────────────────────────────────────────────────
// The deputy reports the digest of the copy it holds (`launchersDigest`, on `hello` and `snapshot`),
// and the lead sends when that differs from what it would send: §18.14's own rule for the device
// registry, for the same reason. A deputy that predates the route answers 404, and the lead stops
// sending to it until the next connect (`lead.ts`).
//
// PURE except for {@link StandbyLauncherStore}, which is the one thing here that touches a disk.

/** The copy's filename under `stateDir`. Never `launchers-added.json`; see the header. */
export const STANDBY_LAUNCHERS_FILENAME = "standby-launchers.json";

/** On-disk schema version, its own, for `standby-devices.ts`'s reason. */
export const STANDBY_LAUNCHERS_VERSION = 1;

/**
 * The most rows one copy carries. The added store holds at most twenty (`MAX_ADDED`), and an
 * operator's `launchers.toml` has no cap of its own, so this is a bound on the wire, not a design
 * number. A lead with more sends the first this many, operator rows first.
 */
export const MAX_COPIED_ROWS = 200;

/** The longest line and label one copied row may carry. Generous: an operator row has no cap either. */
export const MAX_COPIED_TEXT = 4096;

/** The report's field on `hello` and `snapshot` (§18.14). */
export const LAUNCHERS_DIGEST_FIELD = "launchersDigest";

/** One row as it crosses the crew link and lands on the deputy. A type, so it is a JSON object. */
export type CopiedRow = {
  command: string;
  label: string;
  kind: "agent" | "command";
  noPrompts: boolean;
  /** The pinned folder as {@link folderQuestion} writes it: `~/rel` under the lead's home. */
  cwd?: string;
  harness?: string;
};

/** The whole file. It records whose rows these are, so a deputy of another lead never serves them. */
export interface StandbyLaunchers {
  readonly version: number;
  readonly crewId: string;
  /** The lead that sent the copy. */
  readonly from: string;
  /** Epoch ms of the write, on this machine's clock. */
  readonly at: number;
  readonly rows: readonly CopiedRow[];
}

// ── The lead's projection ────────────────────────────────────────────────────────────────────────

/**
 * What the lead sends: each merged row as it runs, its folder written for the deputy's home, at most
 * {@link MAX_COPIED_ROWS}. Pure; the key order is fixed here, so the same rows digest the same.
 */
export function copiedRowsOf(rows: readonly Launcher[], leadHome: string): CopiedRow[] {
  return rows.slice(0, MAX_COPIED_ROWS).map((row) => {
    const out: CopiedRow = {
      command: row.command,
      label: row.label,
      kind: row.kind === "agent" || (row.kind === undefined && row.harness !== undefined) ? "agent" : "command",
      noPrompts: row.noPrompts === true,
    };
    if (row.cwd !== undefined) out.cwd = folderQuestion(row.cwd, leadHome);
    if (row.harness !== undefined) out.harness = row.harness;
    return out;
  });
}

/**
 * A stable fingerprint of a copy: the lead's over what it would send, the deputy's over what it holds.
 * Both are the projection above, so the two agree exactly when the deputy's copy is current.
 */
export function copyDigest(rows: readonly CopiedRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** Whether a lead must send: a deputy that reports nothing, or another digest, is behind. */
export function copyPushNeeded(current: string, reported: string | null): boolean {
  return reported !== current;
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────

function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/** A line a launch could type: not empty, bounded, and free of the characters no typed line may hold. */
function isLine(value: JsonValue | undefined): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_COPIED_TEXT) return false;
  for (const ch of value) if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return false;
  return true;
}

/** A folder the deputy can read: absolute, or `~` / `~/rel` for its own home. */
function isCopiedFolder(value: string): boolean {
  return value === "~" || value.startsWith("~/") || isAbsolute(value);
}

/** One row, or `null`. Every field is checked: the copy reaches a launch allowlist when it is served. */
function parseRow(value: JsonValue | undefined): CopiedRow | null {
  const r = asRecord(value);
  if (r === null || !isLine(r.command) || !isLine(r.label)) return null;
  if (r.kind !== "agent" && r.kind !== "command") return null;
  if (typeof r.noPrompts !== "boolean") return null;
  const row: CopiedRow = { command: r.command, label: r.label, kind: r.kind, noPrompts: r.noPrompts };
  if (r.cwd !== undefined) {
    if (!isLine(r.cwd) || !isCopiedFolder(r.cwd)) return null;
    row.cwd = r.cwd;
  }
  if (r.harness !== undefined) {
    if (!isLine(r.harness)) return null;
    row.harness = r.harness;
  }
  return row;
}

/**
 * The rows of a body or a file, or `null` for anything that is not a clean list: a bad row refuses the
 * whole list, as `standby-devices.ts` refuses a registry with a hole in it, and so does a second row
 * with the same `command`, which a launch could not tell apart.
 */
export function parseCopiedRows(value: JsonValue | undefined): CopiedRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_COPIED_ROWS) return null;
  const out: CopiedRow[] = [];
  for (const item of value) {
    const row = parseRow(item);
    if (row === null || out.some((r) => r.command === row.command)) return null;
    out.push(row);
  }
  return out;
}

/** The body of `POST /crew/v1/launchers-copy`, `{ rows }`, or `null`. */
export function parseLaunchersCopy(value: JsonValue | undefined): CopiedRow[] | null {
  return parseCopiedRows(asRecord(value)?.rows);
}

/** Parse the file. `null` for anything this reader does not understand, which reads as no copy. */
export function parseStandbyLaunchers(raw: string): StandbyLaunchers | null {
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every field below is a checked read.
    value = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  const d = asRecord(value);
  if (d === null || d.version !== STANDBY_LAUNCHERS_VERSION) return null;
  if (typeof d.crewId !== "string" || d.crewId === "") return null;
  if (typeof d.from !== "string" || d.from === "") return null;
  const rows = parseCopiedRows(d.rows);
  if (rows === null) return null;
  return { version: STANDBY_LAUNCHERS_VERSION, crewId: d.crewId, from: d.from, at: typeof d.at === "number" ? d.at : 0, rows };
}

/** Serialise for disk. Pretty and newline-terminated, like `standby-devices.json`. */
export function serializeStandbyLaunchers(data: StandbyLaunchers): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** The deputy's report: the digest of the copy it holds, or `null` when it holds none. */
export function copyReportOf(held: StandbyLaunchers | null): string | null {
  return held === null ? null : copyDigest(held.rows);
}

/** Read a member's report off a `hello`/`snapshot` body. Opaque and bounded, as `pairingDigest` is. */
export function parseCopyReport(value: JsonValue | undefined): string | null {
  const digest = asRecord(value)?.[LAUNCHERS_DIGEST_FIELD];
  return typeof digest === "string" && digest !== "" && digest.length <= 128 ? digest : null;
}

// ── Whose copy it is ─────────────────────────────────────────────────────────────────────────────

/** What this machine is in its crew right now, read off its trust store. */
export interface CopyRole {
  /** The crew this machine is in, or `null` with none. */
  readonly crewId: string | null;
  /** This machine leads that crew: it has no lead of its own. */
  readonly leads: boolean;
  /** The lead this machine follows, or `null` while it leads or has no crew. */
  readonly leadMemberId: string | null;
  /** A verified warrant names this machine as its lead's deputy. */
  readonly deputy: boolean;
}

/**
 * Whether the copy may stay on disk. A copy of another crew goes. While this machine follows a lead,
 * it stays only while this machine is that lead's deputy: a demotion, or a different lead, clears it.
 * While this machine leads the crew, after a takeover or a handover, it stays: it is the crew's rows.
 */
export function copyKept(held: StandbyLaunchers | null, role: CopyRole): boolean {
  if (held === null) return true;
  if (role.crewId === null || held.crewId !== role.crewId) return false;
  if (role.leads) return true;
  return role.deputy && role.leadMemberId === held.from;
}

/** The rows this machine serves from its copy: only while it leads the crew the copy is from. */
export function copyServed(held: StandbyLaunchers | null, role: Pick<CopyRole, "crewId" | "leads">): readonly CopiedRow[] | null {
  if (held === null || !role.leads || role.crewId === null || held.crewId !== role.crewId) return null;
  return held.rows;
}

// ── Serving it ───────────────────────────────────────────────────────────────────────────────────

/**
 * One copied row as this machine's own list carries it: an operator row, since nothing here can rename
 * or remove it, with its folder read under `home`. `null` when the folder is not absolute even then.
 */
export function launcherOfCopy(row: CopiedRow, home: string): Launcher | null {
  const out: Launcher = { command: row.command, label: row.label, source: "operator", kind: row.kind, noPrompts: row.noPrompts };
  if (row.harness !== undefined) out.harness = row.harness;
  if (row.cwd === undefined) return out;
  const cwd = expandHome(row.cwd, home);
  if (!isAbsolute(cwd)) return null;
  out.cwd = cwd;
  return out;
}

/**
 * This machine's merged rows with the copy after them (ADR 0127 point 5): its own row wins on the same
 * `command`, a row its switches hold back included, so every `key` on the New screen stays unique.
 * With no copy to serve, `own` comes back as it was. Pure.
 */
export function withCopyRows(own: MergedLaunchers, copy: readonly CopiedRow[] | null, home: string): MergedLaunchers {
  if (copy === null || copy.length === 0) return own;
  const taken = new Set<string>([...own.rows.map((r) => r.command), ...own.off.map((r) => r.command)]);
  const added: Launcher[] = [];
  for (const row of copy) {
    if (taken.has(row.command)) continue;
    const launcher = launcherOfCopy(row, home);
    if (launcher !== null) added.push(launcher);
  }
  return { ...own, rows: [...own.rows, ...added] };
}

/**
 * What `bridge/server.ts` needs of the copy, supplied by index.ts when a trust store exists. The one
 * seam where "this machine's rows" become "the crew's rows": while this machine leads in its old
 * lead's place, `served` answers the copy, and the server merges it under its own rows.
 */
export interface LauncherCopySeam {
  /** The copy this machine serves now, or `null`: only while it leads the crew the copy is from. */
  served(): readonly CopiedRow[] | null;
  /**
   * Handed once, at start, the server's read of the rows a launch here matches (its own and any copy
   * it serves), so the sync to this machine's deputy sends exactly that list.
   */
  source(read: () => Promise<Launcher[]>): void;
}

// ── The file ─────────────────────────────────────────────────────────────────────────────────────

/** Absolute path of the copy for a state dir. The only place this path is composed. */
export function standbyLaunchersPath(stateDir: string): string {
  return join(stateDir, STANDBY_LAUNCHERS_FILENAME);
}

/** Every disk touch this store makes, injected so the logic is testable without a disk. */
export interface StandbyLauncherIo {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * The copy as the process holds it: one cached read, one atomic write, one remove. 0600 in a 0700
 * directory, temp-then-rename, the discipline `standby-devices.json` keeps.
 *
 * **Solo writes none of it.** Only a machine with a trust store constructs one, and only a crew route
 * from this machine's own lead, while a warrant names this machine, ever writes it.
 */
export class StandbyLauncherStore {
  private cached: StandbyLaunchers | null = null;
  private loaded = false;
  private readonly path: string;

  constructor(
    stateDir: string,
    private readonly io: StandbyLauncherIo = fsStandbyLauncherIo(stateDir),
  ) {
    this.path = standbyLaunchersPath(stateDir);
  }

  async load(): Promise<StandbyLaunchers | null> {
    if (this.loaded) return this.cached;
    const raw = await this.io.read(this.path);
    this.cached = raw === null ? null : parseStandbyLaunchers(raw);
    this.loaded = true;
    return this.cached;
  }

  /** The last loaded value, without touching the disk. `null` before {@link load} has run. */
  current(): StandbyLaunchers | null {
    return this.cached;
  }

  /** Replace the copy wholesale: a row the lead no longer has must go here too. */
  async replace(next: StandbyLaunchers): Promise<void> {
    await this.io.write(this.path, serializeStandbyLaunchers(next));
    this.cached = next;
    this.loaded = true;
  }

  /** Remove the copy, when it is no longer this machine's to hold. A copy that is not there is fine. */
  async clear(): Promise<void> {
    await this.io.remove(this.path);
    this.cached = null;
    this.loaded = true;
  }

  /** Clear the copy when {@link copyKept} says it is not this machine's any more. Answers whether it did. */
  async reconcile(role: CopyRole): Promise<boolean> {
    if (copyKept(await this.load(), role)) return false;
    await this.clear();
    return true;
  }
}

export function fsStandbyLauncherIo(stateDir: string): StandbyLauncherIo {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(path, data) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, path);
    },
    async remove(path) {
      await rm(path, { force: true });
    },
  };
}
