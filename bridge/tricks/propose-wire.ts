import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { isTrickId, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { isRequestId } from "../worktree-receipts.ts";
import { CONFIG_FILE, isPictureName, PICTURE_DIRS, unsafeText } from "./code-hash.ts";
import { MANIFEST_BYTES_MAX, readManifestText } from "./discover.ts";
import { isPictureBytes } from "./approved.ts";
import { MANIFEST_FILE } from "./paths.ts";

// A TRICK PROPOSAL ON THE WIRE (crew slice 8): the one reader of the files a proposal carries.
//
// `collie trick propose <folder>` sends a trick's files to the local bridge, and a crew member's bridge
// sends them on to its lead. Every hop reads them with THIS function and nothing else: the CLI before it
// sends (so an agent learns of a problem at once), the member's bridge before it forwards, and the lead
// again on receipt, where every byte is hostile. Nothing here touches the disk.
//
// A proposal is `{ requestId, files: [{ rel, b64, x? }] }`. What a file may be:
//   * `rel` is a relative path of 1 to {@link PROPOSE_LIMITS}.depth + 1 steps split by `/`, at most
//     {@link PROPOSE_LIMITS}.pathChars characters, each step at most 255 bytes. Refused: an empty step,
//     `.` and `..`, a step that starts with a dot (dot files and dot folders, `.git`, `.env`, `.collie-*`),
//     `node_modules`, a top-level `inputs/` (the bridge fills it), a `*.log` (outside the code hash), a
//     backslash, a colon, any `\p{C}` character (control, format such as a bidi or zero-width mark,
//     private use, unassigned) and anything `unsafeText` refuses, and a name not in Unicode NFC.
//   * Two names that fold to one (NFKC, then lower case) are refused, so a case-folding file system or a
//     normalising one never writes one file over another. So is a name used as a file and as a folder.
//   * `media/` and `captures/` take pictures only: a `.png`, `.jpg`, `.jpeg` or `.webp` name whose first
//     bytes are a PNG, JPEG or WebP picture, as the approved copy seeds them (approved.ts).
//   * `b64` is standard base64 that writes back to itself. `x: true` marks an executable file; the
//     proposed store never sets the bit, the installed folder does.
//   * At most {@link PROPOSE_LIMITS}.files files and {@link PROPOSE_LIMITS}.bytes bytes, the caps of
//     `collie trick add`. `trick.toml` is required, and with `config.toml` at most 64 KiB; the manifest
//     is read by the strict reader, and its `id` names the trick.

/** Every cap of a proposal. The file and byte caps are `collie trick add`'s (`ADD_LIMITS`, held to it by a test). */
export const PROPOSE_LIMITS = {
  files: 300,
  bytes: 5 * 1024 * 1024,
  /** Folder levels inside the trick's folder. */
  depth: 8,
  /** Characters of one relative path. */
  pathChars: 256,
  /** Bytes of one step of a path, the common file system limit. */
  stepBytes: 255,
} as const;

/** Trick ids a proposal may not take, though they are valid ids: they read as Collie's own words on a card. */
export const RESERVED_PROPOSAL_IDS: readonly string[] = ["collie", "trick", "tricks", "hill", "settings"];

/** One file of a proposal, read and checked. */
export interface ProposedFile {
  rel: string;
  bytes: Uint8Array;
  executable: boolean;
}

/** A proposal read and checked: its request id, its files in path order, its manifest and its hash. */
export interface ProposalRead {
  requestId: string;
  files: ProposedFile[];
  manifest: TrickManifest;
  /** {@link proposalHash} of the files. */
  hash: string;
  bytes: number;
}

/** Why a proposal is refused: a code for a program, and one plain line. */
export interface ProposeRefusal {
  code: ProposeRefusalCode;
  error: string;
}

export type ProposeRefusalCode =
  | "bad_request"
  | "bad_files"
  | "bad_manifest"
  | "reserved_id"
  | "hill_off"
  | "exists"
  | "open_elsewhere"
  | "answering"
  | "too_many_open"
  | "too_many_bytes"
  | "rate"
  | "request_id_reused"
  | "no_tricks"
  | "not_on_lead"
  | "lead_unreachable"
  | "failed";

export const PROPOSE_REFUSAL_CODES: readonly ProposeRefusalCode[] = [
  "bad_request",
  "bad_files",
  "bad_manifest",
  "reserved_id",
  "hill_off",
  "exists",
  "open_elsewhere",
  "answering",
  "too_many_open",
  "too_many_bytes",
  "rate",
  "request_id_reused",
  "no_tricks",
  "not_on_lead",
  "lead_unreachable",
  "failed",
];

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u;
const BAD_CHARS = /[\p{C}\\:]/u;

function refuse(code: ProposeRefusalCode, error: string) {
  const refusal: ProposeRefusal = { code, error };
  return { ok: false as const, refusal };
}

/** Standard base64 that decodes and writes back to itself, or null. */
export function strictBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
}

