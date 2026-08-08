import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { claudeAdapter } from "./claude";
import { describeAdapterConformance, isValidHerdrKey } from "./conformance";

// The Claude adapter is one registered implementation gated by the conformance suite. Its fixture
// cohorts are derived from the byte-faithful corpus (web/src/fixtures/panes/claude--*.txt) by
// GLOBBING it, so a newly-captured dialog is covered the moment it lands — including the multiSelect
// captures whose block may still be wiring up (a not-yet-detecting own fixture is tolerated by the
// suite, see conformance.ts). This invocation has no foreign dialog-fixture cohort; the harness
// handles an empty cohort cleanly.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

// The neutral (no-dialog) Claude states: they must never lift an interactive block. Includes the
// in-flight-send captures — a `❯ …` input box (with or without a slash-autocomplete menu above it) is
// composer chrome, not a dialog, so it must stay raw. The wrapped-draft capture is the same: a
// (multi-line) input box, stripped as chrome, never lifted.
const NEUTRAL = [
  "claude--working.txt",
  "claude--fresh-idle.txt",
  "claude--done.txt",
  "claude--send-inflight.txt",
  "claude--rename-resolved.txt",
  "claude--draft-wrapped.txt",
  // A long send that Claude collapsed into `[Pasted text #3 +3 lines]`: still an input box holding a
  // draft, never a dialog. Pinned below (.adr/0010) — the token must not read as a modal.
  "claude--draft-paste-placeholder.txt",
  // Input boxes with the background-agents footer below them — still composer chrome (stripped), not a
  // dialog, so they must stay raw / lift no interactive block.
  "claude--draft-footer-empty.txt",
  "claude--draft-footer-single.txt",
  "claude--draft-footer-wrapped.txt",
  // The /model picker DISMISSED: the input box is back, so this is an ordinary idle screen. It is the
  // negative control for the generic menu grammar — its statusline is `·`-separated like a key-hint
  // footer, and the input-box gate is the only thing that keeps it raw.
  "claude--menu-model-picker-dismissed.txt",
];

const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();

const ownFixtures = allClaudeFixtures.filter((f) => !NEUTRAL.includes(f));
const neutralFixtures = allClaudeFixtures.filter((f) => NEUTRAL.includes(f));

describeAdapterConformance(claudeAdapter, {
  ownFixtures,
  foreignFixtures: [], // no foreign dialog-fixture cohort for this invocation
  neutralFixtures,
});

// The paste-placeholder screen (.adr/0010). The fail-closed cohort above already pins "no dialog is
// lifted from it"; what this adds is the POSITIVE half the reply guard depends on — the token screen
// is an ordinary input box with a draft in it, so the pre-flight lets a send through and the draft the
// guard polls is the token. If any of this drifted, a long send would go back to being un-sendable.
describe("claude--draft-paste-placeholder.txt — a collapsed long send is composer chrome", () => {
  const lines = splitLines(
    parseAnsi(readFileSync(join(PANES_DIR, "claude--draft-paste-placeholder.txt"), "utf8")),
  );

  it("reads the placeholder off the ❯ line as the draft", () => {
    expect(claudeAdapter.extractInputDraft(lines)).toBe("[Pasted text #3 +3 lines]");
  });

  it("is composer-ready (the pre-flight must not mistake the token for a modal)", () => {
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });

  it("lifts no interactive block, and the draft it shows is send evidence for a matching send", () => {
    expect(claudeAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
    const draft = claudeAdapter.extractInputDraft(lines)!;
    expect(claudeAdapter.draftCarriesSend!("one\ntwo\nthree\nfour", draft)).toBe(true);
    expect(claudeAdapter.draftIsOpaque!(draft)).toBe(true);
  });
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
