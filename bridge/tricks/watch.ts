import { statSync, realpathSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// THE FILE WATCH OF A TRICK (M105 spec 03, decision 10): `watch = [...]` in `trick.toml` runs the trick when
// one of those files changes. One `TrickWatch` per trick that is on and lists paths; the runner
// (bridge/tricks/triggers.ts) owns it and turns a change into a run request.
//
// THE PARENT FOLDER, FILTERED BY NAME. An editor saves by writing a temporary file and renaming it over
// the old one, so a watch on the file itself would follow the old, deleted file and go silent. The watch is
// on the FOLDER (`fs.watch`), and an event counts only when its file name is the one watched.
//
// REAL PATHS. Each path is resolved with `realpath` when the watch starts, and again whenever a change shows
// up or a poll runs: a link may be retargeted. Two folders are watched for a link: the real file's folder
// (filtered by the real name) and the folder the path itself sits in (filtered by the path's own name, the
// link). A link made in that folder is therefore noticed, and the watch moves to the new target. The
// trigger keeps naming the path as the manifest wrote it. A folder that is a link itself is followed once, at
// the resolve; retargeting THAT link is noticed at the next change of the file, or not at all.
//
// A PATH THAT IS NOT THERE. If its folder exists, the folder is watched and the file's creation fires. If the
// folder is missing too, that path is checked every {@link WATCH_POLL_MS} until the folder appears.
//
// DEBOUNCE. A change waits {@link WATCH_DEBOUNCE_MS} after the LAST change in the burst, and never longer
// than {@link WATCH_MAX_WAIT_MS} after the FIRST, so a steady stream still fires at least every 2 s.
//
// A CHANGE IS A DIFFERENT STAT. Each file's (mtime in nanoseconds, size, inode) is kept. An event only
// SAYS something may have changed; a run is asked for only when the stat now differs from the one kept,
// and the stat kept moves when it fires. So a stream of events about one write fires once.
//
// A TRICK THAT WRITES THE FILE IT WATCHES must not loop. The runner calls {@link TrickWatch.recordOwn}
// right after each of the trick's own runs ends: the stats kept become the stats now, and what was waiting
// to fire is dropped. A write the run made is absorbed. So is an OUTSIDE write that landed during the run:
// the next change after the run ends fires. Both are documented in docs/tricks-reference.md.
//
// WHEN `fs.watch` CANNOT BE SET UP (ENOSPC and EMFILE are the usual, EPERM and anything else count too):
// the whole watch falls back to a check of every file's stat each {@link WATCH_POLL_MS}, and the runner is
// told once, with the system's error code, which only the bridge's log keeps: the trick's row says it in
// the phone's own words, with no code in them (`watchPollSeconds` on the trick's wire entry).

/** The wait after the last change of a burst. */
export const WATCH_DEBOUNCE_MS = 300;
/** The longest a change waits, counted from the first of its burst. */
export const WATCH_MAX_WAIT_MS = 2000;
/** The interval of the check that stands in for a watch, and of the check for a folder that is not there yet. */
export const WATCH_POLL_MS = 5000;

/** An open `fs.watch`. */
export interface FsWatchHandle {
  close(): void;
}

/** Open a watch on one folder. Throws when it cannot. `name` is the changed file's name, or null when the system gave none. */
export type WatchFactory = (dir: string, onEvent: (name: string | null) => void, onError: (err: Error) => void) => FsWatchHandle;

const systemFactory: WatchFactory = (dir, onEvent, onError) => {
  const handle = fsWatch(dir, { persistent: false, encoding: "utf8" }, (_type, name) => onEvent(name === "" || name === null ? null : name));
  handle.on("error", onError);
  return { close: () => handle.close() };
};

/** The knobs a test turns. Every field has the production value. */
export interface WatchOptions {
  factory?: WatchFactory;
  debounceMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
  /** The home folder `~/` stands for. Default: the bridge user's. */
  home?: () => string;
  /** A file's stat signature, or `"absent"`. Default: size, inode and mtime in nanoseconds. */
  signature?: (path: string) => string;
  /** The real path of a path, or null when it does not exist. Default: `fs.realpathSync`. */
  realpath?: (path: string) => string | null;
  now?: () => number;
}

function systemSignature(path: string): string {
  const st = statSync(path, { bigint: true, throwIfNoEntry: false });
  return st === undefined ? "absent" : `${String(st.mtimeNs)}:${String(st.size)}:${String(st.ino)}`;
}

function systemRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // A missing path, a loop or a denied step all mean "no real path now": the poll looks again.
    return null;
  }
}

