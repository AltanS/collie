import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONFIG_FILE, diskTrickFs, trickCodeHash } from "../tricks/code-hash.ts";
import { powersOfDir, snapshotTrick } from "../tricks/approved.ts";
import { ORIGIN_FILE, parseOrigin, parseProposalOrigin } from "../tricks/origin.ts";
import { readManifestFile } from "../tricks/discover.ts";
import { approvedCopyDir, approvedTrickDir, switchesPath, tricksConfigDir, trickStateDir, tricksStateDir } from "../tricks/paths.ts";
import { parseSwitches, updateSwitches, withApproval, withEntry } from "../tricks/switches.ts";
import { strictBase64 } from "../tricks/propose-wire.ts";
import type { CarriedReady, StandbyTricksStore } from "./standby-tricks.ts";

// THE PERSON'S TAP STARTS THE CARRIED TRICKS (CREW_PROTOCOL §25). The one place the deputy's inert copy
// (standby-tricks.ts) becomes running tricks, and it runs only inside that tap: the takeover commit on
// the deputy's own standby page (bridge/index.ts `performTakeover`), or `collie promote` typed on the
// machine taking the crown. Nothing else calls it.
//
// FOR EACH CARRIED TRICK WHOSE CODE IS HELD:
//   1. The held code is hashed again with the real code hash. A mismatch starts nothing.
//   2. Its folder is written out: into `<configDir>/tricks/<id>/` when that is missing (staged in a dot
//      folder beside it, renamed into place), or into a scratch folder under the copy when this machine
//      already has a folder of that name. A person's folder is never written over: when its code is other
//      code, the carried version runs from its approved copy and the folder becomes the usual "new
//      version" card (tricks/version-card.ts), exactly as an edit of the folder would.
//   3. The approved copy is made by the normal path (`snapshotTrick`, with `expect` set to the carried
//      hash, so it is checked a third time), and the switch is written by the normal path
//      (`updateSwitches` + `withApproval`), with `by: "takeover"` (or `handover`), `from: <old lead>`,
//      the time of the tap and the lead's `auto` (only when the folder here is the carried version).
//   4. The trick's state folder is written only where this machine has none.
// A trick whose check fails is not started and is answered in `failed`, so the bridge can put a Decision
// on the Hill that says so (`TAKEOVER_NOTICES_FILE`).
//
// THE RIGHTS (review 7 R6). The deputy trusts what its lead says was approved: the hash and the powers in
// the carried list are the lead's word, and nothing here can check that a person said yes to them on the
// lead. What it can check is that the two agree: the powers the lead says were approved must be the
// powers of the carried code (`powersOfDir`). When they are not (another Collie's rule, a record by
// hand, a lead that lies about one of them), the trick starts OFF: its folder is written where there is
// none, no approved copy and no switch, and its card says so (`kind: "rights"`), so the person reads its
// rights in Settings before a yes on this machine.

/** The file a takeover leaves for the next boot: the tricks that did not start, for the Hill to say so. */
export const TAKEOVER_NOTICES_FILE = "carried-notices.json";

/** One carried trick that did not start, and why in plain words. */
export interface CarryFailure {
  readonly id: string;
  readonly name: string;
  readonly hash: string;
  readonly reason: string;
  /** `rights`: its code asks for other rights than the lead says were approved, so it was left off (R6). */
  readonly kind?: "rights";
}

/** Why a carried trick whose rights do not agree with the lead's record is off. */
export const CARRY_RIGHTS_REASON = "the rights its code asks for are not the rights your lead says you approved";

export interface AdoptTricksResult {
  readonly started: readonly { readonly id: string; readonly name: string }[];
  readonly failed: readonly CarryFailure[];
  /** Tricks whose folder this machine already had: the folder was left as it is. */
  readonly keptFolder: readonly string[];
}

