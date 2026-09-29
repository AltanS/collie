// ONE unified-diff reader for the whole journal.
//
// Three harnesses hand us a patch as a STRING and want it as hunks plus counts: pi in
// `details.patch`, opencode in `metadata.diff` and in each `metadata.files[].patch`. Claude is the
// exception and needs nothing here, because it writes `structuredPatch` already split into hunks.
//
// This started as two private parsers, written the same afternoon against two different real
// corpora, and they disagreed in three small ways. Merging them keeps the union of what each corpus
// proved, so neither harness lost a case:
//
//  - **Preamble is skipped BY NAME, never by position.** opencode's patches carry an
//    `Index:`/`===`/`---`/`+++` header, and two of those marker lines begin with `-` or `+` while
//    sitting ABOVE the first `@@`. Dropping "everything before the first hunk" would work today and
//    break the day a harness emits a patch with no `@@` at all, so the rule is the line's name.
//  - **A body line may begin with `\`.** That is `\ No newline at end of file`, which pi's corpus
//    carries and which belongs to the hunk above it.
//  - **A marker line with no hunk open still counts.** A patch that never wrote an `@@` is rare and
//    real; it gets one header-less hunk rather than being silently read as empty.
//
// `web/src/lib/unified-diff.ts` is NOT this parser and must not be merged with it. It answers a
// different question: rows with two line-number gutters for the Changes view (ADR 0065). It also
// lives in the client, and the bridge does not import from `web/src`.

import type { Hunk } from "./tool-call.ts";

/** A patch read into the three things a {@link ToolCall} of kind `edit` carries. */
export interface DiffFold {
  hunks: Hunk[];
  added: number;
  removed: number;
}

/** File-header lines that are not body lines, whatever character they start with. */
const PREAMBLE = /^(\+\+\+|---|diff |index |Index:|={3,}|rename (from|to) |new file mode|deleted file mode)/;

/** A hunk body line: context, add, remove, or the no-newline marker. */
const BODY = /^[ +\-\\]/;

/**
 * Read a unified diff into hunks and line counts.
 *
 * PURE. Tolerant by design: a patch reaches us as whatever a harness chose to write, and a clipped
 * or preamble-heavy one must still yield the hunks it does contain rather than throw.
 */
export function parseUnifiedDiff(patch: string): DiffFold {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let added = 0;
  let removed = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (PREAMBLE.test(line)) continue;
    if (!BODY.test(line)) continue;
    if (current === undefined) {
      // Context with nothing to belong to is noise; a marker line is a real change and earns a
      // header-less hunk so the counts stay honest.
      if (line.startsWith(" ") || line.startsWith("\\")) continue;
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    current.lines.push(line);
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }

  return { hunks: hunks.filter((h) => h.lines.length > 0), added, removed };
}
