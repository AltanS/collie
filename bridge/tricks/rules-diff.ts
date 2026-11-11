import type { TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import type { ChangedFile } from "./version-diff.ts";

// THE RULES OF AN AGENT VIEW, AS A WHOLE DIFF (contract 2). A trick's rules are the instructions its author
// gives the person's agents. When a new version changes them, the "new version" card shows the change WHOLE:
// every line of the new text and every line taken out, never cut, never masked, never "not shown". So the
// diff is made here from the two texts the folder reader already holds (discover.ts `readRulesFile`), not
// from git: git's output passes the screen mask (version-diff.ts), and a masked line would not be the bytes
// the agent reads. The content rule keeps both texts to printable ASCII and `\n`, at most 8 KiB, lines of at
// most 160 characters, so every row fits a diff row of the card as it is.
//
// The rows are a unified diff with the whole file as context: a header, then each line of the old and the
// new text in order, ` ` kept, `-` taken out, `+` put in. The common head and tail are matched first; the
// middle by a longest common subsequence when it is small, else as all out and all in, which is still whole.

/** The most cells of the middle's table before the diff takes the middle as all out and all in. */
export const RULES_DIFF_CELLS_MAX = 1_000_000;

/** The lines of a rules text: split on `\n`, without the empty piece after a final `\n`. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The middle rows: a longest common subsequence when the table is small enough, else all out then all in. */
function middleRows(old: readonly string[], now: readonly string[]): string[] {
  if (old.length * now.length > RULES_DIFF_CELLS_MAX) return [...old.map((line) => `-${line}`), ...now.map((line) => `+${line}`)];
  const cols = now.length + 1;
  // lcs[i][j] is the longest common subsequence of old[i..] and now[j..], one flat table.
  const lcs = new Uint32Array((old.length + 1) * cols);
  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = now.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] = old[i] === now[j] ? (lcs[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * cols + j] ?? 0, lcs[i * cols + j + 1] ?? 0);
    }
  }
  const rows: string[] = [];
  let i = 0;
  let j = 0;
  // Bounded: every pass takes one line of `old` or of `now`.
  while (i < old.length || j < now.length) {
    if (i < old.length && j < now.length && old[i] === now[j]) {
      rows.push(` ${old[i] ?? ""}`);
      i += 1;
      j += 1;
    } else if (j < now.length && (i >= old.length || (lcs[i * cols + j + 1] ?? 0) >= (lcs[(i + 1) * cols + j] ?? 0))) {
      rows.push(`+${now[j] ?? ""}`);
      j += 1;
    } else {
      rows.push(`-${old[i] ?? ""}`);
      i += 1;
    }
  }
  return rows;
}

/** A side of the header: `1,N`, or `0,0` for no lines. */
function range(count: number): string {
  return count === 0 ? "0,0" : `1,${String(count)}`;
}

/** The whole diff of two rules texts as rows, with a header. `old` is null when there were none. */
export function rulesDiffRows(old: string | null, now: string | null): string[] {
  const a = old === null ? [] : linesOf(old);
  const b = now === null ? [] : linesOf(now);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return [
    `@@ -${range(a.length)} +${range(b.length)} @@`,
    ...a.slice(0, head).map((line) => ` ${line}`),
    ...middleRows(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((line) => ` ${line}`),
  ];
}

/**
 * The change of a trick's rules between the approved version and the waiting one, as one changed file whose
 * hunk is the whole diff, or null when the rules did not change (the same bytes, or none on either side).
 * Named after the new rules file, or the old one when the new version has none.
 */
export function rulesChange(base: Pick<TrickManifest, "rules" | "rulesText" | "rulesSha256"> | undefined, next: Pick<TrickManifest, "rules" | "rulesText" | "rulesSha256"> | undefined): ChangedFile | null {
  const old = base?.rules === undefined ? null : (base.rulesText ?? "");
  const now = next?.rules === undefined ? null : (next.rulesText ?? "");
  if (old === now) return null;
  const rel = next?.rules ?? base?.rules ?? "rules.md";
  const hunk = rulesDiffRows(old, now);
  const plus = hunk.filter((row) => row.startsWith("+")).length;
  const minus = hunk.filter((row) => row.startsWith("-")).length;
  return { rel, change: old === null ? "added" : now === null ? "removed" : "changed", plus, minus, hunk };
}
