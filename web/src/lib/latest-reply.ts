// Deciding whether the newest reply in the agent's journal is the one on the mirror, and whether the
// mirror is showing all of it.
//
// WHY THIS EXISTS. A Claude pane runs on the terminal's alternate screen, which keeps no scrollback
// ring, so `pane.read` can only ever hand back the visible viewport — a reply longer than the pane is
// tall has its opening simply gone, and the only copy that still exists is the agent's own session log
// (bridge/journal/, GET /api/pane/:id/history). Reaching it used to mean leaving the pane for the
// history route. locateReply lets the pane view put the full message back in place instead —
// including WHERE the clipped rows end, so the card replaces them rather than printing them twice.
//
// This is NOT a step toward rendering the terminal from the journal, and it must not become one: the
// mirror stays the mirror (ADR 0008), and nothing here synthesises scrollback. All it answers is "is
// the start of the message on screen, and if not, is this even the message on screen".
//
// THE NORMALISATION IS THE WHOLE TRICK. Both sides describe the same prose in different notations:
// the journal holds Markdown source (`**bold**`, `- bullet`, one logical line per paragraph), while
// the mirror holds what Claude's renderer painted (emphasis turned into SGR runs, bullets possibly
// re-glyphed, an `⏺` prefix, and every paragraph hard-wrapped at the pane width with indentation on
// the continuation rows). Folding both to LETTERS AND DIGITS ONLY — dropping whitespace along with
// punctuation — collapses every one of those differences at once. Wrapping is the case that makes it
// necessary rather than merely convenient: the mirror breaks a paragraph wherever the pane width
// falls, the journal breaks it nowhere, and only deleting the spaces makes the two comparable
// (`hello\n  world` and `hello world` both fold to `helloworld`).
//
// Escapes must go BEFORE the fold: `\x1b[38;5;1m` is mostly digits, and digits survive folding, so an
// un-stripped SGR run would inject garbage into the middle of a probe. parseAnsi is the repo's one
// place that knows escape shapes — use it rather than a second regex that can drift from it.

import { parseAnsi } from "./ansi";
import type { TranscriptEntry } from "./types";

/**
 * How much of the reply each probe compares, in folded characters.
 *
 * Long enough that a coincidental match is not a real risk (48 letters of prose is a sentence), short
 * enough to sit inside the first and last rendered lines of a message.
 */
export const PROBE_CHARS = 48;

/** Where the newest reply sits relative to what the mirror is showing. */
export type ReplyFit =
  /** Its tail is on screen but its opening has scrolled off — the case worth surfacing. */
  | "clipped"
  /** All of it is on screen (or it is too short to be worth the machinery). */
  | "whole"
  /** Not the message the mirror is showing at all — see the note on {@link locateReply}. */
  | "off-screen";

/** Keep letters and digits, lose everything else. Unicode-aware, so a non-Latin reply still folds to
 *  its own content rather than to nothing. */
export function fold(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Plain text of a mirror read: the ANSI parse, reassembled. Newlines live inside the segments, so
 *  joining with "" reproduces the screen exactly — and the fold then removes them anyway. */
function plain(mirrorText: string): string {
  return parseAnsi(mirrorText)
    .map((segment) => segment.text)
    .join("");
}

/** A turn's prose — its `text` parts only. Thinking is not the reply, and a tool call is not speech. */
export function replyProse(entry: TranscriptEntry): string {
  return entry.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** True when the bridge capped one of those parts (MAX_TEXT_CHARS), so what we hold is not the end. */
function proseTruncated(entry: TranscriptEntry): boolean {
  return entry.parts.some((part) => part.kind === "text" && part.truncated === true);
}

/** The newest turn that is the agent SPEAKING — the last assistant entry carrying prose. */
export function newestReply(entries: TranscriptEntry[]): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.role === "assistant" && replyProse(entry) !== "") return entry;
  }
  return null;
}

/** Where a turn sits on the mirror, and — when it is clipped — which row it ends on. */
export interface ReplyPlacement {
  fit: ReplyFit;
  /** Index of the last mirror row the reply occupies. Only meaningful when `fit` is `clipped`. */
  endLine: number;
}

/** A verdict with no rows to replace — every fit but `clipped` ends here. */
const elsewhere = (fit: ReplyFit): ReplyPlacement => ({ fit, endLine: -1 });

/**
 * Locate a journal turn on the mirror.
 *
 * Two probes, and the ORDER OF THE VERDICTS matters more than either of them:
 *
 * - The **tail** probe is the identity check. The journal's newest reply is not necessarily the one
 *   on screen — the log lags a message that is still streaming, the operator may have frozen the
 *   mirror by scrolling, and a >20 000-character part reaches us clamped so its real ending never
 *   arrives. When the tail is missing we answer `off-screen` and the caller shows NOTHING. Presenting
 *   an older message as "the reply you are looking at" is the one failure this must not have.
 * - The **head** probe then answers the actual question: is its opening still on the screen.
 *
 * A reply shorter than two probes is `whole` by construction — it cannot be meaningfully clipped, and
 * overlapping probes would compare a string against itself.
 *
 * `endLine` exists so the caller can REPLACE those rows with the full message rather than print it
 * twice. Folding erases the row boundaries, so the row that the reply ends on is recovered by keeping
 * each row's cumulative folded length and finding the first that reaches the tail probe's end.
 */
export function locateReply(mirrorText: string, entry: TranscriptEntry): ReplyPlacement {
  const reply = fold(replyProse(entry));
  if (reply.length < PROBE_CHARS * 2) return elsewhere("whole");
  if (proseTruncated(entry)) return elsewhere("off-screen");

  const rows = plain(mirrorText).split("\n");
  // Folding each row and concatenating is the same string as folding the whole screen — the fold
  // drops the separators either way — so these offsets index into one folded mirror.
  const rowEnds: number[] = [];
  let mirror = "";
  for (const row of rows) {
    mirror += fold(row);
    rowEnds.push(mirror.length);
  }

  const tail = reply.slice(-PROBE_CHARS);
  const at = mirror.indexOf(tail);
  if (at === -1) return elsewhere("off-screen");
  if (mirror.includes(reply.slice(0, PROBE_CHARS))) return elsewhere("whole");

  const end = at + tail.length;
  const endLine = rowEnds.findIndex((rowEnd) => rowEnd >= end);
  return { fit: "clipped", endLine: endLine === -1 ? rows.length - 1 : endLine };
}
