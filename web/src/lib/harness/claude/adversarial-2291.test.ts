import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../../blocks";
import { buildBlocks, withUnreadDialog } from "../index";
import { claudeAdapter } from ".";
import { detectAutocompleteRegion } from "./autocomplete";
import { extractInputDraft, hasInputBox, inputBoxTail } from "./chrome";
import { classifyFooter, namesPlanDialog } from "./markers";
import { detectPromptSelect } from "./prompt-select";

// Adversarial screens for the Claude Code 2.1.291 grammar (commits 3bc491b9 and ca016f2c): the
// "❯"-pointed slash popup, the multi-line draft's "ctrl+g to edit in nano" hint, and the plan
// dialog's own-words rule (namesPlanDialog). Every screen is hand-built from an idle 2.1.291 capture
// (`claude-lab--draft-adversarial--w82.txt`) with the rows between its last border pair edited, and
// every test pins fail-closed behaviour: a wrong claim must never reach the phone, and a draft the
// operator is typing must never cost the input box.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const fixtureText = (name: string): string[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8"))).map(lineText);
const fixtureLines = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const screenOf = (rows: string[]): StyledLine[] => splitLines(parseAnsi(rows.join("\n")));
const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);
const nbsp = " ";

// The transcript half of the idle capture: everything above the box's top border.
const BASE_ROWS = fixtureText("claude-lab--draft-adversarial--w82.txt");
const TOP_RULE = BASE_ROWS.findIndex((row, i) => row.startsWith("─") && BASE_ROWS[i + 1]?.startsWith("❯"));
const TRANSCRIPT = BASE_ROWS.slice(0, TOP_RULE);
const RULE = "─".repeat(82);
const STATUS = "  sonnet · lab-project · main · ctx 12%";
const HINT = "ctrl+g to edit in nano";
/** The statusline row with the 2.1.291 draft hint right-aligned, as at 82 columns. */
const STATUS_WITH_HINT = `${STATUS}${" ".repeat(82 - STATUS.length - HINT.length)}${HINT}`;

/** An idle screen: the capture's transcript, a box holding `draft` rows, and `tail` under it. */
function idle(draft: string[], tail: string[] = [STATUS, "  ⏸ manual mode on"]): StyledLine[] {
  const [first = "", ...rest] = draft;
  return screenOf([...TRANSCRIPT, RULE, `❯${nbsp}${first}`, ...rest.map((r) => `  ${r}`), RULE, ...tail]);
}

/** The draft as extractInputDraft reads it back: each row de-indented, joined with one space. */
const readBack = (rows: string[]): string => rows.map((r) => r.trim()).join(" ");

const blocksOf = (lines: StyledLine[]) => withUnreadDialog(claudeAdapter, lines, claudeAdapter.buildBlocks(lines));

describe("a draft that begins with the pointer glyph", () => {
  it.each([
    ["❯ keep the old name", "a pointed-looking row"],
    ["❯ /model", "a pointed slash command"],
    ["❯", "a lone pointer"],
  ])("%s (%s) stays a draft: the box survives and nothing is lifted", (draft) => {
    const lines = idle([draft]);
    expect(hasInputBox(lines)).toBe(true);
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
    expect(inputBoxTail(lines)).toBe("statusline");
    expect(detectAutocompleteRegion(lines)).toBeNull();
    expect(kinds(blocksOf(lines))).toEqual(["raw"]);
    expect(extractInputDraft(lines)).toBe(draft);
  });

  it("a pointer-led draft under a statusline that carries the ctrl+g hint reads the same", () => {
    const lines = idle(["❯ keep the old name"], [STATUS_WITH_HINT, "  ⏸ manual mode on"]);
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe("❯ keep the old name");
    expect(kinds(blocksOf(lines))).toEqual(["raw"]);
  });
});

