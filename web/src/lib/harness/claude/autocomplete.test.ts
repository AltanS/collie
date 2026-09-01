import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectAutocompleteRegion } from "./autocomplete";
import { extractInputDraft, extractStatusLines, hasInputBox } from "./chrome";
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
    // prose are not a completion popup, so the walk runs unchanged and finds no box behind 12 rows.
    const rows = Array.from({ length: 12 }, (_, i) => `  ${`/cmd${i}`.padEnd(16)}Does the thing`);
    expect(hasInputBox(screen("write the tests", rows))).toBe(false);
  });
});

describe("claudeBuildBlocks", () => {
  it("yields the transcript plus an autocomplete block — never the raw fallback", () => {
    for (const name of [LONG, SHORT]) {
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
