import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../../web/src/lib/json.ts";
import { TRICK_CONTRACT } from "../../web/src/lib/tricks/contract.ts";
import { DESCRIPTION_MAX, isTrickId, isTrickText, NAME_MAX, type OfficialState, type WireOfficialTrick } from "../../web/src/lib/tricks/schema.ts";
import { diskTrickFs, type TrickFs } from "./code-hash.ts";
import shipped from "./official.json";
import { originRepoName, readOrigin } from "./origin.ts";
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
// Collie speaks, no id twice, at most {@link OFFICIAL_ENTRIES_MAX} entries. A list it refuses is no list:
// the bridge offers nothing and says why once. The maintainer script (scripts/official-tricks.ts) rewrites
// commits and hashes from a checkout of the repository, and `--check` fails when the list is stale.

/** The repositories a list entry may name. One, on purpose. */
export const OFFICIAL_REPOS: readonly string[] = ["https://github.com/AltanS/collie-tricks"];
/** The most entries a list holds. */
export const OFFICIAL_ENTRIES_MAX = 32;
/** The keys of an entry, all required, no other. */
const ENTRY_KEYS = ["id", "name", "description", "repo", "dir", "commit", "hash", "contract"] as const;

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
  return { ok: true, entry: { id, name, description, repo, dir, commit, hash, contract } };
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
  const tricks = entries.map((e) => ({ id: e.id, name: e.name, description: e.description, repo: e.repo, dir: e.dir, commit: e.commit, hash: e.hash, contract: e.contract }));
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

/** Where one entry stands on this machine. Reads the folder and its origin record; never follows a link. */
export async function officialStateOf(configDir: string, entry: Pick<OfficialEntry, "id" | "repo" | "dir" | "commit">, fs: TrickFs = diskTrickFs): Promise<OfficialState> {
  const dir = join(tricksConfigDir(configDir), entry.id);
  const st = await fs.lstat(dir);
  if (st === null) return "absent";
  if (st.kind !== "dir") return "taken";
  const origin = await readOrigin(dir, fs);
  // Only a folder from this repository and this folder in it is the list's to update. Any other, a
  // proposal's or one made by hand included, is the person's: never written over.
  if (origin === null || origin.url !== entry.repo || origin.subdir !== entry.dir) return "taken";
  return origin.commit === entry.commit ? "added" : "update";
}

/** The list as the phone reads it, each entry with its state on this machine. */
export async function officialWire(configDir: string, entries: readonly OfficialEntry[], fs: TrickFs = diskTrickFs): Promise<WireOfficialTrick[]> {
  return await Promise.all(
    entries.map(async (e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      repo: e.repo,
      repoName: originRepoName(e.repo),
      commit: e.commit,
      state: await officialStateOf(configDir, e, fs),
    })),
  );
}
