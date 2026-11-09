import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAnsi } from "../ansi";
import { lineText, splitLines } from "../blocks";
import { dialogScreenHash, fnv1a32, hintSegments, keyOnlyTokens, keyTokens, looksLikeKeyHints, normalizeRow, SCREEN_HASH, SCREEN_ROW_MAX, SEGMENT_CHARS_MAX, SEGMENT_WORDS_MAX, unreadDialogScreen, wayOutRow } from "./screen";

// The screen hash of a dialog trouble signal (1.27.4): the way-out row, normalized, hashed only when
// it looks like key hints.

const FIXTURES = join(import.meta.dirname, "../../fixtures/panes");

/** A capture's rows as plain text, the way the unread-dialog card's signature holds them. */
function rowsOf(name: string): string[] {
  return splitLines(parseAnsi(readFileSync(join(FIXTURES, name), "utf8"))).map(lineText);
}

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32-bit vectors, as 8 lower-case hex characters", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(fnv1a32("foobar")).toBe("bf9cf968");
  });

  it("hashes the UTF-8 bytes, so a glyph is not its UTF-16 units", () => {
    const overBytes = (bytes: readonly number[]): string => {
      let hash = 0x811c9dc5;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
      return (hash >>> 0).toString(16).padStart(8, "0");
    };
    // ⎋ is U+238B: three bytes in UTF-8. The Nerd Font glyph U+F12B7 is four.
    expect(fnv1a32("⎋")).toBe(overBytes([0xe2, 0x8e, 0x8b]));
    expect(fnv1a32("\u{F12B7}")).toBe(overBytes([0xf3, 0xb1, 0x8a, 0xb7]));
    expect(fnv1a32("\u{F12B7}")).toMatch(SCREEN_HASH);
  });
});

describe("wayOutRow", () => {
  it("takes the lowest of the last six non-blank rows that names a way out", () => {
    const rows = ["Esc to go back", "", "  ↑/↓ move", "Enter select · esc back", "   ", "status line"];
    expect(wayOutRow(rows)).toBe("Enter select · esc back");
  });

  it("knows esc, escape, ⎋ and the Nerd Font escape glyph, in any case", () => {
    expect(wayOutRow(["ESCAPE to cancel"])).toBe("ESCAPE to cancel");
    expect(wayOutRow(["⎋ close"])).toBe("⎋ close");
    expect(wayOutRow(["\u{F12B7} close"])).toBe("\u{F12B7} close");
    // A word that holds the letters is no way out.
    expect(wayOutRow(["escalate the incident", "Escaped quotes"])).toBeNull();
  });

  it("looks no higher than six non-blank rows from the bottom", () => {
    const rows = ["Enter select · esc back", "a", "b", "", "c", "d", "e", "f"];
    expect(wayOutRow(rows)).toBeNull();
    expect(wayOutRow(rows.slice(0, -1))).toBe("Enter select · esc back");
  });
});

describe("normalizeRow", () => {
  it("strips box glyphs and spaces at both ends and collapses white space", () => {
    expect(normalizeRow("│ PgUp/PgDn scroll · ⎋ to close                     │")).toBe("PgUp/PgDn scroll · ⎋ to close");
    expect(normalizeRow("╰─ PgUp/PgDn   scroll\t· ⎋ to close ─╯")).toBe("PgUp/PgDn scroll · ⎋ to close");
    // A glyph inside the row stays: only the ends are the frame.
    expect(normalizeRow("Tab:next answer  │  Esc:unselect")).toBe("Tab:next answer │ Esc:unselect");
  });
});

