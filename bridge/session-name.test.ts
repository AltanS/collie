import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractClaudeSessionName } from "./state-engine.ts";

// `extractClaudeSessionName` pulls Claude's own `/rename` session name out of a pane's rendered text.
// It must match the name embedded in the horizontal rule above the ❯ prompt, and — critically — never
// false-positive on an unnamed session (plain rule), a pane without an input box (a dialog), or a
// decorative rule elsewhere in the output. We exercise it against the real pane fixtures the web tests
// use, ANSI-stripped to mirror the plain "text" read the bridge actually performs.

const FIXTURES = join(import.meta.dir, "..", "web", "src", "fixtures", "panes");
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const fixture = (name: string) => stripAnsi(readFileSync(join(FIXTURES, `${name}.txt`), "utf8"));

describe("extractClaudeSessionName — named sessions", () => {
  test("reads the name embedded in the rule above the ❯ prompt (fixture)", () => {
    // claude--working.txt was captured with a renamed session ("collie upgrades").
    expect(extractClaudeSessionName(fixture("claude--working"))).toBe("collie upgrades");
  });

  test("reads a hyphenated name from the live 'text' render (CRLF-agnostic, varied width)", () => {
    const live = [
      "❯ /rename",
      "  ⎿  Session renamed to: ping-pong-response",
      "",
      "──────────────────────────── ping-pong-response ──",
      "❯ ",
      "───────────────────────────────────────────────────",
      "  [Opus 4.8 (1M context)] ~/playground/demo…",
    ].join("\r\n"); // CRLF, as some captures carry
    expect(extractClaudeSessionName(live)).toBe("ping-pong-response");
  });

  test("trims trailing rule decoration and surrounding whitespace", () => {
    const text = ["────── my-session ──────   ", "❯ some queued draft"].join("\n");
    expect(extractClaudeSessionName(text)).toBe("my-session");
  });

  test("accepts a single-word and a spaced multi-word name alike", () => {
    expect(extractClaudeSessionName(["──── solo ──", "❯"].join("\n"))).toBe("solo");
    expect(extractClaudeSessionName(["──── two words here ──", "❯"].join("\n"))).toBe(
      "two words here",
    );
  });
});

describe("extractClaudeSessionName — no name / no false positives", () => {
  test("returns undefined for an unnamed session (plain rule above the prompt)", () => {
    expect(extractClaudeSessionName(fixture("claude--fresh-idle"))).toBeUndefined();
    expect(extractClaudeSessionName(fixture("claude--done"))).toBeUndefined();
  });

  test("returns undefined when the pane shows a dialog, not the input box", () => {
    expect(extractClaudeSessionName(fixture("claude--permission-bash"))).toBeUndefined();
  });

  test("does not mistake a decorative in-menu rule for a name (select menu)", () => {
    // claude--select-menu.txt has a full-width rule mid-menu — not above a ❯ prompt.
    expect(extractClaudeSessionName(fixture("claude--select-menu"))).toBeUndefined();
  });

  test("ignores a named-looking rule that is NOT directly above the ❯ prompt", () => {
    const decoy = ["──────── not a prompt ────────", "just output", "more output"].join("\n");
    expect(extractClaudeSessionName(decoy)).toBeUndefined();
  });

  test("ignores the ' ❯' menu cursor (leading space) — only the column-0 prompt anchors", () => {
    // A selected menu row renders as " ❯ 1. Yes"; a rule above it must not be read as a name.
    const menu = ["──────── looks named ────────", " ❯ 1. Yes", "   2. No"].join("\n");
    expect(extractClaudeSessionName(menu)).toBeUndefined();
  });

  test("returns undefined for empty text", () => {
    expect(extractClaudeSessionName("")).toBeUndefined();
  });
});

describe("extractClaudeSessionName — bottommost prompt wins", () => {
  test("a named-rule/❯ pair in scrollback cannot name a session whose live prompt is unnamed", () => {
    // Scrollback holds an echoed shell prompt line starting with ❯ under a decorative rule; the LIVE
    // input box at the bottom has a plain (unnamed) rule. Only the bottommost ❯ may decide.
    const text = [
      "──────── looks like a name ────────",
      "❯ echo hello   # pasted/echoed shell prompt in scrollback",
      "hello",
      "──────────────────────────────────",
      "❯ ",
    ].join("\n");
    expect(extractClaudeSessionName(text)).toBeUndefined();
  });

  test("the live prompt's own named rule still wins over anything above", () => {
    const text = [
      "──────── stale-name ────────",
      "❯ old prompt in scrollback",
      "output",
      "──────── real-name ────────",
      "❯ ",
    ].join("\n");
    expect(extractClaudeSessionName(text)).toBe("real-name");
  });
});
