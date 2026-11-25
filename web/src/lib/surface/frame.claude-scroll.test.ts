import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANES_DIR, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { extractInputDraft } from "../harness/claude/chrome";
import { inputFrameOf, surfaceOfScreen } from "./fold";
import { findInputFrame, pastPrompt, wholeDraft } from "./frame";
import { requireProfile } from "./profile";

const IDLE = requireProfile("claude").idle;
const rows = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "claude--v2331-draft-scrolled-up--w59.txt"), "utf8")));
const GREY = (s: string): string => `\u001b[38;2;136;136;136m${s}\u001b[0m`;
const RULE = "─".repeat(40);
const screen = (lines: readonly string[]) => splitLines(parseAnsi(lines.join("\n")));
const surfaceOf = (lines: readonly string[]) => surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows: screen(lines), ask: null }, IDLE);

describe("Claude Code 2.1.331 box scrolled past its height (`─── ↑ 5 more ───`, no ❯ row in view)", () => {
  it("is still the input box, marked scrolled, with the visible tail as its text", () => {
    const frame = findInputFrame(rows, IDLE);
    expect(frame).not.toBeNull();
    expect(frame!.top).toBe(1);
    expect(frame!.bottom).toBe(5);
    expect(frame!.scrolled).toBe(true);
    expect(frame!.label).toBe("↑ 5 more");
    expect(frame!.interior.text.startsWith("of view. Collie looks for that prompt line")).toBe(true);
    expect(frame!.interior.text.endsWith("without pressing Enter.")).toBe(true);
  });

  it("is past its prompt row, and its tail is no whole draft: every reader of the draft gets none", () => {
    const frame = findInputFrame(rows, IDLE)!;
    expect(pastPrompt(frame)).toBe(true);
    expect(wholeDraft(frame)).toBeNull();
    expect(extractInputDraft(rows)).toBeNull();
  });

  it("reads as a draft when its rows in view are blank: the head of the draft stands above them", () => {
    const lines = ["> an earlier question", "", GREY(`─── ↑ 2 more ${"─".repeat(27)}`), "", "", "", GREY(RULE), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];
    const read = surfaceOf(lines);
    expect(read.frame?.scrolled).toBe(true);
    expect(read.frame?.interior.text).toBe("");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  it("a `↑ N more` row and a rule in the transcript over a dialog are no box", () => {
    const lines = [
      "> an earlier question",
      "─── ↑ 5 more ───────────────────────────",
      "  of view. Collie looks for that prompt",
      "  typing without pressing Enter.",
      RULE,
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      " Esc to cancel · Enter to select",
    ];
    expect(findInputFrame(screen(lines), IDLE)?.scrolled).toBe(true);
    expect(inputFrameOf(screen(lines), IDLE)).toBeNull();
    expect(surfaceOf(lines).surface).toMatchObject({ turn: "unknown", modal: "unreadable", composer: "unknown" });
  });

  it("the same box with its prompt row in view over the same dialog is taken as before (the rule is the scrolled box's own)", () => {
    const lines = ["> an earlier question", RULE, "❯ of view. Collie looks for that prompt", "  typing without pressing Enter.", RULE, "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Enter to select"];
    expect(inputFrameOf(screen(lines), IDLE)).toEqual(findInputFrame(screen(lines), IDLE));
  });
});

describe("wholeDraft", () => {
  it("is the text of a box that shows its whole draft, and empty for the placeholder", () => {
    const draft = findInputFrame(screen(["> q", "", GREY(RULE), "❯ hello there", GREY(RULE), "  status"]), IDLE)!;
    expect(wholeDraft(draft)).toBe("hello there");
    const placeholder = findInputFrame(screen(["> q", "", GREY(RULE), '❯ \u001b[2mTry "fix the failing tests"\u001b[0m', GREY(RULE), "  status"]), IDLE)!;
    expect(placeholder.placeholder).toBe(true);
    expect(wholeDraft(placeholder)).toBe("");
  });

  it("is null for omp's box at its scroll height too, which keeps its prompt row in view", () => {
    const omp = requireProfile("omp").idle;
    const frame = findInputFrame(splitLines(parseAnsi(readFileSync(join(SURFACE_FIXTURES_DIR, "omp--draft-scrolled-2000-chars--v18.6.1.txt"), "utf8"))), omp)!;
    expect(frame.scrolled).toBe(true);
    expect(pastPrompt(frame)).toBe(false);
    expect(wholeDraft(frame)).toBeNull();
  });
});
