import type { StyledLine } from "../../blocks";
import {
  BRIDGE_PROMPT_TAIL_LINES,
  draftGhost,
  draftPlaceholder,
  lineText,
  opensBox,
  rstrip,
} from "./markers";

export interface PiComposer {
  top: number;
  firstDraftRow: number;
  bottom: number;
  suggestEnd: number;
  /**
   * True when the slash palette stands where the statusline would be. omp DROPS the status row for as
   * long as the palette is up, so the run below `bottom` is palette rows rather than a footer, and
   * `extractStatusLines` has nothing to lift.
   */
  palette: boolean;
  layout: "pi";
}

// Captured with OMP 18.1.13, composer.shape=pi (2026-09-07): two coloured
// rules enclose indented draft rows; the status line lives BELOW the editor.
// Match the whole tail, not an arbitrary pair of transcript separators. Unknown
// footer layouts and overlays remain unrecognised rather than authorising Enter —
// with the one exception spelled out below, because that one is the composer's own
// palette and the draft is standing on it.
//
// THE SLASH PALETTE IS THE ONE FOOTER THAT IS NOT A FOOTER, and it is recognised by name rather than
// left to that rule: omp paints the palette BELOW the composer's bottom rule and drops the status row
// for as long as it is up (live capture, omp 18.8.0, 2026-10-07; `omp--v18-8-slash-palette*.txt`):
//
//     ──────────────────────────────────────     ← the composer's top rule
//      /resume                                   ← the filter row: the draft, one space in
//     ──────────────────────────────────────     ← the composer's bottom rule
//     ❯ 🕘 resume       Resume a different…      ← the palette run, where the status row would be
//       📌 pin          Pin or unpin a session…
//
// Recognising it is what lets a slash command SEND at all: the reply guard withholds the submit key
// until it can read the typed text off the screen (lib/reply-action.ts), and on this shape the text
// lives on the filter row, so an unrecognised palette tail stalled every `/…` send with nothing typed
// past it — the exact shape of the 2026-10-07 report. Enter on this screen accepts the highlighted
// entry, which for a typed slash command is that command, verified live (`/resume` + Enter opened the
// Resume Session picker; the boxed-era equivalent is `omp--menu-resume.txt`).
//
// The run is admitted only as a whole: the `❯ `-marked selection row first, then indented entry or
// wrapped-continuation rows, none of them a box. Every overlay omp can put in the composer's place is
// a box at column 0 (markers.ts `opensBox`), so a row that opens one ends the run and the tail then
// fails to reach this composer's bottom rule — a decline, never a keystroke.
export function locatePiComposer(lines: StyledLine[]): PiComposer | null {
  const texts = lines.map((line) => rstrip(lineText(line)));
  let end = texts.length;
  while (end > 0 && texts[end - 1] === "") end--;

  // (a) What is painted below the composer's bottom rule: the palette run, or the statusline (with
  //     pi's own suggestion rows under it).
  const paletteStart = paletteRunStart(texts, end);
  const palette = paletteStart < end;
  let bottom: number;
  if (palette) {
    bottom = paletteStart - 1;
    if (bottom < 2 || !/^─{8,}$/.test(texts[bottom]!)) return null;
  } else {
    bottom = end - 2;
    for (; bottom >= Math.max(0, end - 5); bottom--) {
      if (/^─{8,}$/.test(texts[bottom]!)) break;
    }
    if (bottom < 2 || bottom < end - 5) return null;
    const footer = lines.slice(bottom + 1, end);
    const status = footer[0];
    if (!status || !/^\s+\S/.test(lineText(status))) return null;
    // Status fields are styled and contain the configured separator. A plain
    // transcript following two rules is not evidence of a live editor.
    if (!status.segments.some((s) => s.fg && /[·/|]/.test(s.text))) return null;
    if (footer.some((line) => opensBox(lineText(line)) || !lineText(line).trim())) return null;
    if (footer.slice(1).some((line) => !/^(?:\s+\S|[○●] )/.test(lineText(line)))) return null;
  }

  // (b) …then the draft rows and the top rule, hanging off the bottom one.
  const borderColor = lines[bottom]!.segments.find((s) => s.text.trim())?.fg;
  if (!borderColor) return null;
  let top = bottom - 1;
  for (; top >= Math.max(0, bottom - 101); top--) {
    if (/^─{8,}$/.test(texts[top]!)) break;
    if (texts[top] !== "" && !texts[top]!.startsWith(" ")) return null;
  }
  if (top < 0 || bottom - top > 101 || bottom - top < 2) return null;
  if (texts[top] !== texts[bottom]) return null;
  if (lines[top]!.segments.find((s) => s.text.trim())?.fg !== borderColor) return null;
  return { top, firstDraftRow: top + 1, bottom, suggestEnd: end, palette, layout: "pi" };
}