// FINDING (2026-10-06, Claude Code 2.1.291 grammar at ca016f2c), CLOSED the same day: `namesPlanDialog`
// read the plan dialog's own words ("ready to execute. Would you like to proceed?" over a `1.` row and
// a `2.` row) from ANY rows in the last 30 of the screen, including the operator's own multi-line
// draft inside the input box. With the draft hint "ctrl+g to edit in nano" on the statusline row,
// `classifyFooter` then claimed `plan`: the one-row draft lost its input box (a send stalled), the
// wrapped draft drew the unread-dialog card over a live composer, and the `❯`-pointed draft was LIFTED
// as a plan dialog whose two buttons would type digits into the draft. The rule now: draft text is
// never a dialog. A row inside the input box (insideInputFrame, markers.ts) is no dialog evidence.
describe("a multi-line draft that quotes the plan dialog's words", () => {
  const QUESTION = "Claude has written up a plan and is ready to execute. Would you like to proceed?";
  const draft = [QUESTION, "1. Yes, and use auto mode", "2. Yes, manually approve edits"];
  const wrappedDraft = [
    "Claude has written up a plan and is",
    "ready to execute. Would you like to",
    "proceed?",
    "1. Yes, and use auto mode",
    "2. Yes, manually approve edits",
  ];
  const pointedDraft = [QUESTION, "❯ 1. Yes, and use auto mode", "  2. Yes, manually approve edits"];
  const screen = () => idle(draft, [STATUS_WITH_HINT, "  ⏸ manual mode on"]);
  const wrapped = () =>
    idle(wrappedDraft, [STATUS, "  ⏸ manual mode on", `${" ".repeat(82 - HINT.length)}${HINT}`]);
  const pointed = () => idle(pointedDraft, [STATUS_WITH_HINT]);

  it.each([
    ["one-row question", screen, draft],
    ["question wrapped as at 40 columns", wrapped, wrappedDraft],
    ["pointed menu rows", pointed, pointedDraft],
  ])("stays a draft (%s): the box is ready, nothing is lifted, no card, the draft reads back", (_name, build, rows) => {
    const lines = build();
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
    expect(detectPromptSelect(lines)).toBeNull();
    expect(kinds(blocksOf(lines))).toEqual(["raw"]);
    expect(kinds(buildBlocks(lines, { agent: "claude" }))).toEqual(["raw"]);
    expect(extractInputDraft(lines)).toBe(readBack(rows));
  });

  it("the wrapped draft draws no unread-dialog card", () => {
    expect(kinds(blocksOf(wrapped()))).toEqual(["raw"]);
  });

  it("the pointed-rows draft is not lifted as a plan dialog (the false claim)", () => {
    expect(detectPromptSelect(pointed())).toBeNull();
    expect(kinds(blocksOf(pointed()))).toEqual(["raw"]);
  });

  it("the ctrl+g hint beside a quoting draft is not the plan family", () => {
    const texts = screen().map(lineText);
    const hintRow = texts.find((t) => t.includes(HINT))!;
    expect(classifyFooter(hintRow, texts)).not.toBe("plan");
    expect(namesPlanDialog(texts)).toBe(false);
  });

  it("the question above the box with the numbered rows in the draft names no dialog either", () => {
    const lines = screenOf([
      ...TRANSCRIPT,
      `⏺ ${QUESTION}`,
      "",
      RULE,
      `❯${nbsp}pick one of these`,
      "  1. Yes, and use auto mode",
      "  2. Yes, manually approve edits",
      RULE,
      STATUS_WITH_HINT,
    ]);
    expect(namesPlanDialog(lines.map(lineText))).toBe(false);
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
    expect(kinds(blocksOf(lines))).toEqual(["raw"]);
  });

  it("the real dialog still names itself: its question is not inside a box", () => {
    expect(namesPlanDialog(fixtureText("claude-lab--plan-approval-v2291--w82.txt"))).toBe(true);
    expect(namesPlanDialog(fixtureText("claude-lab--plan-approval--w40.txt"))).toBe(true);
  });
});

// The permission and trust dialogs' own-words tests read the same last rows. A draft that quotes
// either dialog cannot reach a claim: both need a footer the composer never prints ("Esc to cancel"
// alone, "Tab to amend", "Enter to confirm"), and the footerless permission path needs its last option
// row at the tail, where the box's bottom border sits instead. Pinned so a change is noticed.
describe("a multi-line draft that quotes the permission or trust dialog's words", () => {
  const permission = [
    "Do you want to make this edit to lab-notes.md?",
    "❯ 1. Yes",
    "  2. Yes, allow all edits during this session (shift+tab)",
    "  3. No, and tell Claude what to do differently (esc)",
  ];
  const trust = [
    "Is this a project you created or one you trust?",
    "❯ 1. Yes, I trust this folder",
    "  2. No, exit",
  ];

  it.each([
    ["permission", permission],
    ["trust", trust],
  ])("the %s words in a draft stay a draft", (_name, rows) => {
    for (const tail of [[STATUS_WITH_HINT, "  ⏸ manual mode on"], [STATUS_WITH_HINT]]) {
      const lines = idle(rows, tail);
      expect(claudeAdapter.composerReady!(lines)).toBe(true);
      expect(detectPromptSelect(lines)).toBeNull();
      expect(kinds(blocksOf(lines))).toEqual(["raw"]);
      expect(extractInputDraft(lines)).toBe(readBack(rows));
    }
  });
});

