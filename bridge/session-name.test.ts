import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractClaudeSessionName } from "./state-engine.ts";

// `extractClaudeSessionName` pulls Claude's own `/rename` session name out of a pane's rendered text.
// It must match the name embedded in the horizontal rule above the ❯ prompt, and — critically — never
// false-positive on an unnamed session (plain rule), a pane without an input box (a dialog), or a
// decorative rule elsewhere in the output. We exercise it against the real pane fixtures the web tests
// use, ANSI-stripped (the shape a multiplexer that drops colour hands back) and, below, as styled.

const FIXTURES = join(import.meta.dir, "..", "web", "src", "fixtures", "panes");
// The escape byte is built rather than written literally: a raw control character in a regex
// literal is unreadable in a diff and easy to corrupt in an editor.
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string) => s.replace(SGR, "");
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

// The bridge reads the grid with its colours, because colour is the only thing that tells a name from
// a mode badge Claude draws in the same place. These lines are the rule and prompt verbatim from a
// live Claude Code 2.1.290 capture (2026-10-06); the rule runs are shortened, the escapes are untouched.
const ESC = String.fromCharCode(27);
const sgr = (codes: string) => `${ESC}[${codes}m`;
const RULE = "────────────";
const GREY = "38;2;136;136;136";
const box = (rule: string) => [rule, `${sgr("0")}${sgr("38;2;153;153;153")}❯${sgr("0")}`].join("\n");

describe("extractClaudeSessionName — styled reads", () => {
  test("reads a /rename name drawn in the rule's own colour", () => {
    const rule = `${sgr("0")}${sgr(GREY)}${RULE} my-name ─${sgr("0")}`;
    expect(extractClaudeSessionName(box(rule))).toBe("my-name");
  });

  test("reads a name drawn as a chip in the colour /color gave the rule", () => {
    const rule = `${sgr("0")}${sgr("38;2;220;38;38")}${RULE}${sgr("0")}${sgr("38;2;0;0;0")}${sgr("48;2;220;38;38")} b-name ${sgr("0")}${sgr("38;2;220;38;38")}─${sgr("0")}`;
    expect(extractClaudeSessionName(box(rule))).toBe("b-name");
    expect(extractClaudeSessionName(readFileSync(join(FIXTURES, "claude--working.txt"), "utf8"))).toBe(
      "collie upgrades",
    );
  });

  test("a mode badge in its own colour is not a name: the session is unnamed", () => {
    // `/effort ultracode` on an unnamed session. The badge stays through every turn until the mode is
    // switched off, and a /rename replaces it, so its presence means the session has no name.
    const rule = `${sgr("0")}${sgr(GREY)}${RULE} ${sgr("0")}${sgr("38;2;175;135;255")}ultracode ${sgr("0")}${sgr(GREY)}─${sgr("0")}`;
    expect(extractClaudeSessionName(box(rule))).toBeNull();
  });

  test("an unstyled plain rule above the styled prompt is unnamed", () => {
    expect(extractClaudeSessionName(readFileSync(join(FIXTURES, "claude--fresh-idle.txt"), "utf8"))).toBeNull();
  });

  // The cases below are not in a capture. tmux (`capture-pane -e`) and zellij hand back styled text
  // too, and a terminal may spell one colour several ways, so the rule is pinned against each spelling.
  test("a palette chip matches its rule whichever code names the colour", () => {
    const basic = `${sgr("31")}${RULE} ${sgr("30")}${sgr("41")}my-name${sgr("0")}${sgr("31")} ─${sgr("0")}`;
    const bright = `${sgr("91")}${RULE} ${sgr("30")}${sgr("101")}my-name${sgr("0")}${sgr("91")} ─${sgr("0")}`;
    const mixed = `${sgr("31")}${RULE} ${sgr("30")}${sgr("48;5;1")}my-name${sgr("0")}${sgr("31")} ─${sgr("0")}`;
    expect(extractClaudeSessionName(box(basic))).toBe("my-name");
    expect(extractClaudeSessionName(box(bright))).toBe("my-name");
    expect(extractClaudeSessionName(box(mixed))).toBe("my-name");
  });

  test("a chip drawn in inverse video over the rule's colour is a name", () => {
    const rule = `${sgr("38;2;220;38;38")}${RULE} ${sgr("7")}my-name${sgr("27")} ─${sgr("0")}`;
    expect(extractClaudeSessionName(box(rule))).toBe("my-name");
  });

  test("a colour set on an earlier row carries into the rule", () => {
    const text = [
      `${sgr("38;2;220;38;38")}scrollback`,
      `${RULE} ${sgr("38;2;0;0;0")}${sgr("48;2;220;38;38")}my-name${sgr("49")}${sgr("38;2;220;38;38")} ─${sgr("0")}`,
      `${sgr("0")}❯`,
    ].join("\n");
    expect(extractClaudeSessionName(text)).toBe("my-name");
  });

  test("a coloured badge on a rule in the default colour is not a name", () => {
    const rule = `${sgr("0")}${RULE} ${sgr("35")}ultracode ${sgr("0")}─`;
    expect(extractClaudeSessionName(box(rule))).toBeNull();
  });

  test("a name in the default colour on a rule in the default colour is a name", () => {
    expect(extractClaudeSessionName(box(`${sgr("0")}${RULE} my-name ─`))).toBe("my-name");
  });

  test("a colour this reader cannot parse says nothing, so the cached name stays", () => {
    const rule = `${sgr("38:2::220:38:38")}${RULE} my-name ─${sgr("0")}`;
    expect(extractClaudeSessionName(box(rule))).toBeUndefined();
  });

  test("without any colour the badge still reads as a name (the known limit)", () => {
    // A multiplexer that drops colour leaves nothing to tell the two apart, so the words are taken
    // as a name rather than lose a real one.
    expect(extractClaudeSessionName(["──── ultracode ─", "❯"].join("\n"))).toBe("ultracode");
  });
});

describe("extractClaudeSessionName — no name / no false positives", () => {
  test("returns null for an unnamed session (plain rule above the prompt)", () => {
    expect(extractClaudeSessionName(fixture("claude--fresh-idle"))).toBeNull();
    expect(extractClaudeSessionName(fixture("claude--done"))).toBeNull();
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
    expect(extractClaudeSessionName(text)).toBeNull();
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
