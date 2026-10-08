// WHICH BRANCH A PANE'S FOLDER IS ON, read off disk, for every multiplexer alike.
//
// The snapshot names a pane by its workspace, its tab and its folder, and never by the one fact that
// tells two checkouts of one repo apart: the branch. This module answers it for any folder, and it
// does so without git. A process per pane per poll would cost a fork on every phone poll for every
// pane, and `git status` and its kin may take `index.lock` against an agent that is committing in
// the same checkout. So the read is two small files and nothing else: the `.git` entry found by
// walking up from the folder (a directory, or in a linked worktree or a submodule a FILE that says
// `gitdir: <path>`), then that git dir's `HEAD`, which is `ref: refs/heads/<name>` on a branch and a
// bare object name on a detached head. Packed refs do not matter: HEAD names the branch either way.
//
// ── IT NEVER BLOCKS A SNAPSHOT ──────────────────────────────────────────────────────────────────
// `localSnapshot` in server.ts is synchronous, so {@link GitHeads.get} is too: it answers from the
// cache and never touches the disk. A missing or stale answer schedules a read in the background and
// the NEXT snapshot carries it; the first snapshot after a folder appears carries nothing, which the
// phone renders as exactly what it showed before the field existed. The state engine's poll also
// asks ({@link GitHeads.refresh}, fired and not awaited in bridge/index.ts), so the cache is usually
// warm before a phone asks at all. Herdr's own repo lookup (mux/herdr/adapter.ts, `settleRepos`) is
// the shape this one avoids: that one is awaited inside the snapshot and is never asked again.
//
// ── TWO CACHES, TWO CLOCKS ──────────────────────────────────────────────────────────────────────
// Which git dir a folder belongs to changes rarely (a `git init`, a clone, a removed worktree), so a
// folder's git dir is re-resolved every {@link GIT_DIR_TTL_MS}. Which branch a git dir is on changes
// whenever someone runs `git switch`, so HEAD is re-read every {@link GIT_HEAD_TTL_MS}, ONCE per git
// dir however many panes sit in it. A folder nobody has asked about for {@link GIT_FORGET_MS} is
// dropped, with every git dir no remaining folder points at.

import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** What a checkout is on: a branch by name, or a detached head at a full object name. */
export type GitHead = { kind: "branch"; name: string } | { kind: "detached"; sha: string };

/** How long a HEAD reading stands before the next ask reads the file again. */
export const GIT_HEAD_TTL_MS = 5_000;
/** How long a folder's git dir stands before it is resolved again. */
export const GIT_DIR_TTL_MS = 30_000;
/** A folder no snapshot has asked about for this long is forgotten. */
export const GIT_FORGET_MS = 5 * 60_000;

/** HEAD is one line. A longer file is not a HEAD this module will read. */
const HEAD_MAX_BYTES = 1024;
/** A `.git` FILE is one `gitdir:` line holding a path. */
const GIT_FILE_MAX_BYTES = 4096;
/** A ref name past this is not one worth printing, and not one git would make by hand. */
const NAME_MAX = 255;
/** The walk up from a folder stops here even if the root is further, so a loop cannot run away. */
const MAX_DEPTH = 64;

/**
 * The disk, as narrow as this module needs it: what a path is, and the head of a small file. Both
 * answer `null` for anything that is not a plain answer (missing, unreadable, a permission error), so
 * the walk above them has no error branch to forget.
 */
export interface GitHeadDisk {
  kind(path: string): Promise<"file" | "dir" | null>;
  readHead(path: string, maxBytes: number): Promise<string | null>;
}

/** The real disk. Reads at most `maxBytes`, takes no lock, writes nothing. */
export const nodeGitHeadDisk: GitHeadDisk = {
  async kind(path) {
    try {
      const s = await stat(path);
      if (s.isDirectory()) return "dir";
      return s.isFile() ? "file" : null;
    } catch {
      return null;
    }
  },
  async readHead(path, maxBytes) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};

/** A C0 control character or DEL anywhere in a name: not a ref git made, and not one to print. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
    // Bidi overrides and isolates: a name from a repo you did not write could reorder the row's text.
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * One HEAD file's text as a {@link GitHead}, or `null` when it is neither shape.
 *
 * `ref: refs/heads/<name>` is a branch, unborn or not (a fresh repo's HEAD already names its first
 * branch). Any other `ref:` keeps the ref as written, which is what git itself prints for one. A bare
 * SHA-1 or SHA-256 object name is a detached head.
 */
export function parseHead(text: string): GitHead | null {
  const line = text.trim();
  if (line.startsWith("ref:")) {
    const ref = line.slice(4).trim();
    // Only a ref git itself could write. A `.git` file can point at any folder, so a HEAD there is
    // any file; this keeps its text from reaching the phone unless it reads like a ref.
    if (!ref.startsWith("refs/")) return null;
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    if (name.length === 0 || name.length > NAME_MAX || hasControl(name)) return null;
    return { kind: "branch", name };
  }
  return OBJECT_NAME.test(line) ? { kind: "detached", sha: line } : null;
}

/**
 * The git dir a `.git` FILE points at, resolved against the folder that holds the file, or `null`.
 *
 * A linked worktree writes an absolute path there and a submodule a relative one
 * (`gitdir: ../.git/modules/sub`); both resolve the same way.
 */
export function parseGitFile(text: string, folder: string): string | null {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first.startsWith("gitdir:")) return null;
  const target = first.slice("gitdir:".length).trim();
  if (target.length === 0 || hasControl(target)) return null;
  return isAbsolute(target) ? target : resolve(folder, target);
}

