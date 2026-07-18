import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeAdapter } from "./claude";
import { describeAdapterConformance, isValidHerdrKey } from "./conformance";

// The Claude adapter is the reference implementation the conformance suite gates. The fixture
// cohorts are derived from the byte-faithful corpus (web/src/fixtures/panes/claude--*.txt) by
// GLOBBING it, so a newly-captured dialog is covered the moment it lands — including the multiSelect
// captures whose block may still be wiring up (a not-yet-detecting own fixture is tolerated by the
// suite, see conformance.ts). Foreign = [] until a second adapter exists; the harness handles the
// empty cohort cleanly.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

// The neutral (no-dialog) Claude states: they must never lift an interactive block. Includes the
// in-flight-send captures — a `❯ …` input box (with or without a slash-autocomplete menu above it) is
// composer chrome, not a dialog, so it must stay raw.
const NEUTRAL = [
  "claude--working.txt",
  "claude--fresh-idle.txt",
  "claude--done.txt",
  "claude--send-inflight.txt",
  "claude--rename-resolved.txt",
];

const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();

const ownFixtures = allClaudeFixtures.filter((f) => !NEUTRAL.includes(f));
const neutralFixtures = allClaudeFixtures.filter((f) => NEUTRAL.includes(f));

describeAdapterConformance(claudeAdapter, {
  ownFixtures,
  foreignFixtures: [], // no second adapter yet — the suite tolerates an empty foreign cohort
  neutralFixtures,
});

// A focused unit test of the grammar validator itself — the load-bearing helper the suite leans on.
describe("isValidHerdrKey", () => {
  it("accepts single literal chars, bare special keys, and modifier chords", () => {
    for (const key of [
      "0",
      "9",
      "n",
      "y",
      "Enter",
      "Escape",
      "Tab",
      "Backspace",
      "Up",
      "Down",
      "Left",
      "Right",
      "Space",
      "shift+tab",
      "ctrl+c",
      "ctrl+k",
      "ctrl+left",
      "F5",
    ]) {
      expect(isValidHerdrKey(key), key).toBe(true);
    }
  });

  it("rejects multi-char digit runs and the unsupported paging/edit keys", () => {
    for (const key of ["10", "42", "PageUp", "PageDown", "Home", "End", "Insert", "Delete", "", "C-c"]) {
      expect(isValidHerdrKey(key), key).toBe(false);
    }
  });
});
