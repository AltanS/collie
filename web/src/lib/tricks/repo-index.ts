// ONE REPOSITORY, MANY TRICKS: the index file `collie-tricks.json` (2026-11-17, package J).
//
// A repository may hold `collie-tricks.json` at its top. It is a list and nothing more:
//
//   { "contract": 1, "tricks": [ { "folder": "idle-watch", "name": "Idle Watch", "about": "Marks a session that waits for you." } ] }
//
// THE INDEX GRANTS NOTHING. It only names folders. Each trick is still fetched, checked, hashed and added
// OFF, and its switch asks as for any trick. `name` and `about` are the repository's own words, untrusted:
// the phone shows them as "the repository says", and the trick's own `trick.toml` wins once it is added. A
// repository's index never makes a trick official: the list this binary carries is the only "Official".
//
// This file has no node import: the bridge (bridge/tricks/repo-index.ts), the CLI (cli/trick-add.ts) and the
// phone (components/tricks-repo-sheet.tsx) read the same rules from it.
//
// THE PARSER IS STRICT, like `trick.toml`'s: at most {@link REPO_INDEX_BYTES_MAX} bytes of UTF-8, JSON, an
// object of exactly `contract` and `tricks`, `contract` {@link REPO_INDEX_CONTRACT} (a higher one is refused
// with one sentence), at most {@link REPO_INDEX_TRICKS_MAX} entries of exactly `folder`, `name` and `about`.
// `folder` is spelled as a trick id, so it is one path step (no `/`, no `..`, no leading dot); no folder
// twice. `name` at most {@link REPO_INDEX_NAME_MAX} characters, `about` at most {@link REPO_INDEX_ABOUT_MAX},
// both one line with no control, direction or invisible character. Any other key is refused.
//
// THE PHONE'S HOSTS. A tap makes the bridge fetch the link the person pasted, so the phone flow takes only
// {@link REPO_INDEX_HOSTS}, spelled exactly (lower case, no port, no user name), as https. Any other host,
// an IP address and `localhost` included, answers {@link REPO_INDEX_TERMINAL_LINE}. The terminal verb
// `collie trick add <url>` keeps its wider reach (cli/trick-add.ts).

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import { REPO_INDEX_ABOUT_MAX, REPO_INDEX_BYTES_MAX, REPO_INDEX_CONTRACT, REPO_INDEX_NAME_MAX, REPO_INDEX_TRICKS_MAX } from "./limits";
import { isSourceUrl, isTrickId, isTrickText, SOURCE_URL_MAX } from "./schema";

/** The index's file name, at the top of the repository. */
export const REPO_INDEX_FILE = "collie-tricks.json";

/** The hosts the phone flow fetches from, exactly as spelled here. */
export const REPO_INDEX_HOSTS = ["github.com", "gitlab.com", "codeberg.org"] as const;

/** The one sentence for a link on any other host. */
export const REPO_INDEX_TERMINAL_LINE = "The phone adds from github.com, gitlab.com and codeberg.org only; add a trick from this link at the terminal with `collie trick add <url>`.";

/** One entry of an index, as the parser took it. */
export interface RepoIndexEntry {
  folder: string;
  name: string;
  about: string;
}

/** A parsed index. */
export interface RepoIndex {
  contract: typeof REPO_INDEX_CONTRACT;
  tricks: RepoIndexEntry[];
}

export type RepoIndexRead = { ok: true; index: RepoIndex } | { ok: false; reason: string };

const TOP_KEYS = ["contract", "tricks"] as const;
const ENTRY_KEYS = ["folder", "name", "about"] as const;

function refused(reason: string): RepoIndexRead {
  return { ok: false, reason: `${REPO_INDEX_FILE} ${reason}` };
}

/** The first key of `obj` that is not in `allowed`, or undefined. */
function strayKey(obj: Record<string, JsonValue | undefined>, allowed: readonly string[]): string | undefined {
  return Object.keys(obj).find((key) => !allowed.includes(key));
}

