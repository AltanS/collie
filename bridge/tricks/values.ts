import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { asJsonObject, parseJson } from "../../web/src/lib/json.ts";
import { VALUE_WRITES_SEEN_MAX } from "../../web/src/lib/tricks/limits.ts";
import {
  asFieldValue,
  effectiveValues,
  FIELDS_CONTRACT,
  isTrickId,
  keptValues,
  needsSetup,
  type FieldValues,
  type TrickFacts,
  type TrickManifest,
  type WireTrickInfo,
} from "../../web/src/lib/tricks/schema.ts";
import { trickStateDir } from "./paths.ts";
import { holdStat, statFactsOf, stillHolds, type StatFacts, type StatHeld } from "../stat-held.ts";

// THE VALUES A PERSON KEEPS FOR A TRICK (contract 3, `[[field]]`, decided 2026-11-17).
//
// ── WHERE ──────────────────────────────────────────────────────────────────────────────────────────
// `<stateDir>/tricks/<id>/.collie/values.json`: inside the trick's state folder, so `collie trick remove`
// (which deletes that folder) and a proposal's fresh start (service.ts `installProposed`) remove it with the
// rest. The `.collie/` step keeps it apart from the program's own notes: the helper's `t.state` names only
// plain names that never start with a dot (cli/trick-kit/trick.ts `statePath`), so `t.state.set("values")`
// writes `values.json` beside it and never over it. The same dot keeps it off the deputy: a takeover carries
// a state folder only through `statePathProblem` (bridge/crew/standby-tricks.ts), which refuses a dot step,
// so in a crew the values live on the lead alone, as decided. After a takeover the deputy's trick reads as
// "Needs setup" until the person sets its values there.
//
// ── THE FILE ───────────────────────────────────────────────────────────────────────────────────────
// `{ "v": 1, "values": { "<key>": <text | true/false | whole number> } }`, mode 0600 in a 0700 folder,
// written whole: a temp file in the same folder, then a rename, so a crash leaves the old file or the new
// one. A file that does not read (not JSON, another shape, another `v`) reads as EMPTY, never as a guess,
// and the row says so (`valuesUnread`); the next write replaces it. A stored value that no longer keeps its
// field's rule (a new version changed the field) reads as unset: the default, or "Needs setup".
//
// ── WHAT IS NOT A BOUNDARY ─────────────────────────────────────────────────────────────────────────
// The program runs as the user and gets `trick.state`, so it can read or write this file. Collie reads it
// back through the field rules, so a write by the program changes nothing a person would not see on the row.

/** The file's version. Another reads as empty. */
export const VALUES_FILE_VERSION = 1;

/** `<stateDir>/tricks/<id>/.collie/values.json`. */
export function valuesPath(stateDir: string, id: string): string {
  const dir = trickStateDir(stateDir, id);
  return join(dir, ".collie", "values.json");
}

/** One trick's stored values, and whether the file was there but could not be read. */
export interface StoredValues {
  values: FieldValues;
  unread: boolean;
}

/** The values of one file's text, or null when it does not read. Pure. */
export function parseValuesFile(text: string): FieldValues | null {
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined || doc.v !== VALUES_FILE_VERSION) return null;
  const raw = asJsonObject(doc.values);
  if (raw === undefined) return null;
  const out: FieldValues = {};
  for (const [key, one] of Object.entries(raw)) {
    const value = asFieldValue(one);
    if (!isTrickId(key) || value === undefined) return null;
    out[key] = value;
  }
  return out;
}

/**
 * Why the `.collie` folder is not one the bridge may use, or null when it is a real folder of this user or is
 * not there yet. A symlink (or a file, or a folder of another user) is refused: the bridge would otherwise
 * chmod and write through it into a place the person never chose (security read of package G, point 3).
 * `lstat` does not follow a link. A uid check runs only where the platform has one.
 */
export function collieFolderProblem(dir: string): string | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return `${dir} is not a real folder`;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return `${dir} belongs to another user`;
  return null;
}

/**
 * The values store of one bridge. Reads go through a small cache keyed on the file's size, modified time, inode
 * and change time, and a read within the racy window of the file's last write is not kept (stat-held.ts), so a
 * row publish (every scan) costs one `stat`; a write by anyone else is read on the next look.
 */
export class TrickValues {
  private readonly cache = new Map<string, { held: StatHeld; read: StoredValues }>();

  /** `look`: the clock of a read (the racy window, stat-held.ts) and the `stat`, for a test. */
  constructor(
    private readonly stateDir: string,
    private readonly look: { now?: () => number; stat?: (path: string) => { size: number; mtimeMs: number; ino?: number; ctimeMs?: number } } = {},
  ) {}

