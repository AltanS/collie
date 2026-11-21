import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, rm, unlink, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import { APPROVED_DIR, PENDING_DIR, tricksConfigDir, tricksStateDir } from "./paths.ts";
import { withSwitchLock } from "./switches.ts";

// ── SETTING A TRICK'S PATHS ASIDE, WITH ONE COMMIT POINT (ADR 0168, point 5) ──────────────────────────────
//
// A remove (remove.ts) and a leftover forget before an add (approved.ts `forgetLeftovers`) never delete inside the
// switch file's lock: they RENAME each path aside, to `.gone-<id>-<token>` beside it, and delete after the unlock.
// One batch shares one token. After its last rename (and its switch write, when it has one) the batch is COMMITTED:
// one small file, `<stateDir>/tricks/.aside-commits/<id>-<token>`, written and synced inside the lock. That file is
// the only thing that lets an aside be deleted, now or later:
//
//   * BEFORE THE COMMIT any failure puts every path back (`putBack`), newest first. A path that cannot go back is
//     named with both its paths in the error and in the log, never swallowed.
//   * AFTER THE COMMIT the batch has happened: each delete runs on its own (`finishAside`), a failure is logged and
//     returned as a leftover, and the commit file stays until the last aside is gone.
//   * AT THE BRIDGE'S START (`sweepGone`) a committed aside is deleted. An uncommitted one (a crash between the
//     renames, or a put-back that failed) is renamed back when its original name is free, and otherwise left
//     where it is and logged. So a crash before the commit leaves the trick as it was after the next start.
//
// The sweep reads only names of exactly the shape `moveAside` makes (`isGoneName`), so a person's own folder that
// starts with `.gone-` is never touched.

/** The prefix of a path set aside. Never a trick id: ids hold no dot. */
export const GONE_PREFIX = ".gone-";

/** How many random bytes a batch's token carries, written as hex. */
const GONE_RANDOM_BYTES = 6;
const GONE_NAME = new RegExp(`^${GONE_PREFIX.replace(".", "\\.")}(.+)-([0-9a-f]{${String(GONE_RANDOM_BYTES * 2)}})$`, "u");

/** The folder of commit files inside `<stateDir>/tricks/`. A dotted name: never a trick id, never a gone name. */
export const ASIDE_COMMITS_DIR = ".aside-commits";

/** A fresh token for one batch of renames. */
export function newAsideToken(): string {
  return randomBytes(GONE_RANDOM_BYTES).toString("hex");
}

/** The trick id and the token of a set-aside name, or null when `name` is not exactly what {@link moveAside} makes. */
export function goneParts(name: string): { id: string; token: string } | null {
  const m = GONE_NAME.exec(name);
  const id = m?.[1] ?? "";
  const token = m?.[2] ?? "";
  return m !== null && isTrickId(id) ? { id, token } : null;
}

/** Whether `name` is exactly what {@link moveAside} makes: `.gone-<a trick id>-<12 hex>`. */
export function isGoneName(name: string): boolean {
  return goneParts(name) !== null;
}

