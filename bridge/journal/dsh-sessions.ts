// Where DeepSeek Harness (dsh, and dsh-tui on top of it) keeps its sessions, and how a session's
// log is read.
//
// Each session is a folder <sessions>/<project>/<session-id>/ holding its log, one file per format
// generation: session.v<N>.jsonl.zstd by default, session.v<N>.jsonl when the operator turned
// compression off (and session.jsonl[.zstd] for the oldest generation). dsh opens the highest
// generation, so this reads that one as well. Observed on @deepseek-ai/dsh-session-persistence-jsonl
// with format v4 (fixtures/dsh/README.md says how the fixtures were made).
//
// THE COMPRESSED LOG IS A STACK OF FRAMES, NOT ONE STREAM. dsh appends one independent, checksummed
// Zstandard frame per durable batch, after a first frame that holds only the header row, and every
// frame holds whole JSONL rows. Two consequences shape this file:
//  - A frame boundary is a row boundary, so a byte offset at the end of a frame is a cursor exactly
//    like a newline is for a plain log. The live read resumes there and decodes only the new frames.
//  - The frames can be FOUND without being decoded: the scan below walks frame and block headers
//    only. So a tail read decodes the newest frames and stops, rather than inflating the whole log
//    to throw most of it away. A torn final frame (dsh still writing it) is left for the next read,
//    the same rule `readSinceFile` applies to a torn final line.
// Node's one-shot decoder stops after the first frame of a concatenation, which is the other reason
// each frame is decoded on its own.

import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { decodeCursor, encodeCursor, type Cursor, type ReadSince } from "./cursor.ts";
import {
  CATCH_UP_BYTES,
  containedRealpath,
  FIRST_TAIL_BYTES,
  loadTail,
  MAX_FRAME_OUTPUT_BYTES,
  MAX_TRANSCRIPT_BYTES,
  readSinceFile,
  rootList,
  statFile,
} from "./files.ts";
import type { AgentSessionRef, TranscriptSource } from "./types.ts";

// A session ID becomes a path component, so only a plain name is accepted. dsh names sessions with a
// UUID, or `session-<uuid>` for older ones; nothing here relies on either shape.
const DSH_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether `name` may be a session ID: a plain name, safe as one path component. */
export function isDshSessionId(name: string): boolean {
  return DSH_SESSION_ID.test(name);
}

/** The kernel lock dsh's session writer holds with flock(2); it lives in the session folder. */
export const DSH_LOCK_NAME = "session.lock";

/** A log file's name: its generation and whether it is compressed. */
const LOG_NAME = /^session(?:\.v(\d{1,4}))?\.jsonl(\.zstd)?$/;

