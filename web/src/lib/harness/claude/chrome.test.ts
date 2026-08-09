import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { draftCarriesSend } from "../../reply-action";
import { extractInputDraft, extractStatusLines, hasInputBox, stripChrome } from "./chrome";
import { lineText } from "./markers";

/** The statusline run as plain text. extractStatusLines returns STYLED lines — a statusline tells
 *  its fields apart by colour, so the strip needs the segments — but most assertions here are about
 *  WHICH rows come back, not how they look, and read better against text. */
const statusText = (lines: StyledLine[]): string[] =>
  extractStatusLines(lines).map((l) => lineText(l).trim());

// Anchored on this file's directory (see prompt-select.test.ts for why not `new URL(import.meta.url)`).
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

// Synthesise the input-box shape: a top rule, the "❯ …" prompt line, a bottom rule, and an optional
// statusline below it (matched by position, like the real captures). 40 glyphs is comfortably above
// isBoxBorder's BARE_BORDER_MIN floor (8) — see the narrow (19- and 8-glyph) and labelled-border
// cases below for the width-dependent bug this shape used to have.
function boxBuffer(promptLine: string, status?: string): StyledLine[] {
  const rule = "─".repeat(40);
  const rows = [rule, promptLine, rule];
  if (status !== undefined) rows.push(status);
  return splitLines(parseAnsi(rows.join("\n")));
}

// A WRAPPED-draft box: the "❯ …" prompt plus continuation lines (indented, no "❯") between the two
// rules — the shape a long draft takes. `above` is any real output that precedes the box.
function wrappedBoxBuffer(promptLine: string, continuationLines: string[], above?: string[]): StyledLine[] {
  const rule = "─".repeat(40);
  const rows = [...(above ?? []), rule, promptLine, ...continuationLines, rule];
  return splitLines(parseAnsi(rows.join("\n")));
}

// Same shape as boxBuffer, but with a caller-chosen border WIDTH — for pinning bug #76's
// width-dependent border test at a narrow (sub-20-glyph) pane.
function narrowBoxBuffer(promptLine: string, ruleWidth: number, status?: string): StyledLine[] {
  const rule = "─".repeat(ruleWidth);
  const rows = [rule, promptLine, rule];
  if (status !== undefined) rows.push(status);
  return splitLines(parseAnsi(rows.join("\n")));
}

function boxWithStatusRows(promptLine: string, statusRows: string[]): StyledLine[] {
  const rule = "─".repeat(40);
  return splitLines(parseAnsi(["earlier output", rule, promptLine, rule, ...statusRows].join("\n")));
}

function boxWithBlankFreeRunBelow(output: string[]): StyledLine[] {
  const rule = "─".repeat(40);
  return splitLines(
    parseAnsi([rule, "❯ do the earlier thing", rule, "old statusline", ...output].join("\n")),
  );
}

function echoedSendAboveDialog(sent: string, dialogRows: number): StyledLine[] {
  const rule = "─".repeat(40);
  const dialog = Array.from({ length: dialogRows }, (_, k) => `  ${k + 1}. dialog row`);
  return splitLines(
    parseAnsi(["earlier output", rule, `❯ ${sent}`, rule, ...dialog, "", "Esc to cancel"].join("\n")),
  );
}

function trailingBlankCount(lines: StyledLine[]): number {
  let count = 0;
  while (count < lines.length && lineText(lines[lines.length - 1 - count]!).trim().length === 0) count++;
  return count;
}

