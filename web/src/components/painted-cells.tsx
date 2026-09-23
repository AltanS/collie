import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";

import { cellPieces } from "@/lib/cell-glyphs";

// A plain run → nodes. The Block and Powerline characters whose whole job is to fill their cell are
// painted as boxes rather than typed, because a glyph is an em tall and a cell is taller than that
// (lib/cell-glyphs.ts). Everything else is the same string it was, unwrapped: a run with none of
// those characters — almost every run — allocates nothing and adds no element.
//
// The character stays inside the span, so the text nodes the find/link offsets and a clipboard copy
// are defined over are unchanged.
//
// Every <pre> that mirrors pane rows goes through this: the pane mirror (ansi-output.tsx) and the
// raw region under a lifted card (raw-mirror.tsx). Both run at `leading-[1.25]`, so both had the
// step. The status strip and the agents footer render segments on their own and are not covered.
export function renderCells(run: string): ReactNode {
  const pieces = cellPieces(run);
  if (pieces === null) return run;
  return pieces.map((p, k) => {
    if (p.paint === undefined) return <Fragment key={k}>{p.text}</Fragment>;
    // SAFETY: a CSS custom property is a valid style key at runtime — React passes any `--*` key
    // straight to the CSSOM — and CSSProperties has no index signature for one, so the cast is the
    // only spelling. Same mechanism, and the same reason, as components/mirror-space.ts.
    const style = {
      "--cell-fill": p.paint.fill,
      ...(p.paint.radius === undefined ? null : { "--cell-radius": p.paint.radius }),
    } as CSSProperties;
    return (
      <span key={k} className="cell-glyph" style={style}>
        {p.text}
      </span>
    );
  });
}
