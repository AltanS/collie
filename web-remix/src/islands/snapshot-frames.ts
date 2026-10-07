// The browser half of the snapshot frames (S3; islands/snapshot-wire.ts says what they are and what
// travels). This module is the islands page's SNAPSHOT SOURCE: the beat that reads `/api/snapshot` on
// a static-shell page reads the page URL here instead, takes the snapshot into the same store
// (lib/data.ts `takeSnapshot`), and holds each moved frame's HTML until the runtime asks for it.
//
//   - `pollSnapshotFrames` is the beat's read (the `live` island puts it on the beat).
//   - `resolveSnapshotFrame` is what the runtime gets when such a frame (re)loads (islands/resolver.ts):
//     the held HTML when a beat brought it, else one request for it.
//   - `seedHeld` takes the hashes a document drew its frames with (islands/seed.ts), so the first
//     beat after a document asks with them and an unchanged list moves no bytes.
//
// A page whose answer is not ours (a bridge without the snapshot frames, a proxy's page) falls back to
// the JSON read for the rest of the page's life, and its frames stay as the document drew them.
import type { FrameHandle } from "remix/component";

import type { SnapshotResponse } from "@web/lib/types";

import { getPage } from "../lib/api";
import { loadSnapshot, loadSnapshotWith } from "../lib/data";
import { kick } from "../lib/polling";
import {
  encodeHeld,
  isSnapshotFrameName,
  parseSnapshotAnswer,
  RANKS_HEADER,
  SNAP_HEADER,
  SNAPSHOT_ANSWER,
  type SnapshotFrameName,
} from "./snapshot-wire";

export { isSnapshotFrameName };

/** The response header of the frame route (routes/pane/frames.ts `FRAME_ANSWER_HEADER`). */
const FRAME_ANSWER_HEADER = "x-collie-frame";

interface Held {
  hash: string;
  /** The frame's HTML, or null: on screen from a document, not held as text. */
  html: string | null;
}

const held = new Map<SnapshotFrameName, Held>();
/** The hash each frame shows now. */
const shown = new Map<SnapshotFrameName, string>();
let foreign = false;
/** The next beat draws by the server's own order (the operator asked for a new one). */
let skipRanks = false;

export interface SnapshotFramesBinding {
  /** The frame by name, if it is mounted (`handle.frames.get`). */
  frame(name: SnapshotFrameName): FrameHandle | undefined;
  /** The snapshot frames the page shows. */
  names(): readonly SnapshotFrameName[];
  /** The page's own URL (the frames' src), mounted. */
  src(): string;
  /** The row order the page shows (`X-Collie-Ranks`), or null. */
  ranks(): string | null;
}

let binding: SnapshotFramesBinding | null = null;

export function bindSnapshotFrames(next: SnapshotFramesBinding, signal: AbortSignal): void {
  binding = next;
  signal.addEventListener("abort", () => {
    if (binding === next) binding = null;
  });
}

/** A document's frames, as it drew them (islands/seed.ts). Replaces whatever the last page held. */
export function seedHeld(hashes: Readonly<Record<string, string>>): void {
  held.clear();
  shown.clear();
  for (const [name, hash] of Object.entries(hashes)) {
    if (!isSnapshotFrameName(name)) continue;
    held.set(name, { hash, html: null });
    shown.set(name, hash);
  }
}

/** Ask for the frames with the server's own order on the next beat, and run that beat now. */
export function refreshSnapshotFrames(): void {
  skipRanks = true;
  kick();
}

class Foreign extends Error {
  constructor() {
    super("not a snapshot answer");
    this.name = "Foreign";
  }
}

async function request(names: readonly SnapshotFrameName[], signal: AbortSignal | undefined): Promise<SnapshotResponse> {
  const b = binding;
  if (b === null) throw new Foreign();
  const ask = new Map<SnapshotFrameName, string>();
  // A frame is asked for with the hash it shows; one whose HTML a beat holds but the runtime has not
  // taken yet is asked for with that hash (the newer one wins either way).
  for (const name of names) ask.set(name, held.get(name)?.hash ?? "");
  const headers = new Headers({
    Accept: "text/html",
    "X-Remix-Frame": "true",
    "X-Remix-Target": names[0] ?? "home-list",
    [SNAP_HEADER]: encodeHeld(ask),
  });
  const ranks = skipRanks ? null : b.ranks();
  skipRanks = false;
  if (ranks !== null) headers.set(RANKS_HEADER, ranks);
  const res = await getPage(b.src(), headers, signal);
  if (res.headers.get(FRAME_ANSWER_HEADER) !== SNAPSHOT_ANSWER) {
    void res.body?.cancel();
    throw new Foreign();
  }
  const parsed = parseSnapshotAnswer(await res.text());
  if (parsed === null) throw new Foreign();
  for (const part of parsed.frames) held.set(part.name, { hash: part.hash, html: part.html });
  // SAFETY: the snapshot block of the frame route's own answer (header checked above) is the bridge's
  // `SnapshotResponse`, serialised by `snapshotAnswer` from the same body `/api/snapshot` sends.
  return parsed.snapshot as SnapshotResponse;
}

/** Reload every mounted snapshot frame whose held HTML is newer than what it shows. */
function reloadMounted(): void {
  const b = binding;
  if (b === null) return;
  const src = b.src();
  for (const name of b.names()) {
    const entry = held.get(name);
    const frame = b.frame(name);
    if (entry === undefined || entry.html === null || frame === undefined || frame.src !== src) continue;
    if (shown.get(name) === entry.hash) continue;
    void frame.reload().catch(() => shown.delete(name));
  }
}

/** The beat's read on an islands page. Resolves true when the herd changed. */
export async function pollSnapshotFrames(signal: AbortSignal): Promise<boolean> {
  const names = binding?.names() ?? [];
  if (foreign || binding === null || names.length === 0) return loadSnapshot(signal);
  let wasForeign = false;
  const changed = await loadSnapshotWith(async () => {
    try {
      return await request(names, signal);
    } catch (error) {
      if (error instanceof Foreign) wasForeign = true;
      throw error;
    }
  });
  if (wasForeign) {
    foreign = true;
    return loadSnapshot(signal);
  }
  reloadMounted();
  return changed;
}

/** The runtime asks for a snapshot frame's content (islands/resolver.ts). */
export async function resolveSnapshotFrame(_src: string, target: SnapshotFrameName, signal: AbortSignal | undefined): Promise<string> {
  const ready = (): string | null => {
    const entry = held.get(target);
    if (entry === undefined || entry.html === null) return null;
    shown.set(target, entry.hash);
    return entry.html;
  };
  const now = ready();
  if (now !== null) return now;
  if (foreign) return "";
  try {
    held.delete(target);
    await loadSnapshotWith(() => request([target], signal));
  } catch {
    return "";
  }
  return ready() ?? "";
}
