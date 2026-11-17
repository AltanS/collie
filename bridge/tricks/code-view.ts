import { join } from "node:path";

import { CODE_VIEW_BYTES_MAX } from "../../web/src/lib/tricks/limits.ts";
import type { WireCodeFile, WireCodeIndex, WireCodeIndexFile, WireCodeMark } from "../../web/src/lib/tricks/code-wire.ts";
import type { TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { looksBinary } from "../changes.ts";
import { redactText } from "../redact.ts";
import { CODE_BYTES_MAX, codeHashOfFiles, diskTrickFs, walkTrickCode, type TrickFs } from "./code-hash.ts";
import { MANIFEST_FILE } from "./paths.ts";
import { HELPER_FILE, kindRank, scanTrickFolder, shippedHelperVersion, type CheckWarning } from "./scan.ts";
import { readViewLine } from "./version-diff.ts";

// THE CODE OF A TRICK, FOR THE ABOUT SHEET'S "READ THE CODE" FOLDS (2026-11-17, package F).
//
//   GET /api/tricks/<host>/<id>/code              → CodeIndex: every code file's name, size and flag count
//   GET /api/tricks/<host>/<id>/code?file=<rel>   → CodeFile: that one file's lines, masked, marked
//
// WHICH BYTES. Never the working folder while a copy runs. The approved copy's code (approved.ts), read
// through the walk the code hash takes, and checked against the hash it is filed under: the bytes are read
// ONCE into memory, hashed from memory, and the text search runs over those same bytes, so what is shown,
// what is marked and what the hash covers are one thing. A trick with no approved copy shows what a
// switch on would approve (`approvesOf`, service.ts): the waiting snapshot, else the folder as it is now,
// and `copy: "next"` says so. Bytes that do not hash to the hash the caller expects are refused as `moved`.
//
// WHAT LEAVES. Each text file passes the mask a screen read passes (`redactText`, over the whole text so a
// key block over several lines is found), then each line the card's own line reader (version-diff.ts
// `readViewLine`: a tab as two spaces, a hidden or control character a `?`), so no character hides or turns
// a line around. The number of lines the mask changed is sent. A file over {@link CODE_VIEW_BYTES_MAX} shows
// its first part, cut at a line end, and `leftOut` says how many bytes are not shown. A binary file (a NUL in
// its head, as the Changes view tells) sends its name and size only.
//
// MARKS. The text search's warnings (scan.ts) are kept with their file and line. A line carries the kinds it
// was flagged for, in the search's own order; a flag on a line past the part shown is counted in `marksLeft`.
// It is a text search, and the sheet says so.
//
// READS ONLY. No write route, no new right.
//
// ── NO SWITCH ON OF CODE THE SHEET CANNOT SHOW AS IT IS (A5) ──────────────────────────────────────────
// The fold may mask and cut. So a switch on outside a card, from the phone's switch (service.ts `setSwitch`)
// or from `collie trick on`, is refused while the code it would approve holds a file the fold cannot show
// whole and as it is: a line the mask changes (a key, or a hidden character as `?`), a file over
// {@link CODE_VIEW_BYTES_MAX}, or a file that is not UTF-8 text ({@link codeShowsWhole}). Collie's own helper,
// byte for byte, is left out: card 1 of a proposal names it the same way. The one rule of every card: a
// view that cannot show every byte as it is offers no yes.

export type { WireCodeFile as CodeFile, WireCodeIndex as CodeIndex, WireCodeIndexFile as CodeIndexFile, WireCodeMark as CodeMark };

/** Where the code is read from, as the service picks it. */
export interface CodeSource {
  dir: string;
  hash: string;
  copy: WireCodeIndex["copy"];
  manifest: Pick<TrickManifest, "run" | "everyMs"> | undefined;
}

/** The parts of a trick's runtime this reads. */
export interface CodeRuntime {
  approved: { dir: string; hash: string; found: { manifest?: TrickManifest | undefined } } | null;
  copyProblem: string | null;
  pending: { dir: string; hash: string; manifest?: TrickManifest | undefined } | null;
  found: { dir: string; codeHash?: string | undefined; manifest?: TrickManifest | undefined };
}

/**
 * The copy to show: the approved copy while one runs; else the version a switch on would approve, the
 * waiting snapshot or the folder as it is now. Null when there is no code that hashes.
 */
export function codeSource(rt: CodeRuntime): CodeSource | null {
  if (rt.approved !== null && rt.copyProblem === null) return { dir: rt.approved.dir, hash: rt.approved.hash, copy: "approved", manifest: rt.approved.found.manifest };
  if (rt.pending !== null) return { dir: rt.pending.dir, hash: rt.pending.hash, copy: "next", manifest: rt.pending.manifest ?? rt.found.manifest };
  if (rt.found.codeHash === undefined) return null;
  return { dir: rt.found.dir, hash: rt.found.codeHash, copy: "next", manifest: rt.found.manifest };
}

/** Why no code is shown. `no-code`: the folder does not walk or hash; `moved`: its bytes are not the ones the hash names; `no-file`: no such code file. */
export type CodeRefusal = { ok: false; code: "no-code" | "moved" | "no-file"; message: string };

export const CODE_MOVED = "The code changed while it was read. Open the sheet again.";
export const CODE_NONE = "This trick has no code that can be read.";
export const CODE_NO_FILE = "That file is not part of this trick's code.";

interface Bytes {
  rel: string;
  bytes: Uint8Array;
}

/** The bytes of every code file, read once, and proof that they hash to `hash`. */
async function readCode(source: CodeSource, fs: TrickFs): Promise<{ ok: true; files: Bytes[] } | CodeRefusal> {
  const walk = await walkTrickCode(fs, source.dir);
  if (!walk.ok) return { ok: false, code: "no-code", message: CODE_NONE };
  const files: Bytes[] = [];
  for (const entry of walk.entries) {
    if (entry.kind !== "file") return { ok: false, code: "no-code", message: CODE_NONE };
    const bytes = await fs.read(join(source.dir, entry.rel), CODE_BYTES_MAX);
    if (bytes === null) return { ok: false, code: "moved", message: CODE_MOVED };
    files.push({ rel: entry.rel, bytes });
  }
  if (codeHashOfFiles(files) !== source.hash) return { ok: false, code: "moved", message: CODE_MOVED };
  return { ok: true, files };
}

/** A file system that answers a read from the bytes already held, so the text search sees what was hashed. */
function heldFs(dir: string, files: readonly Bytes[]): TrickFs {
  const held = new Map(files.map((file) => [join(dir, file.rel), file.bytes]));
  return { ...diskTrickFs, read: async (path, max) => held.get(path)?.subarray(0, max) ?? null };
}

/** The warnings of the held bytes, by the one scan `collie trick check` runs. */
async function warningsOf(source: CodeSource, files: readonly Bytes[]): Promise<CheckWarning[]> {
  const walkEntries = files.map((file) => ({ rel: file.rel, kind: "file" as const, size: file.bytes.length, mtimeMs: 0, ino: 0 }));
  const scan = await scanTrickFolder(source.dir, source.manifest ?? {}, walkEntries, heldFs(source.dir, files));
  return scan.warnings;
}

/** The part of a text file that is shown: whole under the cap, else cut after the last line end inside it. */
function shownEnd(bytes: Uint8Array): number {
  if (bytes.length <= CODE_VIEW_BYTES_MAX) return bytes.length;
  const lineEnd = bytes.lastIndexOf(10, CODE_VIEW_BYTES_MAX - 1);
  return lineEnd > 0 ? lineEnd + 1 : CODE_VIEW_BYTES_MAX;
}

/** The lines of a text, masked as a card shows a line; how many the mask changed. */
interface MaskedLines {
  lines: string[];
  masked: number;
}

function maskedLines(text: string): MaskedLines {
  const redacted = redactText(text);
  const raw = text.split("\n");
  const seen = redacted.split("\n");
  if (seen.at(-1) === "") {
    raw.pop();
    seen.pop();
  }
  let masked = 0;
  const lines = seen.map((line, i) => {
    const read = readViewLine(line);
    if (read.masked || line !== raw[i]) masked += 1;
    return read.line;
  });
  return { lines, masked };
}

/** The marks of one file's warnings: per line the kinds, in the search's order, lines in order. */
function marksOf(warnings: readonly CheckWarning[], file: string): WireCodeMark[] {
  const byLine = new Map<number, Set<CheckWarning["kind"]>>();
  for (const warning of warnings) {
    if (warning.file !== file) continue;
    byLine.set(warning.line, (byLine.get(warning.line) ?? new Set()).add(warning.kind));
  }
  return [...byLine]
    .toSorted((a, b) => a[0] - b[0])
    .map(([line, kinds]) => ({ line, kinds: [...kinds].toSorted((a, b) => kindRank(a) - kindRank(b)) }));
}

/** The index of a trick's code: every file with its size and how many lines the text search flags in it. */
export async function codeIndex(source: CodeSource, fs: TrickFs = diskTrickFs): Promise<{ ok: true; body: WireCodeIndex } | CodeRefusal> {
  const read = await readCode(source, fs);
  if (!read.ok) return read;
  const warnings = await warningsOf(source, read.files);
  const files = read.files.map((file): WireCodeIndexFile => {
    const entry: WireCodeIndexFile = { file: file.rel, size: file.bytes.length, flagged: marksOf(warnings, file.rel).length };
    if (looksBinary(file.bytes)) entry.binary = true;
    return entry;
  });
  // The manifest first: it holds the run line, and the run line is code too.
  files.sort((a, b) => Number(b.file === MANIFEST_FILE) - Number(a.file === MANIFEST_FILE));
  return { ok: true, body: { hash: source.hash, copy: source.copy, files } };
}

/** One file of a trick's code: its lines, masked and marked, or its name and size when it is binary. */
export async function codeFile(source: CodeSource, rel: string, fs: TrickFs = diskTrickFs): Promise<{ ok: true; body: WireCodeFile } | CodeRefusal> {
  const read = await readCode(source, fs);
  if (!read.ok) return read;
  const file = read.files.find((candidate) => candidate.rel === rel);
  if (file === undefined) return { ok: false, code: "no-file", message: CODE_NO_FILE };
  if (looksBinary(file.bytes)) return { ok: true, body: { file: rel, size: file.bytes.length, binary: true } };
  const end = shownEnd(file.bytes);
  // A cut inside a character leaves a replacement character at the end: it is not part of the code.
  const text = new TextDecoder().decode(file.bytes.subarray(0, end)).replace(/�+$/u, "");
  const { lines, masked } = maskedLines(text);
  const marks = marksOf(await warningsOf(source, read.files), rel);
  const shown = marks.filter((mark) => mark.line <= lines.length);
  return { ok: true, body: { file: rel, size: file.bytes.length, lines, leftOut: file.bytes.length - end, masked, marks: shown, marksLeft: marks.length - shown.length } };
}

/** Why a switch on is refused for code the About sheet cannot show whole and as it is (A5). Bridge English. */
export function switchNotText(rel: string, id: string): string {
  return `${rel} is not text, so the phone cannot show it, and ${id} stays off. Code must be text; pictures go in media/.`;
}
export function switchTooLarge(rel: string, id: string): string {
  return `${rel} is larger than ${String(CODE_VIEW_BYTES_MAX / 1024)} KB, more than the phone shows of one file, so ${id} stays off. Split it into smaller files.`;
}
export function switchMasked(rel: string, id: string): string {
  return `${rel} holds text the phone cannot show as it is (a key, or a hidden character), so ${id} stays off. Take it out of the code.`;
}

/** Whether every file of the code a switch on would approve shows whole and as it is, or the first that does not. */
export type CodeWholeCheck = { ok: true } | CodeRefusal | { ok: false; code: "not-whole"; rel: string; message: string };

/**
 * Whether the About sheet shows every code file of `source` whole and as it is: read once, checked against its
 * hash, then each file: UTF-8 text, at most {@link CODE_VIEW_BYTES_MAX}, and no line the mask changes. Collie's
 * own helper, byte for byte, passes. A switch on outside a card is refused otherwise (A5).
 */
export async function codeShowsWhole(source: Pick<CodeSource, "dir" | "hash">, id: string, fs: TrickFs = diskTrickFs): Promise<CodeWholeCheck> {
  const read = await readCode({ ...source, copy: "next", manifest: undefined }, fs);
  if (!read.ok) return read;
  for (const file of read.files) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      return { ok: false, code: "not-whole", rel: file.rel, message: switchNotText(file.rel, id) };
    }
    if (looksBinary(file.bytes)) return { ok: false, code: "not-whole", rel: file.rel, message: switchNotText(file.rel, id) };
    if (file.rel === HELPER_FILE && shippedHelperVersion(text) !== null) continue;
    if (file.bytes.length > CODE_VIEW_BYTES_MAX) return { ok: false, code: "not-whole", rel: file.rel, message: switchTooLarge(file.rel, id) };
    if (maskedLines(text).masked > 0) return { ok: false, code: "not-whole", rel: file.rel, message: switchMasked(file.rel, id) };
  }
  return { ok: true };
}
