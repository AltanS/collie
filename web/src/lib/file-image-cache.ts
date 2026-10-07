import type { FileImageAnswer } from "@/lib/api";
import { getDeviceToken, subscribePairing } from "@/lib/pairing";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { onWipe } from "@/lib/wipe";

// ── PICTURES THE FILES SCREEN HOLDS (ADR 0090, amended 2026-10-07) ─────────────────────────────────
//
// Opening the same picture twice used to download it twice: the bridge answers `no-store`, and the
// phone made an object URL per view and revoked it. This module holds the BYTES of the pictures the
// Files screen has drawn, so the second open of the same file draws at once and asks for nothing.
//
// IN MEMORY, NEVER PERSISTED. The table below lives in this page's heap and nowhere else: not
// IndexedDB, not Cache Storage, not localStorage, not the service worker. M46 decided that file
// contents leave no copy on the phone beyond the page's life, and a reload, a closed tab and a wipe
// all empty it. The wipe routine clears it (`onWipe`), and so does a new token: bytes fetched under
// one pairing are not shown under another.
//
// WHAT IT HOLDS IS A BLOB, NOT AN OBJECT URL. Each view makes its own URL from the blob and revokes it
// when it goes (components/file-preview.tsx `useObjectUrl`). A URL held here would have to be revoked
// when its entry is evicted, while a screen may still be drawing it, and a second view could be
// handed a URL the first one already revoked. A Blob has no such lifetime: it is plain memory the
// table frees by dropping it.
//
// THE KEY IS THE FILE AND ITS VERSION. A picture changes under one path, so the key carries the
// version: machine, session and pane or workspace, the root-relative path, and the file's size and
// mtime (`fileVersionOf`). A changed file has a new key and misses. A caller that has no version
// (an older bridge sends no mtime) is not held at all.
//
// BOUNDED TWICE: 32 pictures and 64 MiB, whichever is hit first. The oldest-used goes first; a hit
// counts as a use. A picture is 16 MiB at most (the bridge's cap), so four of the biggest fill it.

/** The most pictures held at once. */
export const MAX_HELD_IMAGES = 32;

/** The most bytes held at once, summed over the pictures' sizes. */
export const MAX_HELD_BYTES = 64 * 1024 * 1024;

interface Held {
  /** The pane or workspace the picture was read for, so a refresh of that screen can drop its share. */
  subject: string;
  blob: Blob;
}

/** Insertion order is use order: a hit moves its entry to the end, and the front is evicted first. */
const held = new Map<string, Held>();
let heldBytes = 0;

/**
 * A file's version: its size and modification time joined. The text read gives the two as fields and
 * the image read as headers; both spell the number the way JavaScript prints it, so the strings agree.
 * Null when either is missing, and then nothing is held.
 */
export function fileVersionOf(size: number | string | null | undefined, mtimeMs: number | string | null | undefined): string | null {
  if (size === null || size === undefined || mtimeMs === null || mtimeMs === undefined) return null;
  return `${String(size)}:${String(mtimeMs)}`;
}

/**
 * The table's name for the pane or workspace a Files screen belongs to. `target` is the route's own
 * (`pane:<id>` or `space:<id>`), so a pane and a workspace never share a subject.
 */
export function imageSubject(scope: Scope | undefined, target: string): string {
  return paneScopeKey(scope, target);
}

function keyOf(subject: string, path: string, version: string): string {
  return JSON.stringify([subject, path, version]);
}

function evictOldest(): void {
  const oldest = held.entries().next();
  if (oldest.done) return;
  const [key, entry] = oldest.value;
  held.delete(key);
  heldBytes -= entry.blob.size;
}

function hold(subject: string, path: string, version: string, blob: Blob): void {
  if (blob.size > MAX_HELD_BYTES) return;
  const key = keyOf(subject, path, version);
  const old = held.get(key);
  if (old !== undefined) {
    held.delete(key);
    heldBytes -= old.blob.size;
  }
  held.set(key, { subject, blob });
  heldBytes += blob.size;
  while (held.size > MAX_HELD_IMAGES || heldBytes > MAX_HELD_BYTES) evictOldest();
}

function hit(subject: string, path: string, version: string): Blob | null {
  const key = keyOf(subject, path, version);
  const entry = held.get(key);
  if (entry === undefined) return null;
  held.delete(key);
  held.set(key, entry);
  return entry.blob;
}

/**
 * What a held read asks for. `tag` is the version the key carries. `own` says the tag is THIS file's
 * size and mtime: then a version the bridge sent with the bytes that disagrees means the file changed
 * between the text read and the image read, and the bytes are not held under the older tag. A Markdown
 * picture is keyed on its Markdown file's version, which the picture's own headers cannot be compared
 * with, so it is `own: false`.
 */
export interface ImageVersion {
  tag: string;
  own: boolean;
}

/**
 * One picture, from the table when it holds this file at this version, else from `fetch`, which is
 * then held if it came back as a picture. A refusal, a failed read and a body that is not an image
 * are returned and NOT held, so asking again asks the bridge again. With no `version` it is a plain
 * `fetch`.
 */
export async function heldImage(
  subject: string,
  path: string,
  version: ImageVersion | null,
  fetch: () => Promise<FileImageAnswer>,
): Promise<FileImageAnswer> {
  if (version === null) return fetch();
  const blob = hit(subject, path, version.tag);
  if (blob !== null) return { outcome: "image", blob };
  const answer = await fetch();
  if (answer.outcome !== "image" || !answer.blob.type.startsWith("image/")) return answer;
  const changed = version.own && answer.version !== undefined && answer.version !== version.tag;
  if (!changed) hold(subject, path, version.tag, answer.blob);
  return answer;
}

/** Drop what one pane or workspace holds. The Files screen's refresh button calls it, then reads again. */
export function dropHeldImages(subject: string): void {
  for (const [key, entry] of held) {
    if (entry.subject !== subject) continue;
    held.delete(key);
    heldBytes -= entry.blob.size;
  }
}

/** Drop everything. The wipe, and a new token. */
export function clearHeldImages(): void {
  held.clear();
  heldBytes = 0;
}

/** Test seam: how many pictures and bytes are held. */
export function __heldImages() {
  return { count: held.size, bytes: heldBytes };
}

// A picture fetched under one token is not shown under another. A wipe clears the table (below), and
// so does a fresh pairing, which the wipe does not cover: it sets a token without ending one first.
let tokenSeen = getDeviceToken();
subscribePairing(() => {
  const now = getDeviceToken();
  if (now === tokenSeen) return;
  tokenSeen = now;
  clearHeldImages();
});

/**
 * Every wipe empties the table, a password prompt's too: the prompt's wipe is about one pane, but a
 * held picture names its folder rather than its pane, and the table is cheap to refill.
 */
function registerImageWipe(): void {
  onWipe("file-images", () => clearHeldImages());
}

registerImageWipe();

/** Test seam: put the wipe hook back after a test emptied the wipe's registry. */
export function __registerImageWipe(): void {
  registerImageWipe();
}
