import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { looksBinary } from "../changes.ts";
import { listFolder, parseRelPath, readFileBytes, sniffImageType, UNKNOWN_PATH, type FilesContext } from "../files-view.ts";
import { HOST, isBelow, type Host } from "../host.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { redactText } from "../redact.ts";
import type { FileEntry } from "../types.ts";
import { unsafeText } from "./code-hash.ts";
import { asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { INPUT_ANSWER_MAX_BYTES, INPUT_IMAGE_MAX_BYTES, INPUT_RUN_MAX_BYTES, INPUT_TEXT_MAX_BYTES } from "../../web/src/lib/tricks/limits.ts";
import {
  FACT_SESSIONS_MAX,
  INPUT_FILES_MAX,
  inputGlobMatches,
  inputGlobProblem,
  inputGlobStepMatches,
  INPUTS_MAX,
  isScopeKey,
  isTrickId,
  type FactsInputFile,
  type FactsInputs,
  type FactsSession,
  type InputKind,
  type InputState,
} from "../../web/src/lib/tricks/schema.ts";

// A TRICK READS FILES FROM ITS AGENT SESSIONS' FOLDERS (M99 slice 6, contract 2).
//
// A trick lists globs in `trick.toml` (`inputs = ["TODO.md", "notes/*.md"]`), and the operator approves
// them with the rest of its powers (approved.ts `powersOf`). Before each run the bridge that runs the
// trick (a solo bridge or a crew's lead) fetches the files those globs match in each agent session's
// folder, on every machine of the crew, into `inputs/<member>/<pane>/<rel>` of the approved copy, and the
// facts list them per session. The program reads plain files. It never reaches another machine itself.
//
// WHO NAMES WHAT, AND WHERE IT IS CHECKED.
//   - The globs: the trick's author, approved by the operator. Checked on the lead (the manifest parse),
//     again on the member before any read ({@link parseInputsRequest}), and again on the lead against every
//     file name a member answers with ({@link inputGlobMatches}).
//   - The panes: the lead, from the facts. The member reads only a pane that is ITS OWN AGENT pane (the
//     `rootOf` dep answers null for a shell pane, a pane of another machine and an unknown id), so a
//     lead cannot point it at anything else: those answer `no-pane`.
//   - The folder: never the lead's. The member reads its own snapshot's Files root for the pane, the one
//     the Files view reads (bridge/server.ts `agentPaneFilesRoot`), through the Files view's own checks
//     (`listFolder`, `readFileBytes`): real-path containment, no symlink, no `.git`, no state secret, no
//     private folder.
//   - The file names (`rel`): the member. The lead trusts none of them: each must parse as a relative
//     path (files-view `parseRelPath`), hold no character a Decision's view refuses (code-hash.ts
//     `unsafeText`: a control, a bidi mark, a zero-width character), match one of the trick's globs, and
//     land below the staging folder after the join. The member's walk refuses such a name too: it is
//     never served, only counted as `skipped: "name"`. The member folder is the lead's trust-store member id and the pane folder the pane
//     the lead asked about, each encoded to one safe step ({@link inputsDirName}).
//   - The bytes: the member. The lead checks the size against the kind's cap, the SHA-256, the picture
//     type off the bytes, and that a text file is UTF-8 with no NUL. Nothing is ever executed: the
//     program reads them as data (the tricks README says so).

// The four byte caps live in web/src/lib/tricks/limits.ts, which the tricks catalogue reads too.
export { INPUT_ANSWER_MAX_BYTES, INPUT_IMAGE_MAX_BYTES, INPUT_RUN_MAX_BYTES, INPUT_TEXT_MAX_BYTES };
/** One call to a member: 8 s, no retry. And at most one call per trick per member per 5 s. */
export const INPUT_CALL_MS = 8000;
export const INPUT_RATE_MS = 5000;
/** The most folders one pane's walk lists. */
export const INPUT_LISTINGS_MAX = 64;
/** The longest `rel` either side takes, in UTF-8 bytes. */
export const INPUT_REL_MAX_BYTES = 1024;
/** The request body a member reads at most. */
export const INPUT_REQUEST_MAX_BYTES = 256 * 1024;
/** The answer body the lead reads at most: {@link INPUT_ANSWER_MAX_BYTES} as base64, and room for the JSON around it. */
export const INPUT_ANSWER_BODY_MAX_BYTES = Math.ceil((INPUT_ANSWER_MAX_BYTES * 4) / 3) + 1024 * 1024;
/** The crew route, lead → member: `POST /crew/v1/tricks/inputs`. */
export const TRICKS_INPUTS_ROUTE = "tricks/inputs";
/** The machine-readable `code` of a member that switched trick reads off (`COLLIE_CREW_TRICK_READS`). */
export const TRICK_READS_OFF = "trick_reads_off";
/** The folder of the approved copy the files go to. */
export const INPUTS_DIR = "inputs";

/** Why a matched file was left out. `name`: its path holds a character {@link unsafeText} refuses. */
export type InputSkip = "too-large" | "cap" | "type" | "name";
/** One file in a member's answer. `b64` is absent when the lead already holds these bytes (`have`), and on a skipped one. */
export interface WireInputFile {
  rel: string;
  bytes: number;
  mtime: string;
  sha256?: string;
  kind?: InputKind;
  b64?: string;
  skipped?: InputSkip;
}
/** One pane in a member's answer: `ok`, or `no-pane` (not an agent pane of this machine), or `no-folder`. */
export type WirePaneState = "ok" | "no-pane" | "no-folder";
export interface WirePaneInputs {
  state: WirePaneState;
  files: WireInputFile[];
}

const encoder = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isoOf(ms: number | undefined): string {
  return new Date(ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
}

// ── The member's read ───────────────────────────────────────────────────────────────────────────

/** The answer bytes left for one call, shared by its panes. */
export interface InputsBudget {
  left: number;
}

/** A refused name as the answer counts it: each character {@link unsafeText} refuses as `?`, so the name itself never travels. */
function maskedRel(rel: string): string {
  return [...rel].map((ch) => (unsafeText(ch) ? "?" : ch)).join("");
}

/**
 * The relative paths the globs match under the root, in glob order then listing order, at most
 * {@link INPUT_FILES_MAX} together with `refused`: the matched files whose name holds a character
 * {@link unsafeText} refuses. A folder with such a name is never entered.
 */
async function walkGlobs(ctx: FilesContext, globs: readonly string[], top: FileEntry[]): Promise<{ found: Map<string, number>; refused: Map<string, number>; more: boolean }> {
  const found = new Map<string, number>();
  const refused = new Map<string, number>();
  let listings = 1;
  for (const glob of globs) {
    if (inputGlobProblem(glob) !== undefined) continue;
    const depthOf = glob.split("/").length;
    let level: string[] = [""];
    for (let depth = 0; depth < depthOf; depth += 1) {
      const last = depth === depthOf - 1;
      const next: string[] = [];
      for (const dir of level) {
        let entries: readonly FileEntry[];
        if (dir === "") entries = top;
        else {
          if (listings >= INPUT_LISTINGS_MAX) return { found, refused, more: true };
          listings += 1;
          const listing = await listFolder(ctx, dir);
          if (listing === UNKNOWN_PATH || !listing.available) continue;
          entries = listing.entries;
        }
        for (const entry of entries) {
          if (!inputGlobStepMatches(glob, depth, entry.name)) continue;
          const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
          // A link is never followed, at any level: only a real folder and a regular file count.
          if (!last) {
            if (entry.kind === "dir" && !unsafeText(entry.name)) next.push(rel);
            continue;
          }
          if (entry.kind !== "file" || found.has(rel) || refused.has(rel)) continue;
          if (found.size + refused.size >= INPUT_FILES_MAX) return { found, refused, more: true };
          if (unsafeText(entry.name)) refused.set(rel, entry.size ?? 0);
          else found.set(rel, entry.size ?? 0);
        }
      }
      level = next;
    }
  }
  return { found, refused, more: false };
}

/** A matched file as the answer carries it: its kind and bytes, or why it is left out. */
async function readOne(ctx: FilesContext, rel: string, size: number, redact: boolean): Promise<{ file: WireInputFile; data?: Uint8Array } | null> {
  if (size > INPUT_IMAGE_MAX_BYTES) return { file: { rel, bytes: size, mtime: isoOf(undefined), skipped: "too-large" } };
  const read = await readFileBytes(ctx, rel, INPUT_IMAGE_MAX_BYTES);
  // Gone since the listing, or refused by the Files view's checks: not in the answer at all.
  if (read === UNKNOWN_PATH || !read.available) return null;
  if (read.kind === "too-large") return { file: { rel, bytes: read.size, mtime: isoOf(undefined), skipped: "too-large" } };
  const mtime = isoOf(read.mtimeMs);
  const type = sniffImageType(read.bytes.subarray(0, 64));
  if (type === "image/png" || type === "image/jpeg" || type === "image/webp") {
    return { file: { rel, bytes: read.bytes.length, mtime, sha256: sha256(read.bytes), kind: "image" }, data: read.bytes };
  }
  if (type !== null || looksBinary(read.bytes)) return { file: { rel, bytes: read.bytes.length, mtime, skipped: "type" } };
  if (read.bytes.length > INPUT_TEXT_MAX_BYTES) return { file: { rel, bytes: read.bytes.length, mtime, skipped: "too-large" } };
  let text: string;
  try {
    text = utf8Strict.decode(read.bytes);
  } catch {
    return { file: { rel, bytes: read.bytes.length, mtime, skipped: "type" } };
  }
  // With COLLIE_REDACT on, a text file leaves masked, as the Files view shows it (answer-mask.ts).
  const data = redact ? encoder.encode(redactText(text)) : read.bytes;
  if (data.length > INPUT_TEXT_MAX_BYTES) return { file: { rel, bytes: data.length, mtime, skipped: "too-large" } };
  return { file: { rel, bytes: data.length, mtime, sha256: sha256(data), kind: "text" }, data };
}

/**
 * One pane's inputs on the machine that holds it: the files the globs match under its Files root, read
 * through the Files view. `have` is what the reader already holds, by `rel`: a file whose SHA-256 it
 * names travels without its bytes. The bytes sent count against `budget`; a file past it is `cap`.
 */
export async function readPaneInputs(ctx: FilesContext, globs: readonly string[], have: ReadonlyMap<string, string>, budget: InputsBudget, redact: boolean): Promise<WirePaneInputs> {
  // No `git check-ignore` per listing: an ignored file is read like any other, so the probe would only cost.
  const quiet: FilesContext = { ...ctx, ignoreProbe: () => Promise.resolve(null) };
  const top = await listFolder(quiet, "");
  if (top === UNKNOWN_PATH || !top.available) return { state: "no-folder", files: [] };
  const { found, refused } = await walkGlobs(quiet, globs, top.entries);
  const files: WireInputFile[] = [];
  for (const [rel, size] of found) {
    const one = await readOne(quiet, rel, size, redact);
    if (one === null) continue;
    const { file, data } = one;
    if (data !== undefined && file.sha256 !== undefined && have.get(rel) !== file.sha256) {
      if (data.length > budget.left) file.skipped = "cap";
      else {
        file.b64 = Buffer.from(data).toString("base64");
        budget.left -= data.length;
      }
    }
    if (file.skipped !== undefined) {
      delete file.sha256;
      delete file.kind;
    }
    files.push(file);
  }
  // A refused name is counted, never read: its masked path, its listed size, and `skipped: "name"`.
  for (const [rel, size] of refused) files.push({ rel: maskedRel(rel), bytes: size, mtime: isoOf(undefined), skipped: "name" });
  return { state: "ok", files };
}

// ── The request, on the member ──────────────────────────────────────────────────────────────────

/** `POST /crew/v1/tricks/inputs`'s body, parsed. */
export interface InputsRequest {
  trick: string;
  run: string;
  globs: string[];
  panes: string[];
  /** What the lead holds, per pane and rel: the SHA-256 of its copy. */
  have: Map<string, Map<string, string>>;
}

const REQUEST_KEYS = new Set(["trick", "run", "globs", "panes", "have"]);
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A pane id as a crew names one: the mux id rule of a scope key, and never a trick session's id. */
function isPaneId(paneId: string): boolean {
  return isScopeKey(`p:${paneId}`);
}

function strings(value: JsonValue | undefined, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = asJsonString(item);
    if (text === undefined) return null;
    out.push(text);
  }
  return out;
}

/** A `rel` either side takes: within {@link INPUT_REL_MAX_BYTES}, a Files path, and no character {@link unsafeText} refuses. */
function relOk(rel: string): boolean {
  return encoder.encode(rel).length <= INPUT_REL_MAX_BYTES && !unsafeText(rel) && parseRelPath(rel) !== null;
}

/**
 * The request a member takes, or the reason it refuses it with a 400. Strict: every key known, the trick
 * id a trick id, each glob passing {@link inputGlobProblem} again (the member never trusts the lead's
 * parse), each pane id a mux id, and `have` naming only asked panes and well-formed paths.
 */
export function parseInputsRequest(raw: JsonValue | undefined): InputsRequest | { error: string } {
  const obj = asJsonObject(raw);
  if (obj === undefined) return { error: "the body must be a JSON object" };
  for (const key of Object.keys(obj)) if (!REQUEST_KEYS.has(key)) return { error: `unknown key "${key}"` };
  const trick = asJsonString(obj.trick);
  if (trick === undefined || !isTrickId(trick)) return { error: '"trick" must be a trick id' };
  const run = asJsonString(obj.run);
  if (run === undefined || !RUN_ID.test(run)) return { error: '"run" must be 1 to 64 letters, digits and hyphens' };
  const globs = strings(obj.globs, INPUTS_MAX);
  if (globs === null) return { error: `"globs" must list 1 to ${String(INPUTS_MAX)} globs` };
  for (const glob of globs) {
    const problem = inputGlobProblem(glob);
    if (problem !== undefined) return { error: `a glob ${problem}` };
  }
  const panes = strings(obj.panes, FACT_SESSIONS_MAX);
  if (panes === null || !panes.every(isPaneId)) return { error: `"panes" must list 1 to ${String(FACT_SESSIONS_MAX)} pane ids` };
  const asked = new Set(panes);
  const have = new Map<string, Map<string, string>>();
  const haveList = obj.have;
  if (haveList !== undefined) {
    if (!Array.isArray(haveList) || haveList.length > panes.length) return { error: '"have" must list at most one entry per pane' };
    for (const item of haveList) {
      const row = asJsonObject(item);
      const pane = asJsonString(row?.pane);
      const files = row?.files;
      if (row === undefined || pane === undefined || !asked.has(pane) || have.has(pane) || !Array.isArray(files) || files.length > INPUT_FILES_MAX) {
        return { error: '"have" names a pane that was not asked, twice, or with more than 32 files' };
      }
      const byRel = new Map<string, string>();
      for (const f of files) {
        const file = asJsonObject(f);
        const rel = asJsonString(file?.rel);
        const sum = asJsonString(file?.sha256);
        if (rel === undefined || sum === undefined || !relOk(rel) || !SHA256_HEX.test(sum)) return { error: '"have" holds a file that is not { rel, sha256 }' };
        byRel.set(rel, sum);
      }
      have.set(pane, byRel);
    }
  }
  return { trick, run, globs: [...new Set(globs)], panes: [...asked], have };
}

/** What the member's handler needs from its bridge. */
export interface InputsMemberDeps {
  /**
   * The Files root of THIS machine's agent pane, `{ root: null }` when it has no folder, or null when the
   * id names no agent pane here: a shell pane, another machine's pane, or none (bridge/server.ts
   * `agentPaneFilesRoot`). Read off the live snapshot; never a word of the request.
   */
  rootOf(paneId: string): Promise<{ root: string | null } | null>;
  home: string;
  /** The bridge's state and config folders (bridge/server.ts `filesPrivateFolders`). */
  privateFolders: readonly string[];
  /** COLLIE_REDACT: a text file leaves masked. */
  redact: boolean;
  /** The member's gate (crew config `trickReads`): false answers 403 `trick_reads_off`. */
  allowed(): boolean;
  /** One audit line per answered call: the trick id, the count of files sent and their bytes, never a name. */
  audit?(detail: { trick: string; files: number; bytes: number }): void;
  host?: Host;
}

/** A crew route's answer: a status and a JSON body. */
export interface InputsAnswer {
  status: number;
  body: JsonValue;
}

/**
 * `POST /crew/v1/tricks/inputs` on a MEMBER, for its lead only (the router checks the caller). The gate
 * first, then the body, then one read per asked pane, in order, inside one answer budget.
 */
export async function answerInputsRequest(raw: JsonValue | undefined, deps: InputsMemberDeps): Promise<InputsAnswer> {
  if (!deps.allowed()) return { status: 403, body: { error: "trick reads are off on this machine", code: TRICK_READS_OFF } };
  const req = parseInputsRequest(raw);
  if ("error" in req) return { status: 400, body: { error: req.error } };
  const budget: InputsBudget = { left: INPUT_ANSWER_MAX_BYTES };
  const panes: JsonObject[] = [];
  let files = 0;
  for (const pane of req.panes) {
    const found = await deps.rootOf(pane);
    if (found === null) {
      panes.push({ pane, state: "no-pane", files: [] });
      continue;
    }
    if (found.root === null) {
      panes.push({ pane, state: "no-folder", files: [] });
      continue;
    }
    const ctx: FilesContext = { root: found.root, home: deps.home, privateFolders: deps.privateFolders };
    if (deps.host !== undefined) ctx.host = deps.host;
    const read = await readPaneInputs(ctx, req.globs, req.have.get(pane) ?? new Map(), budget, deps.redact);
    files += read.files.filter((f) => f.b64 !== undefined).length;
    panes.push({ pane, state: read.state, files: read.files.map(wireFileJson) });
  }
  deps.audit?.({ trick: req.trick, files, bytes: INPUT_ANSWER_MAX_BYTES - budget.left });
  return { status: 200, body: { panes } };
}

// ── The lead's fetch ────────────────────────────────────────────────────────────────────────────

/** One step of the copy's `inputs/` folder for a member id or a pane id: `[A-Za-z0-9.-]` as they are, `_` doubled, every other byte `_xx`, a leading dot `_2e`. Injective. A long one is a hash. */
export function inputsDirName(id: string): string {
  let out = "";
  for (const byte of encoder.encode(id)) {
    const ch = String.fromCharCode(byte);
    if (ch === "_") out += "__";
    else if (/[A-Za-z0-9-]/.test(ch) || (ch === "." && out !== "")) out += ch;
    else out += `_${byte.toString(16).padStart(2, "0")}`;
  }
  if (out === "") return "_";
  return out.length > 128 ? `h_${sha256(encoder.encode(id)).slice(0, 32)}` : out;
}

/** The result of one call to a member: its status and body text (null past the read cap), or nothing. */
export type InputsCallResult = { kind: "answer"; status: number; text: string | null } | { kind: "failed" };

/** What the lead's fetch needs from its bridge. */
export interface InputsFetchDeps {
  /** Whether a member id is this bridge's own (bridge-id.ts `isOwnId`). */
  isOwn(memberId: string): boolean;
  /** One of this machine's own panes, read locally ({@link readPaneInputs} through `agentPaneFilesRoot`). */
  readLocal(paneId: string, globs: readonly string[], have: ReadonlyMap<string, string>, budget: InputsBudget): Promise<WirePaneInputs>;
  /** A member as the lead's sweep sees it: whether it answers, and whether it runs a Collie below the floor. Null when it is no member. */
  member(memberId: string): { reachable: boolean; older: boolean } | null;
  /** One call to a member, at most {@link INPUT_CALL_MS}, never retried. Absent on a solo bridge and a member. */
  call?(memberId: string, body: string): Promise<InputsCallResult>;
  /** One audit line per run: the trick id, the count of files the run got and their bytes, never a name. */
  audit?(detail: { trick: string; files: number; bytes: number }): void;
  now?(): number;
  /** A fresh run id for the request; a test fixes it. */
  runId?(): string;
}

/** The trick a fetch is for: its id, its approved copy and its globs. */
export interface InputsTrick {
  id: string;
  dir: string;
  globs: readonly string[];
}

/** One file the lead holds or will hold. `data` is set for new bytes; absent, the copy in the folder is kept. */
export interface HeldFile {
  rel: string;
  bytes: number;
  mtime: string;
  sha256: string;
  kind: InputKind;
  data?: Uint8Array;
}
/** One pane's result on the lead. */
export interface PaneResult {
  state: InputState;
  files: HeldFile[];
  skipped: number;
}
interface MemberCall {
  at: number;
  panes: Map<string, PaneResult>;
  /** The member's state when the call gave no panes: `offline`, `older` or `refused`. */
  state?: InputState;
}

const KIND_CAP = { text: INPUT_TEXT_MAX_BYTES, image: INPUT_IMAGE_MAX_BYTES } satisfies Record<InputKind, number>;
const SKIPS = new Set<string>(["too-large", "cap", "type", "name"] satisfies InputSkip[]);

/** One file of a member's answer as the lead takes it, or null when it is refused (and so counted as skipped). */
function takeFile(row: JsonObject, globs: readonly string[], held: ReadonlyMap<string, string>): HeldFile | null {
  const rel = asJsonString(row.rel);
  const kind = asJsonString(row.kind);
  const bytes = asJsonNumber(row.bytes);
  const sum = asJsonString(row.sha256);
  const mtimeRaw = asJsonString(row.mtime);
  if (rel === undefined || !relOk(rel) || !globs.some((glob) => inputGlobMatches(glob, rel))) return null;
  if (kind !== "text" && kind !== "image") return null;
  if (bytes === undefined || !Number.isInteger(bytes) || bytes < 0 || bytes > KIND_CAP[kind]) return null;
  if (sum === undefined || !SHA256_HEX.test(sum)) return null;
  const mtime = mtimeRaw !== undefined && mtimeRaw.length <= 40 && Number.isFinite(Date.parse(mtimeRaw)) ? new Date(Date.parse(mtimeRaw)).toISOString() : isoOf(undefined);
  const b64 = asJsonString(row.b64);
  if (b64 === undefined) return held.get(rel) === sum ? { rel, bytes, mtime, sha256: sum, kind } : null;
  if (b64.length > Math.ceil((KIND_CAP[kind] * 4) / 3) + 4) return null;
  const data = new Uint8Array(Buffer.from(b64, "base64"));
  if (Buffer.from(data).toString("base64") !== b64 || data.length !== bytes || sha256(data) !== sum) return null;
  if (kind === "image") {
    const type = sniffImageType(data.subarray(0, 64));
    if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") return null;
  } else {
    if (looksBinary(data)) return null;
    try {
      utf8Strict.decode(data);
    } catch {
      return null;
    }
  }
  return { rel, bytes, mtime, sha256: sum, kind, data };
}

/** A member's answer body as pane results for the asked panes, or null when it does not read. */
export function takeAnswer(text: string, asked: readonly string[], globs: readonly string[], held: ReadonlyMap<string, ReadonlyMap<string, string>>): Map<string, PaneResult> | null {
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse output IS a JsonValue by construction; every field is checked below.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  const list = asJsonObject(parsed)?.panes;
  if (!Array.isArray(list)) return null;
  const want = new Set(asked);
  const out = new Map<string, PaneResult>();
  for (const item of list) {
    const row = asJsonObject(item);
    const pane = asJsonString(row?.pane);
    if (row === undefined || pane === undefined || !want.has(pane) || out.has(pane)) continue;
    const state = asJsonString(row.state);
    if (state !== "ok") {
      out.set(pane, { state: "none", files: [], skipped: 0 });
      continue;
    }
    const files: HeldFile[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    const rows = Array.isArray(row.files) ? row.files : [];
    for (const f of rows) {
      const fileRow = asJsonObject(f);
      if (fileRow === undefined) continue;
      const skip = asJsonString(fileRow.skipped);
      if (skip !== undefined) {
        if (SKIPS.has(skip)) skipped += 1;
        continue;
      }
      const file = takeFile(fileRow, globs, held.get(pane) ?? new Map());
      if (file === null || seen.has(file.rel) || files.length >= INPUT_FILES_MAX) {
        skipped += 1;
        continue;
      }
      seen.add(file.rel);
      files.push(file);
    }
    out.set(pane, { state: "ok", files, skipped });
  }
  return out;
}

/** A pane's files as the facts list them, `path` relative to the trick folder. */
function factsFiles(memberDir: string, paneDir: string, files: readonly HeldFile[]): FactsInputFile[] {
  return files.map((f) => ({ rel: f.rel, path: `${INPUTS_DIR}/${memberDir}/${paneDir}/${f.rel}`, bytes: f.bytes, sha256: f.sha256, mtime: f.mtime, kind: f.kind }));
}

/** The real path of a folder that is a folder (not a link), made when absent; null when it cannot be. */
async function realFolderOf(dir: string): Promise<string | null> {
  const st = await lstat(dir).catch(() => null);
  if (st !== null && !st.isDirectory()) await rm(dir, { force: true, recursive: true }).catch(() => undefined);
  if (st === null || !st.isDirectory()) await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const again = await lstat(dir).catch(() => null);
  if (again === null || !again.isDirectory()) return null;
  return realpath(dir).catch(() => null);
}

/** The bytes of a kept file in the current folder, or null when it is not the file the lead wrote (a link on the way, another size, another hash). */
async function keptBytes(root: string, segments: readonly string[], want: HeldFile): Promise<Uint8Array | null> {
  const path = join(root, ...segments);
  if (!isBelow(HOST, root, path)) return null;
  const real = await realpath(path).catch(() => null);
  if (real !== path) return null;
  const st = await lstat(path).catch(() => null);
  if (st === null || !st.isFile() || st.size !== want.bytes) return null;
  const data = await readFile(path).catch(() => null);
  if (data === null || sha256(data) !== want.sha256) return null;
  return new Uint8Array(data);
}

/**
 * The lead's half: before a run, the inputs of every agent session in the facts, written into the
 * approved copy's `inputs/` folder, which is replaced whole: the new tree is built beside it, then swapped
 * in, and every file the run does not hold goes. Holds one record per trick of what it wrote and when it
 * last called each member, so a file the folder already holds travels as its hash only, and a member is
 * called at most once per {@link INPUT_RATE_MS} per trick. Never throws.
 */
export class TrickInputs {
  /** By the approved copy's folder: what its `inputs/` holds, per member, and when each member was called. */
  private readonly held = new Map<string, { trick: string; calls: Map<string, MemberCall> }>();
  constructor(private readonly deps: InputsFetchDeps) {}

  /** Forget every copy of a trick (switched off, removed). The record is kept per copy, so a new copy starts clean on its own. */
  forget(trickId: string): void {
    for (const dir of this.held.keys()) if (this.held.get(dir)?.trick === trickId) this.held.delete(dir);
  }

  /** Each session's inputs by its scope key. Sessions that are not agent sessions are `none`. */
  async fetch(trick: InputsTrick, sessions: readonly FactsSession[]): Promise<Map<string, FactsInputs>> {
    const now = this.deps.now?.() ?? Date.now();
    const before = this.held.get(trick.dir)?.calls ?? new Map<string, MemberCall>();
    const after = new Map<string, MemberCall>();
    const byMember = new Map<string, FactsSession[]>();
    for (const session of sessions) {
      if (session.agent === undefined) continue;
      const list = byMember.get(session.memberId) ?? [];
      list.push(session);
      byMember.set(session.memberId, list);
    }
    const runBudget = { left: INPUT_RUN_MAX_BYTES };
    // The bridge's own sessions first, so a cap never cuts them for another machine's.
    const order = [...byMember.keys()].toSorted((a, b) => Number(this.deps.isOwn(b)) - Number(this.deps.isOwn(a)));
    const states = new Map<string, InputState>();
    for (const memberId of order) {
      const panes = (byMember.get(memberId) ?? []).map((s) => s.paneId);
      const call = await this.forMember(trick, memberId, panes, before.get(memberId), now, states);
      if (call === null) continue;
      after.set(memberId, call);
    }
    // The run's cap, in member order, the bridge's own first.
    for (const memberId of order) {
      for (const result of after.get(memberId)?.panes.values() ?? []) {
        const kept: HeldFile[] = [];
        for (const file of result.files) {
          if (file.bytes > runBudget.left) {
            result.skipped += 1;
            continue;
          }
          runBudget.left -= file.bytes;
          kept.push(file);
        }
        result.files = kept;
      }
    }
    const written = await this.write(trick, after);
    this.held.set(trick.dir, { trick: trick.id, calls: written });
    let files = 0;
    let bytes = 0;
    const out = new Map<string, FactsInputs>();
    for (const session of sessions) {
      const memberDir = inputsDirName(session.memberId);
      const result = written.get(session.memberId)?.panes.get(session.paneId);
      if (session.agent === undefined) {
        out.set(session.id, { state: "none", files: [] });
        continue;
      }
      const state = result?.state ?? states.get(session.memberId) ?? "none";
      const list = result === undefined ? [] : factsFiles(memberDir, inputsDirName(session.paneId), result.files);
      files += list.length;
      bytes += list.reduce((sum, f) => sum + f.bytes, 0);
      const inputs: FactsInputs = { state, files: list };
      if (result !== undefined && result.skipped > 0) inputs.skipped = result.skipped;
      out.set(session.id, inputs);
    }
    this.deps.audit?.({ trick: trick.id, files, bytes });
    return out;
  }

  /** One member's panes: read locally, called, reused inside the rate window, or a state with no call. */
  private async forMember(trick: InputsTrick, memberId: string, panes: readonly string[], last: MemberCall | undefined, now: number, states: Map<string, InputState>): Promise<MemberCall | null> {
    const haveOf = (pane: string): Map<string, string> => new Map((last?.panes.get(pane)?.files ?? []).map((f) => [f.rel, f.sha256]));
    if (this.deps.isOwn(memberId)) {
      const budget: InputsBudget = { left: INPUT_ANSWER_MAX_BYTES };
      const out = new Map<string, PaneResult>();
      for (const pane of panes) {
        const read = await this.deps.readLocal(pane, trick.globs, haveOf(pane), budget).catch((): WirePaneInputs => ({ state: "no-pane", files: [] }));
        const text = JSON.stringify({ panes: [{ pane, ...read }] });
        out.set(pane, takeAnswer(text, [pane], trick.globs, new Map([[pane, haveOf(pane)]]))?.get(pane) ?? { state: "none", files: [], skipped: 0 });
      }
      return { at: now, panes: out };
    }
    const member = this.deps.member(memberId);
    if (member === null || this.deps.call === undefined) {
      states.set(memberId, "none");
      return null;
    }
    // A member below the floor never gets the call: it would not know the route.
    if (member.older) {
      states.set(memberId, "older");
      return null;
    }
    if (!member.reachable) {
      states.set(memberId, "offline");
      return null;
    }
    // At most one call per trick per member per INPUT_RATE_MS: inside the window the last answer stands,
    // its files kept from the folder.
    if (last !== undefined && now - last.at < INPUT_RATE_MS) {
      const reused = new Map<string, PaneResult>();
      for (const pane of panes) {
        const was = last.panes.get(pane);
        if (was !== undefined) reused.set(pane, { state: was.state, skipped: was.skipped, files: was.files.map(({ data: _data, ...file }) => file) });
      }
      if (last.state !== undefined) states.set(memberId, last.state);
      return last.state === undefined ? { at: last.at, panes: reused } : { at: last.at, panes: reused, state: last.state };
    }
    const have = panes.map((pane) => ({ pane, files: [...haveOf(pane)].map(([rel, sum]) => ({ rel, sha256: sum })) })).filter((row) => row.files.length > 0);
    const body = JSON.stringify({ trick: trick.id, run: this.deps.runId?.() ?? randomBytes(8).toString("hex"), globs: trick.globs, panes, have });
    const answer = await this.deps.call(memberId, body).catch((): InputsCallResult => ({ kind: "failed" }));
    const without = (state: InputState): MemberCall => {
      states.set(memberId, state);
      return { at: now, panes: new Map(), state };
    };
    if (answer.kind === "failed" || answer.text === null) return without("offline");
    // A member built before the route answers 404: older, though its version did not say so.
    if (answer.status === 404) return without("older");
    if (answer.status === 403 && asJsonString(asJsonObject(safeParse(answer.text))?.code) === TRICK_READS_OFF) return without("refused");
    const held = new Map(panes.map((pane) => [pane, haveOf(pane)]));
    const taken = answer.status === 200 ? takeAnswer(answer.text, panes, trick.globs, held) : null;
    if (taken === null) return without("offline");
    // One answer's cap, again on the lead: what passes it is skipped.
    let left = INPUT_ANSWER_MAX_BYTES;
    for (const result of taken.values()) {
      result.files = result.files.filter((file) => {
        if (file.data === undefined) return true;
        if (file.data.length > left) {
          result.skipped += 1;
          return false;
        }
        left -= file.data.length;
        return true;
      });
    }
    return { at: now, panes: taken };
  }

  /** Build the new `inputs/` tree beside the old one, swap it in, and drop the old. Answers what it holds now. */
  private async write(trick: InputsTrick, calls: Map<string, MemberCall>): Promise<Map<string, MemberCall>> {
    const out = new Map<string, MemberCall>();
    const root = await realFolderOf(join(trick.dir, INPUTS_DIR));
    if (root === null) return out;
    const tag = randomBytes(6).toString("hex");
    const stageName = `.stage-${tag}`;
    const oldName = `.old-${tag}`;
    const stage = join(root, stageName);
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const [memberId, call] of calls) {
        const memberDir = inputsDirName(memberId);
        const panes = new Map<string, PaneResult>();
        for (const [pane, result] of call.panes) {
          const paneDir = inputsDirName(pane);
          const files: HeldFile[] = [];
          let skipped = result.skipped;
          for (const file of result.files) {
            const segments = parseRelPath(file.rel);
            const data = segments === null ? null : (file.data ?? (await keptBytes(root, [memberDir, paneDir, ...segments], file)));
            if (segments === null || data === null) {
              skipped += 1;
              continue;
            }
            const target = join(stage, memberDir, paneDir, ...segments);
            // The second look, on the joined path: a name that leaves the stage never lands.
            if (!isBelow(HOST, join(stage, memberDir, paneDir), target)) {
              skipped += 1;
              continue;
            }
            try {
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              // `wx`: a new file only, never through a link or over another file (two names one folder folds together).
              await writeFile(target, data, { flag: "wx", mode: 0o600 });
            } catch {
              skipped += 1;
              continue;
            }
            const { data: _data, ...kept } = file;
            files.push(kept);
          }
          panes.set(pane, { state: result.state, files, skipped });
        }
        out.set(memberId, call.state === undefined ? { at: call.at, panes } : { at: call.at, panes, state: call.state });
      }
      // The swap: everything in the folder moves aside, the stage's members move up, the old goes.
      const old = join(root, oldName);
      await mkdir(old, { mode: 0o700 });
      for (const name of await readdir(root)) {
        if (name === stageName || name === oldName) continue;
        await rename(join(root, name), join(old, name));
      }
      for (const name of await readdir(stage)) await rename(join(stage, name), join(root, name));
      await rm(old, { recursive: true, force: true });
    } catch {
      // A folder that cannot be written: the run gets no files, and says so by an empty list.
      out.clear();
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    return out;
  }
}

/** A wire file as the JSON body carries it. */
function wireFileJson(file: WireInputFile): JsonObject {
  return { ...file };
}

function safeParse(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse output IS a JsonValue by construction.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
