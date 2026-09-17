import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectAutocompleteRegion } from "./autocomplete";
import { extractInputDraft, extractStatusLines, hasInputBox, inputBoxTail, stripChrome } from "./chrome";
import { claudeBuildBlocks } from "./index";

// The slash-autocomplete grammar and, more importantly, what it must NOT cost: the input box under
// the popup has to stay detectable. That is the bug this module exists for — the popup is taller than
// MAX_STATUS_LINES, so before the peel `locateInputBox` never reached the bottom border, `hasInputBox`
// (= the adapter's `composerReady`) read false, and every send from the phone stalled with the text
// already typed into a live box.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
function load(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}
function lines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}

const RULE = "─".repeat(40);
const LONG = "claude--autocomplete-slash-long.txt";
const SHORT = "claude--autocomplete-slash-short.txt";
// Hand-built from a live 82-column observation (fixtures/panes/README.md): Claude clipped a plugin
// command's name from the left, and the "…"-led row used to end the popup run early and hide the box.
const CLIPPED = "claude--autocomplete-slash-clipped.txt";

/** A screen with `entries` popup rows under a complete input box holding `draft`. */
function screen(draft: string, rows: string[]): StyledLine[] {
  return lines(["● Ran the tests", "", RULE, `❯ ${draft}`, RULE, ...rows].join("\n"));
}

describe("detectAutocompleteRegion", () => {
  it("reads the long capture — 17 entries, wrapped descriptions folded back in", () => {
    const region = detectAutocompleteRegion(load(LONG));
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(9); // directly under the box's bottom border
    const entries = region!.model.entries;
    expect(entries).toHaveLength(17);
    expect(entries.map((e) => e.name)).toEqual([
      "/model",
      "/claude-api",
      "/loop",
      "/advisor",
      "/effort",
      "/status",
      "/auto-mode-setup",
      "/typescript:structure-module",
      "/doctor",
      "/update-config",
      "/add-system-service",
      "/typescript:refactor-dependencies",
      "/typescript:tao-of-node-react",
      "/code-review",
      "/fast",
      "/voice",
      "/plan",
    ]);
    expect(entries[0]!.description).toBe(
      "Set the AI model for Claude Code (currently Opus 5 (1M context))",
    );
    // A continuation row is folded onto its entry with the single space the soft wrap dropped.
    expect(entries[1]!.description).toContain("model migration. TRIGGER — read BEFORE opening the target file");
  });

  it("reads the short variant", () => {
    const region = detectAutocompleteRegion(load(SHORT));
    expect(region!.model.entries).toEqual([
      { name: "/rename", description: "Rename the current conversation" },
      { name: "/resume", description: "Resume a conversation" },
      { name: "/release-notes", description: "View release notes" },
    ]);
  });

  it("is blind to colour — the highlighted row is SGR-only and reads like its neighbours", () => {
    // The short fixture paints its first entry in the accent colour with a bold prefix run and the
    // rest in grey. Nothing about that reaches the model, so the entries are indistinguishable.
    const entries = detectAutocompleteRegion(load(SHORT))!.model.entries;
    expect(entries.every((e) => e.description.length > 0)).toBe(true);
  });

  it("declines a run that is not anchored on a box border", () => {
    expect(detectAutocompleteRegion(lines(["● output", "  /model    Set the model"].join("\n")))).toBeNull();
  });

  it("declines when anything follows the run — the popup is always the last thing on screen", () => {
    const withStatus = ["● Ran the tests", "", RULE, "❯ /re", RULE, "  /rename    Rename it", "  [Opus 5] ~/src"];
    expect(detectAutocompleteRegion(lines(withStatus.join("\n")))).toBeNull();
  });

  it("declines a continuation row that misses the description column", () => {
    expect(detectAutocompleteRegion(screen("/re", ["  /rename    Rename it", "      astray"]))).toBeNull();
  });

  it("declines entry rows that disagree on the description column", () => {
    expect(detectAutocompleteRegion(screen("/re", ["  /rename    Rename it", "  /resume        Resume it"]))).toBeNull();
  });

  it("declines a path-shaped statusline row", () => {
    // The one real near-miss: a statusline whose first field is an absolute path also opens with two
    // spaces and a slash. The command-name character set (no interior "/") is what rejects it.
    expect(detectAutocompleteRegion(screen("/re", ["  /home/altan/nixos    main ✓"]))).toBeNull();
  });
});

