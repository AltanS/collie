import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { stripChrome } from "./chrome";
import { lineText } from "./markers";

// Anchored on this file's directory (see prompt-select.test.ts for why not `new URL(import.meta.url)`).
const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

// stripChrome peels the agent's own input-box + statusline + trailing blanks off the TAIL. It's
// deliberately conservative: it strips only when the full box shape matches and never removes
// content above the last real output — when unsure it returns the buffer untouched. Driven against
// the same real captures as the detector.

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

const joined = (lines: StyledLine[]) => lines.map(lineText).join("\n");

describe("stripChrome — trims the input box off the tail", () => {
  it("fresh-idle: removes the empty input box + statusline, keeps the welcome banner", () => {
    const lines = fixtureLines("claude--fresh-idle.txt");
    const kept = joined(stripChrome(lines));
    expect(stripChrome(lines).length).toBeLessThan(lines.length);
    expect(kept).toContain("Welcome back Altan!"); // real content above survives
    expect(kept).not.toContain("← for agents"); // hint line gone
    expect(kept).not.toMatch(/\/fixture-sandbox\s*$/); // statusline gone
  });

  it("working: removes the statusline + permission hint, keeps the last real output", () => {
    const lines = fixtureLines("claude--working.txt");
    const kept = joined(stripChrome(lines));
    expect(stripChrome(lines).length).toBeLessThan(lines.length);
    expect(kept).toContain("How is Claude doing this session?"); // last real block survives
    expect(kept).not.toContain("bypass permissions"); // hint line gone
    expect(kept).not.toContain("151.5k tokens"); // statusline gone
  });

  it("done: removes the input box (draft and all) + statusline, keeps the completed turn", () => {
    const lines = fixtureLines("claude--done.txt");
    const kept = joined(stripChrome(lines));
    expect(kept).toContain("Created hello.txt containing the single word hello.");
    expect(kept).not.toContain("cat hello.txt to verify"); // the input-box draft is chrome
    expect(kept).not.toContain("32.7k tokens"); // statusline gone
  });
});

describe("stripChrome — conservative: leaves non-chrome untouched", () => {
  it("returns the same buffer (same reference) when there's no tail chrome", () => {
    const lines = splitLines(parseAnsi("hello\nworld"));
    expect(stripChrome(lines)).toBe(lines);
  });

  it("does not strip a blocked-state menu (its footer is not an input box)", () => {
    const lines = fixtureLines("claude--trust-prompt.txt");
    const result = stripChrome(lines);
    expect(result).toBe(lines); // untouched
    const kept = joined(result);
    expect(kept).toContain("Enter to confirm"); // footer preserved
    expect(kept).toContain("Yes, I trust this folder"); // option preserved
  });

  it("only trims trailing blank lines when no box is present", () => {
    const lines = splitLines(parseAnsi("output line\n\n\n"));
    const kept = joined(stripChrome(lines));
    expect(kept).toBe("output line");
  });
});