function keptAboveTail(lines: StyledLine[]): number {
  return lines.length - trailingBlankCount(lines);
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

  // The newer Claude Code UI paints a "background agents" footer BELOW the statusline/hint, separated
  // by a blank line. It broke the bottom-up anchor (only the statusline window was tolerated), so the
  // whole box stayed visible on the mirror AND no draft chip surfaced. These three cover empty /
  // single-line / wrapped drafts with that footer present — see the real-capture cohort in the README.
  it("footer variant (empty prompt): strips the box + statusline + hint + background-agents footer", () => {
    const lines = fixtureLines("claude--draft-footer-empty.txt");
    const kept = joined(stripChrome(lines));
    expect(stripChrome(lines).length).toBeLessThan(lines.length);
    expect(kept).toContain("Wired up the token refresh path"); // real content above survives
    expect(kept).not.toContain("● main"); // footer header gone
    expect(kept).not.toContain("worker:scout"); // footer agent row gone
    expect(kept).not.toContain("bypass permissions"); // hint gone
    expect(kept).not.toContain("ctx:33%"); // statusline gone
  });

  it("footer variant (single-line draft): strips the box AND the footer below it", () => {
    const lines = fixtureLines("claude--draft-footer-single.txt");
    const kept = joined(stripChrome(lines));
    expect(kept).toContain("Wired up the token refresh path"); // content above survives
    expect(kept).not.toContain("update the changelog"); // the box draft is chrome
    expect(kept).not.toContain("● main"); // footer gone with the box
  });

  it("footer variant (wrapped draft): strips the multi-line box AND the footer", () => {
    const lines = fixtureLines("claude--draft-footer-wrapped.txt");
    const kept = joined(stripChrome(lines));
    expect(kept).toContain("Wired up the token refresh path"); // content above survives
    expect(kept).not.toContain("soft-wraps it onto several"); // wrapped continuation gone
    expect(kept).not.toContain("worker:scout"); // footer gone
  });
});

