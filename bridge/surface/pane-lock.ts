// One pane, one writer, across every bridge on the machine (M102 spec 16). The Send Protocol's pane
// lock (`SessionLocks`, protocol.ts) lives in one bridge's memory: two bridges on one multiplexer (a
// release lane and a dev lane) both took it, and the keys of two sends went into one input line. This
// is the second gate every bridge shares: one file per pane under the user's runtime folder, keyed by
// the multiplexer and its socket and the pane id, never by a bridge's own state folder.
//
// THE FILE. `<dir>/<sha256(scope NUL pane), 32 hex>.lock`, mode 0600, one JSON line:
// `{"v":1,"pid":1234,"start":"98765","at":<ms>,"until":<ms>}`. The owner's pid, its process start time
// (Linux `/proc/<pid>/stat` field 22; null where there is none), when it was written and the end of the
// span it covers. No text, no request id, no pane id.
//
// TAKE. The content goes to a temp file first, then `link(temp, lock)`: the link is the exclusive
// create, and a reader never sees a half-written lock. A file system with no hard links takes
// `open(lock, "wx")` instead. A process takes the file once per pane and counts its own holders, so a
// person's key press inside this bridge's own send is not refused (the in-memory lock and the key gate
// still order those, as before). Past its `until` that count proves nothing: another bridge may have
// taken the file over. So a join past `until` reads the file first, and when it no longer holds this
// process's bytes the join is refused (a send meets the busy answer, a person's key the busy words, Stop its
// wait and then its bypass); a file that is gone is taken again (2026-11-17, second review).
//
// STALE. A lock whose owner is gone (no such pid, or a pid whose start time is not the recorded one: the
// pid was reused) is stale. So is one past its `until` plus STALE_MARGIN_MS, and one whose `until` lies
// more than MAX_SPAN_MS ahead (the clock jumped back). A lock this process wrote and no longer counts
// (a release that failed) is stale for this process.
//
// TAKEOVER is itself atomic: under a short takeover mutex (`<lock>.take`, an exclusive create), the lock
// is read again and, still stale, REPLACED by `rename(temp, lock)`. Never delete-then-create: two bridges
// that both see the stale lock serialize on the mutex, and the second reads the first one's fresh lock.
// A mutex is held for a few file calls; one older than TAKE_STALE_MS was left by a crash and is moved
// aside. A release runs under the same mutex, so it never removes a lock a takeover just wrote.
//
// NO FOLDER. With no runtime folder (or none writable) {@link paneLockDir} and {@link openPaneLock}
// answer null and the bridge keeps the in-memory lock alone. A folder removed while the bridge runs (a
// cleaner of the runtime folder) is made again on the next take, once per take. A failing file call never fails a send: it
// is logged once and the pane counts as free here.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";

/** How far past its `until` a lock still stands, for a clock that differs a little between two reads. */
export const STALE_MARGIN_MS = 5_000;
/** The longest span a lock may claim ahead of now; one further ahead was written before a clock jump back. */
export const MAX_SPAN_MS = 15 * 60_000;
/** A takeover mutex older than this was left by a crash in the middle of a takeover. */
export const TAKE_STALE_MS = 2_000;

/** The words a writer gets that finds another bridge writing to the pane (the in-memory lock's own words). */
export const PANE_BUSY = "Another send on this pane is still running. Wait, then try again.";

/** What a lock file says. */
interface LockBody {
  readonly v: 1;
  readonly pid: number;
  readonly start: string | null;
  readonly at: number;
  readonly until: number;
}

/** The seams: the process, its clock and the way to look at another process. Defaults are the real ones. */
export interface PaneLockOptions {
  readonly dir: string;
  /** The multiplexer's address space: its registry key and its socket, as the bridge dials it. */
  readonly scope: string;
  readonly pid?: number;
  readonly now?: () => number;
  /** A process's start time, or null where the host has none to read (or the pid is gone). */
  readonly startOf?: (pid: number) => string | null;
  /** Whether a process exists. */
  readonly alive?: (pid: number) => boolean;
  readonly log?: (line: string) => void;
}