/** The absolute path a manifest's path names: `~/x` is under the home folder. */
export function expandWatchPath(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** What a watch holds open. */
export interface OpenCounts {
  handles: number;
  timers: number;
}

/** What one fire says: the first changed path as the manifest wrote it, and how many paths changed. */
export interface WatchFire {
  path: string;
  count: number;
}

interface Point {
  readonly dir: string;
  readonly name: string;
}

interface FileState {
  readonly written: string;
  readonly abs: string;
  /** The folders and names whose events mean this file may have changed. Empty while no folder of it exists. */
  points: Point[];
  sig: string;
}

type Timer = ReturnType<typeof setTimeout>;

export class TrickWatch {
  private readonly files: FileState[];
  private readonly handles = new Map<string, FsWatchHandle>();
  private readonly dirty = new Set<FileState>();
  private readonly factory: WatchFactory;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly signature: (path: string) => string;
  private readonly realpath: (path: string) => string | null;
  private readonly now: () => number;
  private firstAt: number | null = null;
  private debounce: Timer | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private fallback = false;
  private closed = false;

  constructor(
    paths: readonly string[],
    private readonly onFire: (fire: WatchFire) => void,
    /** Told once when the watch falls back to the poll; `why` is the system's error code, or a short word. */
    private readonly onFallback: (why: string) => void,
    opts: WatchOptions = {},
  ) {
    const home = (opts.home ?? homedir)();
    this.factory = opts.factory ?? systemFactory;
    this.debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? WATCH_MAX_WAIT_MS;
    this.pollMs = opts.pollMs ?? WATCH_POLL_MS;
    this.signature = opts.signature ?? systemSignature;
    this.realpath = opts.realpath ?? systemRealpath;
    this.now = opts.now ?? Date.now;
    this.files = [...new Set(paths)].map((written) => ({ written, abs: expandWatchPath(written, home), points: [], sig: "absent" }));
  }

  /** Resolve every path, keep the stats as they are now, and open the watches. A change that already happened fires nothing. */
  start(): void {
    for (const file of this.files) {
      this.resolve(file);
      file.sig = this.signature(file.abs);
    }
    this.syncHandles();
    this.syncPoll();
  }

  /** How many `fs.watch` handles and timers are open: for a test. */
  open(): OpenCounts {
    return { handles: this.handles.size, timers: (this.debounce === null ? 0 : 1) + (this.poll === null ? 0 : 1) };
  }

  /** Whether the watch fell back to the stat check. */
  get polling(): boolean {
    return this.fallback;
  }

  /** The trick's own run ended: its writes, and any write that landed meanwhile, are absorbed. */
  recordOwn(): void {
    if (this.closed) return;
    this.cancelDebounce();
    this.dirty.clear();
    for (const file of this.files) {
      this.resolve(file);
      file.sig = this.signature(file.abs);
    }
    this.syncHandles();
    this.syncPoll();
  }

  close(): void {
    this.closed = true;
    this.cancelDebounce();
    this.dirty.clear();
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }

  /** The folders and names that stand for `file` now. */
  private resolve(file: FileState): void {
    const parent = this.realpath(dirname(file.abs));
    const own = this.realpath(file.abs);
    const points: Point[] = [];
    if (parent !== null) points.push({ dir: parent, name: basename(file.abs) });
    if (own !== null) points.push({ dir: dirname(own), name: basename(own) });
    file.points = points.filter((point, at) => points.findIndex((other) => other.dir === point.dir && other.name === point.name) === at);
  }

  /** Make the open handles the folders the files need, or fall back when one cannot open. */
  private syncHandles(): void {
    if (this.closed) return;
    const wanted = this.fallback ? new Set<string>() : new Set(this.files.flatMap((file) => file.points.map((point) => point.dir)));
    for (const [dir, handle] of this.handles) {
      if (wanted.has(dir)) continue;
      handle.close();
      this.handles.delete(dir);
    }
    for (const dir of wanted) {
      if (this.handles.has(dir)) continue;
      try {
        this.handles.set(dir, this.factory(dir, (name) => this.onEvent(dir, name), (err) => this.enterFallback(errorWord(err.message))));
      } catch (err) {
        this.enterFallback(errorWord(err instanceof Error ? err.message : String(err)));
        return;
      }
    }
  }

  /** The stat check: on while the watch fell back, or while a file has no folder yet. */
  private syncPoll(): void {
    if (this.closed) return;
    const needed = this.fallback || this.files.some((file) => file.points.length === 0);
    if (needed && this.poll === null) {
      this.poll = setInterval(() => this.onPoll(), this.pollMs);
      this.poll.unref?.();
    }
    if (!needed && this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  private enterFallback(why: string): void {
    if (this.closed || this.fallback) return;
    this.fallback = true;
    this.syncHandles();
    this.syncPoll();
    this.onFallback(why);
  }

  private onEvent(dir: string, name: string | null): void {
    if (this.closed) return;
    const hit = this.files.filter((file) => file.points.some((point) => point.dir === dir && (name === null || point.name === name)));
    if (hit.length === 0) return;
    for (const file of hit) this.dirty.add(file);
    const at = this.now();
    this.firstAt ??= at;
    if (this.debounce !== null) clearTimeout(this.debounce);
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - (at - this.firstAt)));
    this.debounce = setTimeout(() => this.flush(), wait);
    this.debounce.unref?.();
  }

  private cancelDebounce(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    this.firstAt = null;
  }

  /** The burst is over: look again at what the events named, and ask for a run when a stat moved. */
  private flush(): void {
    this.debounce = null;
    this.firstAt = null;
    if (this.closed) return;
    const named = [...this.dirty];
    this.dirty.clear();
    for (const file of named) this.resolve(file);
    this.syncHandles();
    this.syncPoll();
    this.fireChanged(named);
  }

  private onPoll(): void {
    if (this.closed) return;
    for (const file of this.files) if (this.fallback || file.points.length === 0) this.resolve(file);
    this.syncHandles();
    this.syncPoll();
    this.fireChanged(this.files);
  }

  /** Ask for one run for the files whose stat differs from the kept one, and keep the new one. */
  private fireChanged(files: readonly FileState[]): void {
    const changed: FileState[] = [];
    for (const file of files) {
      const now = this.signature(file.abs);
      if (now === file.sig) continue;
      file.sig = now;
      changed.push(file);
    }
    const first = changed[0];
    if (first !== undefined) this.onFire({ path: first.written, count: changed.length });
  }
}

/** The system's error code, which an error's message starts with (`ENOSPC: no space left...`), or a short word. */
function errorWord(message: string): string {
  return /^([A-Z][A-Z0-9_]{1,23}):/u.exec(message)?.[1] ?? "an error";
}