/** The generation a log file name carries (the unversioned name is generation 0), or null for any other file. */
function generationOf(name: string): number | null {
  const match = LOG_NAME.exec(name);
  if (match === null) return null;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/** Whether a log path is a compressed one. Everything else here is plain JSONL. */
function compressed(path: string): boolean {
  return path.endsWith(".zstd");
}

/** The session ID a log path belongs to, or null when the path is not a session log. */
export function dshSessionIdOf(log: string): string | null {
  if (generationOf(basename(log)) === null) return null;
  const id = basename(dirname(log));
  return isDshSessionId(id) ? id : null;
}

/** The highest-generation log in a session folder, or null when it holds none. */
export async function newestLog(folder: string): Promise<string | null> {
  let best: { name: string; generation: number } | null = null;
  for (const name of await readdir(folder).catch(() => [])) {
    const generation = generationOf(name);
    if (generation !== null && (best === null || generation > best.generation)) best = { name, generation };
  }
  return best === null ? null : join(folder, best.name);
}

// ── Frames ───────────────────────────────────────────────────────────────────

const ZSTD_MAGIC = 0xfd2fb528;

/** One complete frame's byte range, end exclusive. */
interface Frame {
  readonly start: number;
  readonly end: number;
}

/**
 * The complete frames in `bytes`, found from their headers alone, and where a torn final frame
 * starts (or `bytes.length` when there is none). Null when the bytes are not a frame stack at all:
 * a wrong magic or a reserved bit, which a reader treats as "start over" rather than as rows.
 */
export function scanFrames(bytes: Uint8Array): { frames: Frame[]; complete: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Frame[] = [];
  let at = 0;
  const torn = { frames, complete: 0 };
  while (at < bytes.length) {
    const start = at;
    torn.complete = start;
    if (bytes.length - at < 5) return torn;
    if (view.getUint32(at, true) !== ZSTD_MAGIC) return null;
    const descriptor = view.getUint8(at + 4);
    at += 5;
    if ((descriptor & 0x18) !== 0) return null;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const dictionaryFlag = descriptor & 3;
    at += (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag);
    at += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    for (;;) {
      if (bytes.length - at < 3) return torn;
      const header = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
      at += 3;
      const type = (header >>> 1) & 3;
      if (type === 3) return null;
      // An RLE block stores one byte, whatever size it expands to.
      at += type === 1 ? 1 : header >>> 3;
      if (at > bytes.length) return torn;
      if ((header & 1) !== 0) break;
    }
    if ((descriptor & 4) !== 0) at += 4;
    if (at > bytes.length) return torn;
    frames.push({ start, end: at });
  }
  return { frames, complete: at };
}

/**
 * The rows one frame holds, or null when it does not decode (its checksum or its blocks are wrong)
 * or expands past `limit` bytes. Never throws.
 */
export function frameRows(bytes: Uint8Array, frame: Frame, limit: number = MAX_FRAME_OUTPUT_BYTES): string[] | null {
  try {
    const text = new TextDecoder().decode(
      zstdDecompressSync(bytes.subarray(frame.start, frame.end), { maxOutputLength: limit }),
    );
    return text.split("\n").filter((row) => row !== "");
  } catch {
    return null;
  }
}

/** The rows a tail read decoded, and whether the log's first frame was among them. */
interface TailRows {
  readonly rows: string[];
  readonly fromStart: boolean;
}

/**
 * The rows of the newest frames, decoded back from the last one until `budget` characters are
 * held, oldest first. `fromStart` says the first frame was among them. A frame that does not decode
 * ends the walk there: rows before damage are never stitched to rows after it.
 */
function tailRows(bytes: Uint8Array, frames: readonly Frame[], budget: number): TailRows {
  const chunks: string[][] = [];
  let held = 0;
  let first = frames.length;
  for (let index = frames.length - 1; index >= 0 && held < budget; index -= 1) {
    const frame = frames[index];
    const rows = frame === undefined ? null : frameRows(bytes, frame);
    if (rows === null) break;
    chunks.push(rows);
    held += rows.reduce((sum, row) => sum + row.length + 1, 0);
    first = index;
  }
  return { rows: chunks.toReversed().flat(), fromStart: first === 0 };
}

/** The whole compressed log, or null when it is gone or larger than any log a reader should hold. */
async function readCompressed(path: string): Promise<Uint8Array | null> {
  const st = await statFile(path);
  if (st === null || st.size > MAX_TRANSCRIPT_BYTES) return null;
  return Bun.file(path).bytes().catch(() => null);
}

/** `loadTail` for a compressed log: the newest rows under the journal's cap. */
async function loadFrames(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
  const st = await statFile(path);
  const bytes = await readCompressed(path);
  const scan = bytes === null ? null : scanFrames(bytes);
  if (st === null || bytes === null || scan === null) {
    return { text: "", complete: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
  }
  const { rows, fromStart } = tailRows(bytes, scan.frames, MAX_TRANSCRIPT_BYTES);
  return { text: rows.join("\n"), complete: fromStart, size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * `readSinceFile` for a compressed log. The cursor is a byte offset at a frame boundary, under the
 * same `bytes` tag and the same rules: an unusable, foreign or overtaken cursor, or one left more than
 * the catch-up bound behind, resets to a tail; a torn final frame holds the position.
 */
async function readSinceFrames(path: string, cursor: Cursor): Promise<ReadSince> {
  const st = await statFile(path);
  if (st === null) return { lines: [], cursor, reset: false, fromStart: false };
  const at = decodeCursor(cursor, "bytes", path);
  if (at !== null && at <= st.size && st.size - at <= CATCH_UP_BYTES) {
    if (at === st.size) return { lines: [], cursor, reset: false, fromStart: false };
    const bytes = new Uint8Array(await Bun.file(path).slice(at, st.size).arrayBuffer());
    const scan = scanFrames(bytes);
    if (scan !== null) {
      const lines: string[] = [];
      let end = at;
      for (const frame of scan.frames) {
        const rows = frameRows(bytes, frame);
        if (rows === null) break;
        lines.push(...rows);
        end = at + frame.end;
      }
      return { lines, cursor: encodeCursor("bytes", path, end), reset: false, fromStart: false };
    }
    // Not a frame boundary any more: the log was rewritten under the same name. Start over.
  }
  const bytes = await readCompressed(path);
  const scan = bytes === null ? null : scanFrames(bytes);
  if (bytes === null || scan === null) return { lines: [], cursor: encodeCursor("bytes", path, st.size), reset: true, fromStart: false };
  const { rows, fromStart } = tailRows(bytes, scan.frames, FIRST_TAIL_BYTES);
  return { lines: rows, cursor: encodeCursor("bytes", path, scan.complete), reset: true, fromStart };
}

// ── The source ───────────────────────────────────────────────────────────────

/** The dsh journal's source: resolves a session ID to its newest log and reads either encoding. */
export class DshTranscriptSource implements TranscriptSource {
  // Session ID to the session folder resolve last found, with its root. The log inside it is chosen
  // again on every resolve, because dsh publishes a new generation beside the old one.
  private readonly folderCache = new Map<string, { folder: string; root: string }>();
  readonly roots: readonly string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isDshSessionId(ref.value)) return null;
    const cached = this.folderCache.get(ref.value);
    if (cached !== undefined) {
      const hit = await logIn(cached.folder, cached.root);
      if (hit !== null) return hit;
      this.folderCache.delete(ref.value);
    }
    for (const root of this.roots) {
      for (const project of await readdir(root).catch(() => [])) {
        const folder = join(root, project, ref.value);
        const hit = await logIn(folder, root);
        if (hit === null) continue;
        this.folderCache.set(ref.value, { folder, root });
        return hit;
      }
    }
    return null;
  }

  stat = statFile;

  load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    return compressed(path) ? loadFrames(path) : loadTail(path);
  }

  readSince(path: string, cursor: Cursor): Promise<ReadSince> {
    return compressed(path) ? readSinceFrames(path, cursor) : readSinceFile(path, cursor);
  }
}

/** The real path of the newest log in a session folder, when it is inside `root`. */
async function logIn(folder: string, root: string): Promise<string | null> {
  const log = await newestLog(folder);
  return log === null ? null : containedRealpath(log, root);
}
