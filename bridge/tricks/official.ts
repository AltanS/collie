import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { TRICK_CONTRACT } from "../../web/src/lib/tricks/contract.ts";
import { DESCRIPTION_MAX, isTrickId, isTrickText, NAME_MAX, type OfficialState, type WireOfficialTrick } from "../../web/src/lib/tricks/schema.ts";
import { diskTrickFs, type TrickFs } from "./code-hash.ts";
import shipped from "./official.json";
import { originRepoName, readOrigin, type TrickOrigin } from "./origin.ts";
import { tricksConfigDir } from "./paths.ts";

// THE FROM COLLIE LIST (M94): the official tricks this Collie release can add with a tap. Collie ships no
// trick code and switches nothing on. A release carries only this list, `official.json` beside this file,
// bundled into the binary by the import below (the compiled `collie` holds it; nothing reads it from disk
// at run time). Each entry names a trick, one line about it, the repository and the folder in it, a full
// commit id and the code hash (code-hash.ts `trickCodeHash`, 64 hex, the hash a switch approves) that
// folder has at that commit.
//
// THE TRUST ROOT is this file as built into the binary: the commit pins what git fetches (git checks every
// object against its id), and the code hash pins what Collie writes (official-install.ts compares it before
// anything lands in the tricks folder). Changing the list on a machine means changing the binary.
//
// THE READER IS STRICT (`parseOfficialList`): exactly the keys below, an https repository that is one of
// {@link OFFICIAL_REPOS} (an allowlist of one), a folder that is one step by the trick id rule, a commit of
// 40 hex digits, a hash of 64, a name and a description by the manifest's own text rules, a contract this
// Collie speaks, at most {@link OFFICIAL_PREVIOUS_MAX} earlier versions (`previous`, each a commit and its
// hash, none the current commit, none twice), no id twice, at most {@link OFFICIAL_ENTRIES_MAX} entries. A list it refuses is no list:
// the bridge offers nothing and says why once. The maintainer script (scripts/official-tricks.ts) rewrites
// commits and hashes from a checkout of the repository, and `--check` fails when the list is stale.
//
// WHAT COUNTS AS FROM THE LIST (security review): a folder of an entry's id whose origin record says
// `official: true`, names the entry's repository and folder, and names a commit this list knows for the id:
// its current commit or one in `previous`, the versions earlier releases listed. Only then is the entry
// `added` or `update`. A folder from the same repository at any other commit (a pull request's ref, a fork's
// commit, a branch nobody listed) is `taken`, marked `unlisted`, and its row says it is not on the Collie
// list: the record is written by Collie, but a hand can write it too, so the commit must be a listed one,
// and an update checks the folder's code hash against that commit's listed hash first (official-install.ts).

/** The repositories a list entry may name. One, on purpose. */
export const OFFICIAL_REPOS: readonly string[] = ["https://github.com/AltanS/collie-tricks"];
/** The most entries a list holds. */
export const OFFICIAL_ENTRIES_MAX = 32;
/** The most earlier versions an entry keeps. */
export const OFFICIAL_PREVIOUS_MAX = 8;
/** The keys of an entry, all required, no other. */
const ENTRY_KEYS = ["id", "name", "description", "repo", "dir", "commit", "hash", "contract", "previous"] as const;

/** One version of an entry: a commit and the code hash its folder has there. */
export interface OfficialVersion {
  commit: string;
  hash: string;
}

/** One entry of the list. */
export interface OfficialEntry {
  id: string;
  name: string;
  description: string;
  repo: string;
  /** The trick's folder in the repository: one step. */
  dir: string;
  /** The commit to fetch, 40 hex. */
  commit: string;
  /** The code hash that folder has at that commit, 64 hex. */
  hash: string;
  /** The trick contract its manifest names. */
  contract: number;
  /** Versions earlier releases listed, newest first: a folder at one of them is still from the list. */
  previous: OfficialVersion[];
}

export type OfficialList = { ok: true; entries: OfficialEntry[] } | { ok: false; reason: string };

const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

/** Why a repository URL is not one an entry may name, or null. */
export function officialRepoProblem(repo: string): string | null {
  if (!OFFICIAL_REPOS.includes(repo)) return `${JSON.stringify(repo).slice(0, 120)} is not a repository this list may name`;
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return "the repository is not a URL";
  }
  // Belt and braces under the allowlist: an https GitHub address with nothing but the owner and the name.
  const plain = url.protocol === "https:" && url.hostname === "github.com" && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  if (!plain || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url.pathname)) return "the repository is not a plain https GitHub address";
  return null;
}

type EntryRead = { ok: true; entry: OfficialEntry } | { ok: false; reason: string };
const refuse = (reason: string): EntryRead => ({ ok: false, reason });