describe("the key-hint gate (privacy)", () => {
  it("counts whole key tokens, each once, in any case", () => {
    expect([...keyTokens("Enter/Space to change · Tab to jump · Esc to close")]).toEqual(["enter", "space", "tab", "esc"]);
    expect([...keyTokens("↑/↓ select · ⏎ confirm · Ctrl+G editor · ⎋ cancel")]).toEqual(["↑", "↓", "⏎", "ctrl+g", "⎋"]);
    expect([...keyTokens("Alt+H hide · Shift+x dismiss · ^C quit · ⌥ menu · ␣ toggle · ⇥ next")]).toEqual(["alt+h", "shift+x", "^c", "⌥", "␣", "⇥"]);
    expect([...keyTokens("PgUp/PgDn · Home/End · ←/→")]).toEqual(["pgup", "pgdn", "home", "end", "←", "→"]);
    // Inside a word is not a token: tabs, sender, entered, escapes, spaced.
    expect(keyTokens("tabs sender entered escapes spaced homes").size).toBe(0);
    expect(keyTokens("esc esc ESC").size).toBe(1);
  });

  it("tells the keys that are only keys from the key names that are also words", () => {
    expect([...keyOnlyTokens("Enter/Space to change · Tab to jump · Home/End · Esc to close")]).toEqual(["esc"]);
    expect(keyOnlyTokens("enter select · tab next · home top · end bottom").size).toBe(0);
  });

  it("cuts a row at · • | and │, and drops empty segments", () => {
    expect(hintSegments("enter select · esc back")).toEqual(["enter select", "esc back"]);
    expect(hintSegments("↑↓ navigate • Enter to select • Esc to cancel")).toEqual(["↑↓ navigate", "Enter to select", "Esc to cancel"]);
    expect(hintSegments("tab to add notes | enter to submit answer | esc to interrupt")).toHaveLength(3);
    expect(hintSegments("Tab:next answer │ Esc:unselect │ Shift+x:dismiss")).toEqual(["Tab:next answer", "Esc:unselect", "Shift+x:dismiss"]);
    // A dot or a dash with no spaces round it is no separator.
    expect(hintSegments("esc·back")).toEqual(["esc·back"]);
    expect(hintSegments("[⌦/⌫ delete · ⏎ select · ⎋ cancel]")).toHaveLength(3);
  });

  it("passes a short list of key hints", () => {
    expect(looksLikeKeyHints("enter select · esc back")).toBe(true);
    expect(looksLikeKeyHints("PgUp/PgDn scroll · ⎋ to close")).toBe(true);
    expect(looksLikeKeyHints("Tab:next answer │ Esc:unselect │ Shift+x:dismiss")).toBe(true);
    expect(looksLikeKeyHints("tab or esc to clear notes | enter to submit answer")).toBe(true);
  });

  it("refuses a row with no hint separator, however many keys it names", () => {
    expect(dialogScreenHash(["⎋ Fixing the home page end-to-end tests"])).toBeNull();
    expect(dialogScreenHash(["› press enter then esc to leave vim"])).toBeNull();
    expect(looksLikeKeyHints("↑/↓ navigate ⏎ select ⎋ cancel")).toBe(false);
  });

  it("refuses a row whose keys are all plain words", () => {
    expect(looksLikeKeyHints("Fixing the home page · end-to-end tests")).toBe(false);
    expect(dialogScreenHash(["Fixing the home page · end-to-end tests"])).toBeNull();
    expect(looksLikeKeyHints("enter select · tab next · home top")).toBe(false);
  });

  it(`refuses a segment of more than ${String(SEGMENT_WORDS_MAX)} words or ${String(SEGMENT_CHARS_MAX)} characters`, () => {
    expect(looksLikeKeyHints("enter select · esc to go back to where you were")).toBe(false);
    expect(looksLikeKeyHints(`enter select · esc ${"x".repeat(SEGMENT_CHARS_MAX)}`)).toBe(false);
    expect(looksLikeKeyHints(`enter select · esc ${"x".repeat(SEGMENT_CHARS_MAX - 4)}`)).toBe(true);
  });

  it("refuses a row where only one segment names a key", () => {
    expect(looksLikeKeyHints("esc to close · type to search")).toBe(false);
    expect(dialogScreenHash(["• Working (3s • esc to interrupt)"])).toBeNull();
  });

  it("refuses a prose row that names esc once", () => {
    expect(looksLikeKeyHints("Esc to interrupt is not a key hint here")).toBe(false);
    expect(dialogScreenHash(["I changed the esc handler so the dialog closes on the first press."])).toBeNull();
  });

  it("refuses a row with one key token, however often it names it", () => {
    expect(looksLikeKeyHints("esc to cancel")).toBe(false);
    expect(looksLikeKeyHints("esc, or esc again, or ESC")).toBe(false);
    expect(dialogScreenHash(["• Working (3s • esc to interrupt)"])).toBeNull();
  });

  it(`refuses a row longer than ${String(SCREEN_ROW_MAX)} characters, even of key hints`, () => {
    const long = `enter select · esc back · ${"type to search · ".repeat(10)}`.trim();
    expect(Array.from(normalizeRow(long)).length).toBeGreaterThan(SCREEN_ROW_MAX);
    expect(looksLikeKeyHints(normalizeRow(long))).toBe(false);
    expect(dialogScreenHash([long])).toBeNull();
    // Counted in characters after the frame is stripped, so a padded box row still fits.
    const boxed = `│ enter select · esc back${" ".repeat(200)}│`;
    expect(dialogScreenHash([boxed])).toBe(fnv1a32("enter select · esc back"));
  });

  it("refuses a transcript line: one above the tail, and one in it that names one key", () => {
    const transcript = ["› press enter and then esc to close it", "a", "b", "c", "d", "e", "f"];
    expect(dialogScreenHash(transcript)).toBeNull();
    expect(dialogScreenHash(["⏺ The dialog closes when you press Esc.", "  2 files changed"])).toBeNull();
  });

  it("gives no hash when no row names a way out", () => {
    expect(dialogScreenHash(["enter select · tab next", "↑/↓ move"])).toBeNull();
    expect(dialogScreenHash([])).toBeNull();
  });
});

