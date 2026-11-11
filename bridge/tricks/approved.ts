import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HOST } from "../host.ts";
import { AGENT_VIEW_PLACE, isTrickId, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { hillImageMime } from "../hill/media.ts";
import { CODE_BYTES_MAX, CONFIG_FILE, diskTrickFs, hashCodeEntries, isPictureName, linkRefusal, PICTURE_DIRS, walkFingerprint, walkTrickCode, WRITABLE_TOP_DIRS, type CodeEntry, type TrickFs } from "./code-hash.ts";
import { readManifestFile, readSmallFile } from "./discover.ts";
import { ORIGIN_FILE } from "./origin.ts";
import { APPROVED_DIR, approvedCopyDir, approvedTrickDir, hash16, PENDING_DIR, pendingTrickDir, switchesPath, tricksConfigDir } from "./paths.ts";
import { parseSwitches, updateSwitches, withApproval, type SwitchEntry, type Switches } from "./switches.ts";

// THE APPROVED COPY (M94, crew slice 2): a trick runs from a copy of the code a person said yes to, so an
// edit of its folder never stops it. The folder is where the trick is written; the copy is what runs.
//
//   <configDir>/tricks/.collie-approved/<id>/<hash16>/   the copy that runs. `<hash16>` is the first 16
//                                                        hex characters of the code hash approved (switches.ts).
//   <configDir>/tricks/.collie-pending/<id>/<hash16>/    a snapshot of a changed folder, waiting for a yes.
//
// Beside the trick folders, not in the state folder: paths.ts says why (the hill's picture guard).
//
// WHAT A COPY HOLDS. One definition, the code hash's own (code-hash.ts `walkTrickCode`):
//   * CODE: every entry the walk hashes, copied byte for byte, so the copy hashes exactly as the folder
//     did. Read only: a file is 0400 (0500 when it was executable). A FIFO, a socket or a device refuses
//     the copy, and the walk refuses a symbolic link before anything is copied (code-hash.ts).
//   * CONFIG: `config.toml`, copied in at approval and again whenever the folder's one changes, with no
//     question asked (the service restarts the trick as it always did). Writable, outside the hash.
//   * METADATA: the origin record `.collie-origin.json` (origin.ts), copied in at approval so the row says
//     which commit runs. Outside the hash, never copied again.
//   * WRITABLE: `media/`, `captures/` and `inputs/` (code-hash.ts `WRITABLE_TOP_DIRS`), outside the hash.
//     `media/` and `captures/` are seeded at approval with the folder's PICTURES only: a regular file
//     whose name ends in `.png`, `.jpg`, `.jpeg` or `.webp` (code-hash.ts `isPictureName`) and whose
//     first bytes are a PNG, JPEG or WebP picture (the Hill's own sniff, hill/media.ts). Anything else
//     there stays behind, so the copy holds no file the hash and the card left out that a program could
//     import as code. Capped by {@link SEED_FILES_MAX} and {@link SEED_BYTES_MAX}; `inputs/` starts
//     empty. The program writes here, and so do its `*.log` files and dot files, which the hash skips too.
//   * NOT COPIED: `node_modules/` and every other dot file or dot folder. They are outside the hash, so
//     they would be code nobody approved; a program that needs them does not run from the copy.
//   * STATE stays where it was: `<stateDir>/tricks/<id>/`, the program's own folder (paths.ts).
//
// A copy is staged in a dot folder beside its target, hashed, made read only, then renamed into place:
// a reader sees no copy or a whole one. The hash of the COPY is what is approved, never a hash taken of
// the folder before the copy, so an edit in between cannot slip in. A copy that already exists under the
// same name is checked and kept, or replaced when it does not hash right.
//
// THE TAMPER CHECK (service.ts): before a run and on each scan the copy's listing (`lstat` only) is
// compared with the one taken when it was last verified; a listing that moved is hashed again, and a
// mismatch stops the trick. A program that writes a code file into its own working folder therefore stops
// itself. It keeps its state in `trick.state`.

/** The most files seeded into `media/` and `captures/` together. */
export const SEED_FILES_MAX = 500;
/** The most bytes seeded into `media/` and `captures/` together. */
export const SEED_BYTES_MAX = 64 * 1024 * 1024;
/** The most bytes of the origin record copied. */
const ORIGIN_BYTES_MAX = 8 * 1024;
/** An unreferenced copy or a stage folder younger than this is left alone by a prune: a writer may be about to name it. */
export const PRUNE_AFTER_MS = 60_000;

const isWindows = (platform: NodeJS.Platform): boolean => platform === "win32";

/** A copy made, or why not. */
export type SnapshotResult = { ok: true; hash: string; dir: string } | { ok: false; reason: string };

export interface SnapshotOptions {
  /** The trick folder copied. */
  src: string;
  /** `.collie-approved/<id>` or `.collie-pending/<id>`: the copy lands in `<parent>/<hash16>`. */
  parent: string;
  /** Refuse unless the copy hashes to this: the folder moved since it was hashed. */
  expect?: string;
  fs?: TrickFs;
  platform?: NodeJS.Platform;
}

/** The message of a thrown value, without assuming it was an Error. */
function message<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/** Remove a tree. Never throws. */
async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Copy one code entry of the walk into the stage. */
async function copyEntry(fs: TrickFs, src: string, stage: string, entry: CodeEntry): Promise<string | null> {
  const from = join(src, entry.rel);
  const to = join(stage, entry.rel);
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  if (entry.kind === "other") return `${entry.rel} is not a regular file, so the trick cannot be copied.`;
  // The walk refuses a link already; one that appeared since is refused here, never copied.
  if (entry.kind === "symlink") return linkRefusal(entry.rel);
  const bytes = await fs.read(from, CODE_BYTES_MAX);
  if (bytes === null) return `${entry.rel} cannot be read.`;
  await writeFile(to, bytes, { flag: "wx", mode: 0o600 });
  return null;
}

/** Whether a file of the folder is executable by anyone, so its copy keeps the bit. */
async function executable(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return st !== null && (st.mode & 0o111) !== 0;
}

/** Whether bytes are a picture the copy takes from `media/` or `captures/`: PNG, JPEG or WebP by their first bytes. */
export function isPictureBytes(bytes: Uint8Array): boolean {
  return hillImageMime(bytes) !== null;
}

/**
 * Copy the PICTURES under `src/<name>/` into `dest/<name>/`, within the shared budget: a regular file with
 * a picture's name whose first bytes are a picture's. A folder that is not a real folder (a link) is not
 * listed, and a file is read without following a link. Answers why the copy is refused, or null.
 */
async function seedDir(src: string, dest: string, name: string, budget: { files: number; bytes: number }, fs: TrickFs): Promise<string | null> {
  const queue: string[] = [name];
  // Bounded by the budget: every pass takes one folder; a folder is queued only while files remain.
  for (let pass = 0; queue.length > 0 && pass < SEED_FILES_MAX; pass += 1) {
    const rel = queue.shift();
    if (rel === undefined) break;
    const here = await fs.lstat(join(src, rel));
    if (here === null) continue;
    // A top-level `media/` that is a link is refused by the walk; one that became a link since is refused here.
    if (here.kind === "symlink") return linkRefusal(rel);
    if (here.kind !== "dir") continue;
    const listed = await fs.list(join(src, rel));
    if (!listed.ok) continue;
    await mkdir(join(dest, rel), { recursive: true, mode: 0o700 });
    for (const item of listed.entries) {
      if (item.name.startsWith(".")) continue;
      const child = `${rel}/${item.name}`;
      if (item.kind === "dir") {
        queue.push(child);
        continue;
      }
      if (item.kind !== "file" || budget.files <= 0 || !isPictureName(item.name)) continue;
      const st = await fs.lstat(join(src, child));
      if (st === null || st.kind !== "file" || st.size > budget.bytes) continue;
      const bytes = await fs.read(join(src, child), st.size);
      if (bytes === null || !isPictureBytes(bytes)) continue;
      await writeFile(join(dest, child), bytes, { flag: "wx", mode: 0o600 });
      budget.files -= 1;
      budget.bytes -= bytes.length;
    }
  }
  return null;
}

/** The writable and metadata parts of a copy: config.toml, the origin record, the seeded and empty folders. */
async function copyExtras(fs: TrickFs, src: string, stage: string): Promise<string | null> {
  const config = await readSmallFile(fs, src, CONFIG_FILE);
  if (config.kind === "refused") return config.refusal.reason;
  if (config.kind === "bytes") await writeFile(join(stage, CONFIG_FILE), config.bytes, { mode: 0o600 });
  const origin = await fs.lstat(join(src, ORIGIN_FILE));
  if (origin !== null && origin.kind === "file" && origin.size <= ORIGIN_BYTES_MAX) {
    const bytes = await fs.read(join(src, ORIGIN_FILE), ORIGIN_BYTES_MAX);
    if (bytes !== null) await writeFile(join(stage, ORIGIN_FILE), bytes, { mode: 0o600 });
  }
  const budget = { files: SEED_FILES_MAX, bytes: SEED_BYTES_MAX };
  for (const name of PICTURE_DIRS) {
    const problem = await seedDir(src, stage, name, budget, fs);
    if (problem !== null) return problem;
  }
  for (const name of WRITABLE_TOP_DIRS) await mkdir(join(stage, name), { recursive: true, mode: 0o700 });
  return null;
}

/** Make the code entries of a copy read only. Nothing on Windows, where a read-only file cannot be removed by `rm`. */
async function sealCode(src: string, stage: string, entries: readonly CodeEntry[], platform: NodeJS.Platform): Promise<void> {
  if (isWindows(platform)) return;
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    await chmod(join(stage, entry.rel), (await executable(join(src, entry.rel))) ? 0o500 : 0o400);
  }
}