/** A name as one cleaned line for a refusal: every character a terminal or a card could misread as `?`. */
export function shownPath(rel: string): string {
  return [...rel]
    .slice(0, 80)
    .map((ch) => (BAD_CHARS.test(ch) || unsafeText(ch) ? "?" : ch))
    .join("");
}

/** The words for a proposal that carries a config.toml: the program reads it, and nobody would see it. */
export const PROPOSE_NO_CONFIG = "A proposal cannot carry a config.toml. Your person sets the trick up on the machine.";

/** Whether a path is the trick's top-level config.toml, in any case. */
export function isConfigPath(rel: string): boolean {
  return foldKey(rel) === CONFIG_FILE;
}

/** Why a relative path is refused, or null when a proposal may carry it. */
export function proposedPathProblem(rel: string): string | null {
  if (rel === "" || [...rel].length > PROPOSE_LIMITS.pathChars) return `is empty or longer than ${String(PROPOSE_LIMITS.pathChars)} characters`;
  if (BAD_CHARS.test(rel) || unsafeText(rel)) return "holds a control, invisible or direction character, a backslash or a colon";
  if (rel.normalize("NFC") !== rel) return "is not in Unicode NFC form";
  if (rel.startsWith("/")) return "is an absolute path";
  const steps = rel.split("/");
  if (steps.length > PROPOSE_LIMITS.depth + 1) return `sits deeper than ${String(PROPOSE_LIMITS.depth)} folders`;
  for (const step of steps) {
    if (step === "") return "has an empty step";
    if (step === "." || step === "..") return "has a . or .. step";
    if (step.startsWith(".")) return "names a dot file or a dot folder, which a trick does not carry";
    // Reserved names are compared folded: on a case-insensitive disk `Node_Modules` is `node_modules`.
    if (foldKey(step) === "node_modules") return "names node_modules, which a trick does not carry";
    if (Buffer.byteLength(step, "utf8") > PROPOSE_LIMITS.stepBytes) return `has a step longer than ${String(PROPOSE_LIMITS.stepBytes)} bytes`;
  }
  if (foldKey(steps[0] ?? "") === "inputs") return "is under inputs/, which the bridge fills";
  if (rel.endsWith(".log")) return "is a .log file, which is not code";
  return null;
}

/** Whether a path is in one of the picture folders, `media/` or `captures/`. */
export function inPictureDir(rel: string): boolean {
  const top = foldKey(rel.split("/")[0] ?? "");
  return rel.includes("/") && PICTURE_DIRS.some((dir) => dir === top);
}

/** The key two names collide on: NFKC, then lower case. */
export function foldKey(rel: string): string {
  return rel.normalize("NFKC").toLowerCase();
}

