// The filesystem half of the journal, shared by every adapter.
//
// SECURITY. Reading session logs is the journal's only filesystem work, so the path is pinned shut
// here rather than re-argued per harness:
//  - the client never supplies a path — only a pane id, which the route maps to a session ref;
//  - an `id` ref is pattern-validated by its adapter before it is ever concatenated into a path;
//  - a `path` ref (pi reports one) is attacker-shaped by construction — it arrives over the socket
//    from a process we don't control — so it is confined to the harness's own root the same way;
//  - EVERY resolved path is re-checked for containment AFTER symlink resolution, so a log or project
//    directory symlinked out of the root cannot become a way to read arbitrary files;
//  - reads are byte-capped, so a pathological log can't balloon the bridge's memory — twice over
//    since the live read landed: `MAX_TRANSCRIPT_BYTES` bounds a History page, and the smaller
//    `FIRST_TAIL_BYTES` bounds the live window's opening read and every catch-up after a gap.
//
// The live read (`readSinceFile`, at the foot of this file) adds no filesystem surface: it takes
// the path `resolve` already validated, and a cursor whose only power is to name a byte offset
// inside THAT file. A cursor this module refuses costs a reset, never a different file.
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
//   A CLIENT-SUPPLIED VALUE BECOMES A PATH IN TWO PLACES ONLY: THE JOURNAL, AND THE CHANGES VIEW.
//
// In the journal it is a pane id, never a path. The Changes view (bridge/changes.ts, ADR 0065) is
// the second place, and it is bounded by a LISTED-PATHS rule: the client names a repo and a file,
// and both are looked up, never joined blind. The repo must be one the bridge's own discovery under
// the pane's folder returned, and the file one git itself listed as changed there; anything else is
// refused before a path exists. The one file it reads off disk itself (an untracked one) goes
// through `containedRealpath` against the repo's real path as well. The font surface does not become
// a third such place: `GET /api/fonts/<basename>` LOOKS the request's name UP in the rows the
// operator's own `theme.toml` declared and takes THAT row's path, so a name nobody declared is
// refused before any path exists. Containment then runs anyway, as an independent second check on
// the real paths. A new reader may reuse this function; it may not become a third place without an
// ADR that says why and names its bound.

import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

import { type Cursor, decodeCursor, encodeCursor, type ReadSince } from "./cursor.ts";

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
  return tailBytes(path, MAX_TRANSCRIPT_BYTES);
}

/**
 * How much of the tail a cache probe reads. Big enough to hold the last assistant turn even after a
 * few large tool results, small enough to be free — and the same 128 KB window herdr-cache-alert
 * measured against a 3.7 GB transcript directory.
 *
 * It is NOT {@link MAX_TRANSCRIPT_BYTES}: a history read happens when somebody taps History, a cache
 * probe happens on the poll loop, and 32 MB per pane per poll is not a thing to do.
 */
export const CACHE_PROBE_BYTES = 128 * 1024;

/**
 * Tail-read at most `bytes` of a log. {@link loadTail} is this at the journal's own cap.
 *
 * ALWAYS the same window, never a remembered offset. A resume-from-offset read is the right shape for
 * streaming every turn and the wrong shape for asking "what is the newest turn": a poll where nothing
 * new was written would read zero bytes and conclude, wrongly, that there is no turn at all.
 *
 * Over the cap the clipped first line is a partial JSON object; every parser skips unparseable lines
 * by design, so the window simply starts one turn later.
 */
export async function tailBytes(
  path: string,
  bytes: number,
): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
  const st = await stat(path);
  const size = st.size;
  const complete = size <= bytes;
  const file = Bun.file(path);
  const text = complete ? await file.text() : await file.slice(size - bytes).text();
  return { text, complete, size, mtimeMs: st.mtimeMs };
}

// ── The live read ────────────────────────────────────────────────────────────

/**
 * How much of a log a FIRST live read takes, when the caller holds no cursor.
 *
 * NOT {@link MAX_TRANSCRIPT_BYTES}. That 32 MB is the History page's cap, paid once when somebody
 * taps History. This is the live window's opening read, and the sessions measured on 2026-09-29 were
 * 186.8 MB, 89.8 MB and 64.9 MB — so a first read is a tail by design rather than by luck. The
 * turns before it are not lost: they are the History path's job (`store.ts`), which still reads its
 * own larger window on demand.
 */