/** The code listing of a copy (`lstat` only), or null when it cannot be walked. */
export async function copyListing(dir: string, fs: TrickFs = diskTrickFs): Promise<string | null> {
  const walk = await walkTrickCode(fs, dir);
  return walk.ok ? walkFingerprint(walk.entries, "") : null;
}

/** A copy checked against its hash: its listing when it holds, or why not (`missing` when there is no copy). */
export type CopyCheck = { ok: true; listing: string } | { ok: false; missing: boolean; reason: string; link?: true };

/** Hash a copy again and compare it with the hash it is filed under. */
export async function verifyCopy(dir: string, hash: string, fs: TrickFs = diskTrickFs): Promise<CopyCheck> {
  const st = await fs.lstat(dir);
  if (st === null) return { ok: false, missing: true, reason: "The approved copy is not there." };
  if (st.kind !== "dir") return { ok: false, missing: false, reason: "The approved copy is not a folder." };
  const walk = await walkTrickCode(fs, dir);
  // A copy made before links were refused may hold one: it does not run any more, and says why.
  if (!walk.ok) return walk.code === "link" ? { ok: false, missing: false, reason: walk.reason, link: true } : { ok: false, missing: false, reason: walk.reason };
  const got = await hashCodeEntries(fs, dir, walk.entries);
  if (got !== hash) return { ok: false, missing: false, reason: "The approved copy changed on disk." };
  return { ok: true, listing: walkFingerprint(walk.entries, "") };
}

