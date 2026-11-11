import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CODE_DIRS_MAX, CODE_FILES_MAX, codeHashOfFiles, diskTrickFs, skippedName, trickCodeHash, walkTrickCode, type EntryKind } from "./code-hash.ts";
import { ORIGIN_FILE, renderProposalOrigin, type ProposalOrigin } from "./origin.ts";
import type { ProposedFile } from "./propose-wire.ts";

// A PROPOSED TRICK, WRITTEN INTO THE TRICKS FOLDER (crew slice 8). Two ways in, both on the lead and both
// only from the tricks runner's serial lane (service.ts), so no switch write or version change runs beside
// them:
//
//   * NEW: after the person's "Switch it on", the proposal's files become `<configDir>/tricks/<id>/`. They
//     are written into a staged sibling (`.collie-add-<id>-<hex>`, a dot folder the scanner never reads),
//     with the proposal record (origin.ts) beside them, then renamed into place. A folder of that name
//     that appeared since the card was made stops it: nothing is written over.
//   * A NEW VERSION of a trick a proposal made, after the person's "Use the new version": only the code
//     moves, file by file (`replaceTrickCode`). Everything the code hash does not read stays untouched.
//
// Folders are 0700 and files 0644, or 0755 for a file the proposal marked executable, as `collie trick
// add` writes them (cli/trick-add.ts). A path written twice is a bug, never an overwrite (`wx`).
//
// The From Collie list (official-install.ts) writes through the same two ways in (`writeNewTrick`,
// `replaceCode`), with its own origin record and the code hash the list expects (`expect`): code that
// hashes otherwise is refused, and nothing in the tricks folder changes.

/** A staged or set-aside sibling in the tricks folder. The scanner never reads a dot folder. */
export function proposalSideName(root: string, what: "add" | "old", id: string): string {
  return join(root, `.collie-${what}-${id}-${randomBytes(4).toString("hex")}`);
}