/** The start time of a process: field 22 of `/proc/<pid>/stat` (clock ticks since boot), or null. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The command name (field 2) may hold spaces and parentheses: the fields after it start after the LAST ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/** Whether a process exists: signal 0. EPERM is a process of another user that exists. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return codeOf(err) === "EPERM";
  }
}

/**
 * The folder every bridge of this user shares for pane locks: `$XDG_RUNTIME_DIR/collie/pane-locks`, else
 * `/run/user/<uid>/collie/pane-locks` when that folder exists (a unit with no XDG_RUNTIME_DIR), else the
 * user's state home (`${XDG_STATE_HOME:-~/.local/state}/collie-pane-locks`, as herdr-core falls back on
 * macOS and Windows). Never `/tmp`: a bridge unit runs with `PrivateTmp=yes`, so its `/tmp` is its own.
 */
export function paneLockDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  uid: number = process.getuid?.() ?? -1,
  dirExists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  const runtime = (env.XDG_RUNTIME_DIR ?? "").trim();
  if (runtime.length > 0) return join(runtime, "collie", "pane-locks");
  const userRun = `/run/user/${String(uid)}`;
  if (uid >= 0 && dirExists(userRun)) return join(userRun, "collie", "pane-locks");
  const stateHome = (env.XDG_STATE_HOME ?? "").trim() || (home.length > 0 ? join(home, ".local", "state") : "");
  return stateHome.length > 0 ? join(stateHome, "collie-pane-locks") : null;
}

/** A pane lock in `dir`, or null (and one log line) when the folder cannot be made: the in-memory lock alone. */
export function openPaneLock(options: PaneLockOptions): PaneLockFiles | null {
  try {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    return new PaneLockFiles(options);
  } catch (err) {
    options.log?.(`[pane-lock] no shared pane lock (${options.dir}: ${errText(err)}); each bridge keeps its own lock only`);
    return null;
  }
}

function errText<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/** The errno code of a thrown file error, or undefined. */
function codeOf<T>(err: T): string | undefined {
  return err instanceof Error && "code" in err ? String(err.code) : undefined;
}

function parseBody(raw: string): LockBody | null {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue; every field is checked below.
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  const node = asJsonObject(parsed);
  if (node === undefined || node.v !== 1) return null;
  const pid = asJsonNumber(node.pid);
  const at = asJsonNumber(node.at);
  const until = asJsonNumber(node.until);
  const start = node.start === null ? null : asJsonString(node.start);
  if (pid === undefined || at === undefined || until === undefined || start === undefined) return null;
  return { v: 1, pid, start, at, until };
}

/** What this process holds on one pane: its holders and the `until` the file says. */
interface Held {
  readonly owners: Map<string, number>;
  fileUntil: number;
  /** The exact bytes this process wrote, so a release removes only its own file. */
  raw: string;
}

/** The shared pane lock of one multiplexer scope. Every call is synchronous: a take sits between two checks of the in-memory lock. */
export class PaneLockFiles {
  private readonly held = new Map<string, Held>();
  private readonly pid: number;
  private readonly start: string | null;
  private readonly now: () => number;
  private readonly startOf: (pid: number) => string | null;
  private readonly alive: (pid: number) => boolean;
  private warned = false;
  /** The folder was made again during this take ({@link writeTemp}): at most once per take. */
  private remade = false;

  constructor(private readonly options: PaneLockOptions) {
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.startOf = options.startOf ?? processStart;
    this.alive = options.alive ?? processAlive;
    this.start = this.startOf(this.pid);
  }

  /** The lock file of a pane. */
  pathOf(paneId: string): string {
    const name = createHash("sha256").update(this.options.scope).update("\u0000").update(paneId).digest("hex").slice(0, 32);
    return join(this.options.dir, `${name}.lock`);
  }

  /**
   * Take the pane for `owner` until `until`, or false when another live bridge holds it. A second owner in
   * this process joins the hold. A file call that fails answers true (the pane counts as free here) and
   * logs once: the lock must never fail a send that the in-memory lock lets go.
   */
  take(paneId: string, owner: string, until: number): boolean {
    this.remade = false;
    const mine = this.held.get(paneId);
    if (mine !== undefined) {
      // Past its `until` another bridge may have taken the file over: join only while it is still ours.
      if (this.now() > mine.fileUntil && !this.stillMine(paneId, mine, until)) return false;
      mine.owners.set(owner, until);
      if (until > mine.fileUntil) this.extend(paneId, mine, until);
      return true;
    }
    try {
      const raw = this.acquire(paneId, until);
      if (raw === null) return false;
      this.held.set(paneId, { owners: new Map([[owner, until]]), fileUntil: until, raw });
      return true;
    } catch (err) {
      this.warn(err);
      return true;
    }
  }

