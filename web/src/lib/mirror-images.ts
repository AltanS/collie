// Terminal graphics in the mirror: finding the placeholders, and deciding which image goes where.
//
// ── WHAT THE MIRROR ACTUALLY HOLDS ───────────────────────────────────────────
// Collie runs no terminal emulator (.adr/0008) — `pane.read` hands back the multiplexer's already
// rendered grid. A Kitty-protocol image is not IN that grid: the terminal painted the pixels itself
// and left behind a rectangle of U+10EEEE placeholder cells, each carrying combining diacritics
// that encode the image id and the cell's row/column. So what reaches the phone is a block of
// placeholder characters, which is why the mirror used to show an image as a black box.
//
// ── AND WHY THE MATCH IS BY ORDER, NOT BY ID ─────────────────────────────────
// Those diacritics encode Kitty's own image id. Nothing in the agent's session journal records that
// id — the journal names a blob by its sha-256 — so THERE IS NO MAPPING from a placeholder to a
// file, and this module does not pretend to have one. What it has is order: the journal's images are
// oldest-first, the clusters on screen are top-first, and the newest image is the one at the bottom.
// So the alignment runs from the END. It is an APPROXIMATION and the operator is told so (the
// changelog says it in as many words); a cluster with no image left of it gets a badge rather than a
// repeat, because showing the wrong picture is worse than showing none.

import type { StyledLine } from "./blocks";
import type { TranscriptEntry } from "./types";

/** The Kitty unicode placeholder. One code point, painted once per cell the image covers. */
export const IMAGE_PLACEHOLDER = "\u{10EEEE}";

/**
 * The placeholder plus the combining marks that ride on it.
 *
 * Kitty encodes the image id and the cell's row/column as combining marks on the placeholder, so
 * `\p{Mn}*` takes whatever it attached rather than a hand-listed set of blocks. Blanking is a
 * REPLACEMENT OF EQUAL LENGTH (see {@link blankPlaceholders}), so this is about which characters
 * look like tofu, never about how wide the result is.
 */
const PLACEHOLDER_RUN = /\u{10EEEE}\p{Mn}*/gu;

/** Whether one mirror line carries at least one placeholder cell. */
export function hasImagePlaceholder(line: StyledLine): boolean {
  return line.segments.some((s) => s.text.includes(IMAGE_PLACEHOLDER));
}

/**
 * The same line with every placeholder run turned into spaces of the SAME character count.
 *
 * Equal length is the whole point. Find matches and autolinks are addressed by an offset into the
 * concatenated line text, so dropping a character would slide every coordinate after it; a space
 * costs nothing and keeps that space exact. Returns the line unchanged when it holds none, so the
 * ordinary poll allocates nothing.
 */
export function blankPlaceholders(line: StyledLine): StyledLine {
  if (!hasImagePlaceholder(line)) return line;
  return {
    ...line,
    segments: line.segments.map((s) =>
      s.text.includes(IMAGE_PLACEHOLDER)
        ? { ...s, text: s.text.replace(PLACEHOLDER_RUN, (m) => " ".repeat(m.length)) }
        : s,
    ),
  };
}

/**
 * Whether a line is placeholder-and-whitespace ONLY.
 *
 * A line like that is the image and nothing else, so the card stands in for it. A line that also
 * carries real text keeps that text: an agent printing `Screenshot: <image>` on one row means both
 * halves, and dropping the row would delete the sentence.
 */
export function isPlaceholderOnlyLine(line: StyledLine): boolean {
  if (!hasImagePlaceholder(line)) return false;
  const text = line.segments.map((s) => s.text).join("").replace(PLACEHOLDER_RUN, "");
  return text.trim() === "";
}

/** A run of consecutive placeholder-carrying lines — ONE image, however many cells it covers. */
export interface ImageCluster {
  /** Index of the run's first line within its block. */
  readonly start: number;
  /** Index of the run's last line within its block, inclusive. */
  readonly end: number;
}

/** The placeholder clusters in one block's lines, top-first. */
export function imageClusters(lines: readonly StyledLine[]): ImageCluster[] {
  const clusters: ImageCluster[] = [];
  let li = 0;
  while (li < lines.length) {
    if (!hasImagePlaceholder(lines[li]!)) {
      li++;
      continue;
    }
    const start = li;
    while (li < lines.length && hasImagePlaceholder(lines[li]!)) li++;
    clusters.push({ start, end: li - 1 });
  }
  return clusters;
}

/**
 * Which image belongs to which cluster, aligned FROM THE END.
 *
 * The last cluster on screen takes the most recent image, the one before it takes the one before,
 * and a cluster with nothing left takes `null` — the "[Image]" badge. Never a repeat: an image shown
 * twice is a claim about the screen that the ordering cannot support.
 */
export function alignImagesFromEnd(
  clusterCount: number,
  images: readonly string[],
): (string | null)[] {
  const aligned: (string | null)[] = [];
  for (let i = 0; i < clusterCount; i++) {
    const from = images.length - (clusterCount - i);
    aligned.push(from >= 0 ? images[from]! : null);
  }
  return aligned;
}

/**
 * Every image reference in a page of journal turns, oldest-first, in the order they were written.
 *
 * Both places an image can sit are read: an `image` part (an attachment, or a picture the agent
 * spoke) and a `tool` part's `result.imageUrl` (a screenshot a tool returned). Duplicates are kept,
 * because two identical screenshots ARE two images on the screen.
 */
export function transcriptImages(entries: readonly TranscriptEntry[]): string[] {
  const urls: string[] = [];
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.kind === "image") urls.push(part.url);
      else if (part.kind === "tool" && part.result?.imageUrl) urls.push(part.result.imageUrl);
    }
  }
  return urls;
}
