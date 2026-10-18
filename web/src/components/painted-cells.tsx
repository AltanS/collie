import { Fragment } from "react";
import type { ReactNode } from "react";

import { cellPieces } from "@/lib/cell-glyphs";
import { WIDE_RANGES, widePieces } from "@/lib/text-width";

// A plain run → nodes. The Block and Powerline characters whose whole job is to fill their cell are
// painted as boxes rather than typed, because a glyph is an em tall and a cell is taller than that
// (lib/cell-glyphs.ts). Everything else is the same string it was, unwrapped: a run with none of
// those characters — almost every run — allocates nothing and adds no element.
//
// A painted span carries its shape as `data-cell` and nothing else: the paint is one fixed rule per
// shape in index.css, so no style object is built per character on the polling path. Each painted
// character is its own span, because a wrapping mirror can break a run across two lines
// (lib/cell-glyphs.ts).
//
// The characters stay inside the span, so the text nodes the find/link offsets and a clipboard copy
// are defined over are unchanged.
//
// Every <pre> that mirrors pane rows goes through this: the pane mirror (ansi-output.tsx)
// and the raw region under a lifted card (raw-mirror.tsx). Both run at `leading-[1.25]`, so
// both had the step. A row that keeps its columns goes through `renderWideCells` below,
// which ends in this function for every run it has nothing to add to. The status strip and
// the agents footer render segments on their own and are not covered.
export function renderCells(run: string): ReactNode {
  const pieces = cellPieces(run);
  if (pieces === null) return run;
  return pieces.map((p, k) =>
    p.cell === undefined ? (
      <Fragment key={k}>{p.text}</Fragment>
    ) : (
      <span key={k} className="cell-glyph" data-cell={p.cell}>
        {p.text}
      </span>
    ),
  );
}

// The mirror's monospace stack carries no CJK face, so a double-width character falls
// back to a font whose advance is not two ASCII cells, and every wall to its right drifts
// off the column the terminal put it in. `renderWideCells` holds each such character to
// exactly `2ch`, which is two cells of the monospace face, so the walls line up again.
//
// It runs wherever a row keeps its columns: inside a table run, in the pane mirror with
// wrapping off, and in a lifted card's raw view with wrapping off. It does NOT run in
// wrapping prose, because an inline-block per ideograph changes how the line breaks, and
// nothing in prose needs the column back.
//
// `inline-block` is also why `[text-decoration:inherit]` is here: an underline does not
// propagate into an inline-block child, so a link such as `docs/한글.md` would show its
// Hangul bare. Each wide piece draws the decoration of the link around it.
const WIDE_CELL_CLASS = "inline-block w-[2ch] text-center [text-decoration:inherit]";

// Every code point that can start a two-cell cluster, built once from the table
// `widePieces` reads, plus U+FE0F (VS16), which turns a narrow base such as `⚠` or a
// keycap digit into a two-cell emoji. A run with no match holds no wide cluster, so it
// skips `widePieces` and its `Intl.Segmenter` pass. Box drawing, `⏺`, `❯` and `→` are not
// in the table, and a Claude screen carries them on nearly every row, re-rendered on every
// poll. The regex is not global, so `test` keeps no state and allocates nothing.
const hex = (cp: number) => `\\u{${cp.toString(16)}}`;
const MAY_HOLD_WIDE = new RegExp(
  `[${WIDE_RANGES.map(([lo, hi]) => `${hex(lo)}-${hex(hi)}`).join("")}${hex(0xfe0f)}]`,
  "u",
);

/** `renderCells`, with each double-width character held to two cells. A run without one
 *  is handed to `renderCells` as it came: no pieces, no segmenter, no element. */
export function renderWideCells(run: string): ReactNode {
  if (!MAY_HOLD_WIDE.test(run)) return renderCells(run);
  const pieces = widePieces(run);
  if (!pieces.some((p) => p.wide)) return renderCells(run);
  return pieces.map((p, k) =>
    p.wide ? (
      <span key={k} className={WIDE_CELL_CLASS}>
        {p.text}
      </span>
    ) : (
      <Fragment key={k}>{renderCells(p.text)}</Fragment>
    ),
  );
}