/** Read one entry, or say why it is refused. */
function readEntry(raw: JsonValue, at: number): { ok: true; entry: RepoIndexEntry } | { ok: false; reason: string } {
  const where = `tricks[${String(at)}]`;
  const obj = asJsonObject(raw);
  if (obj === undefined) return { ok: false, reason: `${where} is not an object.` };
  const stray = strayKey(obj, ENTRY_KEYS);
  // The key is the file's own text: shown cut and cleaned, never as it is.
  if (stray !== undefined) return { ok: false, reason: `${where} has a key Collie does not know: "${shownIndexText(stray, 40)}".` };
  const folder = asJsonString(obj.folder);
  const name = asJsonString(obj.name);
  const about = asJsonString(obj.about);
  if (folder === undefined || !isTrickId(folder)) return { ok: false, reason: `${where}.folder is not a folder name Collie takes (1 to 32 of a-z, 0-9 and -, starting with a letter or digit).` };
  if (name === undefined || !isTrickText(name, { max: REPO_INDEX_NAME_MAX })) return { ok: false, reason: `${where}.name must be one line of 1 to ${String(REPO_INDEX_NAME_MAX)} characters, with no control or invisible character.` };
  if (about === undefined || !isTrickText(about, { max: REPO_INDEX_ABOUT_MAX })) return { ok: false, reason: `${where}.about must be one line of 1 to ${String(REPO_INDEX_ABOUT_MAX)} characters, with no control or invisible character.` };
  return { ok: true, entry: { folder, name, about } };
}

