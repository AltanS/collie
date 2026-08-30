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
//
// A harness may have MORE THAN ONE root (Claude Code's `CLAUDE_CONFIG_DIR` gives a profile its own
// projects tree — see config.ts), which changes nothing about the rule, only how often it is applied:
// a resolved path must lie inside THE ROOT IT WAS RESOLVED THROUGH. For a path an adapter BUILT from
// a root, that is the building root and no other — a candidate that symlinks out of it is skipped
// even if it happens to land inside a sibling root, because the name we followed was that root's. For
// a free-form path ref (pi reports one), no root built it, so any configured root may contain it and
// each is tried in turn ({@link containedRealpathIn}). Both are the same sentence: containment is
// checked per root, never against a union of them.
// A journal is exactly as sensitive as the pane mirror Collie already serves (it is the same
// conversation), but it reaches further back — `COLLIE_TRANSCRIPT=off` disables the feature wholesale.
//
// THE LAW, RESTATED RATHER THAN EXCEPTED. `containedRealpath` is exported and reused outside the
// journal — bridge/operator-fonts.ts serves an operator's own font files under it. That does not
// widen anything, because the rule was never "only the journal touches the disk". The rule is:
//
//   THE JOURNAL IS THE ONLY PLACE A CLIENT-SUPPLIED VALUE BECOMES A PATH.
//
// and even there it is a pane id, never a path. The font surface does not become a second such
// place: `GET /api/fonts/<basename>` LOOKS the request's name UP in the rows the operator's own
// `theme.toml` declared and takes THAT row's path, so a name nobody declared is refused before any
// path exists. Containment then runs anyway, as an independent second check on the real paths. A
// new reader may reuse this function; it may not become a third answer to the sentence above.

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

/**
 * Normalise an adapter's root configuration to the list it searches, in order.
 *
 * Adapters accept a bare string as well as a list purely so a caller with one root (every test
 * fixture, and every deployment that never set a second one) stays unchanged. Empty entries are
 * dropped rather than searched: `""` would resolve relative to the bridge's cwd, which is nobody's
 * journal.
 */
export function rootList(roots: string | readonly string[]): string[] {
  const list = typeof roots === "string" ? [roots] : [...roots];
  return list.map((r) => r.trim()).filter((r) => r !== "");
}

/**
 * First root that really contains `candidate`, or null.
 *
 * ONLY for a path an adapter did not build — a session ref that arrived as a path (pi). Since no root
 * derived the name, the question is simply "does this file live in a journal we serve", and each root
 * answers for itself; the check per root is the same {@link containedRealpath} as everywhere else.
 * Never use this on a path built from a root: there the building root is the only one that may
 * contain it (see the header).
 */
export async function containedRealpathIn(
  candidate: string,
  roots: readonly string[],
): Promise<string | null> {
  for (const root of roots) {
    const real = await containedRealpath(candidate, root);
    if (real !== null) return real;
  }
  return null;
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