// An entry row, a wrapped entry's continuation row, or the row omp marks as the selection. The
// selection marker is `❯ ` at column 0; everything else is indented by at least the two-space gutter
// omp reserves for column 0 (markers.ts `opensBox` says why that column is meaningful). A row that is
// nothing but gutter (`                  █`) still carries the scrollbar glyph after its indent, so
// the `\S` floor is what keeps a run of blank padding from joining the palette.
const PALETTE_ROW = /^(?:❯ | {2,})\S/;

/**
 * How many rows the palette run may occupy. omp renders the palette into the viewport — its rows carry
 * a scrollbar column, so the list is a window onto a longer one — which makes its true ceiling the
 * pane's own height; 64 covers the tallest pane this has been captured on with room to spare. The cap
 * is NOT what separates a palette from a modal (`opensBox` is), it bounds how much torn transcript a
 * frame can have eaten before its tail still reads as a composer with a palette under it. Raising it
 * costs only that bound; lowering it is the unsafe direction, because a run that cannot reach the
 * composer's bottom rule makes the locator return null and every reply on that pane refuse for as
 * long as the pane stays that tall.
 */
const MAX_PALETTE_ROWS = 64;

/**
 * Where the palette run starts, or `end` when the tail is not one. The run is the contiguous block of
 * rows reaching the buffer's tail, and it has to be admitted as a whole: the `❯ `-marked selection row
 * opens it, every row after that is an entry or a continuation, and no row opens a box.
 */
function paletteRunStart(texts: string[], end: number): number {
  let start = end;
  while (
    start > 0 &&
    end - start < MAX_PALETTE_ROWS &&
    texts[start - 1] !== "" &&
    !opensBox(texts[start - 1]!) &&
    PALETTE_ROW.test(texts[start - 1]!)
  ) {
    start -= 1;
  }
  return start < end && texts[start]!.startsWith("❯ ") ? start : end;
}

export function piDraft(lines: StyledLine[], box: PiComposer): string | null {
  if (box.bottom - box.firstDraftRow === 1) {
    const row = lines[box.firstDraftRow]!;
    if (draftPlaceholder(row, 1, rstrip(lineText(row)).length)) return null;
  }
  const draft = lines.slice(box.firstDraftRow, box.bottom)
    .map((line, i) => {
      const text = rstrip(lineText(line));
      const ghost = box.firstDraftRow + i === box.bottom - 1 ? draftGhost(line, 1, text.length) : "";
      return text.slice(1, ghost ? text.length - ghost.length : undefined).trimEnd();
    }).join(" ").trim();
  return draft || null;
}

/**
 * The region a destructive write is bound to on this shape: the composer's own rows, top rule through
 * bottom rule. That is the whole of what the sweep is aimed at — the draft rows between them, and the
 * two rules that pin them — where the boxed composer (chrome.ts) names its single `╰─ … ─╯` row.
 *
 * The palette is why this needs a tail check at all. `verifyExpectedPrompt`
 * (bridge/prompt-binding.ts) accepts a binding only when its match ends inside the last
 * `BRIDGE_PROMPT_TAIL_LINES` non-blank rows of the fresh read, and while the palette is up the run
 * below the bottom rule sits between this region and the tail. A run long enough to push the region
 * out of that window would 409 every destructive sweep with "The input box changed while clearing it"
 * — a permanent refusal, on a screen where nothing is wrong. Null instead means an UNBOUND write: the
 * sweep loses its binding, never its pre-flight. chrome.ts declines the same way, for the same
 * palette sitting under its own composer.
 */
export function piComposerPrompt(lines: StyledLine[], box: PiComposer): string | null {
  if (box.suggestEnd - box.bottom - 1 > BRIDGE_PROMPT_TAIL_LINES - 1) return null;
  const region = lines
    .slice(box.top, box.bottom + 1)
    .map((line) => line.segments.map((s) => s.text).join("").trimEnd())
    .join("\n");
  return region.trim().length === 0 ? null : region;
}
