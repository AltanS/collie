// The height of one diff line, as a plain number. A pure module, so the trick layout (which the
// bridge imports) reads it without pulling in React or a web-only package
// (scripts/bridge-web-imports.test.ts guards that). The diff view, `components/ui/diff-lines.tsx`,
// draws its lines `leading-5`, which is this height.

/** One line's height, in rem: the block reserves its lines from this (`leading-5`). */
export const DIFF_LINE_REM = 1.25;
