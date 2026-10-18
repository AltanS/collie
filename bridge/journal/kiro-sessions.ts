// Where Kiro V3 keeps its sessions, and the one set of rules for finding them.
//
// Each session is a folder <sessions>/<bucket>/<session-id>/ holding session.json, which describes
// it, and messages.jsonl, its rows (read by kiro.ts). Sessions started in one folder share a bucket.
// A sub-agent's own history sits in the session's sub-executions/ folder and is not read. Observed on
// kiro-cli 2.32.0 (fixtures/kiro/README.md).
//
// Resolution (the pane names a session) and discovery (kiro-discovery.ts, the pane does not) walk
// the same tree with the same rules (KiroSessionTree): the first 32 configured roots, each anchored
// at its real path; bucket and session folders named by safe path components only; no symlink
// anywhere below a root. Resolution checks session.json once; reads then use the shared readers in
// files.ts on the real log path.

import type { Dir, Dirent } from "node:fs";
import { lstat, opendir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";
import { containedRealpath, head, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import { clamp } from "./text.ts";
import type { AgentSessionRef, TranscriptSource } from "./types.ts";

// A bucket or session folder name becomes a path component, so only a plain name is accepted.
// kiro-cli 2.32.0 names them with 16 hex digits and `sess_<uuid>`; nothing here relies on either shape.
const KIRO_FOLDER_NAME = /^[A-Za-z0-9_-]{1,128}$/;
/** Configured roots past this many are ignored, by resolution and discovery alike. */
const MAX_ROOTS = 32;
/** Folder entries one walk may list, counted across every root, bucket and session folder. */
const MAX_WALK_ENTRIES = 8192;
const MAX_METADATA_BYTES = 256 * 1024;
/** session.json schema versions this reader was written against. Others are read and logged once. */
const KNOWN_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(["1.0.0"]);
/** At most this many unknown schema versions are logged, so a broken writer cannot flood the log. */
const MAX_LOGGED_SCHEMA_VERSIONS = 8;

/** Whether `name` may be a bucket or session folder: a plain name, safe as one path component. */
export function isKiroFolderName(name: string): boolean {
  return KIRO_FOLDER_NAME.test(name);
}

/** The parent log's name inside a session folder; the folder is named for the session ID. */
export const KIRO_LOG_NAME = "messages.jsonl";

/** The session ID a parent log path belongs to, or null when the path is not a parent log. */
export function kiroSessionIdOf(log: string): string | null {
  if (basename(log) !== KIRO_LOG_NAME) return null;
  const id = basename(dirname(log));
  return isKiroFolderName(id) ? id : null;
}

/** A folder a walk found: its real path, and the real configured root it lies under. */
interface KiroFolder {
  readonly root: string;
  readonly path: string;
}

/** A session folder a walk found, with the session ID it is named for. */
interface KiroSessionFolder extends KiroFolder {
  readonly id: string;
}

/** One bounded walk of the tree; {@link KiroSessionTree.walk} explains `complete`. */
interface KiroWalk {
  /** False once the walk stopped at its entry limit or a listing failed part way. */
  readonly complete: boolean;
  /** Every bucket folder under every configured root, in root order. */
  buckets(): AsyncGenerator<KiroFolder>;
  /**
   * Every session folder in `bucket` that holds a regular `.lock` file, which the TUI keeps for the
   * session it shows (kiro-discovery.ts reads it). Most saved sessions have none, so the `lstat`
   * runs first and only the few that pass it pay the real-path check.
   */
  lockedSessions(bucket: KiroFolder): AsyncGenerator<KiroSessionFolder>;
}

interface WalkState {
  left: number;
  complete: boolean;
}

/**
 * The configured Kiro roots, and the one set of rules for finding folders under them.
 *
 * A configured root may be a symlink or sit below one (KIRO_HOME moved by the operator): roots are
 * operator config, never request input. Each walk is anchored at the root's real path, and every
 * bucket or session folder it yields is a real folder inside that root, with no symlink in its path.
 * A root that is missing or cannot be listed is skipped; the other roots are still walked.
 */
export class KiroSessionTree {
  readonly roots: readonly string[];
  private limitLogged = false;

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots).filter(isAbsolute).slice(0, MAX_ROOTS);
  }

  /**
   * A fresh walk with its own entry budget. A caller that must see every session (discovery
   * proves an owner is unique) checks `complete` after the walk and refuses when it is false.
   */
  walk(): KiroWalk {
    const state: WalkState = { left: MAX_WALK_ENTRIES, complete: true };
    return {
      get complete(): boolean {
        return state.complete;
      },
      buckets: () => this.buckets(state),
      lockedSessions: (bucket) => this.lockedSessions(bucket, state),
    };
  }

  /** The folder for session `id` in `bucket`, or null when the ID or the folder fails the rules. */
  async session(bucket: KiroFolder, id: string): Promise<KiroSessionFolder | null> {
    if (!isKiroFolderName(id)) return null;
    const path = join(bucket.path, id);
    return (await this.isFolder(path, bucket.root)) ? { root: bucket.root, path, id } : null;
  }

  /** True when `path` is a folder inside `root` and is its own real path, so no part is a symlink. */
  private async isFolder(path: string, root: string): Promise<boolean> {
    const stamp = await lstat(path).catch(() => null);
    return stamp?.isDirectory() === true && (await containedRealpath(path, root)) === path;
  }

  private async *buckets(state: WalkState): AsyncGenerator<KiroFolder> {
    for (const root of this.roots) {
      const real = await containedRealpath(root, root);
      if (real === null) continue;
      for await (const entry of this.entries(real, state)) {
        if (!entry.isDirectory() || !isKiroFolderName(entry.name)) continue;
        const path = join(real, entry.name);
        if (await this.isFolder(path, real)) yield { root: real, path };
      }
    }
  }

  private async *lockedSessions(bucket: KiroFolder, state: WalkState): AsyncGenerator<KiroSessionFolder> {
    for await (const entry of this.entries(bucket.path, state)) {
      if (!entry.isDirectory() || !isKiroFolderName(entry.name)) continue;
      const path = join(bucket.path, entry.name);
      const lock = await lstat(join(path, ".lock")).catch(() => null);
      if (lock?.isFile() === true && (await this.isFolder(path, bucket.root))) {
        yield { root: bucket.root, path, id: entry.name };
      }
    }
  }

  /** One folder's entries, streamed: readdir would hold a whole large listing in memory. */
  private async *entries(dir: string, state: WalkState): AsyncGenerator<Dirent> {
    let listing: Dir;
    try {
      listing = await opendir(dir);
    } catch {
      // Missing or unreadable: it holds nothing this bridge could read, so the walk is not short.
      return;
    }
    try {
      for await (const entry of listing) {
        if (state.left <= 0) {
          state.complete = false;
          this.noteLimit();
          return;
        }
        state.left--;
        yield entry;
      }
    } catch {
      state.complete = false;
    }
  }

  private noteLimit(): void {
    if (this.limitLogged) return;
    this.limitLogged = true;
    console.warn(`[journal] kiro: a session folder walk stopped after ${MAX_WALK_ENTRIES} entries; sessions past them are not found`);
  }
}