/** Rename `path` to its sibling `.gone-<id>-<token>`. Its new name, or null when nothing was there. */
export async function moveAside(path: string, id: string, token: string = newAsideToken()): Promise<string | null> {
  const to = join(dirname(path), `${GONE_PREFIX}${id}-${token}`);
  try {
    await rename(path, to);
    return to;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** One path renamed aside, and where it came from. */
export interface Moved {
  from: string;
  to: string;
}

function messageOf<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Put back what a batch moved, newest first. Every path that cannot go back is logged with both its paths and
 * named in the answer; an empty answer means all went back. Never throws.
 */
export async function putBack(moved: readonly Moved[], warn: (line: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const one of moved.toReversed()) {
    try {
      await rename(one.to, one.from);
    } catch (err) {
      const line = `${one.to} could not be put back at ${one.from}: ${messageOf(err)}`;
      warn(line);
      failed.push(line);
    }
  }
  return failed;
}

export function asideCommitPath(stateDir: string, id: string, token: string): string {
  return join(tricksStateDir(stateDir), ASIDE_COMMITS_DIR, `${id}-${token}`);
}

/** Sync a folder's entry list to disk where the platform allows it. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r").catch(() => null);
  if (handle === null) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}

/**
 * Commit a batch: from here on its asides are deleted, never put back. Written exclusively and synced, with its
 * folder, so a crash right after this answer still finds it. Throws when it cannot be written: the caller then
 * puts the batch back.
 */
export async function commitAside(stateDir: string, id: string, token: string): Promise<void> {
  const dir = join(tricksStateDir(stateDir), ASIDE_COMMITS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = await open(asideCommitPath(stateDir, id, token), "wx", 0o600);
  try {
    await handle.writeFile(`${id} ${token}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDir(dir);
}

async function committed(stateDir: string, id: string, token: string): Promise<boolean> {
  return (await lstat(asideCommitPath(stateDir, id, token)).catch(() => null)) !== null;
}

/** Delete one path, and answer why it is still there, or null when it is gone. Never throws, never follows a link. */
async function deletePath(path: string): Promise<string | null> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    return messageOf(err);
  }
  return (await lstat(path).catch(() => null)) === null ? null : "it is still there";
}

/**
 * After the commit: delete each aside on its own, so one that fails does not keep the others. Answers the paths
 * still there (each logged); the next start's sweep finishes them. The commit file goes once none is left.
 */
export async function finishAside(opts: { stateDir: string; id: string; token: string; paths: readonly string[]; warn: (line: string) => void }): Promise<string[]> {
  const left: string[] = [];
  for (const path of opts.paths) {
    const why = await deletePath(path);
    if (why === null) continue;
    opts.warn(`${path} could not be deleted (${why}); the next start deletes it`);
    left.push(path);
  }
  if (left.length === 0) await unlink(asideCommitPath(opts.stateDir, opts.id, opts.token)).catch(() => {});
  return left;
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** What one sweep did. */
export interface SweepResult {
  /** Committed asides deleted. */
  removed: number;
  /** Uncommitted asides renamed back to their original name. */
  restored: number;
  /** Asides left where they are: uncommitted with their original name taken, or a delete or rename that failed. */
  kept: number;
}

/**
 * At the bridge's start: finish what a crash or a failure left in the four folders a batch renames inside (the
 * tricks folder itself, the state folder's `tricks/`, the approved and the pending folders). A committed aside is
 * deleted; an uncommitted one goes back to its name when that name is free, else it stays and is logged. A commit
 * file with no aside left goes. Never throws.
 */
export async function sweepGone(opts: { stateDir: string; configDir: string; warn?: (line: string) => void; listed?: () => Promise<void> }): Promise<SweepResult> {
  const warn = opts.warn ?? (() => {});
  const out: SweepResult = { removed: 0, restored: 0, kept: 0 };
  const found = await listGone(opts.stateDir, opts.configDir);
  // A seam for the tests: another process may commit a batch right after this listing.
  await opts.listed?.();
  const doomed: typeof found = [];
  const back: typeof found = [];
  for (const one of found) ((await committed(opts.stateDir, one.id, one.token)) ? doomed : back).push(one);
  // A put-back renames a folder into `<id>`, so it holds the switch file's lock, as an add and a remove do.
  if (back.length > 0) {
    try {
      await withSwitchLock(opts.stateDir, async () => {
        for (const one of back) {
          const original = join(one.parent, one.id);
          if ((await lstat(original).catch(() => null)) !== null) {
            warn(`${one.path} was set aside and not removed, and ${original} is there again, so it is left as it is`);
            out.kept += 1;
            continue;
          }
          try {
            await rename(one.path, original);
            out.restored += 1;
          } catch (err) {
            warn(`${one.path} could not be put back at ${original}: ${messageOf(err)}`);
            out.kept += 1;
          }
        }
      });
    } catch (err) {
      warn(`the set-aside folders could not be put back: ${messageOf(err)}`);
      out.kept += back.length - out.restored - out.kept;
    }
  }
  for (const one of doomed) {
    const why = await deletePath(one.path);
    if (why === null) {
      out.removed += 1;
      continue;
    }
    warn(`${one.path} could not be deleted (${why})`);
    out.kept += 1;
  }
  // A commit file goes only when, inside the lock that every commit is written in, a fresh listing shows no aside of
  // its batch: a batch another process committed after the first listing keeps its file while it deletes.
  try {
    await withSwitchLock(opts.stateDir, async () => {
      const held = new Set((await listGone(opts.stateDir, opts.configDir)).map((one) => `${one.id}-${one.token}`));
      const commits = join(tricksStateDir(opts.stateDir), ASIDE_COMMITS_DIR);
      for (const name of await names(commits)) if (!held.has(name)) await unlink(join(commits, name)).catch(() => {});
    });
  } catch (err) {
    warn(`the commit files of removed tricks could not be cleaned up: ${messageOf(err)}`);
  }
  return out;
}

/** Every set-aside name in the four folders a batch renames inside, with its parent, id and token. */
async function listGone(stateDir: string, configDir: string): Promise<{ path: string; parent: string; id: string; token: string }[]> {
  const root = tricksConfigDir(configDir);
  const found: { path: string; parent: string; id: string; token: string }[] = [];
  for (const parent of [root, tricksStateDir(stateDir), join(root, APPROVED_DIR), join(root, PENDING_DIR)]) {
    for (const name of await names(parent)) {
      const parts = goneParts(name);
      if (parts !== null) found.push({ path: join(parent, name), parent, ...parts });
    }
  }
  return found;
}
