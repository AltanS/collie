import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import { diskTrickFs, type TrickFs } from "./code-hash.ts";

// WHERE A TRICK CAME FROM (M94 review 15). `collie trick add` writes one dot file into the trick folder it
// makes, and `collie trick update` rewrites it:
//
//   { "v": 1, "url": "https://github.com/AltanS/collie-tricks", "ref": "v1", "commit": "<40 hex>",
//     "subdir": "legs", "at": "2026-11-10T09:41:00.000Z" }
//
// `ref` is what the person asked for (null for the repository's default branch), `commit` what it
// resolved to, `subdir` the folder inside the repository (null for its top). The file starts with a dot,
// so the code hash leaves it out (code-hash.ts `skippedName`): writing it never stops a trick, and the
// consent stays with the code. `update` is refused for a folder without one, and the bridge shows it on
// the trick's row as its provenance. A file that does not parse reads as no origin.
//
// A trick added from the official list (official-install.ts) carries the same record with
// `"official": true`, its `ref` the list's commit. The key is absent from every other record, so a record
// `collie trick add` wrote reads byte for byte as before. It is read (official.ts `isListedOrigin`), but it
// is never enough alone: a hand can write it, so a folder counts as from the list only when the record
// also names a commit the list knows for that id, and an update first checks the folder's code hash
// against that commit's listed hash (official-install.ts). Nothing else is allowed by it.

/** The origin record inside a trick folder. A dot file: outside the code hash. */
export const ORIGIN_FILE = ".collie-origin.json";
/** The most bytes of the origin record read. */
const ORIGIN_BYTES_MAX = 8 * 1024;

export interface TrickOrigin {
  url: string;
  /** The branch, tag or commit asked for, or null for the default branch. */
  ref: string | null;
  /** The commit the ref resolved to, 40 hex. */
  commit: string;
  /** The folder inside the repository, or null for its top. */
  subdir: string | null;
  /** When it was added or last updated, an instant. */
  at: string;
  /** Added or updated from the official list of this Collie (official-install.ts). Absent otherwise. */
  official?: true;
}

/** The record's text. */
export function renderOrigin(origin: TrickOrigin): string {
  const { url, ref, commit, subdir, at } = origin;
  const doc = origin.official === true ? { v: 1, url, ref, commit, subdir, at, official: true } : { v: 1, url, ref, commit, subdir, at };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The record from its text, or null when it is not one. */
export function parseOrigin(text: string | null): TrickOrigin | null {
  if (text === null) return null;
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined || asJsonNumber(doc.v) !== 1) return null;
  const url = asJsonString(doc.url);
  const commit = asJsonString(doc.commit);
  const at = asJsonString(doc.at);
  if (url === undefined || commit === undefined || !/^[0-9a-f]{40}$/u.test(commit) || at === undefined) return null;
  const ref = doc.ref === null ? null : asJsonString(doc.ref);
  const subdir = doc.subdir === null ? null : asJsonString(doc.subdir);
  if (ref === undefined || subdir === undefined) return null;
  return doc.official === true ? { url, ref, commit, subdir, at, official: true } : { url, ref, commit, subdir, at };
}

/** Read a trick folder's origin record: a regular file of at most 8 KiB, never through a symlink. */
export async function readOrigin(dir: string, fs: TrickFs = diskTrickFs): Promise<TrickOrigin | null> {
  const text = await readOriginText(dir, fs);
  return parseOrigin(text);
}

/** The origin record's text, or null: a regular file of at most 8 KiB, never through a symlink. */
async function readOriginText(dir: string, fs: TrickFs): Promise<string | null> {
  const path = join(dir, ORIGIN_FILE);
  const st = await fs.lstat(path);
  if (st === null || st.kind !== "file" || st.size > ORIGIN_BYTES_MAX) return null;
  const bytes = await fs.read(path, ORIGIN_BYTES_MAX);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

// A PROPOSED TRICK (crew slice 8). A trick an agent or a terminal handed in with `collie trick propose`,
// installed after the person's yes, carries the other form of the record:
//
//   { "v": 1, "via": "proposal", "by": "agent", "host": "minibuch", "label": "repo#one",
//     "at": "2026-11-11T09:41:00.000Z" }
//
// `by` is `agent` or `terminal`; `host` and `label` are what the lead knew of the proposer when the
// proposal came in. It is display data: Settings says "Added by agent" (or "Added by CLI") from it. It
// is not consent; the approval in switches.json is. `collie trick update` refuses a folder with this
// record, as it refuses one with no record: there is no repository to update from.

/** Where a proposed trick came from. */
export interface ProposalOrigin {
  by: "agent" | "terminal";
  /** The machine the proposal came from, as the lead names it. */
  host: string;
  /** The proposing session's name, or null for a terminal. */
  label: string | null;
  /** When the person said yes, an instant. */
  at: string;
}

/** The longest host or label the record keeps. */
const PROPOSAL_FIELD_MAX = 80;

/** The proposal record's text. */
export function renderProposalOrigin(origin: ProposalOrigin): string {
  const { by, host, label, at } = origin;
  return `${JSON.stringify({ v: 1, via: "proposal", by, host, label, at }, null, 2)}\n`;
}

/** The proposal record from its text, or null when it is not one. */
export function parseProposalOrigin(text: string | null): ProposalOrigin | null {
  if (text === null) return null;
  const doc = asJsonObject(parseJson(text));
  if (doc === undefined || asJsonNumber(doc.v) !== 1 || asJsonString(doc.via) !== "proposal") return null;
  const by = asJsonString(doc.by);
  const host = asJsonString(doc.host);
  const at = asJsonString(doc.at);
  const label = doc.label === null ? null : asJsonString(doc.label);
  if ((by !== "agent" && by !== "terminal") || host === undefined || at === undefined || label === undefined) return null;
  if (host.length > PROPOSAL_FIELD_MAX || (label !== null && label.length > PROPOSAL_FIELD_MAX)) return null;
  return { by, host, label, at };
}

/** Read a trick folder's proposal record, the same hardened way as {@link readOrigin}. */
export async function readProposalOrigin(dir: string, fs: TrickFs = diskTrickFs): Promise<ProposalOrigin | null> {
  return parseProposalOrigin(await readOriginText(dir, fs));
}

/** One short word for `collie trick list`: `proposed by agent on minibuch`. */
export function proposalShort(origin: ProposalOrigin): string {
  return `proposed by ${origin.by} on ${origin.host}`;
}

/** A short name for the repository: `owner/repo` on GitHub, else the host and path, no `.git`. */
export function originRepoName(url: string): string {
  const bare = url.replace(/^https:\/\//u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  return bare.startsWith("github.com/") ? bare.slice("github.com/".length) : bare;
}

/** One short word for `collie trick list`: `owner/repo@abc1234`, with `/subdir` when there is one. */
export function originShort(origin: TrickOrigin): string {
  const where = origin.subdir === null ? originRepoName(origin.url) : `${originRepoName(origin.url)}/${origin.subdir}`;
  return `${where}@${origin.commit.slice(0, 7)}`;
}
