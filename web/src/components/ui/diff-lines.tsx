import { useLayoutEffect, useRef, useState } from "react";

import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

// A FEW LINES OF A DIFF, AS ONE BLOCK (2026-11-10). A line that starts with `+` is added, `-` removed,
// `@@` a hunk's head; any other line is context. The tints and the sign inks are the ones the Changes
// view and Chat's diff card draw with (`bg-status-done/12`, `bg-status-blocked/12`, the sign in its
// status ink, a minus drawn as `−`), so a diff reads the same wherever Collie shows one. Those two still
// carry their own copy of the table; a third place takes it from here.
//
// MONO, AND NEVER WIDER THAN ITS COLUMN. A long line is not wrapped (a diff is read column by column):
// the block scrolls sideways inside its own frame, and every row is as wide as the widest, so a tint
// runs under the whole line. The page never overflows. Owns no words: `file`, when given, is the
// caller's, drawn small over the lines.
//
// SOFT WRAP ON A DECISION'S CARD (review 7 R2). With `wrap` (a Decision's view, where code is read before
// a yes) nothing scrolls sideways: a line longer than the block's columns goes on in the rows after it,
// and each of those rows shows {@link DIFF_WRAP_MARK} in the sign column, drawn by Collie and never part of
// the code, so a person sees where a line goes on and no code sits out of sight. The columns are measured
// from the block's width and the width of one mono character; before the first measure (and in jsdom)
// the text wraps anywhere by CSS alone.

/** The mark at the start of a row that goes on with the line above it: the one a group's card uses (bridge/tricks/card-group.ts). */
export const DIFF_WRAP_MARK = "↪";

/** The rows one line takes in `cols` columns: its text cut into pieces of at most `cols` characters. */
export function wrapPieces(text: string, cols: number): string[] {
  const chars = [...text];
  if (cols < 1 || chars.length <= cols) return [text];
  const pieces: string[] = [];
  for (let at = 0; at < chars.length; at += cols) pieces.push(chars.slice(at, at + cols).join(""));
  return pieces;
}

/** The columns of mono text a wrapping block holds, or 0 before it was measured. */
function useColumns(on: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [cols, setCols] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    const one = probe.current;
    if (!on || el === null || one === null) return;
    const measure = () => {
      const ch = one.getBoundingClientRect().width / 10;
      // The sign column (2ch) and the row's padding (pl-1, pr-3) are not the text's.
      const width = el.clientWidth - 16;
      setCols(ch > 0 && width > 0 ? Math.max(8, Math.floor(width / ch) - 2) : 0);
    };
    measure();
    if (!hasResizeObserver()) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  return { box, probe, cols };
}

/** What a line of a diff is, by its first characters. */
export type DiffLineKind = "add" | "del" | "hunk" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** The row tint per kind: the Changes view's own. */
export const DIFF_ROW_TONE = { add: "bg-status-done/12", del: "bg-status-blocked/12", hunk: "bg-muted/60 text-muted-foreground", context: "" } as const satisfies Record<DiffLineKind, string>;
/** The sign's ink per kind. */
export const DIFF_SIGN_TONE = { add: "text-status-done", del: "text-status-blocked", hunk: "", context: "" } as const satisfies Record<DiffLineKind, string>;
/** One line's height, in rem: the block reserves its lines from this (`leading-5`). */
export const DIFF_LINE_REM = 1.25;

export function DiffLines({ lines, file, className, wrap = false }: { lines: readonly string[]; file?: string; className?: string; wrap?: boolean }) {
  const { box, probe, cols } = useColumns(wrap);
  return (
    <div data-slot="diff-lines" data-wrap={wrap ? "" : undefined} className={cn("min-w-0 overflow-hidden rounded-sm border border-border font-mono text-xs leading-5 [font-variant-ligatures:none]", className)}>
      {file !== undefined && (
        <div data-slot="diff-lines-file" title={file} className="truncate border-b border-border px-3 text-[11px] text-muted-foreground">
          {file}
        </div>
      )}
      {wrap ? (
        <div ref={box} className="relative min-w-0">
          <span ref={probe} aria-hidden className="invisible absolute whitespace-pre">
            0000000000
          </span>
          {lines.map((line, i) => (
            <WrappedLine key={i} line={line} cols={cols} />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto overflow-y-hidden overscroll-x-contain">
          <div className="w-max min-w-full">
            {lines.map((line, i) => {
              const kind = diffLineKind(line);
              const signed = kind === "add" || kind === "del";
              return (
                <div key={i} data-diff-line={kind} className={cn("flex h-5 pr-3", signed ? "pl-1" : "pl-3", DIFF_ROW_TONE[kind])}>
                  {signed && (
                    <span aria-hidden className={cn("w-[2ch] shrink-0 text-center select-none", DIFF_SIGN_TONE[kind])}>
                      {kind === "del" ? "−" : "+"}
                    </span>
                  )}
                  {/* The sign is read out as the line's first character; the glyph beside it is for the eye. */}
                  <span className="whitespace-pre">
                    {signed && <span className="sr-only">{line.charAt(0)}</span>}
                    {(signed ? line.slice(1) : line) || " "}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One line of a wrapping block: its first row with the sign, then one row per piece that goes on, each
 * with {@link DIFF_WRAP_MARK} in the sign column. Every row keeps the line's tint. A screen reader reads
 * the line once, whole.
 */
function WrappedLine({ line, cols }: { line: string; cols: number }) {
  const kind = diffLineKind(line);
  const signed = kind === "add" || kind === "del";
  const text = signed ? line.slice(1) : line;
  const pieces = wrapPieces(text, cols);
  return (
    <div data-diff-line={kind} className={DIFF_ROW_TONE[kind]}>
      <span className="sr-only">{line}</span>
      {pieces.map((piece, i) => (
        <div key={i} aria-hidden data-diff-wrap={i > 0 ? "" : undefined} className="flex min-h-5 pr-3 pl-1">
          <span className={cn("w-[2ch] shrink-0 text-center select-none", i > 0 ? "text-muted-foreground" : DIFF_SIGN_TONE[kind])}>
            {i > 0 ? DIFF_WRAP_MARK : kind === "del" ? "−" : kind === "add" ? "+" : ""}
          </span>
          <span className="min-w-0 break-all whitespace-pre-wrap">{piece || " "}</span>
        </div>
      ))}
    </div>
  );
}