describe("a command name Claude clipped with a leading ellipsis", () => {
  it("reads the 82-column capture: every entry, the clipped one included", () => {
    const region = detectAutocompleteRegion(load(CLIPPED));
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(7); // directly under the box's bottom border
    const entries = region!.model.entries;
    expect(entries).toHaveLength(19);
    expect(entries[0]).toEqual({
      name: "/model",
      description: "Set the AI model for Claude Code (currently Opus 5 (1M context))",
    });
    expect(entries.find((e) => e.name.startsWith("\u2026"))).toEqual({
      name: "\u2026ugin:refactor-dependencies",
      description:
        "(plugin) Applies dependency injection and inversion patterns to improve testability and modularity.",
    });
    expect(entries.at(-1)!.name).toBe("/init");
  });

  it("finds the input box and the /model draft under it", () => {
    expect(hasInputBox(load(CLIPPED))).toBe(true);
    expect(inputBoxTail(load(CLIPPED))).toBe("autocomplete");
    expect(extractInputDraft(load(CLIPPED))).toBe("/model");
    expect(extractStatusLines(load(CLIPPED))).toEqual([]);
  });

  it("accepts a clipped bare entry, and still needs the clipped row on the description column", () => {
    expect(detectAutocompleteRegion(screen("/re", ["  /rename      Rename it", "  \u2026ugin:rename"]))).not.toBeNull();
    expect(detectAutocompleteRegion(screen("/re", ["  /rename      Rename it", "  \u2026ugin:rename   Rename"]))).toBeNull();
  });

  // The capture lab (Claude Code 2.1.274, 2026-09-17) found the clip landing on a hyphen. The cut is
  // by column, not by token, so the character after the "\u2026" is whatever was at that column.
  // `entry` pads every name to the same description column, exactly as Claude lays the popup out.
  const COLUMN = 34;
  const entry = (name: string, description: string) => `  ${name.padEnd(COLUMN - 2)}${description}`;

  it("reads a name clipped onto a hyphen", () => {
    const rows = [
      entry("/refactor-module-boundaries", "Move code between modules"),
      entry("\u2026-dependencies-across-packages", "Refactor shared dependencies"),
    ];
    const region = detectAutocompleteRegion(screen("/refactor", rows));
    expect(region).not.toBeNull();
    expect(region!.model.entries.map((e) => e.name)).toEqual([
      "/refactor-module-boundaries",
      "\u2026-dependencies-across-packages",
    ]);
    expect(inputBoxTail(screen("/refactor", rows))).toBe("autocomplete");
  });

  it("a clipped name may open on an underscore or a colon, a real /command may not", () => {
    const pair = (name: string) => [entry("/model", "Set the model"), entry(name, "Does the thing")];
    for (const name of ["\u2026_private-helper", "\u2026:deps:refactor-one"]) {
      expect(detectAutocompleteRegion(screen("/m", pair(name))), name).not.toBeNull();
    }
    // A "/" name still has to start with a letter or a digit, so a hyphen-led row stays out.
    expect(detectAutocompleteRegion(screen("/m", pair("/-not-a-command")))).toBeNull();
  });
});

describe("a name column carrying a parenthesised alias", () => {
  // Also from the capture lab: a skill that declares a short name prints both. The single space
  // before the bracket sits INSIDE the name column, so it must not be read as the column gap.
  const COLUMN = 34;
  const entry = (name: string, description: string) => `  ${name.padEnd(COLUMN - 2)}${description}`;

  it("keeps the alias with the name and still reads the description", () => {
    const rows = [
      entry("/model", "Set the AI model"),
      entry("\u2026opic-skills:morning (morning)", "Render the morning brief"),
    ];
    const region = detectAutocompleteRegion(screen("/mo", rows));
    expect(region).not.toBeNull();
    expect(region!.model.entries).toEqual([
      { name: "/model", description: "Set the AI model" },
      { name: "\u2026opic-skills:morning (morning)", description: "Render the morning brief" },
    ]);
  });

  it("an unclipped command with an alias reads too", () => {
    const rows = [entry("/morning (mo)", "Render the brief"), entry("/model", "Set the model")];
    expect(detectAutocompleteRegion(screen("/m", rows))!.model.entries.map((e) => e.name)).toEqual([
      "/morning (mo)",
      "/model",
    ]);
  });

  it("the column rule is untouched: two rows that disagree are not a popup", () => {
    const rows = [entry("/morning (mo)", "Render the brief"), `  ${"/model".padEnd(40)}Set the model`];
    expect(detectAutocompleteRegion(screen("/m", rows))).toBeNull();
  });

  it("the bracket has to look like an alias, not like prose", () => {
    // "(a long note)" carries a space, so it is not an alias, and "/morning" alone is then followed
    // by a single space rather than the two-space column gap. The row matches nothing and the run
    // is refused — the alias arm buys no extra looseness.
    const rows = [entry("/model", "Set the AI model"), entry("/morning (a long note)", "Render the brief")];
    expect(detectAutocompleteRegion(screen("/m", rows))).toBeNull();
  });
});