/** The trick id a manifest names, read loosely: the strict reader then checks it against that id. */
function manifestId(text: string): string | null {
  try {
    // SAFETY: `Bun.TOML.parse` answers with a parsed document; only `id` is read here, as a string, and
    // `readManifestText` checks the whole document strictly right after.
    const doc = Bun.TOML.parse(text) as JsonValue;
    return asJsonString(asJsonObject(doc)?.id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The hash a proposal is bound by: SHA-256 over every file in path order (byte order), each with its
 * path, its executable mark and its bytes. The card's `ref.hash`, the store's folder name (its first 16
 * hex digits), and what the install checks the stored bytes against.
 */
export function proposalHash(files: readonly Pick<ProposedFile, "rel" | "bytes" | "executable">[]): string {
  const h = createHash("sha256");
  h.update("collie-trick-proposal-v1\n");
  for (const file of [...files].toSorted((a, b) => (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1))) {
    h.update(`${file.rel}\0${file.executable ? "x" : "-"}\0${String(file.bytes.length)}\0`);
    h.update(file.bytes);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Check a list of files as a proposal: every path, the twins, the caps, the pictures, the manifest. The
 * one rule the CLI, the member and the lead share. Never throws.
 */
export function checkProposedFiles(files: readonly ProposedFile[]): { ok: true; manifest: TrickManifest; bytes: number } | { ok: false; refusal: ProposeRefusal } {
  if (files.length === 0) return refuse("bad_files", "The proposal holds no file.");
  if (files.length > PROPOSE_LIMITS.files) return refuse("bad_files", `The trick holds ${String(files.length)} files, more than ${String(PROPOSE_LIMITS.files)}.`);
  let bytes = 0;
  const folded = new Map<string, string>();
  // Each folder's folded name, and the one spelling it was first seen with.
  const folders = new Map<string, string>();
  for (const file of files) {
    if (isConfigPath(file.rel)) return refuse("bad_files", PROPOSE_NO_CONFIG);
    const problem = proposedPathProblem(file.rel);
    if (problem !== null) return refuse("bad_files", `The file name "${shownPath(file.rel)}" ${problem}.`);
    const key = foldKey(file.rel);
    if (folded.has(key)) return refuse("bad_files", `Two files are named "${shownPath(file.rel)}" once case and Unicode form are set aside.`);
    folded.set(key, file.rel);
    const steps = key.split("/");
    const spelled = file.rel.split("/");
    for (let i = 1; i < steps.length; i += 1) {
      const folder = steps.slice(0, i).join("/");
      const spelling = spelled.slice(0, i).join("/");
      const seen = folders.get(folder);
      if (seen !== undefined && seen !== spelling) return refuse("bad_files", `Two folders are named "${shownPath(spelling)}" once case and Unicode form are set aside.`);
      folders.set(folder, spelling);
    }
    if (inPictureDir(file.rel) && (!isPictureName(file.rel) || !isPictureBytes(file.bytes))) {
      return refuse("bad_files", `"${shownPath(file.rel)}" is in a picture folder and is not a PNG, JPEG or WebP picture.`);
    }
    if (file.rel === MANIFEST_FILE && file.bytes.length > MANIFEST_BYTES_MAX) {
      return refuse("bad_files", `${file.rel} is larger than ${String(MANIFEST_BYTES_MAX / 1024)} KiB.`);
    }
    bytes += file.bytes.length;
    if (bytes > PROPOSE_LIMITS.bytes) return refuse("bad_files", `The trick holds more than ${String(PROPOSE_LIMITS.bytes / (1024 * 1024))} MB.`);
  }
  for (const key of folded.keys()) {
    if (folders.has(key)) return refuse("bad_files", `"${shownPath(folded.get(key) ?? key)}" is named as a file and as a folder.`);
  }
  const manifestFile = files.find((file) => file.rel === MANIFEST_FILE);
  if (manifestFile === undefined) return refuse("bad_manifest", `There is no ${MANIFEST_FILE} at the top of the trick.`);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(manifestFile.bytes);
  const id = manifestId(text);
  if (id === null || !isTrickId(id)) return refuse("bad_manifest", `${MANIFEST_FILE} names no trick id Collie takes (1 to 32 of a-z, 0-9 and -).`);
  if (RESERVED_PROPOSAL_IDS.includes(id)) return refuse("reserved_id", `"${id}" is a name Collie keeps for itself. Give the trick another id.`);
  const read = readManifestText(text, id);
  if (read.manifest === undefined) {
    const first = read.refusals.find((r) => r.code !== "later") ?? read.refusals[0];
    return refuse("bad_manifest", `${MANIFEST_FILE}${first === undefined || first.path === "" ? "" : ` ${first.path}`}: ${first?.reason ?? "is refused"}`);
  }
  return { ok: true, manifest: read.manifest, bytes };
}

/** The files of a proposal as the wire carries them. */
export function wireFiles(files: readonly ProposedFile[]): JsonObject[] {
  return files.map((file) => (file.executable ? { rel: file.rel, b64: Buffer.from(file.bytes).toString("base64"), x: true } : { rel: file.rel, b64: Buffer.from(file.bytes).toString("base64") }));
}

/**
 * Read a proposal's fields from the wire: `requestId` and `files`, every file decoded strictly and the
 * whole list checked ({@link checkProposedFiles}). Total over garbage; never throws.
 */
export function readProposal(fields: JsonObject | undefined): { ok: true; proposal: ProposalRead } | { ok: false; refusal: ProposeRefusal } {
  if (fields === undefined) return refuse("bad_request", "A proposal is { requestId, files }.");
  const requestId = fields.requestId;
  if (!isRequestId(requestId)) return refuse("bad_request", "A proposal carries a request id, a UUID.");
  const raw = fields.files;
  if (!Array.isArray(raw)) return refuse("bad_request", "A proposal carries its files as a list.");
  if (raw.length > PROPOSE_LIMITS.files) return refuse("bad_files", `The trick holds ${String(raw.length)} files, more than ${String(PROPOSE_LIMITS.files)}.`);
  const files: ProposedFile[] = [];
  // Base64 of the byte cap, plus its padding: a longer text is refused before it is decoded.
  let b64Left = Math.ceil(PROPOSE_LIMITS.bytes / 3) * 4 + 4 * PROPOSE_LIMITS.files;
  for (const entry of raw) {
    const row = asJsonObject(entry);
    const rel = asJsonString(row?.rel);
    const b64 = asJsonString(row?.b64);
    const x = row?.x === undefined ? false : asJsonBoolean(row.x);
    if (row === undefined || rel === undefined || b64 === undefined || x === undefined) return refuse("bad_request", "A file is { rel, b64, x? }.");
    if (Object.keys(row).some((key) => key !== "rel" && key !== "b64" && key !== "x")) return refuse("bad_request", "A file is { rel, b64, x? }.");
    b64Left -= b64.length;
    if (b64Left < 0) return refuse("bad_files", `The trick holds more than ${String(PROPOSE_LIMITS.bytes / (1024 * 1024))} MB.`);
    if (isConfigPath(rel)) return refuse("bad_files", PROPOSE_NO_CONFIG);
    const problem = proposedPathProblem(rel);
    if (problem !== null) return refuse("bad_files", `The file name "${shownPath(rel)}" ${problem}.`);
    const bytes = strictBase64(b64);
    if (bytes === null) return refuse("bad_request", `"${shownPath(rel)}" is not standard base64.`);
    files.push({ rel, bytes, executable: x });
  }
  const checked = checkProposedFiles(files);
  if (!checked.ok) return checked;
  const sorted = files.toSorted((a, b) => (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1));
  return { ok: true, proposal: { requestId, files: sorted, manifest: checked.manifest, hash: proposalHash(sorted), bytes: checked.bytes } };
}