export interface AdoptTricksOptions {
  readonly stateDir: string;
  readonly configDir: string;
  readonly store: StandbyTricksStore;
  /** The lead the copy is from. */
  readonly lead: string;
  readonly by: "takeover" | "handover";
  readonly now: () => number;
  readonly platform?: NodeJS.Platform;
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Copy every regular file under `from` to `to`, 0700 folders and 0600 files, no link followed. */
async function copyTree(from: string, to: string): Promise<void> {
  const queue = [""];
  for (let pass = 0; queue.length > 0 && pass < 10_000; pass += 1) {
    const rel = queue.shift();
    if (rel === undefined) break;
    const listed = await readdir(rel === "" ? from : join(from, rel), { withFileTypes: true }).catch(() => []);
    await mkdir(rel === "" ? to : join(to, rel), { recursive: true, mode: 0o700 });
    for (const item of listed) {
      const child = rel === "" ? item.name : `${rel}/${item.name}`;
      if (item.isDirectory()) queue.push(child);
      if (!item.isFile()) continue;
      const bytes = await diskTrickFs.read(join(from, child), 64 * 1024 * 1024);
      if (bytes !== null) await writeFile(join(to, child), bytes, { mode: 0o600 });
    }
  }
}

/** Write a carried trick's folder at `dir`: its code, its config.toml, its origin record, its pictures. */
async function writeFolder(ready: CarriedReady, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of ready.trick.files) {
    const bytes = await diskTrickFs.read(join(ready.codeDir, file.rel), file.size + 1);
    if (bytes === null) continue;
    const path = join(dir, file.rel);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: file.x ? 0o700 : 0o600 });
  }
  const config = ready.trick.config === null ? null : strictBase64(ready.trick.config);
  if (config !== null) await writeFile(join(dir, CONFIG_FILE), config, { mode: 0o600 });
  const origin = ready.trick.origin;
  // Only a record one of the two readers takes: anything else would be a dot file nobody reads.
  if (origin !== null && (parseOrigin(origin) !== null || parseProposalOrigin(origin) !== null)) await writeFile(join(dir, ORIGIN_FILE), origin, { mode: 0o600 });
  if (ready.heldState !== null) {
    for (const part of ["media", "captures"]) {
      if (await exists(join(ready.heldState, part))) await copyTree(join(ready.heldState, part), join(dir, part));
    }
  }
}

/** Write a carried trick's folder where this machine has none, and nothing else: it stays off (R6). */
async function writeOff(opts: AdoptTricksOptions, ready: CarriedReady): Promise<void> {
  const target = join(tricksConfigDir(opts.configDir), ready.trick.id);
  if (await exists(target)) return;
  const src = join(tricksConfigDir(opts.configDir), `.collie-carry-${randomBytes(6).toString("hex")}`);
  try {
    await writeFolder(ready, src);
    if (!(await exists(target))) await rename(src, target);
  } finally {
    await removeTree(src);
  }
}

