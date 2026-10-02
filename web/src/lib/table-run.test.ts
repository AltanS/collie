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

  it("claims a two-pane box, whose ┬ and ┴ are a column boundary meeting a border", () => {
    // REVERSED by ADR 0072, and this case is the reversal. A tee used to refuse the run on the
    // reasoning that only a table draws a `┼`. True, and the wrong test: a two-pane box draws its
    // divider meeting a border instead, so the rule refused every two-pane box there is. Refusing it
    // does not leave the box wrapping. `FRAME_ROW` in blocks.ts clips a `│ … │` row, so the second
    // pane was simply unreachable on a phone.
    const text = [
      "╭───────────────┬──────────────╮",
      "│ omp 18.1.2    │ opus-5       │",
      "│ /model        │ /resume      │",
      "╰───────────────┴──────────────╯",
    ].join("\n");

    expect(runs(text)).toEqual([{ start: 0, end: 3 }]);
  });

  it("still refuses a lone tee with no box under it", () => {
    // The anchor alphabet widened; the three rules that keep it honest did not. A run of one row is
    // discarded, so a frame row carrying a tee claims nothing on its own.
    expect(runs(["╭───────┬───────╮", "", "some prose"].join("\n"))).toEqual([]);
  });

  it("still refuses a sentence that happens to contain a tee", () => {
    // The anchor row must be a PURE frame row. This is the rule the old glyph test was leaning on a
    // rare character to do for it.
    expect(runs(["the ┬ glyph is a tee", "and this is prose too"].join("\n"))).toEqual([]);
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
// needs it more than most: the anchor alphabet is one character class, and widening it by one glyph
// silently changes what every screen in the corpus does. Globbing rather than listing means a newly
// captured screen is covered the day it lands.
//
// The list below is EXHAUSTIVE on purpose, not a count. It is the whole answer to "what pans", and a
// screen joining it is a diff a person has to read. ADR 0072 was taken by running this gate before
// the change and reading exactly which screens moved.
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

    // THE ONE REAL TABLE. The Bluefin motd's `Command │ Description` two-column list, sitting in the
    // scrollback above Claude's trust prompt — 200 columns wide in the 2026-07-04 capture, 120 in the
    // 2026-09-22 one. It anchors on a cross, as it always did.
    //
    // EVERYTHING ELSE HERE IS A TWO-PANE BOX, claimed since ADR 0072, and each one is a screen whose
    // right-hand pane a phone could not reach before. `FRAME_ROW` in blocks.ts clips a `│ … │` row
    // rather than wrapping it, so refusing these did not make them wrap, it made half of each one
    // invisible. They pan now.
    expect(claimed).toEqual([
      "claude--trust-prompt-unnumbered.txt 5..10",
      "claude--trust-prompt.txt 5..10",
      // THE SCREEN ADR 0072 WAS TAKEN FOR (discussion #301). Claude's dynamic-workflow view: the
      // phase list on the left, the running agents on the right, 226 columns wide. The reporter saw
      // it on a phone as a band of stacked rules with `· 74…` cut off the right edge, which is what
      // clipping every `│ … │` row looks like when the box is wider than the screen. Its lid is
      // TITLED (`╭ Phases ───┬ Read the corpus · 1 agent ───╮`) so the letters in it stop it being a
      // pure frame row and it cannot be the anchor; the floor `╰───┴───╯` anchors instead and the run
      // grows up through the whole box.
      "claude--workflow-view.txt 8..59",
      // omp's welcome splash: the logo on the left, Tips / LSP servers / Recent sessions on the right.
      // It sits in the scrollback of most omp captures, which is why it appears 40 times and always
      // at the same rows. The menus and dialogs BELOW it are not claimed, and that is the point: the
      // run stops where the box does.
      //
      // Absent from this list since .adr/0076: every omp modal that prints its own way out and that no
      // grammar lifts (the `/model` picker, the Ask tool's multi-select screens) gets the unread-dialog
      // card, which mirrors the whole pane in its own horizontally scrolling region instead of a raw
      // block, so no raw block carries a table run there. That includes the `/model` box ADR 0072 once
      // panned, which scrolls as part of the card's mirror, as Claude's generic-menu card always has.
      //
      // Back on this list since .adr/0077: the Ask tool's one-question single-select dialog is a
      // `prompt-select` card now, and the transcript above it is an ordinary raw block again, splash
      // included. The note editor `n` opens is an input, not a modal, so it never had the card.
      //
      // Back on this list since .adr/0078, for the same reason: the three omp 18.1.17 tool-approval
      // screens are a `prompt-select` card now. The five 18.4.10 approval captures are not here because
      // their splash has scrolled out of the buffer.
      //
      // Back on this list since .adr/0079, for the same reason again: the compact model picker's
      // session state is a `prompt-select` card, so the splash above it is a raw block. Its splash is
      // shorter (rows 2 to 14), drawn in the sandbox the picker was captured in. The 74-column capture
      // is here although it is declined: omp clipped its footer, so no card stands over it either. The
      // 103-column captures are absent because their splash has scrolled out, and the four declined
      // states with a way out take the card.
      "omp--approval-bash.txt 2..20",
      "omp--approval-write--deny.txt 2..20",
      "omp--approval-write.txt 2..20",
      "omp--done--tool-result.txt 2..20",
      "omp--done.txt 2..20",
      "omp--draft-ghost-suggestion-busy.txt 2..20",
      "omp--draft-ghost-suggestion.txt 2..20",
      "omp--draft-single.txt 2..20",
      "omp--draft-wrapped.txt 2..20",
      "omp--fresh-idle.txt 2..20",
      "omp--menu-dismissed.txt 2..20",
      "omp--select-menu-moved.txt 2..20",
      "omp--select-menu.txt 2..20",
      "omp--slash-palette--filtered.txt 2..20",
      "omp--slash-palette.txt 2..20",
      "omp--tree.txt 2..20",
      "omp--v18-4-ask-note-editor.txt 2..20",
      "omp--v18-4-ask-single-moved.txt 2..20",
      "omp--v18-4-ask-single.txt 2..20",
      "omp--v18-4-composer-idle.txt 2..20",
      "omp--v18-4-switch-clipped.txt 2..14",
      "omp--v18-4-switch-moved-up.txt 2..14",
      "omp--v18-4-switch-moved.txt 2..14",
      "omp--v18-4-switch-narrow-moved.txt 2..14",
      "omp--v18-4-switch-narrow.txt 2..14",
      "omp--v18-4-switch-overcontext-moved.txt 2..14",
      "omp--v18-4-switch-overcontext.txt 2..14",
      "omp--v18-4-switch-roles-chips.txt 2..14",
      "omp--v18-4-switch-search-short-moved.txt 2..14",
      "omp--v18-4-switch-search-short.txt 2..14",
      "omp--v18-4-switch-search.txt 2..14",
      "omp--v18-4-switch-top-edge.txt 2..14",
      "omp--v18-4-switch-top.txt 2..14",
      "omp--v18-4-switch-wrapped.txt 2..14",
      "omp--v18-4-switch.txt 2..14",
      "omp--v18-4-tree.txt 2..20",
      "omp--v18-rule-draft.txt 2..20",
      "omp--v18-rule-idle.txt 2..20",
      "omp--v18-rule-wrapped.txt 2..20",
      "omp--working.txt 2..20",
    ]);
  });
});
