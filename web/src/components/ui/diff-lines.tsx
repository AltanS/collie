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

export function DiffLines({ lines, file, className }: { lines: readonly string[]; file?: string; className?: string }) {
  return (
    <div data-slot="diff-lines" className={cn("min-w-0 overflow-hidden rounded-sm border border-border font-mono text-xs leading-5 [font-variant-ligatures:none]", className)}>
      {file !== undefined && (
        <div data-slot="diff-lines-file" title={file} className="truncate border-b border-border px-3 text-[11px] text-muted-foreground">
          {file}
        </div>
      )}
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
    </div>
  );
}
