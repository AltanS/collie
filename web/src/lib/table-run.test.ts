import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { buildBlocks } from "./harness";
import { tableRuns, type TableRun } from "./table-run";

// The grammar's only real risk is a false positive: a run pans instead of wrapping, so anything it
// claims by mistake becomes a strip of prose the reader has to scroll sideways. These tests are
// therefore weighted toward what it must REFUSE — chrome, prose with pipes, a lone delimiter, and a
// table the terminal already wrapped past the pane's width, which cannot be repaired by panning.

const runs = (text: string) => tableRuns(splitLines(parseAnsi(text)));

describe("tableRuns — markdown", () => {
  it("claims a pipe table, delimiter row included, and stops at the blank line", () => {
    const text = [
      "here is the comparison:",
      "",
      "| Option | Cost | Notes |",
      "| --- | --- | --- |",
      "| A | low | fine |",
      "| B | high | avoid |",
      "",
      "that is all.",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 2, end: 5 }]);
  });

  it("claims a table written without outer pipes", () => {
    const text = ["Option | Cost", "--- | ---", "A | low"].join("\n");
    expect(runs(text)).toEqual([{ start: 0, end: 2 }]);
  });

  it("claims two tables separately rather than swallowing the prose between them", () => {
    const text = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "and then",
      "",
      "| c | d |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");

    expect(runs(text)).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
  });

  it("drops a row the terminal already wrapped, because its cell count no longer matches", () => {
    // The pane rendered `| B | high | a very long note …` at its own width and broke the tail onto
    // its own row. Neither half now carries the table's four pipes, so BOTH stay outside the run:
    // the intact rows pan, and the wreckage keeps wrapping, which is the only readable thing left
    // to do with it. Panning cannot put those two rows back together — the terminal split them
    // before Collie saw the grid.
    const text = [
      "| Option | Cost | Notes |",
      "| --- | --- | --- |",
      "| A | low | fine |",
      "| B | high | a very long note that ran",
      "past the pane's last column |",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 2 }]);
  });

  it("refuses prose that merely contains a pipe, and a delimiter row with no table under it", () => {
    expect(runs("run `a | b` to pipe it\nthen read the output")).toEqual([]);
    expect(runs("| --- | --- |")).toEqual([]);
    expect(runs("--------------------")).toEqual([]);
  });
});

describe("tableRuns — box drawing", () => {
  it("claims a junction-divided table, frame rows and all", () => {
    const text = [
      "┌────────┬───────┐",
      "│ Option │ Cost  │",
      "├────────┼───────┤",
      "│ A      │ low   │",
      "└────────┴───────┘",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 4 }]);
  });

  it("refuses Claude's input box: a single-column frame has no column junction anywhere", () => {
    const text = [
      "╭──────────────────────────────╮",
      "│ > write the migration        │",
      "╰──────────────────────────────╯",
    ].join("\n");

    expect(runs(text)).toEqual([]);
  });

  it("refuses a single-column frame divided by ├ ┤, which ends a row without splitting it", () => {
    const text = ["╭────────────╮", "│ heading    │", "├────────────┤", "│ body       │", "╰────────────╯"].join("\n");
    expect(runs(text)).toEqual([]);
  });

  it("refuses a two-pane chrome box, whose ┬ and ┴ are border joins and not a table", () => {
    // The shape that made omp's splash screen and its whole /model picker pan: a divider between two
    // panes meets the lid at ┬ and the floor at ┴, and neither is a cross. 18 of the 121 committed
    // pane fixtures were claimed this way. Only a ┼ anchors a run.
    const text = [
      "╭───────────────┬──────────────╮",
      "│ omp 18.1.2    │ opus-5       │",
      "│ /model        │ /resume      │",
      "╰───────────────┴──────────────╯",
    ].join("\n");

    expect(runs(text)).toEqual([]);
  });

  it("keeps a titled lid in the run, though its letters stop it being a pure frame row", () => {
    const text = [
      "┌─ Results ──┬─────────┐",
      "│ id         │ name    │",
      "├────────────┼─────────┤",
      "│ 1          │ alice   │",
      "└────────────┴─────────┘",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 4 }]);
  });

  it("keeps the aligned head of a terminal-wrapped row and stops the run at the remainder", () => {
    // The pane broke `│ A │ a very long note …` across two rows. The head still carries the table's
    // wall at the anchor's offset, so it is a member and pans with the rows above it. The remainder
    // carries nothing there, so the run ends — and the table's closing frame, no longer contiguous,
    // wraps below it. That is the honest outcome: panning cannot rejoin two rows the terminal split
    // before Collie saw the grid, so the run keeps exactly the part that is still a table.
    const text = [
      "┌────────┬───────┐",
      "│ Option │ Cost  │",
      "├────────┼───────┤",
      "│ A      │ a very long note that ran",
      "past the pane's last column │",
      "└────────┴───────┘",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 3 }]);
  });

  it("refuses a neighbouring box whose walls stand somewhere else", () => {
    const text = [
      "┌────┬────┬────┐",
      "│ a  │ b  │ c  │",
      "├────┼────┼────┤",
      "│ 1  │ 2  │ 3  │",
      "└────┴────┴────┘",
      "│ x │ y │ z │",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 4 }]);
  });
});