/** One entry read strictly, or why not. */
function readEntry(raw: JsonValue, at: number): EntryRead {
  const where = `entry ${String(at)}`;
  const doc = asJsonObject(raw);
  if (doc === undefined) return refuse(`${where} is not an object`);
  const extra = Object.keys(doc).find((key) => !ENTRY_KEYS.some((known) => known === key));
  if (extra !== undefined) return refuse(`${where} has a key this Collie does not know: ${JSON.stringify(extra).slice(0, 40)}`);
  const id = asJsonString(doc.id);
  const name = asJsonString(doc.name);
  const description = asJsonString(doc.description);
  const repo = asJsonString(doc.repo);
  const dir = asJsonString(doc.dir);
  const commit = asJsonString(doc.commit);
  const hash = asJsonString(doc.hash);
  const contract = asJsonNumber(doc.contract);
  if (id === undefined || !isTrickId(id)) return refuse(`${where} has no trick id (1 to 32 of a-z, 0-9 and -)`);
  if (name === undefined || !isTrickText(name, { max: NAME_MAX })) return refuse(`${id}: the name is missing, too long or holds a control or invisible character`);
  if (description === undefined || !isTrickText(description, { max: DESCRIPTION_MAX })) return refuse(`${id}: the description is missing, too long or holds a control or invisible character`);
  if (repo === undefined) return refuse(`${id}: no repository`);
  const repoProblem = officialRepoProblem(repo);
  if (repoProblem !== null) return refuse(`${id}: ${repoProblem}`);
  // One step by the trick id rule: no `/`, no `.` or `..`, no dot first, nothing a path could climb with.
  if (dir === undefined || !isTrickId(dir)) return refuse(`${id}: the folder is not one step named by the trick id rule`);
  if (commit === undefined || !COMMIT.test(commit)) return refuse(`${id}: the commit is not 40 hex digits`);
  if (hash === undefined || !HASH.test(hash)) return refuse(`${id}: the code hash is not 64 hex digits`);
  if (contract === undefined || !Number.isInteger(contract) || contract < 1 || contract > TRICK_CONTRACT) return refuse(`${id}: the contract is not one this Collie speaks (1 to ${String(TRICK_CONTRACT)})`);
  const previous = readPrevious(doc.previous, commit);
  if (!previous.ok) return refuse(`${id}: ${previous.reason}`);
  return { ok: true, entry: { id, name, description, repo, dir, commit, hash, contract, previous: previous.versions } };
}

/** An entry's earlier versions read strictly, or why not. */
function readPrevious(raw: JsonValue | undefined, current: string): { ok: true; versions: OfficialVersion[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "previous is not an array" };
  if (raw.length > OFFICIAL_PREVIOUS_MAX) return { ok: false, reason: `previous holds more than ${String(OFFICIAL_PREVIOUS_MAX)} versions` };
  const versions: OfficialVersion[] = [];
  for (const item of raw) {
    const doc = asJsonObject(item);
    if (doc === undefined || Object.keys(doc).some((key) => key !== "commit" && key !== "hash")) return { ok: false, reason: "a previous version is not { commit, hash }" };
    const commit = asJsonString(doc.commit);
    const hash = asJsonString(doc.hash);
    if (commit === undefined || !COMMIT.test(commit) || hash === undefined || !HASH.test(hash)) return { ok: false, reason: "a previous version has no commit of 40 hex digits or no hash of 64" };
    if (commit === current || versions.some((held) => held.commit === commit)) return { ok: false, reason: `the commit ${commit.slice(0, 12)} is listed twice` };
    versions.push({ commit, hash });
  }
  return { ok: true, versions };
}

/** The version of an entry at `commit`: the current one or a previous one, or undefined when the list does not know it. */
export function listedVersion(entry: Pick<OfficialEntry, "commit" | "hash" | "previous">, commit: string): OfficialVersion | undefined {
  if (commit === entry.commit) return { commit: entry.commit, hash: entry.hash };
  return entry.previous.find((v) => v.commit === commit);
}

/** Whether an origin record is one of this list's: `official: true`, the entry's repository and folder, a listed commit. */
export function isListedOrigin(entry: Pick<OfficialEntry, "repo" | "dir" | "commit" | "hash" | "previous">, origin: TrickOrigin): boolean {
  return origin.official === true && origin.url === entry.repo && origin.subdir === entry.dir && listedVersion(entry, origin.commit) !== undefined;
}

/**
 * Whether a trick's origin names an official repository without being a version of the list: a pull
 * request's ref, a fork's commit, a branch nobody listed. Its row says it is not on the Collie list.
 */
