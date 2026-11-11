import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import { CODE_BYTES_MAX, CODE_FILES_MAX, codeHashOfFiles, diskTrickFs, isCodePath, isPictureName, unsafeText } from "../tricks/code-hash.ts";
import { MANIFEST_BYTES_MAX, readManifestFile } from "../tricks/discover.ts";
import { foldKey, proposedPathProblem, strictBase64 } from "../tricks/propose-wire.ts";
import { isPictureBytes } from "../tricks/approved.ts";
import { hash16 } from "../tricks/paths.ts";
import type { CopyRole } from "./standby-launchers.ts";

// THE TRICKS A LEAD RUNS, CARRIED TO ITS DEPUTY AS INERT BYTES (CREW_PROTOCOL §25).
//
// A deputy takes over when its lead is gone. Before this, the tricks the lead ran were gone with it. Now
// the lead keeps a copy of each trick that is ON on its deputy: the approved code, the switch (with
// `auto`), the origin record, the person's `config.toml`, and the trick's small state. The copy starts
// nothing. It lands under `<stateDir>/standby-tricks/`, a folder the tricks loader never reads (it reads
// `<configDir>/tricks/` only), and no switch names it. Only the person's tap on the deputy's own standby
// page turns it into running tricks (`carry-adopt.ts`), and that tap checks every code hash again.
//
// ── THE LAYOUT ────────────────────────────────────────────────────────────────────────────────────
//   <stateDir>/standby-tricks/              0700
//     index.json                            0600  what the lead sent last, and what is held of it
//     code/<id>/<hash16>/<rel>              0600  the approved code, checked against its hash
//     state/<id>/{state,media,captures}/…   0600  the trick's state folder and its pictures
//     .stage-<random>/                      0700  a part on its way in, renamed into place when whole
// No file here carries an executable bit. Whether a file was executable rides in the index (`x`) and is
// applied only when the person's tap writes the trick out.
//
// ── THE WIRE (lead → deputy, the launchers copy's gate) ───────────────────────────────────────────
//   POST /crew/v1/tricks-copy        { seq, tricks: [CarriedTrick] }      → { applied, need: { code, state } }
//   POST /crew/v1/tricks-copy/code   { id, hash, part, parts, chunks }    → { held }
//   POST /crew/v1/tricks-copy/state  { id, digest, files }                → { applied }
// The code goes in parts of at most {@link CARRY_PART_BYTES} bytes, in order, so one call stays under
// its 3 MiB body cap while a trick may hold up to 20 MB of code. The last part is checked: the deputy
// hashes the files it holds with the real code hash (`codeHashOfFiles`) and refuses a mismatch.
//
// ── THE REPORT ────────────────────────────────────────────────────────────────────────────────────
// The deputy reports `tricksDigest` (the digest of the list it holds), `tricksSeq` and `tricksNeed` (how
// many parts it still lacks) on `hello` and `snapshot`. The lead sends when the digest differs, and asks
// again for what is missing at most once a minute. `seq` only rises: a list older than the one held is
// refused, so a late push can never roll a trick back to an older version.
//
// PURE except for {@link StandbyTricksStore}, the one thing here that touches a disk.

/** The folder under the state dir. Never under `<configDir>/tricks/`, where the loader reads. */
export const STANDBY_TRICKS_DIRNAME = "standby-tricks";
/** The index file's schema version. */
export const STANDBY_TRICKS_VERSION = 1;

/** The report's fields on `hello` and `snapshot`. */
export const TRICKS_DIGEST_FIELD = "tricksDigest";
export const TRICKS_SEQ_FIELD = "tricksSeq";
export const TRICKS_NEED_FIELD = "tricksNeed";

/** The most tricks one list carries. A lead with more sends the first this many, by id. */
export const CARRIED_TRICKS_MAX = 32;
/** The most raw bytes of code one part carries: 2 MiB, about 2.7 MiB as base64, under the 3 MiB body cap. */
export const CARRY_PART_BYTES = 2 * 1024 * 1024;
/** The most parts one trick's code may take: {@link CODE_BYTES_MAX} over the part size, and room. */
export const CARRY_PARTS_MAX = Math.ceil(CODE_BYTES_MAX / CARRY_PART_BYTES) + 2;
/** All carried code together. A trick that does not fit is not carried, and the page does not list it. */
export const CARRY_CODE_TOTAL_MAX = 64 * 1024 * 1024;
/** One trick's state, its pictures included. */
export const CARRY_STATE_TRICK_MAX = 4 * 1024 * 1024;
/** Every trick's state together. */
export const CARRY_STATE_TOTAL_MAX = 16 * 1024 * 1024;
/** The most files of one trick's state. */
export const CARRY_STATE_FILES_MAX = 500;
/** A trick's state is taken at most this often. */
export const CARRY_STATE_EVERY_MS = 60_000;
/** The longest origin record carried, as `origin.ts` reads it. */
export const CARRY_ORIGIN_MAX = 8 * 1024;
/** The body caps of the three routes, read before a byte of the body is. */
export const TRICKS_LIST_BODY_MAX = 8 * 1024 * 1024;
export const TRICKS_CODE_BODY_MAX = 3 * 1024 * 1024;
export const TRICKS_STATE_BODY_MAX = 6 * 1024 * 1024;