export const FIRST_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * The same bound for the two harnesses that answer in ROWS rather than bytes.
 *
 * opencode and hermes are SQLite, so their first read is a `limit`, not a byte offset — and the
 * query has to be bounded as well as its answer, or a 10,000-turn session is composed in full to
 * throw most of it away. 400 is deliberately past the 200 turns a History page defaults to
 * (`server.ts` `DEFAULT_HISTORY_LIMIT`), so the live window opens with more than the first page
 * shows.
 */
export const FIRST_TAIL_ROWS = 400;

/**
 * What is new in a log since `cursor` — the live read, beside {@link loadTail}'s whole-window one.
 *
 * Shared by every harness that writes a FILE (claude, codex, pi, grok), which is why it lives here:
 * the byte counting, the bound and the torn-line rule are properties of reading a log, not of any
 * one grammar. The two SQLite harnesses answer the same question in their own language and share
 * nothing with this but the {@link Cursor} codec.
 *
 * THE OFFSET ONLY EVER ADVANCES TO A ROW BOUNDARY. That one rule is what holds a torn final line
 * back without keeping any state outside the cursor: the fragment's bytes are simply read again on
 * the next call, and the row is parsed once, when its newline exists. The prototype's `tailJsonl`
 * carried that fragment in a `rest` variable instead, which works for one file watched by one
 * closure and does not survive a source shared by every pane in the herd.
 *
 * `reset` is returned for five things, and they are one thing: this answer replaces what you hold
 * rather than extending it. No cursor at all, a cursor taken on another path (Claude handed the
 * conversation over to a new log), a cursor past the end (the log was truncated or rewritten), a
 * cursor left so far behind that catching up would mean holding the gap in memory, and a token that
 * cannot be read.
 */
export async function readSinceFile(
  path: string,
  cursor: Cursor,
  firstBytes = FIRST_TAIL_BYTES,
): Promise<ReadSince> {
  const st = await statFile(path);
  // Gone between resolve and read. NOT a reset: blanking a screen because one stat lost a race is a
  // worse answer than showing the turns the caller already has. A log that really went away and came
  // back smaller resets on the next call anyway, through the shrink test below.
  if (st === null) return { lines: [], cursor, reset: false };

  const at = decodeCursor(cursor, "bytes", path);
  // A resume that fell more than one window behind cannot be an append: reading the gap would put
  // tens of megabytes in memory to catch up, which is the one thing a bounded window exists to
  // prevent. It becomes a reset, and the caller replaces its window instead of extending it.
  const behind = at !== null && st.size - at > firstBytes;
  const reset = at === null || at > st.size || behind;
  const from = reset ? Math.max(0, st.size - firstBytes) : at;
  if (from >= st.size) return { lines: [], cursor: encodeCursor("bytes", path, st.size), reset };

  const text = await Bun.file(path).slice(from, st.size).text();
  const end = text.lastIndexOf("\n");
  if (end === -1) {
    // No row boundary in the window at all, which means two different things:
    //  - resuming: we are inside a row the agent is still writing. Hold the position. Its newline
    //    arrives with the next write, and the row is neither parsed nor dropped.
    //  - resetting: the window is the TAIL of one row whose head the bound cut off, so that row can
    //    never be completed from here. Step past it, exactly as `loadTail` drops its clipped head.
    return { lines: [], cursor: encodeCursor("bytes", path, reset ? st.size : from), reset };
  }

  // Everything before the last newline is whole rows; everything after it is the fragment.
  const rows = text.slice(0, end).split("\n");
  // A reset that did not start at byte 0 begins mid-object, because the bound cut the window out of
  // the middle of a row. Every parser skips an unparseable line, but handing one over would put a
  // fragment in the `lines` this function promises never carries one.
  if (reset && from > 0) rows.shift();
  return { lines: rows, cursor: encodeCursor("bytes", path, from + end + 1), reset };
}