/** Write the files and the origin record's text into a fresh folder `dir`. */
async function writeStage(dir: string, files: readonly ProposedFile[], originText: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  for (const file of files) {
    const path = join(dir, file.rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
  }
  await writeFile(join(dir, ORIGIN_FILE), originText, { flag: "wx", mode: 0o600 });
}

/**
 * What a write into the tricks folder came to: the code hash the new folder holds, or why not. `code` names
 * the refusals a caller words on its own: `exists` (a folder of that name is there), `mismatch` (the stage
 * did not hash to `expect`).
 */
export type ProposalWrite = { ok: true; codeHash: string } | { ok: false; reason: string; code?: "exists" | "mismatch" };

/** The options of a write: the code hash the stage must have, or any. */
export interface CodeWriteOptions {
  expect?: string;
}

/** A stage that hashed otherwise than expected. Thrown inside a write, answered as `mismatch`. */
class StageMismatch extends Error {}

/** Hash a stage and hold it to `expect`. */
async function stageHash(stage: string, opts: CodeWriteOptions): Promise<string> {
  const hashed = await trickCodeHash(stage);
  if (!hashed.ok) throw new Error(hashed.reason);
  if (opts.expect !== undefined && hashed.hash !== opts.expect) throw new StageMismatch("The code does not hash to what was expected.");
  return hashed.hash;
}

/** The message of a thrown value. */
function why<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Make `<root>/<id>` from a proposal. Refused when anything named `<id>` is there. The code hash answered is
 * the staged folder's, taken before the rename, so the approval that follows can insist on exactly it.
 */
export async function writeProposedTrick(root: string, id: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<ProposalWrite> {
  return await writeNewTrick(root, id, files, renderProposalOrigin(origin));
}

/** A folder of that name that appeared after the first look. Answered as `exists`. */
class AppearedMeanwhile extends Error {}

/**
 * Make `<root>/<id>` from `files` and an origin record's text, through a staged sibling and one rename.
 * Refused when anything named `<id>` is there, before the write or just before the rename, so nothing is
 * ever written over a folder. With `expect`, a stage that hashes otherwise is removed and nothing is made.
 */
export async function writeNewTrick(root: string, id: string, files: readonly ProposedFile[], originText: string, opts: CodeWriteOptions = {}): Promise<ProposalWrite> {
  const target = join(root, id);
  if ((await lstat(target).catch(() => null)) !== null) return { ok: false, code: "exists", reason: `A trick named ${id} is here now, so nothing was written over it.` };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = proposalSideName(root, "add", id);
  try {
    await writeStage(stage, files, originText);
    const codeHash = await stageHash(stage, opts);
    // A rename onto a folder that appeared meanwhile fails when it holds anything; an empty one is replaced.
    if ((await lstat(target).catch(() => null)) !== null) throw new AppearedMeanwhile(`a trick named ${id} appeared meanwhile`);
    await rename(stage, target);
    return { ok: true, codeHash };
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    if (err instanceof StageMismatch) return { ok: false, code: "mismatch", reason: err.message };
    // A rename that lost the race to a folder with content says ENOTEMPTY or EEXIST: the same answer.
    const raced = err instanceof AppearedMeanwhile || (err instanceof Error && "code" in err && (err.code === "ENOTEMPTY" || err.code === "EEXIST"));
    if (raced) return { ok: false, code: "exists", reason: `A trick named ${id} is here now, so nothing was written over it.` };
    return { ok: false, reason: `The trick could not be written: ${why(err)}` };
  }
}

/** One entry of a trick folder as the version write sees it: a code file, or anything else (the person's). */
type FolderEntry = { kind: "dir" | "code" | "theirs" };

/** The most entries the version write looks at in a folder. */
const FOLDER_ENTRIES_MAX = CODE_FILES_MAX + CODE_DIRS_MAX;

/**
 * Every entry of `dir` by its relative path, `lstat` only, never through a link. A folder the code hash
 * walks is entered; anything the walk does not read (a dot name, `node_modules`, a `.log`, the top-level
 * `config.toml`, `media/`, `captures/`, `inputs/`, a link it passes over) is one opaque entry of the
 * person's, never entered. A code file is one `codeRels` lists. Null past the cap or on a read error.
 */
async function folderEntries(dir: string, codeRels: ReadonlySet<string>): Promise<Map<string, FolderEntry> | null> {
  const out = new Map<string, FolderEntry>();
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  for (let n = 0; queue.length > 0 && n < FOLDER_ENTRIES_MAX; n += 1) {
    const next = queue.shift();
    if (next === undefined) break;
    const listed = await readdir(next.rel === "" ? dir : join(dir, next.rel), { withFileTypes: true }).catch(() => null);
    if (listed === null) return null;
    for (const item of listed) {
      const rel = next.rel === "" ? item.name : `${next.rel}/${item.name}`;
      const st = await lstat(join(dir, rel)).catch(() => null);
      if (st === null) return null;
      const kind: EntryKind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      if (out.size >= FOLDER_ENTRIES_MAX) return null;
      if (kind === "dir" && !skippedName(item.name, kind, next.depth)) {
        out.set(rel, { kind: "dir" });
        queue.push({ rel, depth: next.depth + 1 });
        continue;
      }
      out.set(rel, { kind: codeRels.has(rel) ? "code" : "theirs" });
    }
  }
  return queue.length === 0 ? out : null;
}

/** The folders above a relative path, nearest last: `a/b/c.ts` → `a`, `a/b`. */
function ancestors(rel: string): string[] {
  const steps = rel.split("/");
  return steps.slice(1).map((_, i) => steps.slice(0, i + 1).join("/"));
}

/**
 * Write a new version into `<root>/<id>`, after the person's yes (crew slice 8, security review F3). Only
 * code moves: each file the proposal carries is written (a temp dot file in the trick folder, renamed into
 * place), and each code file of the old version the new one does not have is removed. "Code" is exactly
 * what the code hash walks (code-hash.ts `walkTrickCode`); every other entry of the folder, at any depth,
 * stays where it is, untouched. The old code stays in the approved copy of the old version, so "Undo"
 * brings it back. Refused before anything is written when the new code needs a name the person's own
 * entry holds (a file where a folder must go, or the other way round), or when the folder cannot be read
 * whole. A failure half way leaves the folder as a change that waits for the person's yes: the trick keeps
 * running the approved copy, which this never touches.
 */
export async function replaceTrickCode(root: string, id: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<ProposalWrite> {
  return await replaceCode(root, id, files, renderProposalOrigin(origin));
}

/**
 * {@link replaceTrickCode} with an origin record's text of the caller's, shared with the From Collie update
 * (official-install.ts). `files` must be code only. With `expect`, files that would hash otherwise are
 * refused as `mismatch` before anything in the folder changes.
 */
export async function replaceCode(root: string, id: string, files: readonly ProposedFile[], originText: string, opts: CodeWriteOptions = {}): Promise<ProposalWrite> {
  if (opts.expect !== undefined && codeHashOfFiles(files) !== opts.expect) return { ok: false, code: "mismatch", reason: "The code does not hash to what was expected." };
  const target = join(root, id);
  const st = await lstat(target).catch(() => null);
  if (st === null || !st.isDirectory()) return { ok: false, reason: `There is no trick folder ${id} to change.` };
  const walk = await walkTrickCode(diskTrickFs, target);
  if (!walk.ok) return { ok: false, reason: `The trick's folder cannot be read whole, so nothing was changed: ${walk.reason}` };
  const oldCode = new Set(walk.entries.map((entry) => entry.rel));
  const entries = await folderEntries(target, oldCode);
  if (entries === null) return { ok: false, reason: "The trick's folder cannot be read whole, so nothing was changed." };
  const next = new Set(files.map((file) => file.rel));
  const gone = [...oldCode].filter((rel) => !next.has(rel));
  const goneSet = new Set(gone);
  // What stays after the removals: the person's entries, the code kept, the folders.
  const stays = (rel: string): FolderEntry | undefined => (goneSet.has(rel) ? undefined : entries.get(rel));
  const theirsUnder = (rel: string): boolean => [...entries].some(([path, entry]) => entry.kind === "theirs" && path.startsWith(`${rel}/`));
  for (const rel of next) {
    const clash = ancestors(rel).find((up) => {
      const there = stays(up);
      return there !== undefined && there.kind !== "dir";
    });
    const here = stays(rel);
    const blocked = clash ?? (here?.kind === "theirs" || (here?.kind === "dir" && theirsUnder(rel)) ? rel : undefined);
    if (blocked !== undefined) return { ok: false, reason: `The new version needs the name ${blocked}, where the trick's folder holds something of your own, so nothing was changed.` };
  }
  try {
    for (const rel of gone) await rm(join(target, rel), { force: true });
    for (const file of files) {
      const path = join(target, file.rel);
      // A folder of old code only, where the new version puts a file: its code is gone, so it is empty.
      if (entries.get(file.rel)?.kind === "dir") await rm(path, { recursive: true, force: true });
      const fileDir = dirname(path);
      await mkdir(fileDir, { recursive: true, mode: 0o700 });
      // A dot name beside the file: the code hash never reads it, so a crash leaves no code behind.
      const tmp = join(fileDir, `.collie-new-${randomBytes(6).toString("hex")}`);
      await writeFile(tmp, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
      await rename(tmp, path);
    }
    const trickDir = target;
    const tmp = join(trickDir, `.collie-new-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, originText, { flag: "wx", mode: 0o600 });
    await rename(tmp, join(target, ORIGIN_FILE));
    // The folders that held only removed code, deepest first; a folder with anything left is kept.
    const emptied = [...new Set(gone.flatMap((rel) => ancestors(rel)))].toSorted((a, b) => b.length - a.length);
    for (const folder of emptied) await rmdir(join(target, folder)).catch(() => {});
    return { ok: true, codeHash: codeHashOfFiles(files) };
  } catch (err) {
    return { ok: false, reason: `The new version could not be written: ${why(err)}. The trick still runs the version you approved.` };
  }
}

/** A temp file of the version write: a dot name, so the code hash never reads it. */
const NEW_TEMP = /^\.collie-new-[0-9a-f]{12}$/u;
const ADD_STAGE = /^\.collie-add-[a-z0-9][a-z0-9-]{0,31}-[0-9a-f]{8}$/u;
const OLD_ASIDE = /^\.collie-old-([a-z0-9][a-z0-9-]{0,31})-[0-9a-f]{8}$/u;

/** What {@link recoverProposalWrites} did, for its log line and its test. */
export interface ProposalRecovery {
  stagesRemoved: string[];
  tempsRemoved: string[];
  restored: string[];
  /** Set-aside folders left in place, because a trick folder of that name exists: the person decides. */
  keptAside: string[];
}

/**
 * At bridge start, before any proposal is answered: clean up after a write a crash cut short (security
 * review S1). A `.collie-add-*` stage holds only a proposal's own files and its record, never the person's,
 * so it goes. A `.collie-new-*` temp file in a trick folder is a version write's, and goes. A
 * `.collie-old-<id>-*` folder (a set-aside folder of an earlier build of this slice) is put back when
 * `<id>` is missing, and otherwise left where it is: it is never removed. Never throws.
 */
export async function recoverProposalWrites(root: string): Promise<ProposalRecovery> {
  const done: ProposalRecovery = { stagesRemoved: [], tempsRemoved: [], restored: [], keptAside: [] };
  const top = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (top === null) return done;
  for (const entry of top) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && ADD_STAGE.test(entry.name)) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      done.stagesRemoved.push(entry.name);
      continue;
    }
    const aside = entry.isDirectory() ? OLD_ASIDE.exec(entry.name) : null;
    if (aside !== null) {
      const target = join(root, aside[1] ?? "");
      const there = await lstat(target).catch(() => null);
      if (there === null && (await rename(path, target).then(() => true, () => false))) done.restored.push(entry.name);
      else done.keptAside.push(entry.name);
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) await removeTemps(path, done.tempsRemoved, entry.name);
  }
  return done;
}

/** Remove the version write's temp files in one trick folder, never through a link, within the walk's caps. */
async function removeTemps(dir: string, removed: string[], label: string): Promise<void> {
  const queue = [""];
  for (let n = 0; queue.length > 0 && n < CODE_DIRS_MAX; n += 1) {
    const rel = queue.shift() ?? "";
    const listed = await readdir(rel === "" ? dir : join(dir, rel), { withFileTypes: true }).catch(() => null);
    if (listed === null) continue;
    for (const entry of listed) {
      const sub = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isFile() && NEW_TEMP.test(entry.name)) {
        await rm(join(dir, sub), { force: true }).catch(() => {});
        removed.push(`${label}/${sub}`);
        continue;
      }
      if (entry.isDirectory() && !skippedName(entry.name, "dir", rel === "" ? 0 : 1)) queue.push(sub);
    }
  }
}