// The 2.1.291 popup: a "❯" on the selected entry, four-column leads, one description column.
const POINTED = "  ❯ /model                    Set the AI model for Claude Code";
const PLAIN_A = "    /modelcheck               Print a note about model configuration";
const PLAIN_B = "    /effort                   Set effort level for model usage";
/** A screen with a slash draft in the box and the popup rows directly under its bottom border. */
const popupScreen = (rows: string[], draft = "/m"): StyledLine[] => idle([draft], rows);

describe("the pointed popup fails closed on a wrong pointer count", () => {
  it("one pointer reads, as the baseline", () => {
    const lines = popupScreen([POINTED, PLAIN_A, PLAIN_B]);
    expect(detectAutocompleteRegion(lines)!.model.entries.map((e) => e.name)).toEqual([
      "/model",
      "/modelcheck",
      "/effort",
    ]);
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
    expect(inputBoxTail(lines)).toBe("autocomplete");
  });

  it("four-space entries with no pointer at all lift no list and keep the box", () => {
    const rows = [
      "    /model                    Set the AI model for Claude Code",
      PLAIN_A,
      PLAIN_B,
    ];
    const lines = popupScreen(rows);
    expect(detectAutocompleteRegion(lines)).toBeNull();
    expect(kinds(blocksOf(lines))).not.toContain("autocomplete");
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });

  it("two pointers lift no list and keep the box", () => {
    const lines = popupScreen([POINTED, PLAIN_A.replace("    /", "  ❯ /"), PLAIN_B]);
    expect(detectAutocompleteRegion(lines)).toBeNull();
    expect(kinds(blocksOf(lines))).not.toContain("autocomplete");
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });

  it("a second pointer on a continuation row lifts no list and keeps the box", () => {
    const lines = popupScreen([
      POINTED,
      `${" ".repeat(34)}❯ and then some`,
      PLAIN_A,
    ]);
    // The row is description text on the description column, so the run may read; if it does the
    // entry names must still be the real ones.
    const region = detectAutocompleteRegion(lines);
    if (region !== null) expect(region.model.entries.map((e) => e.name)).toEqual(["/model", "/modelcheck"]);
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });

  it("a pointer row that is not an entry (no slash name) lifts no list and keeps the box", () => {
    const lines = popupScreen([POINTED, "  ❯ something else entirely", PLAIN_B]);
    expect(detectAutocompleteRegion(lines)).toBeNull();
    expect(kinds(blocksOf(lines))).not.toContain("autocomplete");
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });

  it("mixed leads (a pointed entry beside a two-space entry) lift no list and keep the box", () => {
    const lines = popupScreen([POINTED, "  /effort                   Set effort level for model usage"]);
    expect(detectAutocompleteRegion(lines)).toBeNull();
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });
});

describe("a popup description that carries the pointer glyph", () => {
  const column = POINTED.indexOf("Set");

  it("a continuation row that starts with ❯ joins its entry's description, never a name", () => {
    const lines = popupScreen([
      POINTED,
      `${" ".repeat(column)}❯ /effort pretends to be an entry`,
      PLAIN_B,
    ]);
    const region = detectAutocompleteRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.entries.map((e) => e.name)).toEqual(["/model", "/effort"]);
    expect(region!.model.entries[0]!.description).toContain("❯ /effort pretends to be an entry");
    for (const e of region!.model.entries) expect(e.name).not.toContain("❯");
  });

  // LIMITATION, not a false claim: the box locator steps over every "❯"-led row under the border and
  // keeps the box only when the one stepped row is the popup's own pointer. A description that wraps
  // onto a row opening with "❯" is stepped over too, so the box is refused (composerReady false, a
  // send stalls) although the popup grammar read the run correctly. Pinned so a change is noticed.
  it("a continuation row that starts with ❯ costs the box today (liveness, not a wrong claim)", () => {
    const lines = popupScreen([POINTED, `${" ".repeat(column)}❯ and then some`, PLAIN_B]);
    expect(kinds(blocksOf(lines))).not.toContain("autocomplete");
    expect(claudeAdapter.composerReady!(lines)).toBe(false);
  });

  it("a ❯ in the middle of a description stays description text", () => {
    const lines = popupScreen([
      "  ❯ /model                    Set the model ❯ then /effort",
      PLAIN_B,
    ]);
    const region = detectAutocompleteRegion(lines)!;
    expect(region.model.entries.map((e) => e.name)).toEqual(["/model", "/effort"]);
    expect(region.model.entries[0]!.description).toBe("Set the model ❯ then /effort");
  });

  it("a continuation at the pointer's own column (two spaces) ends the run: no list, box kept", () => {
    const lines = popupScreen([POINTED, "  ❯ wrapped back to the left margin", PLAIN_B]);
    expect(detectAutocompleteRegion(lines)).toBeNull();
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });
});