/** The JSON object `text` holds, or null when it is not one. */
function parseJsonObject(text: string): JsonObject | null {
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    return asRecord(JSON.parse(text) as JsonValue);
  } catch {
    return null;
  }
}

interface LocatedLog {
  root: string;
  dir: string;
}

/** The Kiro journal's source: resolves a session ID to its log and reads it with the shared readers. */
export class KiroTranscriptSource implements TranscriptSource {
  // Session ID to the folder resolve last found it in. A shortcut, never a permission: a hit is
  // checked again before it is returned, and a miss costs one walk. One entry per session a pane
  // has named, like grok's path cache.
  private readonly located = new Map<string, LocatedLog>();
  private readonly loggedVersions = new Set<string>();

  constructor(private readonly tree: KiroSessionTree) {}

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isKiroFolderName(ref.value)) return null;
    const cached = this.located.get(ref.value);
    if (cached !== undefined) {
      const log = await this.logIn(cached.dir, cached.root);
      if (log !== null) return log;
      this.located.delete(ref.value);
    }
    for await (const bucket of this.tree.walk().buckets()) {
      const session = await this.tree.session(bucket, ref.value);
      if (session === null || !(await this.describes(session))) continue;
      const log = await this.logIn(session.path, session.root);
      if (log === null) continue;
      this.located.set(ref.value, { root: session.root, dir: session.path });
      return log;
    }
    return null;
  }

  /** The log in a session folder by its real path, or null unless it is a regular file inside it. */
  private async logIn(dir: string, root: string): Promise<string | null> {
    if ((await containedRealpath(dir, root)) !== dir) return null;
    const real = await containedRealpath(join(dir, KIRO_LOG_NAME), dir);
    if (real === null) return null;
    // Bun.file can also open a pipe or a device; never read one as a log.
    const stamp = await stat(real).catch(() => null);
    return stamp?.isFile() === true ? real : null;
  }

  /**
   * True when the folder's session.json names this session, so a folder is a session only by its own
   * record and never by its name alone. Only the fields this reader relies on are checked; a
   * schemaVersion it does not know is read anyway and logged once.
   */
  private async describes(session: KiroSessionFolder): Promise<boolean> {
    try {
      const real = await containedRealpath(join(session.path, "session.json"), session.path);
      if (real === null) return false;
      const stamp = await stat(real);
      if (!stamp.isFile() || stamp.size > MAX_METADATA_BYTES) return false;
      // Bounded even when the file grows between the size check and the read.
      const metadata = parseJsonObject(await head(real, MAX_METADATA_BYTES + 1));
      if (metadata?.id !== session.id) return false;
      const folders = metadata.workspacePaths;
      if (!Array.isArray(folders) || !folders.every((folder) => typeof folder === "string")) return false;
      this.noteSchemaVersion(metadata.schemaVersion);
      return true;
    } catch {
      return false;
    }
  }

  private noteSchemaVersion(version: JsonValue | undefined): void {
    const name = typeof version === "string" ? clamp(version, 32).text : JSON.stringify(version ?? null).slice(0, 32);
    if (KNOWN_SCHEMA_VERSIONS.has(name) || this.loggedVersions.has(name)) return;
    if (this.loggedVersions.size >= MAX_LOGGED_SCHEMA_VERSIONS) return;
    this.loggedVersions.add(name);
    console.warn(`[journal] kiro: session.json schemaVersion ${JSON.stringify(name)} is new to this reader; reading it anyway`);
  }

  stat = statFile;
  load = loadTail;
  readSince = readSinceFile;
}