/** Start one carried trick, leave it off, or say why not. */
async function adoptOne(opts: AdoptTricksOptions, ready: CarriedReady, at: string): Promise<{ ok: true; keptFolder: boolean } | { ok: false; reason: string; kind?: "rights" }> {
  const { id, hash } = ready.trick;
  const held = await trickCodeHash(ready.codeDir);
  if (!held.ok || held.hash !== hash) return { ok: false, reason: "its copy on this machine does not match the version you approved" };
  // The lead's word on the rights must agree with the code it sent (R6); else the trick stays off.
  if ((await powersOfDir(ready.codeDir, id)) !== ready.trick.powers) {
    try {
      await writeOff(opts, ready);
    } catch (err) {
      return { ok: false, reason: `it could not be written: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: false, reason: CARRY_RIGHTS_REASON, kind: "rights" };
  }
  const target = join(tricksConfigDir(opts.configDir), id);
  const keptFolder = await exists(target);
  const src = keptFolder ? join(opts.store.dir, `.adopt-${randomBytes(6).toString("hex")}`) : join(tricksConfigDir(opts.configDir), `.collie-carry-${randomBytes(6).toString("hex")}`);
  try {
    await writeFolder(ready, src);
    const snap = await snapshotTrick({ src, parent: approvedTrickDir(opts.configDir, id), expect: hash, platform: opts.platform });
    if (!snap.ok) return { ok: false, reason: "its copy on this machine does not match the version you approved" };
    // The folder goes into place only where there was none; a folder that appeared meanwhile is kept.
    if (!keptFolder && !(await exists(target))) await rename(src, target);
    const powers = await powersOfDir(snap.dir, id);
    // The lead's `auto` is the person's yes to later versions OF THE LEAD'S FOLDER. A kept folder here
    // holding other code would be such a "later version", taken by auto with no tap on this machine.
    // So `auto` comes along only when the folder here is the carried version; else it is off, and the
    // folder's code is the usual new version card. A decline this machine held for that code stays.
    const folder = keptFolder ? await trickCodeHash(target) : null;
    const same = folder === null || (folder.ok && folder.hash === hash);
    await updateSwitches(opts.stateDir, (now) => {
      const declined = now.on.get(id)?.declined;
      const approved = withApproval(now, id, { at, hash, by: opts.by, powers });
      const entry = approved.on.get(id);
      if (entry === undefined) return approved;
      const kept = !same && folder?.ok === true && declined === folder.hash ? { declined } : {};
      return withEntry(approved, id, { ...entry, ...kept, auto: same ? ready.trick.auto : false, from: opts.lead });
    });
    const state = trickStateDir(opts.stateDir, id);
    if (ready.heldState !== null && !(await exists(state)) && (await exists(join(ready.heldState, "state")))) {
      await mkdir(tricksStateDir(opts.stateDir), { recursive: true, mode: 0o700 });
      await copyTree(join(ready.heldState, "state"), state);
      await chmod(state, 0o700).catch(() => {});
    }
    return { ok: true, keptFolder };
  } catch (err) {
    return { ok: false, reason: `it could not be written: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await removeTree(src);
  }
}

/**
 * Start every carried trick whose code this machine holds. Run only inside the person's tap. Never
 * throws: a trick that cannot start is answered in `failed`, and the others still start.
 */
export async function adoptCarriedTricks(opts: AdoptTricksOptions): Promise<AdoptTricksResult> {
  const index = await opts.store.load();
  if (index === null || index.from !== opts.lead) return { started: [], failed: [], keptFolder: [] };
  const at = new Date(opts.now()).toISOString();
  const started: { id: string; name: string }[] = [];
  const failed: CarryFailure[] = [];
  const keptFolder: string[] = [];
  for (const ready of await opts.store.ready()) {
    const outcome = await adoptOne(opts, ready, at);
    if (outcome.ok) {
      started.push({ id: ready.trick.id, name: ready.name });
      if (outcome.keptFolder) keptFolder.push(ready.trick.id);
      continue;
    }
    failed.push(outcome.kind === undefined ? { id: ready.trick.id, name: ready.name, hash: ready.trick.hash, reason: outcome.reason } : { id: ready.trick.id, name: ready.name, hash: ready.trick.hash, reason: outcome.reason, kind: outcome.kind });
  }
  // A trick the copy refused (its hash did not match when it arrived) does not start either; say so.
  for (const trick of index.tricks) {
    const code = index.code.get(trick.id);
    if (code?.state === "refused" && code.reason !== "too large to carry") failed.push({ id: trick.id, name: trick.id, hash: trick.hash, reason: "its copy on this machine does not match the version you approved" });
  }
  return { started, failed, keptFolder };
}

/** Leave the failures for the next boot, which puts one Decision on the Hill for each. 0600. */
export async function writeCarryNotices(stateDir: string, lead: string, at: number, failed: readonly CarryFailure[]): Promise<void> {
  if (failed.length === 0) return;
  const path = join(tricksStateDir(stateDir), TAKEOVER_NOTICES_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ v: 1, lead, at, failed }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * The names of the tricks that run on this machine after the takeover tap, read off its own disk: every
 * carried trick whose code is held, then every trick this machine already has ON with an approved copy
 * (a peer runs none; a lead runs them). Each once, by id, carried first.
 */
export async function tricksStartingAtTap(store: StandbyTricksStore | null, stateDir: string, configDir: string | null): Promise<string[]> {
  const names = new Map<string, string>();
  for (const ready of (await store?.ready()) ?? []) names.set(ready.trick.id, ready.name);
  if (configDir === null) return [...names.values()];
  const read = parseSwitches(await readFile(switchesPath(stateDir), "utf8").catch(() => null));
  for (const [id, entry] of read.switches.on) {
    if (names.has(id) || entry.hash === null) continue;
    const manifest = await readManifestFile(diskTrickFs, approvedCopyDir(configDir, id, entry.hash), id);
    if (manifest.manifest !== undefined) names.set(id, manifest.manifest.name);
  }
  return [...names.values()];
}