  /**
   * Whether the file still holds this process's bytes, for a hold past its `until`. A file that is gone is
   * taken again (with the later of the hold's ends); one another bridge wrote is not this process's any
   * more. A failing file call answers true, as every file failure here does.
   */
  private stillMine(paneId: string, mine: Held, until: number): boolean {
    try {
      const path = this.pathOf(paneId);
      const now = this.readRaw(path);
      if (now === mine.raw) return true;
      if (now !== null) return false;
      const raw = this.body(Math.max(until, ...mine.owners.values()));
      if (!this.create(path, raw)) return false;
      mine.raw = raw;
      mine.fileUntil = Math.max(until, ...mine.owners.values());
      return true;
    } catch (err) {
      this.warn(err);
      return true;
    }
  }

  /** `owner` lets go; the file goes with the last holder of this process. */
  release(paneId: string, owner: string): void {
    const mine = this.held.get(paneId);
    if (mine === undefined || !mine.owners.delete(owner)) return;
    if (mine.owners.size > 0) return;
    this.held.delete(paneId);
    try {
      this.removeOwn(paneId, mine.raw);
    } catch (err) {
      this.warn(err);
    }
  }

  /** Whether a live bridge other than this one holds the pane. */
  heldElsewhere(paneId: string): boolean {
    if (this.held.has(paneId)) return false;
    const body = this.read(this.pathOf(paneId));
    return body !== null && body !== "missing" && !this.stale(body) && !this.isMe(body);
  }

  // ── The file calls ──

  private body(until: number): string {
    const body: LockBody = { v: 1, pid: this.pid, start: this.start, at: this.now(), until };
    return `${JSON.stringify(body)}\n`;
  }

  /** The tail of a temp file's name beside its target: this pid and a random tag, so two writers never share one. */
  private tag(): string {
    return `${String(this.pid)}.${randomBytes(4).toString("hex")}.tmp`;
  }

  /** The lock taken (its bytes), or null when another live process holds it. */
  private acquire(paneId: string, until: number): string | null {
    const path = this.pathOf(paneId);
    const raw = this.body(until);
    if (this.create(path, raw)) return raw;
    const seen = this.readRaw(path);
    // Gone between the create and the read: one more create, never a loop.
    if (seen === null) return this.create(path, raw) ? raw : null;
    if (!this.staleRaw(path, seen)) return null;
    return this.takeOver(path, seen, raw);
  }