export function isUnlistedOfficialOrigin(entries: readonly OfficialEntry[], id: string, origin: TrickOrigin): boolean {
  if (!OFFICIAL_REPOS.includes(origin.url) && !entries.some((e) => e.repo === origin.url)) return false;
  const entry = entries.find((e) => e.id === id);
  return entry === undefined || !isListedOrigin(entry, origin);
}

/** The list from its JSON value, strictly: every entry or none. */
export function parseOfficialList(raw: JsonValue | undefined): OfficialList {
  const doc = asJsonObject(raw);
  if (doc === undefined) return { ok: false, reason: "the list is not an object" };
  const extra = Object.keys(doc).find((key) => key !== "v" && key !== "tricks");
  if (extra !== undefined) return { ok: false, reason: `the list has a key this Collie does not know: ${JSON.stringify(extra).slice(0, 40)}` };
  if (asJsonNumber(doc.v) !== 1) return { ok: false, reason: "the list is not version 1" };
  const list = doc.tricks;
  if (!Array.isArray(list)) return { ok: false, reason: "the list has no tricks array" };
  if (list.length > OFFICIAL_ENTRIES_MAX) return { ok: false, reason: `the list holds more than ${String(OFFICIAL_ENTRIES_MAX)} entries` };
  const entries: OfficialEntry[] = [];
  for (const [at, item] of list.entries()) {
    const read = readEntry(item, at);
    if (!read.ok) return read;
    const { entry } = read;
    if (entries.some((held) => held.id === entry.id)) return { ok: false, reason: `${entry.id} is listed twice` };
    entries.push(entry);
  }
  return { ok: true, entries };
}

/** The list's text as the maintainer script writes it: two spaces, the keys in their order, one newline at the end. */
export function renderOfficialList(entries: readonly OfficialEntry[]): string {
  const tricks = entries.map((e) => ({ id: e.id, name: e.name, description: e.description, repo: e.repo, dir: e.dir, commit: e.commit, hash: e.hash, contract: e.contract, previous: e.previous.map((v) => ({ commit: v.commit, hash: v.hash })) }));
  return `${JSON.stringify({ v: 1, tricks }, null, 2)}\n`;
}

let held: OfficialList | null = null;

/** The list this binary carries, read once. A list the reader refuses is empty, with `reason` set. */
export function shippedOfficialList(): OfficialList {
  // The import is the JSON document as built; it is read as any JSON value, then strictly.
  const value: JsonValue = shipped;
  held ??= parseOfficialList(value);
  return held;
}

/** Where one entry stands on this machine, and for `taken`, whether the folder is from its repository but not from the list. */
export interface OfficialStanding {
  state: OfficialState;
  /** `taken` by a folder from the entry's repository and folder at a commit the list does not know, or without `official`. */
  unlisted: boolean;
  /** The folder's origin record, when it has one. */
  origin: TrickOrigin | null;
}

type EntryKeys = Pick<OfficialEntry, "id" | "repo" | "dir" | "commit" | "hash" | "previous">;

/** Where one entry stands on this machine. Reads the folder and its origin record; never follows a link. */
export async function officialStanding(configDir: string, entry: EntryKeys, fs: TrickFs = diskTrickFs): Promise<OfficialStanding> {
  const dir = join(tricksConfigDir(configDir), entry.id);
  const st = await fs.lstat(dir);
  if (st === null) return { state: "absent", unlisted: false, origin: null };
  if (st.kind !== "dir") return { state: "taken", unlisted: false, origin: null };
  const origin = await readOrigin(dir, fs);
  // Only a folder from this repository and this folder in it is a candidate. Any other, a proposal's or one
  // made by hand included, is the person's: never written over.
  if (origin === null || origin.url !== entry.repo || origin.subdir !== entry.dir) return { state: "taken", unlisted: false, origin };
  // From the repository, but not a version of the list: `collie trick add` at another ref, or a record by hand.
  if (!isListedOrigin(entry, origin)) return { state: "taken", unlisted: true, origin };
  return { state: origin.commit === entry.commit ? "added" : "update", unlisted: false, origin };
}

/** {@link officialStanding}'s state alone. */
export async function officialStateOf(configDir: string, entry: EntryKeys, fs: TrickFs = diskTrickFs): Promise<OfficialState> {
  return (await officialStanding(configDir, entry, fs)).state;
}

/** The list as the phone reads it, each entry with its state on this machine. */
export async function officialWire(configDir: string, entries: readonly OfficialEntry[], fs: TrickFs = diskTrickFs): Promise<WireOfficialTrick[]> {
  return await Promise.all(
    entries.map(async (e) => {
      const standing = await officialStanding(configDir, e, fs);
      const wire: WireOfficialTrick = { id: e.id, name: e.name, description: e.description, repo: e.repo, repoName: originRepoName(e.repo), commit: e.commit, state: standing.state };
      if (standing.unlisted) wire.unlisted = true;
      return wire;
    }),
  );
}