/** The three folders of a carried state, each the root of its files. */
export const STATE_PARTS = ["state", "media", "captures"] as const;
type StatePart = (typeof STATE_PARTS)[number];

const HASH_RE = /^[0-9a-f]{64}$/u;
const POWERS_RE = /^[0-9a-f]{16}$/u;

/** One code file as the list names it. */
export type CarriedFile = {
  rel: string;
  size: number;
  /** Executable on the lead. Applied only when the person's tap writes the trick out. */
  x: boolean;
};

/** One trick that is ON on the lead, as the list carries it. A type, so it is a JSON object. */
export type CarriedTrick = {
  id: string;
  /** The approved code hash (switches.ts), 64 hex. */
  hash: string;
  auto: boolean;
  /** When and by whom the version was approved on the lead. Display and audit only. */
  at: string;
  by: string;
  /** The powers hash approved, or null when it was not known. Recomputed from the code at the tap. */
  powers: string | null;
  /** `config.toml` as base64, or null with none. It holds the person's settings and may hold secrets. */
  config: string | null;
  /** The origin record's text, or null with none. */
  origin: string | null;
  files: CarriedFile[];
  /** The lead's digest of the state it would send, or null when it has none. */
  state: string | null;
};

/** One part of a trick's code: bytes appended to files, in order. */
export interface CodeChunk {
  rel: string;
  /** Where these bytes go in the file: always the bytes held so far. */
  at: number;
  bytes: Uint8Array;
}

export interface CodePart {
  id: string;
  hash: string;
  part: number;
  parts: number;
  chunks: CodeChunk[];
}

/** One file of a trick's state, under one of {@link STATE_PARTS}. */
export interface StateFile {
  rel: string;
  bytes: Uint8Array;
}

export interface StatePush {
  id: string;
  digest: string;
  files: StateFile[];
}

// ── The digest ─────────────────────────────────────────────────────────────────────────────────────

/** The canonical JSON of one trick: a fixed key order, so the same trick digests the same everywhere. */
function canonicalTrick(t: CarriedTrick): JsonObject {
  return {
    id: t.id,
    hash: t.hash,
    auto: t.auto,
    at: t.at,
    by: t.by,
    powers: t.powers,
    config: t.config,
    origin: t.origin,
    files: t.files.map((f) => ({ rel: f.rel, size: f.size, x: f.x })),
    state: t.state,
  };
}

