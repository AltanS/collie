import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONFIG_FILE, PICTURE_DIRS, trickCodeHash } from "./code-hash.ts";
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
//   * A NEW VERSION of a trick that is on: the proposal replaces the folder's code at once, and the
//     runner's own pending snapshot and "new version" card ask the person (version-card.ts). The folder's
//     `config.toml`, its pictures and its `inputs/` stay, and so do its dot files, except the origin
//     record, which the proposal's replaces. The staged folder is swapped in by two renames.
//
// Folders are 0700 and files 0644, or 0755 for a file the proposal marked executable, as `collie trick
// add` writes them (cli/trick-add.ts). A path written twice is a bug, never an overwrite (`wx`).

/** A staged or set-aside sibling in the tricks folder. The scanner never reads a dot folder. */
export function proposalSideName(root: string, what: "add" | "old", id: string): string {
  return join(root, `.collie-${what}-${id}-${randomBytes(4).toString("hex")}`);
}

/** Write the files and the record into a fresh folder `dir`. */
async function writeStage(dir: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  for (const file of files) {
    const path = join(dir, file.rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
  }
  await writeFile(join(dir, ORIGIN_FILE), renderProposalOrigin(origin), { flag: "wx", mode: 0o600 });
}

/** What a write into the tricks folder came to: the code hash the new folder holds, or why not. */
export type ProposalWrite = { ok: true; codeHash: string } | { ok: false; reason: string };

/** The message of a thrown value. */
function why<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Make `<root>/<id>` from a proposal. Refused when anything named `<id>` is there. The code hash answered is
 * the staged folder's, taken before the rename, so the approval that follows can insist on exactly it.
 */
export async function writeProposedTrick(root: string, id: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<ProposalWrite> {
  const target = join(root, id);
  if ((await lstat(target).catch(() => null)) !== null) return { ok: false, reason: `A trick named ${id} is here now, so nothing was written over it.` };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = proposalSideName(root, "add", id);
  try {
    await writeStage(stage, files, origin);
    const hashed = await trickCodeHash(stage);
    if (!hashed.ok) throw new Error(hashed.reason);
    // A rename onto a folder that appeared meanwhile fails when it holds anything; an empty one is replaced.
    if ((await lstat(target).catch(() => null)) !== null) throw new Error(`a trick named ${id} appeared meanwhile`);
    await rename(stage, target);
    return { ok: true, codeHash: hashed.hash };
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    return { ok: false, reason: `The trick could not be written: ${why(err)}` };
  }
}

/** The top-level names a new version keeps from the folder it replaces. */
function kept(name: string): boolean {
  if (name === ORIGIN_FILE) return false;
  return name === CONFIG_FILE || name === "inputs" || PICTURE_DIRS.some((dir) => dir === name) || name.startsWith(".");
}

/**
 * Replace the code of `<root>/<id>` with a proposal's, keeping its config.toml, pictures, `inputs/` and dot
 * files. A kept name the proposal also carries (a picture folder it brings) is the proposal's. The old
 * folder is set aside and removed once the new one is in place; on a failure it is put back.
 */
export async function replaceTrickCode(root: string, id: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<ProposalWrite> {
  const target = join(root, id);
  const st = await lstat(target).catch(() => null);
  if (st === null || !st.isDirectory()) return { ok: false, reason: `There is no trick folder ${id} to change.` };
  const stage = proposalSideName(root, "add", id);
  const carried = new Set(files.map((file) => file.rel.split("/")[0] ?? ""));
  try {
    await writeStage(stage, files, origin);
    // The code hash is the proposal's alone: the kept names are outside it (code-hash.ts `skippedName`).
    const hashed = await trickCodeHash(stage);
    if (!hashed.ok) throw new Error(hashed.reason);
    const names = await readdir(target);
    for (const name of names) {
      if (!kept(name) || carried.has(name)) continue;
      await rename(join(target, name), join(stage, name));
    }
    const aside = proposalSideName(root, "old", id);
    await rename(target, aside);
    try {
      await rename(stage, target);
    } catch (err) {
      await rename(aside, target);
      throw err;
    }
    await chmod(target, 0o700).catch(() => {});
    await rm(aside, { recursive: true, force: true });
    return { ok: true, codeHash: hashed.hash };
  } catch (err) {
    // What was moved into the stage goes back first, so the old folder keeps its settings and pictures.
    const moved = await readdir(stage).catch((): string[] => []);
    for (const name of moved) if (kept(name) && !carried.has(name)) await rename(join(stage, name), join(target, name)).catch(() => {});
    await rm(stage, { recursive: true, force: true });
    return { ok: false, reason: `The new version could not be written: ${why(err)}` };
  }
}