describe("the input box survives the popup", () => {
  it("hasInputBox is true for both captures, at 23 rows and at 3", () => {
    expect(hasInputBox(load(LONG))).toBe(true);
    expect(hasInputBox(load(SHORT))).toBe(true);
  });

  it("hasInputBox stays true past the old MAX_STATUS_LINES ceiling, row by row", () => {
    // The regression in one line: 0..8 popup rows worked before this grammar existed, 9 and up did
    // not. Every count must now hold.
    for (const n of [0, 1, 8, 9, 12, 23, 40]) {
      // Padded to a fixed description column, exactly as Claude lays the popup out — a run whose
      // entries disagree on that column is not a popup and is refused (asserted above).
      const rows = Array.from({ length: n }, (_, i) => `  ${`/cmd${i}`.padEnd(16)}Does the thing`);
      expect(hasInputBox(screen("/c", rows)), `${n} popup rows`).toBe(true);
    }
  });

  it("extractInputDraft returns the slash command from the ❯ line", () => {
    expect(extractInputDraft(load(LONG))).toBe("/model");
    expect(extractInputDraft(load(SHORT))).toBe("/re");
  });

  it("reports no statusline — Claude paints the popup in its place", () => {
    expect(extractStatusLines(load(LONG))).toEqual([]);
  });

  it("only peels a popup off a box whose draft is a slash command", () => {
    // The gate that keeps the peel honest. Rows shaped like entries under a box holding ordinary
    // prose are not a completion popup: they are an `unknown` tail. The box is still found by its own
    // frame (ADR 0048), but the rows are neither lifted into a popup block nor stripped.
    const rows = Array.from({ length: 12 }, (_, i) => `  ${`/cmd${i}`.padEnd(16)}Does the thing`);
    const prose = screen("write the tests", rows);
    expect(hasInputBox(prose)).toBe(true);
    expect(inputBoxTail(prose)).toBe("unknown");
    expect(claudeBuildBlocks(prose).map((b) => b.kind)).toEqual(["raw"]);
    expect(stripChrome(prose).length).toBe(1 + rows.length);
    expect(inputBoxTail(screen("/c", rows))).toBe("autocomplete");
  });
});

describe("claudeBuildBlocks", () => {
  it("yields the transcript plus an autocomplete block — never the raw fallback", () => {
    for (const name of [LONG, SHORT, CLIPPED]) {
      const blocks = claudeBuildBlocks(load(name));
      expect(blocks.map((b) => b.kind), name).toEqual(["raw", "autocomplete"]);
      // The raw block is the transcript ABOVE the box: the box, the popup and the whole 220-column
      // grid are gone from the mirror, which is the visible half of the bug.
      expect(blocks[0]!.lines.length, name).toBeLessThan(load(name).length);
    }
  });

  it("keeps the /model PICKER a menu — the full-screen screen after Enter is a different shape", () => {
    expect(claudeBuildBlocks(load("claude--menu-model-picker.txt")).map((b) => b.kind)).toEqual([
      "raw",
      "menu",
    ]);
  });

  it("leaves the older above-the-box popup alone", () => {
    // claude--send-inflight.txt carries the same list painted ABOVE the input box. It is chrome, it
    // has always been stripped as chrome, and this tail-anchored grammar must not claim it.
    expect(claudeBuildBlocks(load("claude--send-inflight.txt")).map((b) => b.kind)).toEqual(["raw"]);
  });
});