/** The digest of a list: the lead's over what it would send, the deputy's over what it holds. */
export function tricksDigest(tricks: readonly CarriedTrick[]): string {
  const sorted = tricks.toSorted((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(sorted.map(canonicalTrick))).digest("hex");
}

/** The deputy's report, as it rides `hello` and `snapshot`. */
export interface TricksReport {
  readonly digest: string;
  readonly seq: number;
  readonly need: number;
}

/** Read a member's report off a `hello`/`snapshot` body, or `null` when it carried none. */
export function parseTricksReport(value: JsonValue | undefined): TricksReport | null {
  const body = asJsonObject(value);
  const digest = asJsonString(body?.[TRICKS_DIGEST_FIELD]);
  const seq = asJsonNumber(body?.[TRICKS_SEQ_FIELD]);
  const need = asJsonNumber(body?.[TRICKS_NEED_FIELD]);
  if (digest === undefined || !HASH_RE.test(digest) || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { digest, seq, need: need !== undefined && Number.isSafeInteger(need) && need > 0 ? need : 0 };
}

/** The report's fields, to splice into `hello` and `snapshot`. */
export function tricksReportFields(report: TricksReport | null): JsonObject {
  if (report === null) return {};
  return { [TRICKS_DIGEST_FIELD]: report.digest, [TRICKS_SEQ_FIELD]: report.seq, [TRICKS_NEED_FIELD]: report.need };
}

// ── Reading the wire ──────────────────────────────────────────────────────────────────────────────

/** Why a path cannot be a carried code file, or null. The proposal reader's rules, plus "it is code". */
export function carriedPathProblem(rel: string): string | null {
  const problem = proposedPathProblem(rel);
  if (problem !== null) return problem;
  return isCodePath(rel) ? null : "is not a code file";
}

/**
 * A list of code files, or why not: every path clean, no two that fold to one (case, Unicode form), no
 * name used as a file and as a folder, within the code hash's own caps.
 */
export function checkCarriedFiles(files: readonly CarriedFile[]): string | null {
  if (files.length === 0) return "a trick carries at least its trick.toml";
  if (files.length > CODE_FILES_MAX) return `more than ${String(CODE_FILES_MAX)} files`;
  let bytes = 0;
  const folded = new Set<string>();
  const folders = new Map<string, string>();
  for (const file of files) {
    const problem = carriedPathProblem(file.rel);
    if (problem !== null) return `a file name ${problem}`;
    const key = foldKey(file.rel);
    if (folded.has(key)) return "two files are one name once case and Unicode form are set aside";
    folded.add(key);
    const steps = key.split("/");
    const spelled = file.rel.split("/");
    for (let i = 1; i < steps.length; i += 1) {
      const folder = steps.slice(0, i).join("/");
      const spelling = spelled.slice(0, i).join("/");
      const seen = folders.get(folder);
      if (seen !== undefined && seen !== spelling) return "two folders are one name once case and Unicode form are set aside";
      folders.set(folder, spelling);
    }
    bytes += file.size;
    if (bytes > CODE_BYTES_MAX) return `more than ${String(CODE_BYTES_MAX / (1024 * 1024))} MB of code`;
  }
  for (const key of folded) if (folders.has(key)) return "a name is used as a file and as a folder";
  if (!files.some((f) => f.rel === "trick.toml")) return "there is no trick.toml";
  return null;
}

function readFile1(value: JsonValue | undefined): CarriedFile | null {
  const row = asJsonObject(value);
  const rel = asJsonString(row?.rel);
  const size = asJsonNumber(row?.size);
  const x = asJsonBoolean(row?.x);
  if (rel === undefined || size === undefined || x === undefined || !Number.isSafeInteger(size) || size < 0 || size > CODE_BYTES_MAX) return null;
  return { rel, size, x };
}

/** A short word: `at` or `by`, printable, bounded. */
function shortWord(value: JsonValue | undefined, max: number): string | null {
  const text = asJsonString(value);
  if (text === undefined || text === "" || text.length > max || unsafeText(text)) return null;
  return text;
}

/** One trick of a list, or null. Every field is checked: the bytes it names may run one day. */
export function parseCarriedTrick(value: JsonValue | undefined): CarriedTrick | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const id = asJsonString(row.id);
  const hash = asJsonString(row.hash);
  const auto = asJsonBoolean(row.auto);
  const at = shortWord(row.at, 64);
  const by = shortWord(row.by, 64);
  if (id === undefined || !isTrickId(id) || hash === undefined || !HASH_RE.test(hash) || auto === undefined || at === null || by === null) return null;
  const powers = row.powers === null ? null : asJsonString(row.powers);
  if (powers === undefined || (powers !== null && !POWERS_RE.test(powers))) return null;
  const config = row.config === null ? null : asJsonString(row.config);
  if (config === undefined) return null;
  if (config !== null) {
    const bytes = strictBase64(config);
    if (bytes === null || bytes.length > MANIFEST_BYTES_MAX) return null;
  }
  const origin = row.origin === null ? null : asJsonString(row.origin);
  if (origin === undefined || (origin !== null && Buffer.byteLength(origin, "utf8") > CARRY_ORIGIN_MAX)) return null;
  const state = row.state === null ? null : asJsonString(row.state);
  if (state === undefined || (state !== null && !HASH_RE.test(state))) return null;
  if (!Array.isArray(row.files)) return null;
  const files: CarriedFile[] = [];
  for (const item of row.files) {
    const file = readFile1(item);
    if (file === null) return null;
    files.push(file);
  }
  if (checkCarriedFiles(files) !== null) return null;
  return { id, hash, auto, at, by, powers, config, origin, files: files.toSorted((a, b) => (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1)), state };
}

/** The body of `POST /crew/v1/tricks-copy`, or null. A bad trick refuses the whole list, as does a repeated id. */
export function parseTricksList(value: JsonValue | undefined): { seq: number; tricks: CarriedTrick[] } | null {
  const body = asJsonObject(value);
  const seq = asJsonNumber(body?.seq);
  if (body === undefined || seq === undefined || !Number.isSafeInteger(seq) || seq <= 0 || !Array.isArray(body.tricks)) return null;
  if (body.tricks.length > CARRIED_TRICKS_MAX) return null;
  const tricks: CarriedTrick[] = [];
  for (const item of body.tricks) {
    const trick = parseCarriedTrick(item);
    if (trick === null || tricks.some((t) => t.id === trick.id)) return null;
    tricks.push(trick);
  }
  return { seq, tricks };
}

/** The body of `POST /crew/v1/tricks-copy/code`, or null. Paths are checked against the list later. */
export function parseCodePart(value: JsonValue | undefined): CodePart | null {
  const body = asJsonObject(value);
  const id = asJsonString(body?.id);
  const hash = asJsonString(body?.hash);
  const part = asJsonNumber(body?.part);
  const parts = asJsonNumber(body?.parts);
  if (body === undefined || id === undefined || !isTrickId(id) || hash === undefined || !HASH_RE.test(hash)) return null;
  if (part === undefined || parts === undefined || !Number.isSafeInteger(part) || !Number.isSafeInteger(parts)) return null;
  if (parts < 1 || parts > CARRY_PARTS_MAX || part < 0 || part >= parts || !Array.isArray(body.chunks)) return null;
  const chunks: CodeChunk[] = [];
  let bytes = 0;
  for (const item of body.chunks) {
    const row = asJsonObject(item);
    const rel = asJsonString(row?.rel);
    const at = asJsonNumber(row?.at);
    const b64 = asJsonString(row?.b64);
    if (rel === undefined || at === undefined || b64 === undefined || !Number.isSafeInteger(at) || at < 0) return null;
    const decoded = strictBase64(b64);
    if (decoded === null) return null;
    bytes += decoded.length;
    if (bytes > CARRY_PART_BYTES) return null;
    chunks.push({ rel, at, bytes: decoded });
  }
  return { id, hash, part, parts, chunks };
}

/** Why a path cannot be a carried state file, or null: `<part>/<rel>`, the proposal reader's rules on `<rel>`. */
export function statePathProblem(rel: string): string | null {
  const slash = rel.indexOf("/");
  if (slash <= 0) return "names no part";
  const part = rel.slice(0, slash);
  if (!STATE_PARTS.some((p) => p === part)) return "is not under state/, media/ or captures/";
  const rest = rel.slice(slash + 1);
  // The proposal reader refuses a top-level media/ or captures/ step, which is what `rest` may not be either.
  const problem = proposedPathProblem(rest === "" ? "" : `x/${rest}`);
  if (problem !== null) return problem;
  if (part !== "state" && !isPictureName(rest)) return "is not a picture";
  return null;
}

/** The body of `POST /crew/v1/tricks-copy/state`, or null. */
export function parseStatePush(value: JsonValue | undefined): StatePush | null {
  const body = asJsonObject(value);
  const id = asJsonString(body?.id);
  const digest = asJsonString(body?.digest);
  if (body === undefined || id === undefined || !isTrickId(id) || digest === undefined || !HASH_RE.test(digest) || !Array.isArray(body.files)) return null;
  if (body.files.length > CARRY_STATE_FILES_MAX) return null;
  const files: StateFile[] = [];
  const folded = new Set<string>();
  let bytes = 0;
  for (const item of body.files) {
    const row = asJsonObject(item);
    const rel = asJsonString(row?.rel);
    const b64 = asJsonString(row?.b64);
    if (rel === undefined || b64 === undefined || statePathProblem(rel) !== null) return null;
    const key = foldKey(rel);
    if (folded.has(key)) return null;
    folded.add(key);
    const decoded = strictBase64(b64);
    if (decoded === null) return null;
    // A picture is a picture by its first bytes, as the approved copy and the Hill read one.
    if (!rel.startsWith("state/") && !isPictureBytes(decoded)) return null;
    bytes += decoded.length;
    if (bytes > CARRY_STATE_TRICK_MAX) return null;
    files.push({ rel, bytes: decoded });
  }
  // A file and a folder under one name cannot both be written.
  for (const key of folded) {
    if ([...folded].some((other) => other !== key && other.startsWith(`${key}/`))) return null;
  }
  return { id, digest, files };
}

// ── The index ─────────────────────────────────────────────────────────────────────────────────────

/** What is held of one trick's code: whole and checked, refused (and why), or still owed. */
export type CodeHeld = { hash: string; state: "held" | "need" } | { hash: string; state: "refused"; reason: string };

/** What is held of one trick's state. */
export interface StateHeld {
  digest: string;
  bytes: number;
  at: number;
}

/** The whole index. It records whose tricks these are, so a deputy of another lead never offers them. */
export interface TricksIndex {
  version: number;
  crewId: string;
  /** The lead that sent the list. */
  from: string;
  seq: number;
  /** Epoch ms of the last list, on this machine's clock. */
  at: number;
  tricks: CarriedTrick[];
  code: Map<string, CodeHeld>;
  state: Map<string, StateHeld>;
}

function serializeIndex(index: TricksIndex): string {
  const code: JsonObject = {};
  for (const [id, held] of index.code) code[id] = held.state === "refused" ? { hash: held.hash, state: held.state, reason: held.reason } : { hash: held.hash, state: held.state };
  const state: JsonObject = {};
  for (const [id, held] of index.state) state[id] = { digest: held.digest, bytes: held.bytes, at: held.at };
  const doc: JsonObject = { version: index.version, crewId: index.crewId, from: index.from, seq: index.seq, at: index.at, tricks: index.tricks.map(canonicalTrick), code, state };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Parse the index. `null` for anything this reader does not understand, which reads as no copy. */
export function parseTricksIndex(raw: string | null): TricksIndex | null {
  if (raw === null) return null;
  const doc = parseJsonObject(raw);
  const crewId = asJsonString(doc?.crewId);
  const from = asJsonString(doc?.from);
  const seq = asJsonNumber(doc?.seq);
  if (doc === undefined || asJsonNumber(doc.version) !== STANDBY_TRICKS_VERSION || crewId === undefined || crewId === "" || from === undefined || from === "") return null;
  if (seq === undefined || !Number.isSafeInteger(seq) || !Array.isArray(doc.tricks)) return null;
  const tricks: CarriedTrick[] = [];
  for (const item of doc.tricks) {
    const trick = parseCarriedTrick(item);
    if (trick === null) return null;
    tricks.push(trick);
  }
  const code = new Map<string, CodeHeld>();
  for (const [id, value] of Object.entries(asJsonObject(doc.code) ?? {})) {
    const row = asJsonObject(value);
    const hash = asJsonString(row?.hash);
    const state = asJsonString(row?.state);
    if (!isTrickId(id) || hash === undefined || !HASH_RE.test(hash)) continue;
    if (state === "held" || state === "need") code.set(id, { hash, state });
    if (state === "refused") code.set(id, { hash, state, reason: asJsonString(row?.reason) ?? "refused" });
  }
  const state = new Map<string, StateHeld>();
  for (const [id, value] of Object.entries(asJsonObject(doc.state) ?? {})) {
    const row = asJsonObject(value);
    const digest = asJsonString(row?.digest);
    const bytes = asJsonNumber(row?.bytes);
    const at = asJsonNumber(row?.at);
    if (!isTrickId(id) || digest === undefined || !HASH_RE.test(digest) || bytes === undefined || at === undefined) continue;
    state.set(id, { digest, bytes, at });
  }
  return { version: STANDBY_TRICKS_VERSION, crewId, from, seq, at: asJsonNumber(doc.at) ?? 0, tricks, code, state };
}

/** How many parts the deputy still lacks: code owed, and state the list names that it does not hold. */
export function needOf(index: TricksIndex | null): number {
  if (index === null) return 0;
  let need = 0;
  for (const trick of index.tricks) {
    if (index.code.get(trick.id)?.state === "need") need += 1;
    if (trick.state !== null && index.state.get(trick.id)?.digest !== trick.state) need += 1;
  }
  return need;
}

/** The deputy's report of what it holds, or `null` when it holds nothing. */
export function reportOf(index: TricksIndex | null): TricksReport | null {
  if (index === null) return null;
  return { digest: tricksDigest(index.tricks), seq: index.seq, need: needOf(index) };
}

/** The ids of the tricks whose code, and whose state, the deputy still lacks. */
export interface CarryNeed {
  readonly code: string[];
  readonly state: string[];
}

/** What the deputy owes the lead next: the tricks whose code it lacks, and those whose state it lacks. */
export function needLists(index: TricksIndex): CarryNeed {
  const code = index.tricks.filter((t) => index.code.get(t.id)?.state === "need").map((t) => t.id);
  const state = index.tricks.filter((t) => t.state !== null && index.state.get(t.id)?.digest !== t.state).map((t) => t.id);
  return { code, state };
}

/**
 * Whether the copy may stay. It stays only while this machine is the named deputy of the lead that sent
 * it, in that crew. A demotion, another lead, another crew, or this machine leading clears it: a lead
 * adopts its copy at the person's takeover tap, and a copy that was not adopted then is never run later.
 */
export function tricksCopyKept(index: Pick<TricksIndex, "crewId" | "from"> | null, role: CopyRole): boolean {
  if (index === null) return true;
  if (role.crewId === null || index.crewId !== role.crewId || role.leads) return false;
  return role.deputy && role.leadMemberId === index.from;
}

// ── The store ─────────────────────────────────────────────────────────────────────────────────────

/** What a list did: applied with what is owed now, or refused as older than the one held. */
export type ListAnswer = { ok: true; need: { code: string[]; state: string[] } } | { ok: false; code: "stale" };

/** What a code part did. `held` is true once the last part checked out. */
export type PartAnswer = { ok: true; held: boolean } | { ok: false; code: "unknown" | "order" | "bad_part" | "mismatch"; reason: string };

/** What a state push did. */
export type StateAnswer = { ok: true } | { ok: false; code: "unknown" | "rate" | "too_large"; reason: string };

/** One carried trick that could start: its code is held, whole and checked. Read off this machine's disk. */
export interface CarriedReady {
  readonly trick: CarriedTrick;
  /** The held code folder. */
  readonly codeDir: string;
  /** The trick's name from the held code's own trick.toml, or its id when that does not read. */
  readonly name: string;
  /** The held state folder of this trick (`state/`, `media/`, `captures/`), or null with none. */
  readonly heldState: string | null;
}

/**
 * The copy on the deputy's disk: one index, the code parts, the state. 0700 folders, 0600 files, every
 * write staged and renamed. Only a crew route from this machine's own lead, while a warrant names this
 * machine, ever writes it; nothing here is read by the tricks loader, and nothing here runs.
 */
export class StandbyTricksStore {
  readonly dir: string;
  private cached: TricksIndex | null = null;
  private loaded = false;
  /** The next part each incoming code expects, by `<id>:<hash>`. In memory: a restart starts again at 0. */
  private readonly incoming = new Map<string, { next: number; stage: string }>();
  /** When each trick's state last landed, for the once-a-minute rule. */
  private readonly stateAt = new Map<string, number>();
  /** Set while the person's tap adopts the copy, so a role change on the way does not remove it. */
  private holdDepth = 0;

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(stateDir, STANDBY_TRICKS_DIRNAME);
  }

  private get indexPath(): string {
    return join(this.dir, "index.json");
  }

  /** The held code folder of one version. */
  codeDir(id: string, hash: string): string {
    return join(this.dir, "code", id, hash16(hash));
  }

  /** The held state folder of one trick. */
  stateDirOf(id: string): string {
    return join(this.dir, "state", id);
  }

  async load(): Promise<TricksIndex | null> {
    if (this.loaded) return this.cached;
    let raw: string | null = null;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch {
      raw = null;
    }
    this.cached = parseTricksIndex(raw);
    this.loaded = true;
    return this.cached;
  }

  /** The last loaded index, without touching the disk. */
  current(): TricksIndex | null {
    return this.cached;
  }

  /** The report this deputy makes on `hello` and `snapshot`. */
  report(): TricksReport | null {
    return reportOf(this.cached);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
  }

  private async saveIndex(next: TricksIndex): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.indexPath}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, serializeIndex(next), { mode: 0o600 });
    await rename(tmp, this.indexPath);
    this.cached = next;
    this.loaded = true;
  }

  /**
   * Take a list from `from`, this machine's lead. A list whose `seq` is not above the one held from the
   * same lead is refused (`stale`): pushes land in order, and an older one never rolls a trick back.
   * Code the list no longer names is removed; code it names that is held stays. A trick whose code does
   * not fit {@link CARRY_CODE_TOTAL_MAX} is refused here, so it is never owed and never asked for again.
   */
  async applyList(input: { from: string; crewId: string; seq: number; tricks: readonly CarriedTrick[] }): Promise<ListAnswer> {
    const held = await this.load();
    const same = held !== null && held.from === input.from && held.crewId === input.crewId;
    if (same && input.seq <= held.seq) return { ok: false, code: "stale" };
    const code = new Map<string, CodeHeld>();
    let budget = CARRY_CODE_TOTAL_MAX;
    for (const trick of input.tricks.toSorted((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))) {
      const size = trick.files.reduce((sum, f) => sum + f.size, 0);
      const before = same ? held.code.get(trick.id) : undefined;
      if (size > budget) {
        code.set(trick.id, { hash: trick.hash, state: "refused", reason: "too large to carry" });
        continue;
      }
      budget -= size;
      if (before !== undefined && before.hash === trick.hash && before.state !== "need") code.set(trick.id, before);
      else code.set(trick.id, { hash: trick.hash, state: "need" });
    }
    const state = new Map<string, StateHeld>();
    if (same) for (const [id, kept] of held.state) if (input.tricks.some((t) => t.id === id && t.state !== null)) state.set(id, kept);
    const next: TricksIndex = { version: STANDBY_TRICKS_VERSION, crewId: input.crewId, from: input.from, seq: input.seq, at: this.now(), tricks: [...input.tricks], code, state };
    await this.saveIndex(next);
    await this.pruneFolders(next);
    return { ok: true, need: needLists(next) };
  }

  /** Remove every code and state folder the index does not name. */
  private async pruneFolders(index: TricksIndex): Promise<void> {
    const keepCode = new Set([...index.code].filter(([, held]) => held.state === "held").map(([id, held]) => `${id}/${hash16(held.hash)}`));
    for (const id of await names(join(this.dir, "code"))) {
      for (const version of await names(join(this.dir, "code", id))) {
        if (!keepCode.has(`${id}/${version}`)) await removeTree(join(this.dir, "code", id, version));
      }
      if ((await names(join(this.dir, "code", id))).length === 0) await removeTree(join(this.dir, "code", id));
    }
    for (const id of await names(join(this.dir, "state"))) if (!index.state.has(id)) await removeTree(join(this.dir, "state", id));
    for (const name of await names(this.dir)) {
      if (name.startsWith(".stage-") && ![...this.incoming.values()].some((i) => i.stage === join(this.dir, name))) await removeTree(join(this.dir, name));
    }
  }

  /**
   * Take one part of a trick's code. Parts come in order from 0; part 0 starts the stage again. Each
   * chunk appends to a file the list names, at exactly the bytes held so far and never past its size.
   * The last part checks every file's size, hashes them with the real code hash and refuses a mismatch.
   */
  async applyCodePart(part: CodePart): Promise<PartAnswer> {
    const index = await this.load();
    const trick = index?.tricks.find((t) => t.id === part.id);
    const held = index?.code.get(part.id);
    if (index === null || trick === undefined || held === undefined || trick.hash !== part.hash || held.hash !== part.hash) {
      return { ok: false, code: "unknown", reason: "this list names no such trick at this hash" };
    }
    if (held.state === "held") return { ok: true, held: true };
    if (held.state === "refused") return { ok: false, code: "unknown", reason: held.reason };
    const key = `${part.id}:${part.hash}`;
    let progress = this.incoming.get(key);
    if (part.part === 0) {
      if (progress !== undefined) await removeTree(progress.stage);
      await this.ensureDir();
      const stage = join(this.dir, `.stage-${randomBytes(6).toString("hex")}`);
      await mkdir(stage, { mode: 0o700 });
      progress = { next: 0, stage };
      this.incoming.set(key, progress);
    }
    if (progress === undefined || progress.next !== part.part) return { ok: false, code: "order", reason: "parts come in order from 0; start again" };
    for (const chunk of part.chunks) {
      const file = trick.files.find((f) => f.rel === chunk.rel);
      if (file === undefined) return await this.dropIncoming(key, "bad_part", "a part names a file the list does not");
      const path = join(progress.stage, chunk.rel);
      const have = (await lstat(path).catch(() => null))?.size ?? 0;
      if (chunk.at !== have || have + chunk.bytes.length > file.size) return await this.dropIncoming(key, "bad_part", "a part does not continue its file");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, chunk.bytes, { mode: 0o600 });
    }
    progress.next += 1;
    if (progress.next < part.parts) return { ok: true, held: false };
    return await this.finishCode(key, trick, progress.stage);
  }

  private async dropIncoming(key: string, code: "bad_part", reason: string): Promise<PartAnswer> {
    const progress = this.incoming.get(key);
    if (progress !== undefined) await removeTree(progress.stage);
    this.incoming.delete(key);
    return { ok: false, code, reason };
  }

  /** The last part landed: check sizes and the hash, then rename the stage into place, or refuse it for good. */
  private async finishCode(key: string, trick: CarriedTrick, stage: string): Promise<PartAnswer> {
    this.incoming.delete(key);
    const files: { rel: string; bytes: Uint8Array }[] = [];
    for (const file of trick.files) {
      const bytes = await diskTrickFs.read(join(stage, file.rel), file.size + 1);
      if (bytes === null || bytes.length !== file.size) {
        await removeTree(stage);
        return { ok: false, code: "bad_part", reason: "a file did not arrive whole; start again" };
      }
      files.push({ rel: file.rel, bytes });
    }
    if (codeHashOfFiles(files) !== trick.hash) {
      await removeTree(stage);
      await this.markCode(trick, { hash: trick.hash, state: "refused", reason: "the code does not hash to its approved hash" });
      return { ok: false, code: "mismatch", reason: "the code does not hash to its approved hash" };
    }
    const final = this.codeDir(trick.id, trick.hash);
    await removeTree(final);
    await mkdir(dirname(final), { recursive: true, mode: 0o700 });
    await rename(stage, final);
    await this.markCode(trick, { hash: trick.hash, state: "held" });
    return { ok: true, held: true };
  }

  private async markCode(trick: CarriedTrick, held: CodeHeld): Promise<void> {
    const index = this.cached;
    if (index === null || index.tricks.find((t) => t.id === trick.id)?.hash !== trick.hash) return;
    const code = new Map(index.code);
    code.set(trick.id, held);
    await this.saveIndex({ ...index, code });
  }

  /**
   * Take one trick's state: written to a stage and renamed over the old one. At most once a minute per
   * trick, at most {@link CARRY_STATE_TRICK_MAX} for one and {@link CARRY_STATE_TOTAL_MAX} for all.
   */
  async applyState(push: StatePush): Promise<StateAnswer> {
    const index = await this.load();
    const trick = index?.tricks.find((t) => t.id === push.id);
    if (index === null || trick === undefined) return { ok: false, code: "unknown", reason: "this list names no such trick" };
    const last = this.stateAt.get(push.id);
    if (last !== undefined && this.now() - last < CARRY_STATE_EVERY_MS) return { ok: false, code: "rate", reason: "a trick's state is taken at most once a minute" };
    const bytes = push.files.reduce((sum, f) => sum + f.bytes.length, 0);
    const others = [...index.state].filter(([id]) => id !== push.id).reduce((sum, [, held]) => sum + held.bytes, 0);
    this.stateAt.set(push.id, this.now());
    if (bytes > CARRY_STATE_TRICK_MAX || others + bytes > CARRY_STATE_TOTAL_MAX) {
      // Settled as "not kept", so it is not owed and not asked for again until the state changes.
      await removeTree(this.stateDirOf(push.id));
      const state = new Map(index.state);
      state.set(push.id, { digest: push.digest, bytes: 0, at: this.now() });
      await this.saveIndex({ ...index, state });
      return { ok: false, code: "too_large", reason: "the state is larger than the deputy keeps" };
    }
    await this.ensureDir();
    const stage = join(this.dir, `.stage-${randomBytes(6).toString("hex")}`);
    await mkdir(stage, { mode: 0o700 });
    for (const file of push.files) {
      const path = join(stage, file.rel);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
    }
    const final = this.stateDirOf(push.id);
    await removeTree(final);
    await mkdir(dirname(final), { recursive: true, mode: 0o700 });
    await rename(stage, final);
    const state = new Map(index.state);
    state.set(push.id, { digest: push.digest, bytes, at: this.now() });
    await this.saveIndex({ ...index, state });
    return { ok: true };
  }

  /** The carried tricks whose code is held, whole and checked, with their names off this machine's disk. */
  async ready(): Promise<CarriedReady[]> {
    const index = await this.load();
    if (index === null) return [];
    const out: CarriedReady[] = [];
    for (const trick of index.tricks) {
      if (index.code.get(trick.id)?.state !== "held") continue;
      const codeDir = this.codeDir(trick.id, trick.hash);
      const read = await readManifestFile(diskTrickFs, codeDir, trick.id);
      const kept = (index.state.get(trick.id)?.bytes ?? 0) > 0 && (await lstat(this.stateDirOf(trick.id)).catch(() => null))?.isDirectory() === true;
      out.push({ trick, codeDir, name: read.manifest?.name ?? trick.id, heldState: kept ? this.stateDirOf(trick.id) : null });
    }
    return out;
  }

  /** Whether a takeover holds the copy now: then it takes nothing from the lead (§25). */
  held(): boolean {
    return this.holdDepth > 0;
  }

  /** Hold the copy against a role change while the person's tap adopts it. Answers the release. */
  hold(): () => void {
    this.holdDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holdDepth -= 1;
    };
  }

  /** Remove the whole copy. A copy that is not there is fine. */
  async clear(): Promise<void> {
    for (const progress of this.incoming.values()) await removeTree(progress.stage);
    this.incoming.clear();
    this.stateAt.clear();
    await removeTree(this.dir);
    this.cached = null;
    this.loaded = true;
  }

  /** Clear the copy when {@link tricksCopyKept} says it is not this machine's any more. Answers whether it did. */
  async reconcile(role: CopyRole): Promise<boolean> {
    if (this.holdDepth > 0) return false;
    const index = await this.load();
    const present = index !== null || (await lstat(this.dir).catch(() => null)) !== null;
    if (!present) return false;
    if (index !== null && tricksCopyKept(index, role)) return false;
    // A folder with no index it can read is a copy nobody can account for: it goes too, unless this
    // machine is a deputy that may be about to receive one.
    if (index === null && role.deputy && !role.leads) return false;
    await this.clear();
    return true;
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Which of the three parts a state path is under. */
export function statePartOf(rel: string): StatePart | null {
  const top = rel.split("/")[0];
  return STATE_PARTS.find((p) => p === top) ?? null;
}