  /** Exclusive create with the whole content. False when the file exists. */
  private create(path: string, raw: string): boolean {
    const temp = `${path}.${this.tag()}`;
    this.writeTemp(temp, raw);
    try {
      linkSync(temp, path);
      return true;
    } catch (err) {
      if (codeOf(err) === "EEXIST") return false;
      // A file system with no hard links: the exclusive open. A reader may see it empty for a moment,
      // and an empty young file reads as held (staleRaw).
      return this.createOpen(path, raw);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* the temp is ours and harmless */
      }
    }
  }

  /** Write a temp file beside the lock; a folder removed at runtime is made again, once per take. */
  private writeTemp(temp: string, raw: string): void {
    try {
      writeFileSync(temp, raw, { mode: 0o600 });
    } catch (err) {
      if (codeOf(err) !== "ENOENT" || this.remade) throw err;
      this.remade = true;
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      this.options.log?.(`[pane-lock] the pane lock folder was gone; made it again (${this.options.dir})`);
      writeFileSync(temp, raw, { mode: 0o600 });
    }
  }

  private createOpen(path: string, raw: string): boolean {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if (codeOf(err) === "EEXIST") return false;
      throw err;
    }
    try {
      writeSync(fd, raw);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /** Replace a stale lock under the takeover mutex; null when the mutex or a fresh lock is in the way. */
  private takeOver(path: string, seen: string, raw: string): string | null {
    if (!this.lockMutex(path)) return null;
    try {
      const again = this.readRaw(path);
      if (again === null) return this.create(path, raw) ? raw : null;
      // Someone took it in between (the content moved) and it is not stale: theirs.
      if (again !== seen && !this.staleRaw(path, again)) return null;
      const temp = `${path}.${this.tag()}`;
      writeFileSync(temp, raw, { mode: 0o600 });
      renameSync(temp, path);
      this.options.log?.(`[pane-lock] took over a stale pane lock (${path})`);
      return raw;
    } finally {
      this.unlockMutex(path);
    }
  }

  /** Rewrite this process's own lock with a later `until` (a request whose bound grew). */
  private extend(paneId: string, mine: Held, until: number): void {
    try {
      const path = this.pathOf(paneId);
      if (this.readRaw(path) !== mine.raw) return;
      const raw = this.body(until);
      const temp = `${path}.${this.tag()}`;
      writeFileSync(temp, raw, { mode: 0o600 });
      renameSync(temp, path);
      mine.raw = raw;
      mine.fileUntil = until;
    } catch (err) {
      this.warn(err);
    }
  }

  /** Remove the lock when it still holds these exact bytes, under the mutex when it can be had. */
  private removeOwn(paneId: string, raw: string): void {
    const path = this.pathOf(paneId);
    const locked = this.lockMutex(path);
    try {
      if (this.readRaw(path) === raw) unlinkSync(path);
    } finally {
      if (locked) this.unlockMutex(path);
    }
  }

  /** The takeover mutex: an exclusive create; one left by a crash (older than TAKE_STALE_MS) is moved aside once. */
  private lockMutex(path: string): boolean {
    const mutex = `${path}.take`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        closeSync(openSync(mutex, "wx", 0o600));
        return true;
      } catch (err) {
        if (codeOf(err) !== "EEXIST") throw err;
      }
      if (attempt > 0 || !this.oldMutex(mutex)) return false;
      const aside = `${mutex}.${this.tag()}`;
      try {
        renameSync(mutex, aside);
      } catch {
        return false;
      }
      // Moved a fresh mutex of a third bridge by a race: put it back and give way.
      if (!this.oldMutex(aside)) {
        try {
          linkSync(aside, mutex);
        } catch {
          /* it is back, or another one stands there: either way not ours */
        }
        unlinkSync(aside);
        return false;
      }
      unlinkSync(aside);
    }
    return false;
  }

  private oldMutex(path: string): boolean {
    try {
      return this.now() - statSync(path).mtimeMs > TAKE_STALE_MS;
    } catch {
      return false;
    }
  }

  private unlockMutex(path: string): void {
    try {
      unlinkSync(`${path}.take`);
    } catch {
      /* gone already */
    }
  }

  // ── Reading ──

  private readRaw(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if (codeOf(err) === "ENOENT") return null;
      throw err;
    }
  }

  private read(path: string): LockBody | null | "missing" {
    try {
      const raw = this.readRaw(path);
      return raw === null ? "missing" : parseBody(raw);
    } catch (err) {
      this.warn(err);
      return "missing";
    }
  }

  private isMe(body: LockBody): boolean {
    return body.pid === this.pid && (body.start === null || this.start === null || body.start === this.start);
  }

  /** Whether a lock's owner is gone or its span ran out (see the header). */
  private stale(body: LockBody): boolean {
    const now = this.now();
    if (now > body.until + STALE_MARGIN_MS) return true;
    if (body.until - now > MAX_SPAN_MS) return true;
    if (!this.alive(body.pid)) return true;
    if (body.start === null) return false;
    const start = body.pid === this.pid ? this.start : this.startOf(body.pid);
    return start !== null && start !== body.start;
  }

  /** {@link stale} on a file's bytes: this process's own leftover, or a body that does not parse and is old. */
  private staleRaw(path: string, raw: string): boolean {
    const body = parseBody(raw);
    if (body === null) {
      // An empty or torn file: a create by the exclusive open that has not written yet reads held, one left long ago stale.
      try {
        return this.now() - statSync(path).mtimeMs > STALE_MARGIN_MS;
      } catch {
        return false;
      }
    }
    // This process holds no such lock (else `take` had joined it): a leftover of a release that failed.
    if (this.isMe(body)) return true;
    return this.stale(body);
  }

  private warn<T>(err: T): void {
    if (this.warned) return;
    this.warned = true;
    this.options.log?.(`[pane-lock] a pane lock file call failed (${errText(err)}); the in-memory lock still holds`);
  }
}
