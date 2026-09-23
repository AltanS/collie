import { Fragment } from "react";
import type { ReactNode } from "react";

import { cellPieces } from "@/lib/cell-glyphs";

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
// Every <pre> that mirrors pane rows goes through this: the pane mirror (ansi-output.tsx) and the
// raw region under a lifted card (raw-mirror.tsx). Both run at `leading-[1.25]`, so both had the
// step. The status strip and the agents footer render segments on their own and are not covered.
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
