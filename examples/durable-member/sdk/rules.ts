// The id rule, the string cleaning and the caps of the wire (WIRE.md sections 6). Pure functions, no I/O.

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

/** Bytes per field. UTF-8 bytes, not code points. */
export const CAPS = {
  id: 128,
  hostName: 64,
  title: 256,
  askTitle: 256,
  starterLabel: 128,
  optionLabel: 128,
  harness: 64,
  cwd: 4096,
  reason: 2048,
  toolName: 128,
  summary: 1024,
  output: 16384,
  text: 65536,
  ts: 40,
  settledReason: 128,
  message: 512,
  sendText: 32768,
  note: 2048,
  body: 65536,
  /** The smallest `sun_path` limit of the platforms Collie runs on (macOS 104), less the closing NUL. */
  socketPath: 103,
} as const;

/** List caps. */
export const LIMITS = {
  workspaces: 64,
  tabs: 256,
  panes: 256,
  openAsksPerPane: 50,
  options: 6,
  starters: 50,
  eventsPerReply: 1000,
  resetItems: 2000,
  /** The program keeps at least this many request ids per epoch. */
  requestIds: 500,
  /** The events reply may not pass 8 MiB. This leaves room for the envelope. */
  replyBytes: 8_000_000,
} as const;

export const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// The mux id rule (isValidMuxId): control characters, whitespace, `/`, `?` and `#` are out.
const UNSAFE_ID_CHAR = /[\p{C}\s/?#]/u;

/** 1 to 128 bytes, no control character, no whitespace, none of `/`, `?` or `#`. */
export function idOk(id: unknown): boolean {
  return typeof id === "string" && id.length > 0 && bytes(id) <= CAPS.id && !UNSAFE_ID_CHAR.test(id);
}

export function assertId(id: unknown, what: string): string {
  if (!idOk(id)) throw new TypeError(`${what} breaks the id rule (1-128 bytes, no control character, no whitespace, no / ? #): ${JSON.stringify(id)}`);
  return id as string;
}

/**
 * An id a program may use for something it did not mint itself (a tool call id from a model, say).
 * A valid id comes back unchanged. Anything else maps to a valid id, the same one every time.
 */
export function safeId(raw: unknown): string {
  const s = String(raw ?? "");
  if (idOk(s)) return s;
  const hash = createHash("sha256").update(s).digest("hex").slice(0, 16);
  const body = s.replace(/[\p{C}\s/?#]/gu, "_");
  let head = "";
  for (const ch of body) {
    if (bytes(head + ch) > CAPS.id - 17) break;
    head += ch;
  }
  return `${head}~${hash}`;
}

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROLS_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Direction marks and overrides, zero-width characters, the word joiner, the byte order mark, and the tag
// characters (U+E0000 to U+E007F, which can carry a whole invisible sentence). WIRE.md section 6, step 2.
const INVISIBLE = /[\u200b-\u200f\u061c\u202a-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/**
 * Clean a display string, then cut it to `max` bytes at the last whole code point that leaves room
 * for the 3-byte `…`. Multi-line fields keep `\n` and `\t`; every other string keeps neither.
 */
export function cut(text: unknown, max: number, multiline = false): string {
  const clean = String(text ?? "")
    .replace(multiline ? CONTROLS_MULTILINE : CONTROLS, "")
    .replace(INVISIBLE, "");
  if (bytes(clean) <= max) return clean;
  let out = "";
  let used = 0;
  for (const ch of clean) {
    const n = bytes(ch);
    if (used + n > max - 3) break;
    out += ch;
    used += n;
  }
  return `${out}…`;
}

/** An absolute path inside the cap, else undefined (it reads as absent). */
export function cwdOf(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd === "" || bytes(cwd) > CAPS.cwd || HAS_CONTROL.test(cwd)) return undefined;
  return isAbsolute(cwd) ? cwd : undefined;
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
/** ISO 8601 with a zone, at most 40 bytes, else undefined (it reads as absent). */
export function tsOf(ts: unknown): string | undefined {
  return typeof ts === "string" && bytes(ts) <= CAPS.ts && ISO.test(ts) ? ts : undefined;
}