  /** One trick's stored values. A missing file is empty and read; a bad one is empty and `unread`. */
  read(id: string): StoredValues {
    if (!isTrickId(id)) return { values: {}, unread: false };
    const path = valuesPath(this.stateDir, id);
    // A `.collie` that is a link or not ours reads as unread, never followed.
    if (collieFolderProblem(dirname(path)) !== null) {
      this.cache.delete(id);
      return { values: {}, unread: true };
    }
    const readAt = (this.look.now ?? Date.now)();
    let facts: StatFacts;
    try {
      facts = statFactsOf(this.look.stat === undefined ? statSync(path) : this.look.stat(path));
    } catch {
      this.cache.delete(id);
      return { values: {}, unread: false };
    }
    const held = this.cache.get(id);
    if (held !== undefined && stillHolds(held.held, facts)) return held.read;
    let read: StoredValues;
    try {
      const values = parseValuesFile(readFileSync(path, "utf8"));
      read = values === null ? { values: {}, unread: true } : { values, unread: false };
    } catch {
      read = { values: {}, unread: true };
    }
    this.cache.set(id, { held: holdStat(facts, readAt, { path, kind: "a trick's values" }), read });
    return read;
  }

  /**
   * Write one trick's values whole: the folder 0700, a temp file 0600, then a rename. Throws when the disk
   * refuses; the caller answers that in words and nothing changed.
   */
  write(id: string, values: FieldValues): void {
    if (!isTrickId(id)) throw new Error(`"${id}" is not a trick id`);
    const path = valuesPath(this.stateDir, id);
    const dir = dirname(path);
    const problem = collieFolderProblem(dir);
    if (problem !== null) throw new Error(problem);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = join(dir, `.values.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify({ v: VALUES_FILE_VERSION, values })}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    this.cache.delete(id);
  }
}

/** What a trick's row carries of its fields: the fields, the values set, and the two states the row says. */
export type FieldsWire = Pick<WireTrickInfo, "fields" | "values" | "needsSetup" | "valuesUnread">;

/**
 * The row's fields of a trick (contract 3): empty for a manifest with none. `values` holds only what the
 * person set and still keeps its field's rule; the phone reads a default off `fields`.
 */
export function fieldsWire(manifest: TrickManifest | undefined, stored: StoredValues): FieldsWire {
  const fields = manifest?.fields ?? [];
  if (fields.length === 0 || manifest === undefined || manifest.contract < FIELDS_CONTRACT) return {};
  const out: FieldsWire = { fields };
  const kept = keptValues(fields, stored.values);
  if (Object.keys(kept).length > 0) out.values = kept;
  if (needsSetup(fields, stored.values)) out.needsSetup = true;
  if (stored.unread) out.valuesUnread = true;
  return out;
}

/**
 * The facts of one run with the trick's values (contract 3): each field's value now, by key. The ONE way a
 * value reaches a program. Collie never puts a value on a command line, in the environment, in a log line,
 * in a Hill card or in a push. A trick with no fields, or of an older contract, gets its facts as before.
 */
export function withValues(facts: TrickFacts, manifest: TrickManifest, stored: StoredValues): TrickFacts {
  const fields = manifest.fields ?? [];
  if (fields.length === 0 || manifest.contract < FIELDS_CONTRACT) return facts;
  return { ...facts, values: effectiveValues(fields, stored.values) };
}

/** One remembered write: what it asked (a digest) and what it was answered. */
interface SeenWrite<T> {
  digest: string;
  answer: T;
}

// KNOWN LIMIT (accepted by the lead, 2026-11-17): this store is memory only. A bridge restart forgets every id,
// so the same id sent again after a restart writes the same value again, which changes nothing a person sees.
// Value writes are not rate limited beyond the trick's own one-run slot (service.ts `setValue`).
/**
 * The request ids of value writes this bridge took, at most {@link VALUE_WRITES_SEEN_MAX}, the oldest
 * forgotten first. The same id with the same payload is answered again and writes nothing; the same id with
 * another payload is refused. In memory only: a write repeated after a restart writes the same value again,
 * which changes nothing a person sees.
 */
export class SeenWrites<T> {
  private readonly seen = new Map<string, SeenWrite<T>>();

  constructor(private readonly max: number = VALUE_WRITES_SEEN_MAX) {}

  get(rid: string): SeenWrite<T> | undefined {
    return this.seen.get(rid);
  }

  remember(rid: string, digest: string, answer: T): void {
    this.seen.delete(rid);
    this.seen.set(rid, { digest, answer });
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