/** Put a staged copy in its place, or keep a copy already there that hashes right. */
async function settle(stage: string, final: string, hash: string, fs: TrickFs): Promise<void> {
  if ((await fs.lstat(final)) !== null) {
    if ((await verifyCopy(final, hash, fs)).ok) {
      await removeTree(stage);
      return;
    }
    await removeTree(final);
  }
  try {
    await rename(stage, final);
  } catch (err) {
    // Another writer settled the same version first: keep theirs when it hashes right.
    if ((await verifyCopy(final, hash, fs)).ok) {
      await removeTree(stage);
      return;
    }
    throw err;
  }
}

/**
 * Copy a trick folder into `<parent>/<hash16>`: the code (read only), config.toml, the origin record, the
 * seeded `media/` and `captures/`, an empty `inputs/`. The hash answered is the copy's own. Never throws.
 */
export async function snapshotTrick(opts: SnapshotOptions): Promise<SnapshotResult> {
  const fs = opts.fs ?? diskTrickFs;
  const platform = opts.platform ?? HOST.platform;
  const walk = await walkTrickCode(fs, opts.src);
  if (!walk.ok) return walk;
  const other = walk.entries.find((entry) => entry.kind === "other");
  if (other !== undefined) return { ok: false, reason: `${other.rel} is not a regular file or a link, so the trick cannot be copied.` };
  let stage: string | null = null;
  try {
    await mkdir(opts.parent, { recursive: true, mode: 0o700 });
    stage = join(opts.parent, `.stage-${randomBytes(6).toString("hex")}`);
    await mkdir(stage, { mode: 0o700 });
    for (const entry of walk.entries) {
      const problem = await copyEntry(fs, opts.src, stage, entry);
      if (problem !== null) return await failed(stage, problem);
    }
    const extra = await copyExtras(fs, opts.src, stage);
    if (extra !== null) return await failed(stage, extra);
    const copied = await walkTrickCode(fs, stage);
    if (!copied.ok) return await failed(stage, copied.reason);
    const hash = await hashCodeEntries(fs, stage, copied.entries);
    if (opts.expect !== undefined && hash !== opts.expect) return await failed(stage, "The trick folder changed while it was copied.");
    await sealCode(opts.src, stage, copied.entries, platform);
    const final = join(opts.parent, hash16(hash));
    await settle(stage, final, hash, fs);
    stage = null;
    return { ok: true, hash, dir: final };
  } catch (err) {
    return await failed(stage, `The trick could not be copied: ${message(err)}`);
  }
}