describe("the 40-column pointed popup", () => {
  const NAME = /^(?:\/[A-Za-z0-9]|…[A-Za-z0-9:_-])[A-Za-z0-9:_-]*(?: \([A-Za-z0-9:_-]+\))?$/;

  it("lifts only real command names from the capture, no description fragment among them", () => {
    const lines = fixtureLines("claude-lab--popup-slash-all--w40.txt");
    const region = detectAutocompleteRegion(lines);
    expect(region).not.toBeNull();
    const names = region!.model.entries.map((e) => e.name);
    expect(names.slice(0, 4)).toEqual(["/add-dir", "/advisor", "/artifacts", "…o-mode-setup"]);
    for (const name of names) expect(name, name).toMatch(NAME);
    // Every description fragment of the capture is one of the wrapped rows, so none is a name.
    const texts = lines.map(lineText);
    const fragments = texts.filter((t) => /^ {17}\S/.test(t)).map((t) => t.trim().split(/\s+/)[0]!);
    for (const fragment of fragments) expect(names).not.toContain(fragment);
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });

  it("a description fragment that looks like a command, on a cut row, is not a name", () => {
    const lines = idle(["/"], [
      "  ❯ /add-dir       Add a new working",
      "                   directory",
      "    /advisor       Run /effort or",
      "                   /model …",
      "    /bug           Report a bug",
    ]);
    const region = detectAutocompleteRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.entries.map((e) => e.name)).toEqual(["/add-dir", "/advisor", "/bug"]);
    expect(region!.model.entries[1]!.description).toBe("Run /effort or /model …");
  });

  it("a row whose name starts at the description column's indent never becomes an entry", () => {
    const lines = idle(["/"], [
      "  ❯ /add-dir       Add a new working",
      "    /advisor       Let Claude consult",
      "    /effort        a stronger model …",
    ]);
    const region = detectAutocompleteRegion(lines);
    if (region !== null) {
      expect(region.model.entries.map((e) => e.name)).toEqual(["/add-dir", "/advisor", "/effort"]);
    }
    expect(claudeAdapter.composerReady!(lines)).toBe(true);
  });
});

describe("a plan body that repeats the question above the real one", () => {
  const REAL = "Claude has written up a plan and is ready to execute. Would you like to proceed?";
  const dialogRows = (body: string[]): string[] => [
    "─".repeat(82),
    " Ready to code?",
    " Here is Claude's plan:",
    "╌".repeat(82),
    " Plan: add a fourth line to docs/lab-notes.md",
    ...body,
    "╌".repeat(82),
    "─".repeat(82),
    ` ${REAL}`,
    " ❯ 1. Yes, and use auto mode",
    "   2. Yes, manually approve edits",
    "   3. Tell Claude what to change",
    "      shift+tab to approve with this feedback",
    "",
    " ctrl+g to edit in nano ·",
    " /tmp/claude-lab-run/config/plans/plan-a-tiny-change-hidden-stonebraker.md",
  ];

  it.each([
    ["the bare question as a body line", ["Would you like to proceed?"]],
    [
      "the bare question and a numbered list in the body",
      ["Would you like to proceed?", "1. Add the line", "2. Verify the file", "3. Done"],
    ],
    [
      "the full plan wording and a numbered list in the body",
      [REAL, "1. Yes, and use auto mode", "2. Yes, manually approve edits"],
    ],
  ])("%s: the real question and the dialog's own options win", (_name, body) => {
    const lines = screenOf([...TRANSCRIPT, ...dialogRows(body)]);
    const model = detectPromptSelect(lines)!;
    expect(model).not.toBeNull();
    expect(model.family).toBe("plan");
    expect(model.question).toBe(REAL);
    expect(model.options.map((o) => o.label)).toEqual(["Yes, and use auto mode", "Yes, manually approve edits"]);
    expect(model.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(model.feedback).toMatchObject({ key: "3", focused: false, text: "" });
  });

  it("the numbered-body capture with the real question text lifts the dialog's four options", () => {
    const rows = fixtureText("claude--plan-approval--numbered-body.txt").map((row) =>
      row.replace("Claude has written up a plan and is ready to execute. Would you like to proceed?", REAL),
    );
    // Put a line of the same words in the plan body, above the real question.
    const at = rows.findIndex((r) => r.includes("Keep it under"));
    rows.splice(at, 0, "   Would you like to proceed?");
    const model = detectPromptSelect(screenOf(rows))!;
    expect(model.family).toBe("plan");
    expect(model.question).toBe(REAL);
    expect(model.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(model.options.map((o) => o.label)).not.toContain("Title — # biscuit");
  });
});
