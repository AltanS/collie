// The plain `collie doctor` layout: one pure function, no terminal, no globals. Given a section's
// findings and a width, it returns the lines to print. Nothing is cut. A row that does not fit wraps
// at word boundaries, and a word wider than the whole value column breaks hard at the edge, so no
// line is longer than the width.
//
// The label column is as wide as the longest check id in the section plus 2, so every id keeps at
// least one space before its value however long a check id grows. (A fixed 22 was right until
// `surface-claude-2.1.307` landed, and the value then glued onto the id.)

import type { Finding } from "./finding.ts";

/** The status column: `skipped:` plus one space. */
const STATUS_WIDTH = 9;
/** The two spaces every row starts with. */
const LEAD = 2;
/** Less room than this for the value, and the value moves to its own lines. */
const MIN_VALUE_ROOM = 20;
/** Where a moved value starts. */
const MOVED_INDENT = 4;

/** What the row says about its status: a tick when it passed, the severity word otherwise. */
function statusHead(status: Finding["status"]): string {
  return status === "ok" ? "✓" : `${status}:`;
}

/** The value of a row: the detail, then ` → ` and the remedy when there is one. */
function valueOf(f: Pick<Finding, "detail" | "remedy">): string {
  return f.remedy === null ? f.detail : `${f.detail} → ${f.remedy}`;
}

/** Wrap one break-free text into lines of at most `room` characters. */
function wrapText(text: string, room: number): string[] {
  const width = Math.max(1, room);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (word === "") continue;
    let rest = word;
    if (current !== "") {
      // The word follows on the same line when it fits after one space.
      if (current.length + 1 + rest.length <= width) {
        current += ` ${rest}`;
        continue;
      }
      // It fits a fresh line whole: start one. A longer word fills this line to the edge instead.
      if (rest.length <= width) {
        lines.push(current);
        current = rest;
        continue;
      }
      const space = width - current.length - 1;
      if (space < 1) {
        lines.push(current);
        current = "";
      } else {
        lines.push(`${current} ${rest.slice(0, space)}`);
        rest = rest.slice(space);
        current = "";
      }
    }
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    current = rest;
  }
  if (current !== "") lines.push(current);
  return lines;
}

/**
 * Lay out one section. The value starts at `2 + 9 + label` (label = longest check id + 2), and its
 * next lines start under it. A value that holds `\n` keeps each break and wraps each part. When
 * `columns` leaves less than 20 characters for the value, it starts on the next line at indent 4.
 */
export function layoutFindings(findings: readonly Finding[], columns: number): string[] {
  const label = Math.max(0, ...findings.map((f) => f.check.length)) + 2;
  const valueCol = LEAD + STATUS_WIDTH + label;
  const out: string[] = [];
  for (const f of findings) {
    const prefix = `${" ".repeat(LEAD)}${statusHead(f.status).padEnd(STATUS_WIDTH)}${f.check.padEnd(label)}`;
    const moved = columns - valueCol < MIN_VALUE_ROOM;
    const indent = moved ? MOVED_INDENT : valueCol;
    const pad = " ".repeat(indent);
    const parts = valueOf(f).split("\n");
    const lines = parts.flatMap((part) => {
      const wrapped = wrapText(part, columns - indent);
      return wrapped.length === 0 ? [""] : wrapped;
    });
    if (moved) {
      // The id is never broken. When status column plus id would pass the width, the column goes.
      const padded = prefix.trimEnd();
      out.push(padded.length <= columns ? padded : `${" ".repeat(LEAD)}${statusHead(f.status)} ${f.check}`);
      for (const l of lines) out.push(l === "" ? "" : `${pad}${l}`);
      continue;
    }
    // The first line sits right after the label; the rest sit under the value column.
    const [first = "", ...more] = lines;
    out.push(`${prefix}${first}`.trimEnd());
    for (const l of more) out.push(l === "" ? "" : `${pad}${l}`);
  }
  return out;
}