describe("stripChrome — conservative: leaves non-chrome untouched", () => {
  it("returns the same buffer (same reference) when there's no tail chrome", () => {
    const lines = splitLines(parseAnsi("hello\nworld"));
    expect(stripChrome(lines)).toBe(lines);
  });

  it("strips a WRAPPED draft box (multi-line ❯) off the tail, keeping the output above", () => {
    // A long stranded draft soft-wraps onto continuation lines inside the box; the whole box must
    // still come off the mirror (regression: it used to stay visible, raw draft and all).
    const lines = fixtureLines("claude--draft-wrapped.txt");
    const kept = joined(stripChrome(lines));
    expect(stripChrome(lines).length).toBeLessThan(lines.length);
    expect(kept).toContain("Welcome back altan!"); // real content above survives
    expect(kept).not.toContain("soft-wraps"); // the wrapped-draft continuation is gone
    expect(kept).not.toContain("used to stay"); // ...and its last line too
    expect(kept).not.toContain("manual mode on"); // statusline/hint gone with the box
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

// extractStatusLines re-surfaces the statusline RUN stripChrome removes (the branch/model/ctx/
// permission mode the user configured) so the app can render it above the composer — positional
// (every non-blank line below the input box's bottom border, above the background-agents footer),
// never content-parsed. All rows, not just the first: rows 2+ used to be stripped and rendered
// nowhere.
describe("extractStatusLines — recovers the stripped statusline run", () => {
  it("working: returns the statusline including the branch (the field the field-report flagged)", () => {
    const rows = statusText(fixtureLines("claude--working.txt"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toContain("feature/block-renderer"); // the branch survives
    expect(rows[0]).toContain("151.5k tokens");
    // The hint row below it is its own entry now — it used to be dropped on the floor.
    expect(rows.join("\n")).toContain("bypass permissions");
  });

  it("fresh-idle: returns the statusline AND the hint row under it, in order", () => {
    const rows = statusText(fixtureLines("claude--fresh-idle.txt"));
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("fixture-sandbox");
    expect(rows[1]).toContain("← for agents");
  });

  it("done: returns the statusline of a completed turn", () => {
    const rows = statusText(fixtureLines("claude--done.txt"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toContain("tokens");
  });

  it("footer variant: returns the statusline + hint, but NOT the background-agents footer", () => {
    const rows = statusText(fixtureLines("claude--draft-footer-empty.txt"));
    expect(rows[0]).toContain("ctx:33%"); // the statusline itself
    expect(rows.join("\n")).toContain("bypass permissions"); // the hint row is part of the run
    expect(rows.join("\n")).not.toContain("worker:scout"); // …the footer below the blank is not
    expect(rows.join("\n")).not.toContain("● main");
  });

  // The shape that motivated this (verified on a real host): a 3-row statusline under the box. The
  // model, cwd, branch and permission mode all live on rows 2 and 3 — surfacing only row 1 made
  // them invisible everywhere, since stripChrome (correctly) peels the whole run off the mirror.
  it("a real 3-row statusline surfaces every row, in TUI order", () => {
    const REAL_ROWS = [
      "  CTX:20% CACHE:100% LIMITS 5h:22%/1h:20m 7d:26%/5d:03h",
      "  [Opus·medium] ~/projects/workspace-sprqvntrs/argo-sprqvntrs on main*",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents",
    ];
    // U+00A0 after the marker, as Claude renders it — never a plain space.
    const lines = boxWithStatusRows("❯\u00A0", REAL_ROWS);
    expect(statusText(lines)).toEqual(REAL_ROWS.map((r) => r.trim()));
  });

  // The rows come back STYLED, which is the whole reason the strip can show a statusline the way its
  // author meant it: fields are told apart by colour before they are read. Flattening to text here
  // (what this used to do) threw the colour away one call before the surface that renders it.
  it("keeps each row's colour, not just its text", () => {
    const ESC = "\x1b";
    const lines = boxWithStatusRows("❯ ", [
      `${ESC}[32mCTX:20%${ESC}[0m ${ESC}[33mmain*${ESC}[0m`,
    ]);
    const rows = extractStatusLines(lines);
    expect(rows.length).toBe(1);
    // Two differently-coloured runs, both carrying a colour — a flattened row would be one bare
    // segment with no style at all.
    const coloured = rows[0]!.segments.filter((s) => s.style.color !== undefined);
    expect(coloured.length).toBeGreaterThanOrEqual(2);
    expect(coloured[0]!.style.color).not.toBe(coloured[1]!.style.color);
    expect(lineText(rows[0]!)).toContain("CTX:20%");
  });

  it("a single-row statusline is a one-element array (no visual change for those panes)", () => {
    const lines = boxWithStatusRows("❯\u00A0fix the flaky test", ["[Opus 4.8] · ctx:3% · main · 32k tokens"]);
    expect(statusText(lines)).toEqual(["[Opus 4.8] · ctx:3% · main · 32k tokens"]);
  });

  it("returns [] for a box with no statusline under it at all", () => {
    expect(extractStatusLines(boxBuffer("❯\u00A0draft"))).toEqual([]);
  });

  it("returns [] when a menu is up (no input box at the tail)", () => {
    expect(extractStatusLines(fixtureLines("claude--select-menu.txt"))).toEqual([]);
    expect(extractStatusLines(fixtureLines("claude--trust-prompt.txt"))).toEqual([]);
    expect(extractStatusLines(fixtureLines("claude--permission-bash.txt"))).toEqual([]);
  });

  it("returns [] for a plain buffer with no input box", () => {
    expect(extractStatusLines(splitLines(parseAnsi("just some output\nmore output")))).toEqual([]);
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

  // Background-agents footer present below the box — the case that regressed on real panes: the extra
  // footer lines broke locateInputBox, so no draft surfaced. With the footer tolerated, an empty box
  // is still null (no chip), and a real draft (single-line or wrapped) is recovered as before.
  it("footer variant (empty box): no draft to recover", () => {
    expect(extractInputDraft(fixtureLines("claude--draft-footer-empty.txt"))).toBeNull();
  });

  it("footer variant (single-line draft): recovers the draft above the footer", () => {
    expect(extractInputDraft(fixtureLines("claude--draft-footer-single.txt"))).toBe(
      "remember to update the changelog before tagging",
    );
  });

  it("footer variant (wrapped draft): folds the continuations back, footer notwithstanding", () => {
    expect(extractInputDraft(fixtureLines("claude--draft-footer-wrapped.txt"))).toBe(
      "this stranded draft is long enough that the Claude Code TUI soft-wraps it onto several continuation lines inside the input box while the background-agents footer sits below the box",
    );
  });

  it("folds a WRAPPED draft back into one line (real capture)", () => {
    // A long draft the TUI soft-wrapped across the box — the continuation lines are stitched back on.
    const draft = extractInputDraft(fixtureLines("claude--draft-wrapped.txt"));
    expect(draft).toBe(
      "this stranded draft is long enough that Claude soft-wraps it onto several lines inside the input box which is exactly the case that used to stay visible",
    );
  });

  it("joins a synthetic wrapped draft with single spaces (de-indented continuations)", () => {
    const draft = extractInputDraft(
      wrappedBoxBuffer("❯ the quick brown fox jumps over", ["  the lazy dog again and", "  again"]),
    );
    expect(draft).toBe("the quick brown fox jumps over the lazy dog again and again");
  });

  // Bug #76 fix: the wrapped-draft scan used to be bounded by MAX_DRAFT_LINES (12), so a draft long
  // enough to wrap past that many continuation rows made locateInputBox return null — the send guard
  // then saw no draft at all and stalled forever even though the text had landed. The bound is now
  // 100 (defense-in-depth, not a correctness bound — see the comment on MAX_DRAFT_LINES in chrome.ts),
  // comfortably above real wraps, so a draft this long is still found.
  it("matches a box whose draft wraps past the old 12-line bound", () => {
    const many = Array.from({ length: 20 }, (_, i) => `  continuation ${i}`);
    const draft = extractInputDraft(wrappedBoxBuffer("❯ opening line", many));
    expect(draft).toBe(["opening line", ...many.map((l) => l.trim())].join(" "));
  });

  // A very long draft (610 chars / 25 logical lines, per the issue) can wrap to ~40 rows at a narrow
  // pane's column count. Pin that the walk reaches all the way up to the prompt (well past the old
  // 12-line cap, comfortably under the new 100-line one), and that the resulting join is exactly what
  // reply-action's draftCarriesSend needs to verify the send actually landed.
  it("extracts a ~40-row wrapped draft in full, and it verifies a real send via draftCarriesSend", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const wordsPerRow = 5;
    const rows: string[] = [];
    for (let i = 0; i < words.length; i += wordsPerRow) rows.push(words.slice(i, i + wordsPerRow).join(" "));
    expect(rows.length).toBeGreaterThan(30); // comfortably past the old 12-line cap
    expect(rows.length).toBeLessThan(100); // and comfortably under the new one
    const [first, ...continuationRows] = rows;
    const lines = wrappedBoxBuffer(`❯ ${first}`, continuationRows.map((r) => `  ${r}`));

    const draft = extractInputDraft(lines);
    expect(draft).toBe(rows.join(" "));

    const sent = words.join(" "); // what the composer actually typed, single-space separated
    expect(draftCarriesSend(sent, draft)).toBe(true);
  });

  // The Latin case above wraps at WORD boundaries, so every fold seam extractInputDraft inserts
  // happens to coincide with a real space in `sent` — draftCarriesSend's "loosen only the fold's own
  // seam" logic (reply-action.ts) is never actually exercised by it. CJK text wraps mid-run (no spaces
  // to break at), so EVERY seam in a real CJK draft is fabricated by the fold, never a genuine space —
  // this is the case that actually needs the loosening.
  it("extracts a ~40-row wrapped CJK draft (no natural spaces) verified through the fold-seam path", () => {
    const PHRASE = "これはとても長いテストメッセージですのでどうぞよろしくお願いします"; // no spaces
    const sentJa = PHRASE.repeat(Math.ceil(640 / PHRASE.length)).slice(0, 640); // exactly 640 chars
    const CHARS_PER_ROW = 16; // simulates a narrow pane, where 2-cell-wide CJK glyphs wrap often
    const rows: string[] = [];
    for (let i = 0; i < sentJa.length; i += CHARS_PER_ROW) rows.push(sentJa.slice(i, i + CHARS_PER_ROW));
    expect(rows.length).toBe(40);
    const [first, ...continuationRows] = rows;
    const lines = wrappedBoxBuffer(`❯ ${first}`, continuationRows.map((r) => `  ${r}`));

    const draft = extractInputDraft(lines);
    // Every seam here is FABRICATED by the fold (sentJa has no spaces anywhere) — draftCarriesSend
    // must treat each one as an unknowable-width gap rather than require sentJa to hold a literal
    // space at every row boundary.
    expect(draft).toBe(rows.join(" "));
    expect(draftCarriesSend(sentJa, draft)).toBe(true);
  });

  // Bug #76 (finding 2, defense-in-depth): the draft-walk cap (100) exists so a stray line that merely
  // LOOKS like a border can't pair up with a genuinely-quoted "❯" line dozens of rows away to complete
  // a bogus box shape. Pin that the cap actually stops such a far-apart match — a real top border, a
  // real "❯" line, then well over 100 lines of ordinary filler before the (stray-looking) bottom
  // border must NOT locate a box at all.
  it("does not pair a far-away ❯ line with a border more than the draft cap apart", () => {
    const filler = Array.from({ length: 105 }, (_, i) => `filler line ${i}`); // > MAX_DRAFT_LINES (100)
    const lines = wrappedBoxBuffer("❯ this quote is not really the current draft", filler);
    expect(extractInputDraft(lines)).toBeNull();
  });

  // Round-3 finding 2: the two blank-line skips inside locateInputBox step (d) used to be UNBOUNDED
  // (`while (isBlank) i--`), run before/after the counted continuation walk rather than as part of it
  // — so a wall of blank lines could stand in for the non-blank filler above and reach an arbitrarily
  // distant border for free, defeating MAX_DRAFT_LINES entirely for that shape. Both spots now draw
  // from the SAME `wrapped` counter as the continuation walk itself.
  it("does not tolerate 105 blank lines between the ❯ line and the bottom border", () => {
    // These blanks sit exactly where the old free pre-skip used to run: contiguous with the bottom
    // border, walked BEFORE the (previously) counted loop ever started.
    const blanks = Array.from({ length: 105 }, () => "");
    const lines = wrappedBoxBuffer("❯ this line is far from the border", blanks);
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("does not tolerate 105 blank lines between the top border and the ❯ line", () => {
    // These blanks sit where the old free post-prompt skip used to run: between the prompt and the
    // top border, walked AFTER the "❯" line was already found.
    const rule = "─".repeat(40);
    const blanks = Array.from({ length: 105 }, () => "");
    const lines = splitLines(parseAnsi([rule, ...blanks, "❯ padded draft", rule].join("\n")));
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("still tolerates a few blank padding lines between the top border and the prompt", () => {
    // Existing (pre-fix) behaviour preserved: a small amount of blank padding is well under the cap,
    // so it's still just tolerated, not treated as suspicious.
    const rule = "─".repeat(40);
    const lines = splitLines(parseAnsi([rule, "", "", "❯ padded draft", rule].join("\n")));
    expect(extractInputDraft(lines)).toBe("padded draft");
  });
});

// Finding 1 (field review): isBoxBorder used to delegate to isHorizontalRule, whose whitespace-
// stripping let a spaced-out prose separator compact into "nothing but rule glyphs". That let a fake
// dialog buffer complete the FULL border→❯→border shape locateInputBox looks for and get read as a
// live composer — meaning a guarded reply could type into (and, on the old code path, submit into) a
// real permission dialog sitting right below it. Traced repro from the review, verbatim.
describe("a fake box shape built from spaced-out em-dash separators is not an input box", () => {
  const lines = splitLines(
    parseAnsi(
      [
        "— — —",
        "❯ approve deployment now",
        "— — —",
        "Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        "",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    ),
  );

  it("extractInputDraft finds no draft", () => {
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("hasInputBox reports no composer on screen (the dialog owns the keyboard)", () => {
    expect(hasInputBox(lines)).toBe(false);
  });
});

// Bug #76, first failure mode: isBoxBorder used to require 20+ consecutive rule glyphs, which is
// width-dependent — Herdr's shared grid follows the narrowest attached client, so a split pane's
// border can render well under 20 glyphs (19 observed). And Claude sometimes splices a session/job
// name into the TOP border, splitting its run so neither flank reaches 20 even at a normal width.
describe("locateInputBox at a narrow pane width / with a labelled top border", () => {
  it("locates a box whose borders are exactly 19 glyphs wide (below the old 20-glyph floor)", () => {
    const lines = narrowBoxBuffer("❯ narrow pane draft", 19);
    expect(extractInputDraft(lines)).toBe("narrow pane draft");
  });

  it("locates a box whose TOP border carries a spliced label, on a narrow pane", () => {
    // Observed real capture: flanks 5/2 at 43 columns.
    const topBorder = "───── japanese technical troubleshooting ──";
    const bottomBorder = "─".repeat(19);
    const lines = splitLines(
      parseAnsi([topBorder, "❯ reply about the troubleshooting doc", bottomBorder].join("\n")),
    );
    expect(extractInputDraft(lines)).toBe("reply about the troubleshooting doc");
  });

  // Round-3 finding 1: traced against the bundled renderer's own label-placement math, a top border's
  // flank can clamp down to exactly 1 glyph (align:"center", or align:"end" with a zero offset).
  // locateInputBox's step (e) uses isInputBoxTopBorder specifically so this real shape still locates
  // the box.
  it("locates a box whose TOP border has a 1-glyph flank (renderer's align:center/end clamp)", () => {
    const lines = splitLines(
      parseAnsi(["──── fast mode ─", "❯ reply while fast mode is on", "─".repeat(19)].join("\n")),
    );
    expect(extractInputDraft(lines)).toBe("reply while fast mode is on");
  });

  // Strictness boundary: the looser top-border floor is specific to the renderer's real clamp — it
  // must NOT reopen the em-dash-prose hole finding 1 closed. Same box shape as the fake-dialog test
  // above, but as the TOP border of an otherwise well-formed box; still not a box.
  it("does NOT locate a box whose TOP border is a spaced em-dash separator", () => {
    const lines = splitLines(parseAnsi(["— — —", "❯ reply text", "─".repeat(19)].join("\n")));
    expect(extractInputDraft(lines)).toBeNull();
    expect(hasInputBox(lines)).toBe(false);
  });
});

// Round-4 finding: a labelled top border's per-flank minimums alone don't rule out a total width
// narrower than any bare border the renderer can actually draw — the renderer draws a box's top and
// bottom border at the SAME width, and the bare bottom border already requires >= 8 columns. Traced
// bypass buffer from the review, verbatim: a 5-column "─ x ─" top border, an echoed "❯" line, an
// 8-column bare bottom border (just wide enough to pass on its own), then a real permission dialog
// below it. Before the shared width floor, this walked footer → status → 8-glyph bottom → echoed ❯ →
// "─ x ─" as a (loose) top border and reported a composer on screen over a live dialog.
describe("a labelled top border narrower than any real bare border is not an input box", () => {
  const lines = splitLines(
    parseAnsi(
      [
        "─ x ─",
        "❯ approve deployment now",
        "────────",
        "Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        "",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    ),
  );

  it("extractInputDraft finds no draft", () => {
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("hasInputBox reports no composer on screen (the dialog owns the keyboard)", () => {
    expect(hasInputBox(lines)).toBe(false);
  });
});

// Round-5 finding: the shared width floor above must be measured in DISPLAY CELLS, not UTF-16
// `.length` — a combining-mark label can read AT or above the floor in `.length` while actually being
// narrower in real terminal columns. Same bypass shape as the round-4 buffer above, but the top
// border's `.length` (8) alone would have cleared the OLD (length-based) floor; only measuring in
// display cells (7, one short) correctly still rejects it.
describe("a combining-mark top border whose .length clears the floor but whose display width doesn't", () => {
  // Explicit decomposed form (base "e" + combining acute U+0301), NOT the precomposed "é" glyph —
  // that would collapse to a single UTF-16 unit and defeat the point of this fixture.
  const topBorder = "── e" + "́" + " ──"; // .length 8, displayWidth 7
  const lines = splitLines(
    parseAnsi(
      [
        topBorder,
        "❯ approve deployment now",
        "────────",
        "Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        "",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    ),
  );

  it("extractInputDraft finds no draft", () => {
    expect(topBorder.length).toBe(8);
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("hasInputBox reports no composer on screen (the dialog owns the keyboard)", () => {
    expect(hasInputBox(lines)).toBe(false);
  });
});

describe("the statusline run — as tall as a real statusline", () => {
  const DRAFT = "my draft text here";
  const statusRows = (n: number) => Array.from({ length: n }, (_, i) => `status row ${i}`);

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("locates the box under %i statusline row(s)", (rows) => {
    const lines = boxWithStatusRows(`❯ ${DRAFT}`, statusRows(rows));
    expect(extractInputDraft(lines)).toBe(DRAFT);
    expect(statusText(lines)).toEqual(statusRows(rows)); // every row, however tall the run
    expect(stripChrome(lines)).not.toBe(lines);
  });

  it.each([9, 10])("falls back to the raw mirror at %i rows, the deliberate ceiling", (rows) => {
    const lines = boxWithStatusRows(`❯ ${DRAFT}`, statusRows(rows));
    expect(extractInputDraft(lines)).toBeNull();
    expect(extractStatusLines(lines)).toEqual([]);
    expect(stripChrome(lines)).toBe(lines);
  });
});

describe("dialogs are refused by the border and blank checks — not by the row bound", () => {
  const DIALOG_FIXTURES = [
    "claude--permission-bash.txt",
    "claude--permission-edit.txt",
    "claude--plan-approval--numbered-body.txt",
    "claude--plan-approval.txt",
    "claude--select-menu.txt",
    "claude--select-multi.txt",
    "claude--select-multiselect-checked.txt",
    "claude--select-multiselect-review.txt",
    "claude--select-multiselect-single.txt",
    "claude--select-preview-note-attached.txt",
    "claude--select-preview-note-input.txt",
    "claude--select-preview.txt",
    "claude--trust-prompt.txt",
    "claude--wizard-preview-note-attached.txt",
    "claude--wizard-preview-q1.txt",
    "claude--wizard-q1-revisit.txt",
    "claude--wizard-q1.txt",
    "claude--wizard-q2.txt",
    "claude--wizard-submit-unanswered.txt",
    "claude--wizard-submit.txt",
  ];

  it.each(DIALOG_FIXTURES)("%s surfaces no box, so no chrome is stripped from it", (name) => {
    const lines = fixtureLines(name);
    expect(extractStatusLines(lines)).toEqual([]);
    expect(extractInputDraft(lines)).toBeNull();
    expect(stripChrome(lines).length).toBe(keptAboveTail(lines));
  });

  it.each(DIALOG_FIXTURES)("%s ends its tail run with a blank within 2 rows", (name) => {
    const texts = fixtureLines(name).map(lineText);
    let end = texts.length;
    while (end > 0 && texts[end - 1]!.trim().length === 0) end--;
    let run = 0;
    while (end - 1 - run >= 0 && texts[end - 1 - run]!.trim().length > 0) run++;
    expect(run).toBeGreaterThan(0);
    expect(run).toBeLessThanOrEqual(2);
  });
});

describe("the row bound only catches a run taller than any plausible statusline", () => {
  const outputRows = (n: number) => Array.from({ length: n }, (_, i) => `tool output ${i}`);

  it("refuses a complete box above an 8-row blank-free run", () => {
    const lines = boxWithBlankFreeRunBelow(outputRows(8));
    expect(extractStatusLines(lines)).toEqual([]);
    expect(extractInputDraft(lines)).toBeNull();
    expect(stripChrome(lines)).toBe(lines);
  });

  it("known limitation: a complete box above a 7-row blank-free run reads as live", () => {
    const lines = boxWithBlankFreeRunBelow(outputRows(7));
    expect(extractInputDraft(lines)).toBe("do the earlier thing");
    expect(lines.length - stripChrome(lines).length).toBe(11);
  });
});

describe("scrollback echo — a known limitation, pinned on purpose", () => {
  const SENT = "please run the database migration now";

  it.each([3, 8])("reads an echo of our own send back as a draft at %i dialog rows", (rows) => {
    expect(extractInputDraft(echoedSendAboveDialog(SENT, rows))).toBe(SENT);
  });

  it("stops reading the echo once the run passes the bound", () => {
    expect(extractInputDraft(echoedSendAboveDialog(SENT, 9))).toBeNull();
  });

  it.each(["claude--select-menu.txt", "claude--select-multi.txt"])(
    "%s: a real ❯ echo with transcript above it is not read as a draft",
    (name) => {
      expect(extractInputDraft(fixtureLines(name))).toBeNull();
    },
  );
});

describe("real corpus — pinned so any change to the walk shows up as a diff", () => {
  // `statusRows` is the HEIGHT of the re-surfaced statusline run, not a boolean: every real capture
  // in this corpus is 2 rows (statusline + hint), and pinning the count is what would have caught the
  // first-row-only truncation this table used to tolerate.
  const PINNED: { fixture: string; statusRows: number; draft: string | null; stripped: number }[] = [
    { fixture: "done", statusRows: 2, draft: "cat hello.txt to verify", stripped: 28 },
    { fixture: "draft-footer-empty", statusRows: 2, draft: null, stripped: 9 },
    { fixture: "draft-footer-single", statusRows: 2, draft: "remember to update the changelo", stripped: 9 },
    { fixture: "draft-footer-wrapped", statusRows: 2, draft: "this stranded draft is long eno", stripped: 11 },
    { fixture: "draft-paste-placeholder", statusRows: 2, draft: "[Pasted text #3 +3 lines]", stripped: 7 },
    { fixture: "draft-wrapped", statusRows: 2, draft: "this stranded draft is long eno", stripped: 10 },
    { fixture: "fresh-idle", statusRows: 2, draft: null, stripped: 47 },
    { fixture: "permission-bash", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "permission-edit", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "plan-approval", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "menu-model-picker", statusRows: 0, draft: null, stripped: 1 },
    { fixture: "menu-model-picker-dismissed", statusRows: 3, draft: null, stripped: 7 },
    { fixture: "menu-model-picker-moved", statusRows: 0, draft: null, stripped: 1 },
    { fixture: "plan-approval--numbered-body", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "rename-resolved", statusRows: 2, draft: null, stripped: 6 },
    { fixture: "select-menu", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "select-multi", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "select-multiselect-checked", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "select-multiselect-review", statusRows: 0, draft: null, stripped: 5 },
    { fixture: "select-multiselect-single", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "select-preview", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "select-preview-note-attached", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "select-preview-note-input", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "send-inflight", statusRows: 2, draft: "/rename", stripped: 5 },
    { fixture: "trust-prompt", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-multiselect-checked", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-multiselect-final", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-multiselect-pointer-next", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-multiselect-q1", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-preview-note-attached", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-preview-q1", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-preview-wrapped-label", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-q1", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-q1-revisit", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-q2", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-submit", statusRows: 0, draft: null, stripped: 0 },
    { fixture: "wizard-submit-unanswered", statusRows: 0, draft: null, stripped: 3 },
    { fixture: "working", statusRows: 2, draft: null, stripped: 6 },
  ];

  it("pins every claude fixture on disk, so a new capture can't slip past this table", () => {
    const onDisk = readdirSync(PANES_DIR)
      .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
      .map((f) => f.replace("claude--", "").replace(".txt", ""))
      .sort();
    expect(onDisk).toEqual(PINNED.map((p) => p.fixture).sort());
  });

  it.each(PINNED)("$fixture classifies identically", ({ fixture, statusRows, draft, stripped }) => {
    const lines = fixtureLines(`claude--${fixture}.txt`);
    expect(extractStatusLines(lines).length).toBe(statusRows);
    if (draft === null) {
      expect(extractInputDraft(lines)).toBeNull();
    } else {
      expect(extractInputDraft(lines)).toContain(draft);
    }
    expect(lines.length - stripChrome(lines).length).toBe(stripped);
  });
});