/** Read an index file's bytes by the strict rules above. */
export function parseRepoIndex(bytes: Uint8Array): RepoIndexRead {
  if (bytes.length > REPO_INDEX_BYTES_MAX) return refused(`is larger than ${String(REPO_INDEX_BYTES_MAX / 1024)} KiB.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refused("is not UTF-8 text.");
  }
  let doc: JsonValue;
  try {
    // SAFETY: `JSON.parse` answers with a JSON value by construction; every field is checked below.
    doc = JSON.parse(text) as JsonValue;
  } catch {
    return refused("is not JSON.");
  }
  const top = asJsonObject(doc);
  if (top === undefined) return refused("is not a JSON object.");
  const stray = strayKey(top, TOP_KEYS);
  if (stray !== undefined) return refused(`has a key Collie does not know: "${shownIndexText(stray, 40)}".`);
  const contract = asJsonNumber(top.contract);
  if (contract === undefined || !Number.isSafeInteger(contract) || contract < 1) return refused(`needs "contract": ${String(REPO_INDEX_CONTRACT)}.`);
  if (contract > REPO_INDEX_CONTRACT) return refused(`is written for contract ${String(contract)}, and this Collie reads contract ${String(REPO_INDEX_CONTRACT)}; update Collie to read it.`);
  const list = top.tricks;
  if (!Array.isArray(list)) return refused('needs "tricks", a list.');
  if (list.length > REPO_INDEX_TRICKS_MAX) return refused(`lists ${String(list.length)} tricks, more than ${String(REPO_INDEX_TRICKS_MAX)}.`);
  const tricks: RepoIndexEntry[] = [];
  const seen = new Set<string>();
  for (const [at, raw] of list.entries()) {
    const read = readEntry(raw, at);
    if (!read.ok) return refused(read.reason);
    if (seen.has(read.entry.folder)) return refused(`names the folder ${read.entry.folder} twice.`);
    seen.add(read.entry.folder);
    tricks.push(read.entry);
  }
  return { ok: true, index: { contract: REPO_INDEX_CONTRACT, tricks } };
}

// ── untrusted text ─────────────────────────────────────────────────────────────

/** A control, direction or invisible character, as schema.ts refuses them in a trick's text. */
function unseen(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  if (code === 0x200e || code === 0x200f || code === 0x061c || code === 0x200b || code === 0x2060 || code === 0xfeff) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code >= 0xe0000 && code <= 0xe007f;
}

/**
 * A repository's own words as Collie shows them: every control, direction and invisible character dropped
 * (a line break or a tab becomes a space), runs of spaces made one, then cut to `max` characters with an
 * ellipsis. Plain text for a text node or a terminal line, never markup. The parser already refuses such
 * characters; this is the second wall, for any reader of a reply or a name.
 */
export function shownIndexText(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
    else if (!unseen(code)) out += ch;
  }
  const flat = out.replace(/ {2,}/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// ── the phone's link ───────────────────────────────────────────────────────────

/** A link the phone flow takes: the URL as pasted, its host, and its repository path (`owner/repo`). */
export interface PhoneSource {
  url: string;
  host: (typeof REPO_INDEX_HOSTS)[number];
  repo: string;
}

/** Why a link is not one the phone flow takes: `invalid` (not an https repository link) or `host` (another host). */
export type PhoneSourceProblem = { code: "invalid" | "host"; message: string };

const PHONE_LINK = /^https:\/\/([^/?#]*)(\/[^?#]*)$/u;
const REPO_STEP = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u;
/** Path steps of a repository: owner and name, and a few GitLab subgroups between them. */
const REPO_STEPS = { min: 2, max: 6 } as const;

function isPhoneHost(text: string): text is PhoneSource["host"] {
  return REPO_INDEX_HOSTS.some((host) => host === text);
}

/**
 * Read a pasted link by the phone flow's rule: https, no user name or password, no query or fragment,
 * a host of {@link REPO_INDEX_HOSTS} written exactly (so a port, an upper-case letter, an IP address and
 * `localhost` are another host), and a repository path. The host is compared on the text as pasted,
 * never on what `URL` makes of it, so `GitHub.com:443` is not `github.com`.
 */
export function readPhoneSource(raw: string): PhoneSource | PhoneSourceProblem {
  const url = raw.trim();
  if (url.length > SOURCE_URL_MAX) return { code: "invalid", message: "The link is too long." };
  if (!url.startsWith("https://")) return { code: "invalid", message: "Paste an https link to a git repository." };
  const match = PHONE_LINK.exec(url);
  const authority = match?.[1] ?? "";
  if (authority.includes("@")) return { code: "invalid", message: "The link holds a user name or a password. Leave them out." };
  if (match === null || !isSourceUrl(url)) return { code: "invalid", message: "Paste an https link to a git repository, with nothing after its name." };
  if (!isPhoneHost(authority)) return { code: "host", message: REPO_INDEX_TERMINAL_LINE };
  const path = (match[2] ?? "").slice(1);
  const steps = path.split("/");
  if (steps.length < REPO_STEPS.min || steps.length > REPO_STEPS.max || !steps.every((step) => REPO_STEP.test(step) && !step.includes(".."))) {
    return { code: "invalid", message: "Paste the link of the repository itself, like https://github.com/owner/repo." };
  }
  return { url, host: authority, repo: path };
}

// ── the wire ─────────────────────────────────────────────────────────────────

/** One entry of a list reply: the index's words, and whether a trick of that id is here already. */
export interface RepoListEntry extends RepoIndexEntry {
  here: boolean;
}

/** `POST /api/tricks/repo/list`: the receipt of one read, with the commit it read. */
export interface RepoListReply {
  rid: string;
  code: "ok";
  url: string;
  host: string;
  repo: string;
  commit: string;
  tricks: RepoListEntry[];
}

/** `POST /api/tricks/repo/add`: the receipt of one add. The trick is off. */
export interface RepoAddReply {
  rid: string;
  code: "ok";
  id: string;
  hash: string;
}

const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

/** A list reply as the phone takes it: every text cleaned and cut again, a bad entry drops the reply. */
export function readRepoListReply(raw: JsonValue | undefined): RepoListReply | undefined {
  const doc = asJsonObject(raw);
  const rid = asJsonString(doc?.rid);
  const url = asJsonString(doc?.url);
  const host = asJsonString(doc?.host);
  const repo = asJsonString(doc?.repo);
  const commit = asJsonString(doc?.commit);
  const list = doc?.tricks;
  if (doc === undefined || doc.code !== "ok" || rid === undefined || url === undefined || host === undefined || repo === undefined || commit === undefined || !COMMIT.test(commit) || !Array.isArray(list)) return undefined;
  if (list.length > REPO_INDEX_TRICKS_MAX) return undefined;
  const tricks: RepoListEntry[] = [];
  for (const item of list) {
    const entry = asJsonObject(item);
    const folder = asJsonString(entry?.folder);
    const name = asJsonString(entry?.name);
    const about = asJsonString(entry?.about);
    const here = asJsonBoolean(entry?.here);
    if (folder === undefined || !isTrickId(folder) || name === undefined || about === undefined || here === undefined) return undefined;
    tricks.push({ folder, name: shownIndexText(name, REPO_INDEX_NAME_MAX), about: shownIndexText(about, REPO_INDEX_ABOUT_MAX), here });
  }
  return { rid, code: "ok", url: shownIndexText(url, SOURCE_URL_MAX), host: shownIndexText(host, 64), repo: shownIndexText(repo, SOURCE_URL_MAX), commit, tricks };
}

/** An add reply as the phone takes it. */
export function readRepoAddReply(raw: JsonValue | undefined): RepoAddReply | undefined {
  const doc = asJsonObject(raw);
  const rid = asJsonString(doc?.rid);
  const id = asJsonString(doc?.id);
  const hash = asJsonString(doc?.hash);
  if (doc === undefined || doc.code !== "ok" || rid === undefined || id === undefined || !isTrickId(id) || hash === undefined || !HASH.test(hash)) return undefined;
  return { rid, code: "ok", id, hash };
}