/**
 * Move a verified copy (a pending snapshot) to `to`, the approved copy of the same version: kept as it is
 * when a copy that hashes right is there already. False when it could not be placed.
 */
export async function promoteCopy(from: string, to: string, hash: string, fs: TrickFs = diskTrickFs): Promise<boolean> {
  try {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await settle(from, to, hash, fs);
    return (await verifyCopy(to, hash, fs)).ok;
  } catch {
    return false;
  }
}

async function failed(stage: string | null, reason: string): Promise<SnapshotResult> {
  if (stage !== null) await removeTree(stage);
  return { ok: false, reason };
}

/**
 * Bring the copy's `config.toml` in line with the folder's: written when it differs, removed when the
 * folder has none. A folder whose `config.toml` is refused leaves the copy's as it is. True when it moved.
 */
export async function syncConfig(src: string, copyDir: string, fs: TrickFs = diskTrickFs): Promise<boolean> {
  const want = await readSmallFile(fs, src, CONFIG_FILE);
  if (want.kind === "refused") return false;
  const held = await readSmallFile(fs, copyDir, CONFIG_FILE);
  if (want.kind === "absent") {
    if (held.kind === "absent") return false;
    await rm(join(copyDir, CONFIG_FILE), { force: true });
    return true;
  }
  if (held.kind === "bytes" && Buffer.from(held.bytes).equals(Buffer.from(want.bytes))) return false;
  const tmp = join(copyDir, `.${CONFIG_FILE}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, want.bytes, { mode: 0o600 });
  await rename(tmp, join(copyDir, CONFIG_FILE));
  return true;
}

// ── powers ───────────────────────────────────────────────────────────────────

/**
 * The powers of a manifest as a short hash: what it may reach beyond the code itself. The environment
 * names (`env`), the globs it reads from its sessions' folders (`inputs`, contract 2) and the places it
 * draws in (`places`), each sorted and once. `inputs` was hashed as an empty list before the key
 * existed, so a manifest without it hashes the same as before, and only a trick that declares inputs
 * moves its powers: a new glob asks for a new yes.
 *
 * Contract 2's agent view adds two rights, each only when the manifest has it, so every other trick keeps
 * its hash byte for byte: the place word `agent-view` joins `places`, and `rules` is the SHA-256 of the
 * rules file's bytes (discover.ts `readRulesFile`). A changed rules text is therefore a changed right: no
 * auto, no "Use it and stop asking", the card shows it whole. A manifest read from its text alone, whose
 * rules file was not read, hashes `rules` as the empty string: never equal to a read one.
 *
 * THE CANONICAL FORM (fault B). The three first keys, `env`, `inputs` and `places`, are always hashed, as
 * sorted lists. Every key added after them is hashed only when it holds something: an absent key equals
 * its neutral value (`undefined`, `null`, `false`, an empty list, an empty object), so a right a later
 * Collie learns to name moves the hash only for a trick that asks for it, and a trick approved before that
 * key existed reads the same powers after it. The empty string is NOT neutral: it is the unread rules
 * text above. The keys go in sorted order (`env`, `inputs`, `places`, then {@link LATER_POWER_KEYS}), which is
 * the order every stored hash was written in.
 */
export function powersOf(manifest: Pick<TrickManifest, "env" | "places" | "inputs" | "agentView" | "rules" | "rulesSha256">): string {
  const env = [...new Set(manifest.env ?? [])].toSorted();
  const places = [...new Set<string>([...manifest.places, ...(manifest.agentView === true ? [AGENT_VIEW_PLACE] : [])])].toSorted();
  const inputs = [...new Set(manifest.inputs ?? [])].toSorted();
  const later: LaterPowers = {};
  if (manifest.rules !== undefined) later.rules = manifest.rulesSha256 ?? "";
  return powersHash({ env, inputs, places }, later);
}

/**
 * The places the build before stored powers drew (switch file version 2, M94 at f480c61d8: `belt`,
 * `session`, `tab`, `view`, `dashboard`, `status`) that this Collie still draws. `tabbar` and `agent-view`
 * came later, so that build never showed them to the person.
 */
export const LEGACY_PLACES: readonly string[] = ["belt", "dashboard", "session", "status"];

/**
 * The rights an approval from before stored powers could have covered, as a powers hash: the manifest's
 * `env` and the places of {@link LEGACY_PLACES} it names, with no `inputs` and no later key. That build
 * read `env` and `places` and nothing else that reaches beyond the code. The gate compares this with
 * {@link powersOf} for an entry whose powers are `null`: a trick that asks for nothing more runs on after
 * an update, and one that asks for a right that build could not show stops until a person says yes.
 */
export function legacyPowersOf(manifest: Pick<TrickManifest, "env" | "places">): string {
  const env = [...new Set(manifest.env ?? [])].toSorted();
  const places = [...new Set<string>(manifest.places.filter((place) => LEGACY_PLACES.includes(place)))].toSorted();
  return powersHash({ env, inputs: [], places });
}

/** The three first power keys: always hashed, each a sorted list. */
export interface FirstPowers {
  env: readonly string[];
  inputs: readonly string[];
  places: readonly string[];
}

/** The power keys added after the first three. A new right gets its key here, and in {@link LATER_POWER_KEYS}. */
export interface LaterPowers {
  /** The rules file's SHA-256, or the empty string for rules named but not read. */
  rules?: string;
}

/** The later keys, in sorted order. */
export const LATER_POWER_KEYS = ["rules"] as const satisfies readonly (keyof LaterPowers)[];

/** Whether a later power key holds nothing, so it hashes as if absent: absent, or an empty list. The empty string holds something. */
export function neutralPower(value: string | readonly string[] | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

/** The powers hash: the three first keys, then each later key that holds something, all keys in sorted order. */
export function powersHash(first: FirstPowers, later: LaterPowers = {}): string {
  const doc: FirstPowers & LaterPowers = { env: first.env, inputs: first.inputs, places: first.places };
  for (const key of LATER_POWER_KEYS) {
    const value = later[key];
    if (value !== undefined && !neutralPower(value)) doc[key] = value;
  }
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
}

// ── counts ───────────────────────────────────────────────────────────────────

/** How many code files differ between two copies. */
export interface FileCounts {
  added: number;
  changed: number;
  removed: number;
}

async function codeSums(dir: string, fs: TrickFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = await walkTrickCode(fs, dir);
  if (!walk.ok) return out;
  for (const entry of walk.entries) {
    const bytes = entry.kind === "file" ? await fs.read(join(dir, entry.rel), CODE_BYTES_MAX) : null;
    const link = entry.kind === "symlink" ? await fs.readlink(join(dir, entry.rel)) : null;
    const body = bytes === null ? (link ?? "") : createHash("sha256").update(bytes).digest("hex");
    out.set(entry.rel, `${entry.kind}:${body}`);
  }
  return out;
}

/** The code files `next` adds, changes and removes against `base` (null: everything is added). */
export async function fileCounts(base: string | null, next: string, fs: TrickFs = diskTrickFs): Promise<FileCounts> {
  const [old, now] = await Promise.all([base === null ? Promise.resolve(new Map<string, string>()) : codeSums(base, fs), codeSums(next, fs)]);
  let added = 0;
  let changed = 0;
  for (const [rel, sum] of now) {
    const was = old.get(rel);
    if (was === undefined) added += 1;
    else if (was !== sum) changed += 1;
  }
  const removed = [...old.keys()].filter((rel) => !now.has(rel)).length;
  return { added, changed, removed };
}

// ── approving a folder (collie trick on, the phone's switch) ─────────────────

/** A folder approved, or why not. */
export type ApproveResult = { ok: true; hash: string; dir: string; powers: string | null; manifest?: TrickManifest } | { ok: false; reason: string };

export interface ApproveOptions {
  stateDir: string;
  configDir: string;
  id: string;
  /** Who approves: `cli`, `phone`. */
  by: string;
  at: string;
  fs?: TrickFs;
  platform?: NodeJS.Platform;
  /** The code hash the person read (review 8 V-N1): a copy that hashes otherwise is refused. */
  expect?: string;
}

/**
 * Approve a trick folder as it is now: copy it into `.collie-approved/<id>/`, then write the switch with the
 * copy's hash, under the switch file's lock. A switch file of version 1 or 2 is migrated first, so
 * version 3 is written only after its copies exist.
 */
export async function approveFolder(opts: ApproveOptions): Promise<ApproveResult> {
  if (!isTrickId(opts.id)) return { ok: false, reason: `${opts.id} is not a trick id.` };
  const fs = opts.fs ?? diskTrickFs;
  await migrateSwitches({ stateDir: opts.stateDir, configDir: opts.configDir, fs, platform: opts.platform });
  const src = join(tricksConfigDir(opts.configDir), opts.id);
  const snapOpts: SnapshotOptions = { src, parent: approvedTrickDir(opts.configDir, opts.id), fs, platform: opts.platform };
  if (opts.expect !== undefined) snapOpts.expect = opts.expect;
  const snap = await snapshotTrick(snapOpts);
  if (!snap.ok) return snap;
  const read = await readManifestFile(fs, snap.dir, opts.id);
  const powers = read.manifest === undefined ? null : powersOf(read.manifest);
  const instructs = read.manifest?.rules !== undefined;
  await updateSwitches(opts.stateDir, (now) => withApproval(now, opts.id, { at: opts.at, hash: snap.hash, by: opts.by, powers, instructs }));
  const out: ApproveResult = { ok: true, hash: snap.hash, dir: snap.dir, powers };
  if (read.manifest !== undefined) out.manifest = read.manifest;
  return out;
}

/** The powers of the trick in a copy, or null when its manifest does not parse. */
export async function powersOfDir(dir: string, id: string, fs: TrickFs = diskTrickFs): Promise<string | null> {
  const read = await readManifestFile(fs, dir, id);
  return read.manifest === undefined ? null : powersOf(read.manifest);
}

// ── migration from version 1 and 2 ───────────────────────────────────────────

export interface MigrateOptions {
  stateDir: string;
  configDir: string;
  fs?: TrickFs;
  platform?: NodeJS.Platform;
}

/** What a migration did: the tricks that kept running from a fresh copy, and the ones left waiting for a yes. */
export interface Migration {
  kept: string[];
  waiting: string[];
}

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/**
 * Migrate a version 1 or 2 switch file to layout 3. An entry whose approved copy is still on disk and
 * verifies (a file the previous build rewrote after a rollback), or whose folder still hashes to its
 * approved hash, is copied into `.collie-approved/` and keeps running. A changed entry, or a version 1 entry with no hash,
 * keeps its place but approves nothing (`hash: null`): its old bytes are gone, so it waits for a person's
 * yes to the current folder. Version 3 is written only after the copies exist, under the lock, against the
 * file as it is then. Null when there was nothing to migrate.
 *
 * NO POWERS ARE WRITTEN HERE (fault B). A version 1 or 2 entry holds no powers, and this Collie's reader
 * is not the one the person said yes under: powers computed now would approve every right it reads that
 * the old one did not. So a migrated entry stores `powers: null`, and the gate reads null as the rights
 * the build before stored powers could have shown ({@link legacyPowersOf}). Stored powers are written only
 * at an approval by a person.
 */
export async function migrateSwitches(opts: MigrateOptions): Promise<Migration | null> {
  const fs = opts.fs ?? diskTrickFs;
  const read = parseSwitches(await readText(switchesPath(opts.stateDir)));
  const version = read.switches.version ?? 0;
  if (read.problem !== null || version === 0 || version >= 3) return null;
  const copied = new Map<string, string>();
  for (const [id, entry] of read.switches.on) {
    if (entry.hash === null || !isTrickId(id)) continue;
    // A file the previous build rewrote after a rollback (B4): the approved copy of that hash may still
    // be on disk, and it holds exactly the bytes approved, whatever the folder holds now.
    const held = approvedCopyDir(opts.configDir, id, entry.hash);
    if ((await verifyCopy(held, entry.hash, fs)).ok) {
      copied.set(id, entry.hash);
      continue;
    }
    const snap = await snapshotTrick({ src: join(tricksConfigDir(opts.configDir), id), parent: approvedTrickDir(opts.configDir, id), expect: entry.hash, fs, platform: opts.platform });
    if (snap.ok) copied.set(id, snap.hash);
  }
  const out: Migration = { kept: [], waiting: [] };
  await updateSwitches(opts.stateDir, (now) => {
    if ((now.version ?? 0) >= 3) return now;
    const next = new Map<string, SwitchEntry>();
    out.kept = [];
    out.waiting = [];
    for (const [id, entry] of now.on) {
      const kept = entry.hash !== null && copied.get(id) === entry.hash;
      next.set(id, { at: entry.at, hash: kept ? entry.hash : null, auto: false, by: "migrated", powers: null });
      (kept ? out.kept : out.waiting).push(id);
    }
    return { on: next, version: 3 };
  });
  return out;
}

// ── pruning ──────────────────────────────────────────────────────────────────

export interface PruneOptions {
  /** The pending snapshot to keep per trick, by code hash. Absent: every pending snapshot of a trick that is on stays. */
  pending?: ReadonlyMap<string, string>;
  now: number;
  /** Leave anything younger than this alone. Default {@link PRUNE_AFTER_MS}. */
  olderThanMs?: number;
}

async function oldEnough(path: string, opts: PruneOptions): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return st !== null && opts.now - st.mtimeMs >= (opts.olderThanMs ?? PRUNE_AFTER_MS);
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Remove the copies nothing names any more: every copy of a trick that is off, and of one that is on every
 * copy but its approved version and the one before it (`previous`, for undo); every pending snapshot but
 * the one kept. A folder younger than {@link PRUNE_AFTER_MS} stays. Only names that are trick ids are
 * touched. Never throws.
 */
export async function pruneCopies(configDir: string, switches: Switches, opts: PruneOptions): Promise<void> {
  const root = tricksConfigDir(configDir);
  for (const id of await names(join(root, APPROVED_DIR))) {
    if (!isTrickId(id)) continue;
    const entry = switches.on.get(id);
    const keep = new Set<string>();
    if (entry?.hash != null) keep.add(hash16(entry.hash));
    if (entry?.previous !== undefined) keep.add(hash16(entry.previous.hash));
    await pruneChildren(join(root, APPROVED_DIR, id), entry === undefined ? null : keep, opts);
  }
  for (const id of await names(join(root, PENDING_DIR))) {
    if (!isTrickId(id)) continue;
    const entry = switches.on.get(id);
    const kept = opts.pending?.get(id);
    const keep = opts.pending === undefined ? null : new Set(kept === undefined ? [] : [hash16(kept)]);
    if (entry === undefined) await pruneChildren(join(root, PENDING_DIR, id), null, opts);
    else if (keep !== null) await pruneChildren(join(root, PENDING_DIR, id), keep, opts);
  }
}

/** Remove every old child of `dir` not in `keep` (all of them for null), then `dir` itself when it is empty. */
async function pruneChildren(dir: string, keep: ReadonlySet<string> | null, opts: PruneOptions): Promise<void> {
  for (const name of await names(dir)) {
    if (keep?.has(name) === true) continue;
    const path = join(dir, name);
    if (await oldEnough(path, opts)) await removeTree(path);
  }
  if ((await names(dir)).length === 0) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Remove every approved copy and pending snapshot of one trick (`collie trick remove`). */
export async function removeTrickCopies(configDir: string, id: string): Promise<void> {
  if (!isTrickId(id)) return;
  await removeTree(approvedTrickDir(configDir, id));
  await removeTree(pendingTrickDir(configDir, id));
}

/** The approved copy a switch entry names, or null when it approves nothing. */
export function approvedDirOf(configDir: string, id: string, entry: SwitchEntry | undefined): string | null {
  if (entry?.hash == null || !isTrickId(id)) return null;
  return approvedCopyDir(configDir, id, entry.hash);
}