describe("dialogScreenHash on real captures", () => {
  it("hashes the key-hint row of an omp dialog", () => {
    const rows = rowsOf("omp--v18-4-ask-multi.txt");
    expect(normalizeRow(wayOutRow(rows) ?? "")).toBe("␣ toggle · ⏎ submit · ↑/↓ move · ⇥/←/→ · ⎋ cancel");
    expect(dialogScreenHash(rows)).toBe(fnv1a32("␣ toggle · ⏎ submit · ↑/↓ move · ⇥/←/→ · ⎋ cancel"));
    expect(dialogScreenHash(rows)).toMatch(SCREEN_HASH);
  });

  it("gives two omp dialogs two hashes", () => {
    const usage = dialogScreenHash(rowsOf("omp--v18-17-0-usage-dashboard--w120.txt"));
    expect(usage).toBe(fnv1a32("r refresh · ⏎ details · ⎋ close"));
    expect(usage).not.toBe(dialogScreenHash(rowsOf("omp--v18-4-ask-multi.txt")));
  });

  it("gives Codex pickers that share a footer one hash, and its trust prompt another", () => {
    const model = dialogScreenHash(rowsOf("codex--v0162-picker-model.txt"));
    expect(model).toBe(fnv1a32("enter select · esc back"));
    expect(dialogScreenHash(rowsOf("codex--v0162-picker-permissions.txt"))).toBe(model);
    const trust = dialogScreenHash(rowsOf("codex--v0156-trust.txt"));
    expect(trust).toBe(fnv1a32("enter continue · esc quit"));
    expect(trust).not.toBe(model);
  });

  it("gives omp's plan review, Codex's hooks review and Codex's folder trust each a row of its own", () => {
    const plan = dialogScreenHash(rowsOf("omp--v18-16-0-plan-review--w80.txt"));
    const hooks = dialogScreenHash(rowsOf("codex--v0167-hooks-review--w120.txt"));
    const trust = dialogScreenHash(rowsOf("codex--v0167-trust--w120.txt"));
    expect(plan).toBe("cd5c9922");
    expect(hooks).toBe("634c6530");
    expect(trust).toBe("41ea66c7");
    // The same dialog at another width or with the pointer moved is the same row.
    expect(dialogScreenHash(rowsOf("omp--v18-16-0-plan-review-moved--w80.txt"))).toBe(plan);
    expect(dialogScreenHash(rowsOf("codex--v0167-hooks-review-moved--w80.txt"))).toBe(hooks);
    expect(dialogScreenHash(rowsOf("codex--v0167-trust--w80.txt"))).toBe(trust);
    expect(new Set([plan, hooks, trust, dialogScreenHash(rowsOf("codex--v0162-picker-model.txt"))]).size).toBe(4);
  });

  it("gives a Codex turn's working row no hash: its one key is esc", () => {
    const rows = rowsOf("codex--working.txt");
    expect(wayOutRow(rows)).toContain("esc to interrupt");
    expect(dialogScreenHash(rows)).toBeNull();
  });

  it("reads the card's own signature, the rows it was drawn from", () => {
    const rows = rowsOf("codex--v0162-picker-model.txt");
    const signature = rows.filter((row) => row.trim() !== "").slice(-12).join("\n");
    expect(unreadDialogScreen({ signature })).toBe(dialogScreenHash(rows));
  });
});

describe("screen.ts stays harness-agnostic", () => {
  it("names keys, never an agent program", () => {
    const source = readFileSync(join(import.meta.dirname, "screen.ts"), "utf8");
    expect(source).not.toMatch(/\b(claude|codex|omp|opencode|kiro|grok|muse|agy|hermes|cursor|droid|kimi|copilot|gemini)\b/i);
  });
});
