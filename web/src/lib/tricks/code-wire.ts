// A TRICK'S CODE ON THE WIRE, for the About sheet's "Read the code" folds (bridge/tricks/code-view.ts).
//
//   GET /api/tricks/<host>/<id>/code             → WireCodeIndex: each code file's name, size and flag count
//   GET /api/tricks/<host>/<id>/code?file=<rel>  → WireCodeFile: one file's lines, masked, with the marks
//
// The bridge shows the approved copy's bytes (else what a switch on would approve), masks them as a
// screen read is masked, and cuts a long file. The phone reads the reply again here: a shape it does not
// know is left out, and a hidden or control character in a line is drawn as `?`, so the text on the screen
// is text and never a way to turn a line around. React draws the lines as text; nothing here is markdown.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import { isHiddenChar } from "../hidden-chars";

/** Which copy the code is: the one that runs, or the one a switch on would approve. */
export type WireCodeCopy = "approved" | "next";

/** What the index says of one code file. */
export interface WireCodeIndexFile {
  file: string;
  size: number;
  /** A binary file: its name and size are all the fold has. */
  binary?: true;
  /** How many lines of the text search flag in the file. */
  flagged: number;
}

export interface WireCodeIndex {
  /** The code hash (64 hex) the bytes were checked against. */
  hash: string;
  copy: WireCodeCopy;
  files: WireCodeIndexFile[];
}

/** One line the text search flagged: its number from 1, and the kinds in the search's own order. */
export interface WireCodeMark {
  line: number;
  kinds: string[];
}

/** One code file. A binary file has no `lines`. */
export interface WireCodeFile {
  file: string;
  size: number;
  binary?: true;
  lines?: string[];
  /** Bytes past the part shown, 0 when the whole file is shown. */
  leftOut?: number;
  /** How many shown lines the mask changed (a key masked, a hidden character as `?`). */
  masked?: number;
  marks?: WireCodeMark[];
  /** Flags on lines past the part shown. */
  marksLeft?: number;
}

/** Bounds the phone holds the reply to, so one odd reply cannot fill the sheet. */
export const CODE_WIRE_LIMITS = { files: 2000, nameChars: 512, lines: 40_000, lineChars: 40_000, kinds: 8, kindChars: 24 } as const;

function array(raw: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(raw) ? raw : undefined;
}

const HASH = /^[0-9a-f]{64}$/u;

function whole(raw: JsonValue | undefined): number | undefined {
  const n = asJsonNumber(raw);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function name(raw: JsonValue | undefined): string | undefined {
  const text = asJsonString(raw);
  return text === undefined || text === "" || text.length > CODE_WIRE_LIMITS.nameChars ? undefined : text;
}

/** A line of code with each hidden or control character drawn as `?`. */
export function shownLine(line: string): string {
  let out = "";
  for (const ch of line) out += isHiddenChar(ch) ? "?" : ch;
  return out;
}

/** `GET .../code` as the phone reads it, or `undefined` for a body of another shape. */
export function readCodeIndex(raw: JsonValue | undefined): WireCodeIndex | undefined {
  const body = asJsonObject(raw);
  const hash = asJsonString(body?.hash);
  const copy = body?.copy;
  const list = array(body?.files);
  if (hash === undefined || !HASH.test(hash) || (copy !== "approved" && copy !== "next") || list === undefined || list.length > CODE_WIRE_LIMITS.files) return undefined;
  const files: WireCodeIndexFile[] = [];
  for (const entry of list) {
    const one = asJsonObject(entry);
    const file = name(one?.file);
    const size = whole(one?.size);
    const flagged = whole(one?.flagged);
    if (file === undefined || size === undefined || flagged === undefined) return undefined;
    files.push(asJsonBoolean(one?.binary) === true ? { file, size, binary: true, flagged } : { file, size, flagged });
  }
  return { hash, copy, files };
}

function readMarks(raw: JsonValue | undefined): WireCodeMark[] | undefined {
  const list = array(raw);
  if (list === undefined) return undefined;
  const marks: WireCodeMark[] = [];
  for (const entry of list) {
    const one = asJsonObject(entry);
    const line = whole(one?.line);
    const kinds = array(one?.kinds)?.map((kind) => asJsonString(kind));
    if (line === undefined || line < 1 || kinds === undefined || kinds.length === 0 || kinds.length > CODE_WIRE_LIMITS.kinds) return undefined;
    const words = kinds.filter((kind): kind is string => kind !== undefined && kind !== "" && kind.length <= CODE_WIRE_LIMITS.kindChars);
    if (words.length !== kinds.length) return undefined;
    marks.push({ line, kinds: words });
  }
  return marks;
}

/** `GET .../code?file=` as the phone reads it, or `undefined` for a body of another shape. */
export function readCodeFile(raw: JsonValue | undefined): WireCodeFile | undefined {
  const body = asJsonObject(raw);
  const file = name(body?.file);
  const size = whole(body?.size);
  if (file === undefined || size === undefined) return undefined;
  if (asJsonBoolean(body?.binary) === true) return { file, size, binary: true };
  const rows = array(body?.lines);
  const leftOut = whole(body?.leftOut);
  const masked = whole(body?.masked);
  const marksLeft = whole(body?.marksLeft);
  const marks = readMarks(body?.marks);
  if (rows === undefined || rows.length > CODE_WIRE_LIMITS.lines || leftOut === undefined || masked === undefined || marksLeft === undefined || marks === undefined) return undefined;
  const lines: string[] = [];
  for (const row of rows) {
    const text = asJsonString(row);
    if (text === undefined || text.length > CODE_WIRE_LIMITS.lineChars) return undefined;
    lines.push(shownLine(text));
  }
  return { file, size, lines, leftOut, masked, marks, marksLeft };
}