describe("tableRuns — line coordinates", () => {
  it("reports indices into the lines it was given, so the renderer can group in place", () => {
    const lines = splitLines(parseAnsi(["intro", "| a | b |", "|---|---|", "| 1 | 2 |", "outro"].join("\n")));
    const [run] = tableRuns(lines);

    expect(run).toEqual({ start: 1, end: 3 });
    expect(lines.slice(run!.start, run!.end + 1)).toHaveLength(3);
  });

  it("returns the same empty array for output with no table (one identity across polls)", () => {
    expect(runs("nothing to see")).toBe(runs("nothing else either"));
  });
});

describe("tableRuns — ASCII tables", () => {
  it("claims the +---+ table every shell tool prints", () => {
    const text = [
      "+----+-------+",
      "| id | name  |",
      "+----+-------+",
      "|  1 | alice |",
      "|  2 | bob   |",
      "+----+-------+",
    ].join("\n");

    expect(tableRuns(splitLines(parseAnsi(text)))).toEqual([{ start: 0, end: 5 }]);
  });
});

describe("tableRuns — what a run may not grow into", () => {
  it("stops at a chrome box below the table, blank line or no blank line", () => {
    // A single-column box has walls only at its own two edges, never at the table's column offsets,
    // so the anchor cannot reach it. Before the offset rule this claimed all eight lines.
    const text = [
      "┌────────┬───────┐",
      "│ Option │ Cost  │",
      "├────────┼───────┤",
      "│ A      │ low   │",
      "└────────┴───────┘",
      "╭──────────────────────────────╮",
      "│ > write the migration        │",
      "╰──────────────────────────────╯",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 4 }]);
  });

  it("stops at a plain rule beside the table rather than panning and un-clipping it", () => {
    const rule = "─".repeat(30);
    const text = [rule, "┌────────┬───────┐", "│ a      │ b     │", "├────────┼───────┤", "│ 1      │ 2     │", "└────────┴───────┘", rule].join("\n");

    expect(runs(text)).toEqual([{ start: 1, end: 5 }]);
  });
});

describe("tableRuns — the empty result", () => {
  it("is frozen, so a caller cannot poison every later table-free mirror", () => {
    const empty = tableRuns([]);

    expect(empty).toEqual([]);
    // SAFETY: the cast strips `readonly` on purpose — it is the whole test. A caller in plain JS,
    // or one that widens the type exactly like this, must hit the freeze rather than mutate the
    // singleton that every later table-free mirror is handed.
    expect(() => (empty as TableRun[]).push({ start: 999, end: 1000 })).toThrow();
    expect(runs("nothing to see")).toEqual([]);
  });
});

// The corpus gate. Every other grammar in this repo is developed against the byte-faithful captures
// in fixtures/panes (harness/claude/prompt-select.test.ts, harness/conformance.ts), and this one
// needs it more than most: an earlier anchor alphabet that accepted a `┬` claimed omp's welcome
// splash and the WHOLE of its /model picker across 18 of these files, and every hand-written test
// above still passed. Globbing rather than listing means a newly captured screen is covered the day
// it lands.
describe("tableRuns — the whole pane corpus", () => {
  const DIR = join(import.meta.dirname, "..", "fixtures", "panes");

  it("claims real tables and nothing else across every committed capture", () => {
    const claimed: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".txt"))) {
      const agent = file.split("--")[0]!;
      const lines = splitLines(parseAnsi(readFileSync(join(DIR, file), "utf8")));
      for (const block of buildBlocks(lines, { agent })) {
        if (block.kind !== "raw") continue;
        for (const run of tableRuns(block.lines)) claimed.push(`${file} ${run.start}..${run.end}`);
      }
    }

    // The one real table in the corpus: the Bluefin motd's `Command │ Description` two-column list,
    // 200 columns wide, sitting in the scrollback above Claude's trust prompt. Everything else here
    // is chrome — splashes, pickers, permission dialogs, wizards — and must keep wrapping.
    expect(claimed).toEqual(["claude--trust-prompt.txt 5..10"]);
  });
});
