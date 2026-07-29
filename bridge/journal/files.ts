// The filesystem half of the journal, shared by every adapter.
//
// SECURITY. Reading session logs is the only thing in the bridge that touches the filesystem, so the
// path is pinned shut here rather than re-argued per harness:
//  - the client never supplies a path — only a pane id, which the route maps to a session ref;
//  - an `id` ref is pattern-validated by its adapter before it is ever concatenated into a path;
//  - a `path` ref (pi reports one) is attacker-shaped by construction — it arrives over the socket
//    from a process we don't control — so it is confined to the harness's own root the same way;
//  - EVERY resolved path is re-checked for containment AFTER symlink resolution, so a log or project
//    directory symlinked out of the root cannot become a way to read arbitrary files;
//  - reads are byte-capped, so a pathological log can't balloon the bridge's memory.
// A journal is exactly as sensitive as the pane mirror Collie already serves (it is the same
// conversation), but it reaches further back — `COLLIE_TRANSCRIPT=off` disables the feature wholesale.

import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/** Most bytes we will ever pull off one log. Beyond this we keep the TAIL (newest turns). */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024; // 32 MB

/** True when the path exists at all. Cheap pre-check before the more expensive realpath work. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `candidate` and return it only if it is still inside `root` afterwards.
 *
 * The check runs on the REAL paths of both sides, which is the whole point: comparing the strings we
 * were handed would be satisfied by a symlink pointing anywhere. Null means "not ours to read" —
 * callers treat that identically to "no log", so a containment failure is never distinguishable from
 * an absent file by anything the client can see.
 */
export async function containedRealpath(candidate: string, root: string): Promise<string | null> {
  const real = await realpath(candidate).catch(() => null);
  const realRoot = await realpath(root).catch(() => null);
  if (real === null || realRoot === null) return null;
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
}

/** Size + mtime, or null when the file is gone. The store's cache-validity probe (see types.ts). */
export async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** First bytes of a file — enough to identify a log without reading a multi-megabyte one. */
export async function head(path: string, bytes = 64 * 1024): Promise<string> {
  return Bun.file(path).slice(0, bytes).text();
}

/**
 * Tail-read a log under the byte cap. Shared by every adapter's `load` — the cap and the "keep the
 * newest end" policy are properties of the journal, not of any one harness.
 *
 * Over the cap the clipped first line is a partial JSON object; every parser skips unparseable lines
 * by design, so the window simply starts one turn later.
 */
export async function loadTail(
  path: string,
): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
  const st = await stat(path);
  const size = st.size;
  const complete = size <= MAX_TRANSCRIPT_BYTES;
  const file = Bun.file(path);
  const text = complete ? await file.text() : await file.slice(size - MAX_TRANSCRIPT_BYTES).text();
  return { text, complete, size, mtimeMs: st.mtimeMs };
}