/**
 * The git dir a folder's checkout uses, or `null` when the folder is in no checkout.
 *
 * Walks up from the folder to the first `.git`. A folder that does not exist answers `null` rather
 * than the repo above it. A level that is itself a git dir (a bare repo, or somewhere inside `.git`)
 * stops the walk with `null` too: there is no working folder there, so there is no branch to show.
 */
export async function findGitDir(folder: string, disk: GitHeadDisk = nodeGitHeadDisk): Promise<string | null> {
  if (!isAbsolute(folder) || (await disk.kind(folder)) !== "dir") return null;
  let dir = folder;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const dotGit = join(dir, ".git");
    const kind = await disk.kind(dotGit);
    if (kind === "dir") return dotGit;
    if (kind === "file") {
      const text = await disk.readHead(dotGit, GIT_FILE_MAX_BYTES);
      return text === null ? null : parseGitFile(text, dir);
    }
    if ((await disk.kind(join(dir, "HEAD"))) === "file" && (await disk.kind(join(dir, "objects"))) === "dir") {
      return null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** The HEAD of one git dir, or `null` when it cannot be read or is not a HEAD. */
export async function readGitHead(gitDir: string, disk: GitHeadDisk = nodeGitHeadDisk): Promise<GitHead | null> {
  const text = await disk.readHead(join(gitDir, "HEAD"), HEAD_MAX_BYTES);
  return text === null ? null : parseHead(text);
}

interface FolderEntry {
  gitDir: string | null;
  resolvedAt: number;
  askedAt: number;
}

interface HeadEntry {
  head: GitHead | null;
  readAt: number;
}

/** What server.ts reads at serialise time. */
export interface GitHeadSurface {
  get(folder: string): GitHead | undefined;
}

/**
 * The branch of every folder a snapshot names, from memory, kept fresh in the background.
 *
 * ONE object for the whole bridge: every session runtime feeds it its panes' folders, and two panes
 * (in two sessions) in one checkout share one HEAD read.
 */
export class GitHeads implements GitHeadSurface {
  private readonly folders = new Map<string, FolderEntry>();
  private readonly heads = new Map<string, HeadEntry>();
  /** Folder reads in flight, so two overlapping asks walk the disk once. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** HEAD reads in flight, by git dir, so two folders of one checkout read it once. */
  private readonly headReads = new Map<string, Promise<void>>();

  constructor(
    private readonly disk: GitHeadDisk = nodeGitHeadDisk,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The folder's head as last read, or `undefined` when there is none yet or none at all. Never
   * waits: a missing or stale reading starts a background read and this call answers from memory.
   */
  get(folder: string): GitHead | undefined {
    if (!isAbsolute(folder)) return undefined;
    const at = this.now();
    const entry = this.folders.get(folder);
    if (entry !== undefined) entry.askedAt = at;
    if (this.stale(folder, at)) void this.settle(folder);
    if (entry === undefined || entry.gitDir === null) return undefined;
    return this.heads.get(entry.gitDir)?.head ?? undefined;
  }

  /**
   * Bring every folder in `folders` up to date, and forget the ones nobody asked about lately.
   * Never throws. The poll fires it without awaiting; a test awaits it to see the result.
   */
  async refresh(folders: readonly string[]): Promise<void> {
    const at = this.now();
    this.forget(at);
    const pending: Promise<void>[] = [];
    for (const folder of new Set(folders)) {
      if (!isAbsolute(folder)) continue;
      const entry = this.folders.get(folder);
      if (entry !== undefined) entry.askedAt = at;
      if (this.stale(folder, at)) pending.push(this.settle(folder));
    }
    await Promise.all(pending);
  }

  /** Whether the folder's git dir or its HEAD reading is missing or past its clock. */
  private stale(folder: string, at: number): boolean {
    const entry = this.folders.get(folder);
    if (entry === undefined || at - entry.resolvedAt >= GIT_DIR_TTL_MS) return true;
    if (entry.gitDir === null) return false;
    const head = this.heads.get(entry.gitDir);
    return head === undefined || at - head.readAt >= GIT_HEAD_TTL_MS;
  }

  /** One folder's read, deduplicated while in flight. */
  private settle(folder: string): Promise<void> {
    const running = this.inFlight.get(folder);
    if (running !== undefined) return running;
    const work = this.read(folder)
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(folder));
    this.inFlight.set(folder, work);
    return work;
  }

  private async read(folder: string): Promise<void> {
    let entry = this.folders.get(folder);
    if (entry === undefined || this.now() - entry.resolvedAt >= GIT_DIR_TTL_MS) {
      const gitDir = await findGitDir(folder, this.disk);
      entry = { gitDir, resolvedAt: this.now(), askedAt: entry?.askedAt ?? this.now() };
      this.folders.set(folder, entry);
    }
    const gitDir = entry.gitDir;
    if (gitDir === null) return;
    const cached = this.heads.get(gitDir);
    if (cached !== undefined && this.now() - cached.readAt < GIT_HEAD_TTL_MS) return;
    const running = this.headReads.get(gitDir);
    if (running !== undefined) return running;
    const work = this.readHeadOf(gitDir).finally(() => this.headReads.delete(gitDir));
    this.headReads.set(gitDir, work);
    return work;
  }

  private async readHeadOf(gitDir: string): Promise<void> {
    const head = await readGitHead(gitDir, this.disk);
    this.heads.set(gitDir, { head, readAt: this.now() });
  }

  private forget(at: number): void {
    for (const [folder, entry] of this.folders) if (at - entry.askedAt >= GIT_FORGET_MS) this.folders.delete(folder);
    const used = new Set<string>();
    for (const entry of this.folders.values()) if (entry.gitDir !== null) used.add(entry.gitDir);
    for (const gitDir of this.heads.keys()) if (!used.has(gitDir)) this.heads.delete(gitDir);
  }
}
