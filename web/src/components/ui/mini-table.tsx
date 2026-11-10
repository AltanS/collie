import { cn } from "@/lib/utils";

// A SMALL TABLE THAT FITS A PHONE (2026-11-10). One to four columns of a few rows, the heads in small
// muted words over a rule, the rows parted by hairlines. It never scrolls sideways: the columns share
// the width (`table-fixed`), a long word breaks where it must, and a cell takes at most two lines, the
// rest cut with an ellipsis and the whole words in its `title`. A column that keeps the end side (a
// column of figures, `align: "end"`) sets its digits in tabular figures, so they line up.
//
// `rowClassName` lets the caller fix each row's height (a place with a fixed band) or leave it to the
// words. Owns no words and no colour: each cell's ink is the caller's `className`.

export interface MiniTableColumn {
  label: string;
  align: "start" | "end";
}

export interface MiniTableCell {
  text: string;
  className?: string;
}

/** A cell's words, clamped to two lines, the whole words in `title`. */
function Clamped({ text }: { text: string }) {
  return (
    <span title={text} className="line-clamp-2 break-words [overflow-wrap:anywhere]">
      {text}
    </span>
  );
}

/** A column's side: the end side sets its digits in tabular figures. */
function align(column: MiniTableColumn | undefined): string {
  return column?.align === "end" ? "text-right tabular-nums" : "text-left";
}

export function MiniTable({ columns, rows, rowClassName, className }: { columns: readonly MiniTableColumn[]; rows: readonly (readonly MiniTableCell[])[]; rowClassName?: string; className?: string }) {
  return (
    <table data-slot="mini-table" className={cn("w-full table-fixed border-collapse text-xs leading-4", className)}>
      <thead>
        <tr className="border-b border-rule">
          {columns.map((column, i) => (
            <th key={i} scope="col" className={cn("px-1.5 pb-1 align-bottom font-normal text-muted-foreground first:pl-0 last:pr-0", align(column))}>
              <Clamped text={column.label} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row, r) => (
          <tr key={r} className={rowClassName}>
            {row.map((cell, c) => (
              <td key={c} className={cn("px-1.5 py-1.5 align-middle font-content first:pl-0 last:pr-0", align(columns[c]), cell.className)}>
                <Clamped text={cell.text} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
