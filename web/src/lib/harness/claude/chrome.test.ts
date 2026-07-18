import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { extractInputDraft, extractStatusLine, stripChrome } from "./chrome";
import { lineText } from "./markers";

// Anchored on this file's directory (see prompt-select.test.ts for why not `new URL(import.meta.url)`).
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

// Synthesise the input-box shape: a top rule, the "❯ …" prompt line, a bottom rule, and an optional
// statusline below it (matched by position, like the real captures). 40 box glyphs clear the
// 20-glyph border threshold in isBoxBorder.
function boxBuffer(promptLine: string, status?: string): StyledLine[] {
  const rule = "─".repeat(40);
  const rows = [rule, promptLine, rule];
  if (status !== undefined) rows.push(status);
  return splitLines(parseAnsi(rows.join("\n")));
}

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

// extractStatusLine re-surfaces the one statusline stripChrome removes (the branch/model/ctx the
// user configured) so the app can render it above the composer — positional (first non-blank line
// below the input box's bottom border), never content-parsed.
describe("extractStatusLine — recovers the stripped statusline", () => {
  it("working: returns the statusline including the branch (the field the field-report flagged)", () => {
    const status = extractStatusLine(fixtureLines("claude--working.txt"));
    expect(status).not.toBeNull();
    expect(status).toContain("feature/block-renderer"); // the branch survives
    expect(status).toContain("151.5k tokens");
    expect(status).not.toContain("bypass permissions"); // the hint line below it is NOT returned
  });

  it("fresh-idle: returns the statusline, not the hint line under it", () => {
    const status = extractStatusLine(fixtureLines("claude--fresh-idle.txt"));
    expect(status).not.toBeNull();
    expect(status).toContain("fixture-sandbox");
    expect(status).not.toContain("← for agents");
  });

  it("done: returns the statusline of a completed turn", () => {
    const status = extractStatusLine(fixtureLines("claude--done.txt"));
    expect(status).not.toBeNull();
    expect(status).toContain("tokens");
  });

  it("returns null when a menu is up (no input box at the tail)", () => {
    expect(extractStatusLine(fixtureLines("claude--select-menu.txt"))).toBeNull();
    expect(extractStatusLine(fixtureLines("claude--trust-prompt.txt"))).toBeNull();
    expect(extractStatusLine(fixtureLines("claude--permission-bash.txt"))).toBeNull();
  });

  it("returns null for a plain buffer with no input box", () => {
    expect(extractStatusLine(splitLines(parseAnsi("just some output\nmore output")))).toBeNull();
  });
});

// extractInputDraft recovers a user draft stranded on the "❯" prompt line (a queued-then-recalled
// message that stripChrome would otherwise hide) — the marker + separator stripped, trimmed; null
// for an empty box, a TUI placeholder, or no box at the tail.
describe("extractInputDraft — recovers a stranded prompt-line draft", () => {
  it("done: returns the draft left in the input box (the text stripChrome hides)", () => {
    // The same fixture whose draft stripChrome removes as chrome — here we surface it instead.
    const draft = extractInputDraft(fixtureLines("claude--done.txt"));
    expect(draft).toBe("cat hello.txt to verify");
  });

  it("returns null for an empty box (bare ❯)", () => {
    expect(extractInputDraft(boxBuffer("❯"))).toBeNull();
    expect(extractInputDraft(boxBuffer("❯ "))).toBeNull();
  });

  it("returns null for the queued-messages placeholder line", () => {
    expect(extractInputDraft(boxBuffer("❯ Press up to edit queued messages"))).toBeNull();
  });

  it("returns null when there's no input box at the tail", () => {
    expect(extractInputDraft(splitLines(parseAnsi("just some output\nmore output")))).toBeNull();
    expect(extractInputDraft(fixtureLines("claude--trust-prompt.txt"))).toBeNull();
  });

  it("returns the draft even when a statusline sits below the box", () => {
    const draft = extractInputDraft(boxBuffer("❯ fix the flaky test", "[Opus 4.8] · ctx:3% · main · 32k tokens"));
    expect(draft).toBe("fix the flaky test");
  });

  it("trims leading and trailing whitespace around the draft", () => {
    expect(extractInputDraft(boxBuffer("❯   spaced out draft   "))).toBe("spaced out draft");
  });

  // Ground truth for the in-flight self-race (fix: draft-detect). The parse is stateless per snapshot
  // by design, so it DOES read our own just-typed reply as a "draft" during the bridge's ~350ms
  // send_text→Enter gap — that's exactly why the cross-poll stabiliser + match-last-sent guard exist
  // upstream (see use-terminal-draft.ts / composer.tsx). These two pin the parse behaviour those
  // guards depend on.
  it("mid-send in-flight frame: reads the just-typed text off the ❯ line (the false positive to suppress)", () => {
    // The composer typed "/rename"; the bridge hasn't pressed Enter yet, so it sits on the box line.
    expect(extractInputDraft(fixtureLines("claude--send-inflight.txt"))).toBe("/rename");
  });

  it("self-resolved rename frame: the box is empty again, so no draft is read", () => {
    // A poll or two later the command has submitted (spinner up, prompt cleared) — nothing stranded.
    expect(extractInputDraft(fixtureLines("claude--rename-resolved.txt"))).toBeNull();
  });
});
