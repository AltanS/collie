import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { agyAdapter, antigravityAdapter, normalizeAgyScreenRows } from "./index";
import { detectPromptSelect } from "./prompt-select";
import { describeAdapterConformance } from "../conformance";
import { buildBlocks } from "../index";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const LOCAL_FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const fixtureFile = (name: string) =>
  existsSync(join(LOCAL_FIXTURES_DIR, name)) ? join(LOCAL_FIXTURES_DIR, name) : join(PANES_DIR, name);

/** AGY paints its composer between two full-width rules; 60 columns clears isBoxBorder. */
const RULE = "────────────────────────────────────────────────────────────";

const allFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt"))
  .toSorted();

const allAgyFixtures = allFixtures.filter((f) => f.startsWith("agy--"));

const NEUTRAL = new Set([
  "agy--fresh-idle.txt",
  // The 60-row capture that stood as agy--working.txt: the turn is over and the box is free.
  "agy--after-plan-idle.txt",
  "agy--working.txt",
  "agy--done.txt",
  // The slash-command completion popup under a live box: not a dialog, nothing to lift.
  "agy--slash-exact.txt",
  "agy--slash-partial.txt",
  "agy--slash-typed-arg.txt",
  // The Conversations picker after a search that matched nothing: no highlighted row, so nothing to
  // select. It stays raw, and the unread-dialog card offers Escape.
  "agy--resume-picker-nomatch.txt",
  // A checkbox question: Space ticks a row, which no multi-select recipe here sends, so it stays raw
  // and the unread-dialog card offers Escape.
  "agy--ask-multi.txt",
]);

// Claude captures agy's grammar still claims, by name. `isAlienBuffer` (markers.ts) keeps agy off a
// Claude buffer by a Claude name on screen, and a permission dialog raised by a Claude SUBAGENT with
// its banner scrolled away names Claude nowhere: bare Yes / No rows, no `tell Claude`. The fixtures
// README records the same gap for the lab's Edit-permission screens, and that the fix belongs on the
// agy side. This capture is kept in the corpus because the Claude grammar needs it (the card's
// subject, 2026-10-06). It is a named exception, not a silent one: the test below fails the day agy
// stops claiming it, and then the entry is deleted. No agy pane paints this screen, and the agy
// adapter only reads panes Herdr reports as agy.
const KNOWN_FOREIGN_CLAIMS = new Set([
  "claude--v2291-permission-bash-subagent.txt",
  // The same shape on 2.1.303: a background agent's Bash permission with a tall command (2026-10-19).
  "claude--v2303-permission-bash-bg-agent-rm--w160.txt",
  "claude--v2303-permission-bash-bg-agent-rm--w80.txt",
]);

const ownFixtures = allAgyFixtures.filter((f) => !NEUTRAL.has(f));
const neutralFixtures = allAgyFixtures.filter((f) => NEUTRAL.has(f));
const foreignFixtures = allFixtures.filter((f) => !f.startsWith("agy--") && !KNOWN_FOREIGN_CLAIMS.has(f));

describeAdapterConformance(agyAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
});

describeAdapterConformance(antigravityAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
});

describe("agy: the named foreign claims are still claimed (delete the entry when one is not)", () => {
  for (const name of KNOWN_FOREIGN_CLAIMS) {
    it(`${name} is still lifted by agy, so it stays on the KNOWN_FOREIGN_CLAIMS list`, () => {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      expect(agyAdapter.buildBlocks(lines).some((b) => b.kind !== "raw")).toBe(true);
    });
  }
});

describe("the card starts at the question row, so the mirror above it does not repeat it", () => {
  const blocksOf = (name: string) =>
    agyAdapter.buildBlocks(splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8"))));

  it.each([
    ["agy--permission-bash.txt", "Do you want to proceed?"],
    ["agy--permission-edit.txt", "Do you want to proceed?"],
    ["agy--plan-approval.txt", "Question 1/1: Approve plan execution?"],
    ["agy--plan-approval-135.txt", "Question 1/1: Approve plan execution?"],
    ["agy--select-menu.txt", "Question 1/1: Which color theme should the dashboard use?"],
  ])("%s", (name, question) => {
    const [raw, prompt] = blocksOf(name);
    expect(raw?.kind).toBe("raw");
    expect(prompt?.kind).toBe("prompt-select");
    // The row above the question is what the mirror now ends on; the question row is the card's first.
    expect(raw!.lines.slice(-4).map((l) => l.segments.map((s) => s.text).join("").trim())).not.toContain(question);
    expect(prompt!.lines[0]!.segments.map((s) => s.text).join("").trim()).toBe(question);
  });

  it("the trust prompt keeps the card at its options: a sentence under the question is shown by the mirror alone", () => {
    const [raw, prompt] = blocksOf("agy--trust-prompt.txt");
    const mirror = raw!.lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(mirror).toContain("Antigravity CLI requires permission to read, edit, and execute files here.");
    expect(prompt!.lines[0]!.segments.map((s) => s.text).join("")).toContain("Yes, I trust this folder");
  });
});

describe("agyAdapter unit & footer safety", () => {
  it("claims agent 'agy' and 'antigravity'", () => {
    expect(agyAdapter.agent).toBe("agy");
    expect(antigravityAdapter.agent).toBe("antigravity");
  });

  // The folder-trust capture, pinned block-for-block. Claude's `classifyFooter` was narrowed so a
  // footer phrase alone can no longer claim the trust family (ADR 0053); agy's was deliberately left
  // alone, so this fixture must keep lifting exactly what it lifted before that decision.
  it("lifts agy--trust-prompt.txt as the trust family with digit-alone keys", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "agy--trust-prompt.txt"), "utf8")),
    );
    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.family).toBe("trust");
    expect(model!.question).toBe("Do you trust the contents of this project?");
    expect(model!.options.map((o) => o.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);

    const kinds = agyAdapter.buildBlocks(lines).map((b) => b.kind);
    expect(kinds).toEqual(["raw", "prompt-select"]);
  });

  it("detects an AskUserQuestion prompt with a footer and lifts it into interactive prompt-select options", () => {
    const raw = [
      "Which action would you like to take?",
      "❯ 1. Run build directly",
      "  2. Inspect directory first",
      "  3. Skip step",
      "Enter to select · ↑/↓ to navigate",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.question).toBe("Which action would you like to take?");
    expect(model!.family).toBe("select");
    expect(model!.options).toHaveLength(3);
    expect(model!.options[0]!.label).toBe("Run build directly");
    expect(model!.options[0]!.keys).toEqual(["1"]);
    expect(model!.options[1]!.label).toBe("Inspect directory first");
    expect(model!.options[1]!.keys).toEqual(["2"]);

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(true);
  });

  it("finds a question that ends in a fullwidth question mark, above the rows that explain it (issue 543)", () => {
    const raw = [
      "どの色にしますか？",
      "ダッシュボードの配色です。",
      "あとから変更できます。",
      "迷ったら緑を選んでください。",
      "❯ 1. 赤",
      "  2. 緑",
      "  3. 青",
      "Enter to select · ↑/↓ to navigate",
    ].join("\n");
    const model = detectPromptSelect(splitLines(parseAnsi(raw)));
    expect(model).not.toBeNull();
    expect(model!.question).toBe("どの色にしますか？");
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });

  it("declines a numbered list without a dialog footer (ADR 0009 safety)", () => {
    const raw = [
      "Available skills:",
      "  1. agy-customizations - Guide and reference",
      "  2. graphify - Knowledge graph analysis",
      "  3. antigravity-guide - Overview and quick reference",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).toBeNull();

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.every((b) => b.kind === "raw")).toBe(true);
  });

  it("detects tool permission prompt and extracts digit key alone", () => {
    const raw = [
      "Allow bash command: `npm test`?",
      "  1. Yes",
      "  2. No",
      "  3. Always allow",
      "Tab to amend · Esc to cancel",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.options[0]!.label).toBe("Yes");
    expect(model!.options[0]!.keys).toEqual(["1"]);
    expect(model!.options[1]!.label).toBe("No");
    expect(model!.options[1]!.keys).toEqual(["2"]);
  });

  it("answers composerReady false when a prompt dialog is on screen", () => {
    const raw = [
      "Which model should be used?",
      "  1. Gemini 3.7 Pro",
      "  2. Gemini 3.7 Flash",
      "Enter to select",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("answers composerReady true at a boxed idle composer", () => {
    const raw = ["Ready for instructions.", RULE, "> ", RULE, "? for shortcuts"].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
  });

  // agy 1.3.3, harness canary 2026-10-12: a pasted rule sits behind the draft's gutter. Read as the
  // box's top rule, it refused the composer while the draft was there.
  it("a rule inside the draft is draft text, not the box's top rule", () => {
    const short = "────────────────────";
    const raw = ["OK", RULE, "> Reply with only OK.", `  ${short}`, "  some text", `  ${short}`, "  end", RULE, "? for shortcuts"].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).toBe(`Reply with only OK. ${short} some text ${short} end`);
  });

  it("a column-0 rule between the prompt and the box still refuses the composer", () => {
    const raw = ["> echoed earlier", RULE, "  some text", RULE, "? for shortcuts"].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  // AGY echoes every submitted message as a `> ` transcript row, and paints an answered
  // ask_user_question selection the same way. Without the enclosing box those rows are
  // indistinguishable from a live composer, so an unanchored `>` must never claim one: Collie would
  // report a writable pane over a busy agent and hand the echo back as the operator's draft.
  it("refuses an unanchored tail `>` row — a transcript echo is not a composer", () => {
    const raw = ["some transcript output", "----------------", "> this is a quoted line"].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.extractStatusLines!(lines)).toEqual([]);
  });

  it("keeps a bare `>` prompt with no box and no status row out of the composer grammar", () => {
    const lines = splitLines(parseAnsi(["Ready for instructions.", "> "].join("\n")));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("correctly locates the input box and extracts statusline on agy--fresh-idle.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--fresh-idle.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.composerReady!(lines)).toBe(true);

    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("? for shortcuts");
    expect(statusText).toContain("Gemini 3.7 Flash");

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.kind).toBe("raw");
    const mirrorText = blocks[0]!.lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(mirrorText).not.toContain("? for shortcuts");
    expect(mirrorText).not.toContain("──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>");
  });

  it("extracts no spurious draft and extracts statusline on agy--done.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--done.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.composerReady!(lines)).toBe(true);

    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("? for shortcuts");
  });

  // The mid-turn capture (agy--working.txt) carries its status after `esc to cancel` on one row, which
  // extractStatusLines does not read (0 rows); this screen, once filed as `working`, is a finished turn.
  it("extracts the statusline on agy--after-plan-idle.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--after-plan-idle.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("Gemini 3.7 Flash");
  });

  it("extracts typed user draft inside an input box", () => {
    const raw = [
      "────────────────────────────────────────────────────────────",
      "> write a python fibonacci function",
      "────────────────────────────────────────────────────────────",
      "? for shortcuts                                 Gemini 3.7",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBe("write a python fibonacci function");
  });

  it("finds the input box under a four-row custom statusLine", () => {
    // A `statusLine` command prints as many rows as the user wrote. Four used to push the bottom
    // border out of the search window, and the idle pane read as an unread dialog.
    const raw = [
      "Done.",
      "────────────────────────────────────────────────────────────",
      ">",
      "────────────────────────────────────────────────────────────",
      "host-1 [Flash] user@example.com",
      "C 91%",
      "~/project",
      "main",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractStatusLines!(lines)).toHaveLength(4);
    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks[0]!.lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["Done."]);
  });
});


describe("agy: the input-box search window never reads a dialog's rule as a composer", () => {
  const rowsOf = (name: string): string[] =>
    splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8"))).map(lineText);
  const linesOf = (rows: string[]) => splitLines(parseAnsi(rows.join("\n")));

  // `agy--select-menu.txt` with the Red / Green / Blue rows cut to Red alone and the write-in
  // renumbered to 2. The rule under the `Question` label then sits 8 rows from the tail, inside the
  // widened status window, and the echoed `> Use the ask_user_question …` row above it looks like
  // a prompt. The real corpus cannot show this: every captured dialog has at least four option rows.
  const oneOptionDialog = (): string[] =>
    rowsOf("agy--select-menu.txt")
      .filter((r) => !/^\s*3\.\s+Blue\s*$/.test(r) && !/^\s*2\.\s+Green\s*$/.test(r))
      .map((r) => r.replace(/^(\s*)4\.(\s+Write-in)/, "$12.$2"));

  it("the one-option question dialog is not an input box", () => {
    const rows = oneOptionDialog();
    expect(rows.some((r) => /^\s*2\.\s+Write-in/.test(r))).toBe(true);
    expect(rows.filter((r) => /^\s*(?:>\s*)?\d\.\s/.test(r))).toHaveLength(2);
    const lines = linesOf(rows);

    expect(agyAdapter.composerReady!(lines)).toBe(false);
    expect(antigravityAdapter.composerReady!(lines)).toBe(false);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.extractStatusLines!(lines)).toEqual([]);
  });

  it("the real four-option dialog stays not-ready", () => {
    expect(agyAdapter.composerReady!(linesOf(rowsOf("agy--select-menu.txt")))).toBe(false);
  });

  const boxWithStatusRows = (n: number): string[] => [
    "Done.",
    RULE,
    ">",
    RULE,
    ...Array.from({ length: n }, (_, i) => `status row ${i + 1}`),
  ];

  it("eight status rows under a real input box still find it", () => {
    const lines = linesOf(boxWithStatusRows(8));
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractStatusLines!(lines)).toHaveLength(8);
  });

  it("nine status rows push the bottom border out of the window", () => {
    expect(agyAdapter.composerReady!(linesOf(boxWithStatusRows(9)))).toBe(false);
  });

  it.each([["esc to cancel"], ["enter to select"], ["1. Red", "2. Write-in..."]])("a dialog under the rule (%s) is no composer", (...dialogRows) => {
    const rows = [...boxWithStatusRows(1), ...dialogRows];
    expect(agyAdapter.composerReady!(linesOf(rows))).toBe(false);
  });

  it("one numbered item in a custom statusLine is still a live box", () => {
    const rows = [...boxWithStatusRows(1), "1. build ok  2. tests ok"];
    expect(agyAdapter.composerReady!(linesOf(rows))).toBe(true);
  });
});

describe("the slash-command completion popup is the live box, not a dialog (agy 1.3.5)", () => {
  const read = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

  it("reads `/model` over its own highlighted suggestion, with no card and no popup in the status", () => {
    const lines = read("agy--slash-exact.txt");
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).toBe("/model");
    expect(buildBlocks(lines, { agent: "agy" }).map((b) => b.kind)).toEqual(["raw"]);
    const status = agyAdapter.extractStatusLines!(lines).map((l) => lineText(l)).join(" ");
    expect(status).not.toContain("Set a model");
    expect(status).not.toContain("tab Complete");
  });

  it("stalls safe on partial input, where Enter would run the highlighted `/model`", () => {
    const lines = read("agy--slash-partial.txt");
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).not.toBe("/mo");
  });

  it("reads a typed argument once the popup says No matches", () => {
    expect(agyAdapter.extractInputDraft!(read("agy--slash-typed-arg.txt"))).toBe("/model x");
  });

  // The screens below are built from the exact capture and not seen live: each is a shape the popup
  // reader must refuse rather than take for the popup (review of the reader, 2026-10-15).
  const rebuilt = (name: string, edit: (row: string) => string[]) =>
    splitLines(parseAnsi(read(name).flatMap((l) => edit(lineText(l))).join("\n")));

  it("a modal whose hint row only mentions `tab Complete` refuses the composer", () => {
    const rows = read("agy--slash-exact.txt").map((l) => lineText(l));
    const rule = rows.findLastIndex((r) => /^─{20,}/.test(r));
    const modal = [
      "Conversations",
      "> Recent conversation",
      "Keyboard: ↑/↓ Navigate  enter Select  tab Complete search",
      "  esc Go back / Clear search",
    ];
    const lines = splitLines(parseAnsi([...rows.slice(0, rule + 1), ...modal].join("\n")));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("a row the popup never paints, between the rule and its footer, refuses the composer", () => {
    const lines = rebuilt("agy--slash-exact.txt", (t) =>
      t.startsWith("> /model  Set") ? [t, "Delete this file? Press Enter to confirm."] : [t],
    );
    expect(agyAdapter.composerReady!(lines)).toBe(false);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
  });

  it("a highlight drawn with a pointer the reader does not know does not verify `/mo`", () => {
    const lines = rebuilt("agy--slash-exact.txt", (t) => {
      if (t.trimEnd() === "> /model") return ["> /mo"];
      return [t.startsWith("> /model  Set") ? `❯ ${t.slice(2)}` : t];
    });
    expect(agyAdapter.extractInputDraft!(lines)).not.toBe("/mo");
  });

  it("a popup with no highlighted row and no `No matches` does not verify `/mo`", () => {
    const lines = rebuilt("agy--slash-exact.txt", (t) => {
      if (t.trimEnd() === "> /model") return ["> /mo"];
      return [t.startsWith("> /model  Set") ? `  ${t.slice(2)}` : t];
    });
    expect(agyAdapter.extractInputDraft!(lines)).not.toBe("/mo");
  });

  // A second review built these three the same way (2026-10-16).
  it("`No matches` beside a highlighted suggestion does not verify `/mo`", () => {
    const lines = rebuilt("agy--slash-partial.txt", (t) => (t.startsWith("> /model  ") ? ["   No matches", t] : [t]));
    expect(lines.some((l) => lineText(l).trim() === "No matches")).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).not.toBe("/mo");
  });

  it("two highlighted suggestions do not verify the typed command", () => {
    const lines = rebuilt("agy--slash-exact.txt", (t) =>
      t.startsWith("> /model  Set") ? [t, "> /mode   Switch the agent's mode"] : [t],
    );
    expect(lines.filter((l) => lineText(l).startsWith("> /")).length).toBe(3);
    expect(agyAdapter.extractInputDraft!(lines)).not.toBe("/model");
  });

  it("a confirmation painted under the popup's own rows refuses the composer", () => {
    const rows = read("agy--slash-exact.txt").map((l) => lineText(l).trimEnd());
    const lines = splitLines(parseAnsi([...rows, "Delete this file? Press Enter to confirm."].join("\n")));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });
});

describe("agy: the /resume Conversations picker lifts as a menu (1.3.5)", () => {
  const read = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  const menuOf = (name: string) => {
    const block = buildBlocks(read(name), { agent: "agy" }).find((b) => b.kind === "menu");
    return block?.kind === "menu" ? block.menu : null;
  };

  it.each(["agy--resume-picker.txt", "agy--resume-picker-search.txt"])(
    "%s offers Up/Down, Select and Go back, and nothing that renames or deletes",
    (name) => {
      const menu = menuOf(name);
      expect(menu?.title).toBe("Conversations");
      expect(menu?.actions.map((a) => [a.label, a.keys.join("+"), a.cancel === true])).toEqual([
        ["Select", "Enter", false],
        ["Go back", "Escape", true],
      ]);
      expect(menu?.nav.upDown).toBe(true);
      expect(agyAdapter.composerReady!(read(name))).toBe(false);
    },
  );

  it("changes its signature when the highlight moves", () => {
    const moved = menuOf("agy--resume-picker-search-moved.txt");
    const before = menuOf("agy--resume-picker-search.txt");
    expect(moved).not.toBeNull();
    expect(before).not.toBeNull();
    expect(moved!.signature).not.toBe(before!.signature);
  });

  // Built from the capture, not seen live: the screen ends on agy's right-aligned model status, so a
  // row painted after it is something the picker reader does not know (review, 2026-10-15).
  it("does not lift the picker when a row it does not know follows the status", () => {
    const rows = read("agy--resume-picker.txt").map((l) => lineText(l).trimEnd());
    const lines = splitLines(parseAnsi([...rows, "Delete this conversation? Press Enter to confirm."].join("\n")));
    expect(buildBlocks(lines, { agent: "agy" }).some((b) => b.kind === "menu")).toBe(false);
  });

  // A third review (2026-10-16): a delete confirmation painted in place of the pager row, footer intact.
  it("does not lift the picker when a row inside the list asks for a key", () => {
    const rows = read("agy--resume-picker.txt").map((l) => lineText(l).trimEnd());
    const pager = rows.findIndex((t) => /\[\d+-\d+ of \d+ items\]/.test(t));
    expect(pager).toBeGreaterThan(0);
    for (const prompt of ["Delete 'X'? Press Y to confirm", "Delete 'X'? [y/N]"]) {
      const edited = rows.map((t, i) => (i === pager ? prompt : t));
      const lines = splitLines(parseAnsi(edited.join("\n")));
      expect(buildBlocks(lines, { agent: "agy" }).some((b) => b.kind === "menu"), prompt).toBe(false);
    }
  });

  // A second review built these two the same way (2026-10-16).
  it("does not lift the picker when an indented row follows the status", () => {
    const rows = read("agy--resume-picker.txt").map((l) => lineText(l).trimEnd());
    const lines = splitLines(
      parseAnsi([...rows, "        Delete this conversation? Press Enter to confirm."].join("\n")),
    );
    expect(buildBlocks(lines, { agent: "agy" }).some((b) => b.kind === "menu")).toBe(false);
  });

  it("does not lift the picker when a row naming a key sits between the footer and the status", () => {
    const rows = read("agy--resume-picker.txt").flatMap((l) => {
      const t = lineText(l).trimEnd();
      return t === "  esc Go back / Clear search" ? [t, "Delete this conversation? Press Enter to confirm."] : [t];
    });
    expect(rows).toContain("Delete this conversation? Press Enter to confirm.");
    expect(buildBlocks(splitLines(parseAnsi(rows.join("\n"))), { agent: "agy" }).some((b) => b.kind === "menu")).toBe(
      false,
    );
  });

  it("starts the card at the title, so the box above stays in the mirror", () => {
    const blocks = buildBlocks(read("agy--resume-picker.txt"), { agent: "agy" });
    const menu = blocks.find((b) => b.kind === "menu");
    expect(menu?.kind === "menu" && lineText(menu.lines[0]!).trim()).toBe("Conversations");
  });

  it("keeps a search with no match raw: no row to select, Escape on the unread-dialog card", () => {
    const lines = read("agy--resume-picker-nomatch.txt");
    expect(buildBlocks(lines, { agent: "agy" }).map((b) => b.kind)).toEqual(["unread-dialog"]);
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("does not lift a list whose footer lost `enter Select`", () => {
    const rows = read("agy--resume-picker.txt").map((l) => lineText(l).replace("enter Select", "enter Pick  "));
    expect(rows.some((r) => r.includes("enter Pick"))).toBe(true);
    const lines = splitLines(parseAnsi(rows.join("\n")));
    expect(buildBlocks(lines, { agent: "agy" }).some((b) => b.kind === "menu")).toBe(false);
  });
});

describe("agy: a question takes its digit alone (1.3.5)", () => {
  // Measured live 2026-10-15: the digit answers on its own. On a one-question call it submitted; on
  // the first of two it answered and moved to the second; on the last it submitted the set. An Enter
  // sent after it answered the NEXT question with whatever row its pointer stood on.
  const read = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  const promptOf = (lines: ReturnType<typeof read>) => {
    const block = buildBlocks(lines, { agent: "agy" }).find((b) => b.kind === "prompt-select");
    return block?.kind === "prompt-select" ? block.prompt : null;
  };

  it.each([
    ["agy--ask-two-q1.txt", "Question 1/2: Which animal do you like?", [["cat", "1"], ["dog", "2"], ["fox", "3"]]],
    ["agy--ask-two-q2.txt", "Question 2/2: Which drink do you want?", [["tea", "1"], ["coffee", "2"]]],
    ["agy--plan-approval-135.txt", "Question 1/1: Approve plan execution?", [["Execute plan", "1"], ["Request changes", "2"], ["Cancel", "3"]]],
  ])("%s lifts each option as its digit alone", (name, question, options) => {
    const prompt = promptOf(read(name));
    expect(prompt?.question).toBe(question);
    expect(prompt?.options.map((o) => [o.label, o.keys.join("+")])).toEqual(options);
  });

  // A conversation holding a plan artifact adds `ctrl+r Review` to every question's footer, which
  // files it under the plan family. Live 2026-10-15: the old digit-then-Enter there answered
  // Question 2/2 with its highlighted row.
  it.each([
    ["agy--plan-approval.txt", "Question 1/1: Approve plan execution?", [["Execute plan", "1"], ["Request changes", "2"], ["Cancel", "3"]]],
    ["agy--ask-two-q1.txt", "Question 1/2: Which animal do you like?", [["cat", "1"], ["dog", "2"], ["fox", "3"]]],
  ])("%s under a Review footer lifts each option as its digit alone", (name, question, options) => {
    const rows = read(name).map((l) => {
      const t = lineText(l);
      return t.trimEnd().endsWith("esc Skip") ? `${t.trimEnd()} · ctrl+r Review` : t;
    });
    expect(rows.some((r) => r.includes("ctrl+r Review"))).toBe(true);
    const prompt = promptOf(splitLines(parseAnsi(rows.join("\n"))));
    expect(prompt?.question).toBe(question);
    expect(prompt?.options.map((o) => [o.label, o.keys.join("+")])).toEqual(options);
  });

  it("sends no Enter after a digit on the captured one-question menu", () => {
    const prompt = promptOf(read("agy--select-menu.txt"));
    expect(prompt?.options.length).toBeGreaterThan(1);
    expect(prompt?.options.every((o) => o.keys.length === 1 && /^[1-9]$/.test(o.keys[0]!))).toBe(true);
  });

  it("keeps a checkbox question raw, also under a Submit All footer", () => {
    const lines = read("agy--ask-multi.txt");
    expect(buildBlocks(lines, { agent: "agy" }).map((b) => b.kind)).toEqual(["unread-dialog"]);
    const rows = lines.map((l) => lineText(l).replace("enter Submit · esc Skip", "enter Submit All · esc Skip"));
    expect(rows.some((r) => r.includes("Submit All"))).toBe(true);
    expect(promptOf(splitLines(parseAnsi(rows.join("\n"))))).toBeNull();
  });

  // Built from the capture, not seen live (review, 2026-10-15): the checkbox is known by its rows'
  // `[ ]` as well as by the footer, so neither a wrapped footer nor one without `space Toggle` lifts it.
  it.each([
    ["with `space Toggle` on a footer row of its own", "  ↑/↓ Navigate · space Toggle\n  enter Submit All · esc Skip"],
    ["under a Submit All footer that does not say `space Toggle`", "  ↑/↓ Navigate · enter Submit All · esc Skip"],
  ])("keeps a checkbox question raw %s", (_, footer) => {
    const rows = read("agy--ask-multi.txt").map((l) => {
      const t = lineText(l);
      return t.trimEnd() === "  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip" ? footer : t;
    });
    expect(rows.includes(footer)).toBe(true);
    expect(promptOf(splitLines(parseAnsi(rows.join("\n"))))).toBeNull();
  });

  // The case above keeps the boxes, so it holds without the `space Toggle` scan (second review,
  // 2026-10-16). Here only the wrapped footer says it is a checkbox.
  it("keeps a checkbox question raw from a wrapped `space Toggle` alone, with no boxes on its rows", () => {
    const rows = read("agy--ask-multi.txt").flatMap((l) => {
      const t = lineText(l);
      if (t.trimEnd() === "  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip") {
        return ["  ↑/↓ Navigate · space Toggle", "  enter Submit All · esc Skip"];
      }
      return [t.replace("[ ] ", "")];
    });
    expect(rows.some((t) => t.includes("[ ]"))).toBe(false);
    expect(promptOf(splitLines(parseAnsi(rows.join("\n"))))).toBeNull();
  });
});

describe("agy: background task rail", () => {
  const captured = readFileSync(fixtureFile("agy--v145-background-task--w80.txt"), "utf8");
  const rows = () => splitLines(parseAnsi(captured));

  it.each([agyAdapter, antigravityAdapter])("keeps task progress and finds the composer for $agent", (adapter) => {
    const lines = rows();
    expect(adapter.composerReady!(lines)).toBe(true);
    expect(adapter.extractInputDraft!(lines)).toBeNull();
    expect(adapter.extractStatusLines!(lines).map(lineText)).toEqual([lineText(lines[5]!)]);
    const blocks = buildBlocks(lines, { agent: adapter.agent });
    expect(blocks.map((block) => block.kind)).toEqual(["raw"]);
    expect(blocks[0]!.lines.map(lineText)).toEqual(["", "", "", lineText(lines[3]!), lineText(lines[4]!)]);
  });

  it("reads a real draft without including task progress", () => {
    const lines = rows();
    lines[1] = splitLines(parseAnsi("> typed draft"))[0]!;
    expect(agyAdapter.extractInputDraft!(lines)).toBe("typed draft");
  });

  it.each(["unexpected task row", "enter Confirm · esc Cancel", "  1. Allow\n  2. Deny"])("refuses unknown or modal rows: %s", (extra) => {
    const lines = rows();
    lines.splice(4, 0, ...splitLines(parseAnsi(extra)));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
  });
});

describe("AGY /artifact review and detail viewer (1.4.7)", () => {
  const load = (name: string) => splitLines(parseAnsi(readFileSync(fixtureFile(name), "utf8")));

  it("extracts the reviewing statusline when the composer is idle awaiting artifact review", () => {
    const lines = load("agy--v147-reviewing-idle--w119.txt");
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    const status = agyAdapter.extractStatusLines!(lines).map(lineText);
    expect(status).toEqual([
      "Gemini 3.8 Flash (Low)  plan  reviewing  ctx 98%  main  Gemini 5h 98.4% ↻4h56m · 7d 86.8% ↻4d2h  Cla",
    ]);
  });

  it.each([
    [
      "agy--v147-artifact-review--w119.txt",
      "Action required (1 left)",
      true,
      [
        ["Approve", ["y"]],
        ["Reject", ["n"]],
        ["Preview", ["p"]],
        ["Open", ["Enter"]],
        ["Done", ["Escape"]],
      ],
    ],
    [
      "agy--v147-artifact-review-preview--w119.txt",
      "Action required (1 left)",
      true,
      [
        ["Approve", ["y"]],
        ["Reject", ["n"]],
        ["Preview", ["p"]],
        ["Open", ["Enter"]],
        ["Done", ["Escape"]],
      ],
    ],
    [
      "agy--v147-artifact-review--w50.txt",
      "Action required (1 left)",
      true,
      [
        ["Approve", ["y"]],
        ["Reject", ["n"]],
        ["Preview", ["p"]],
        ["Open", ["Enter"]],
        ["Done", ["Escape"]],
      ],
    ],
    [
      "agy--v147-artifact-review-submit--w50.txt",
      "Action required (1 left)",
      false,
      [
        ["Submit", ["Enter"]],
        ["Dismiss", ["Escape"]],
      ],
    ],
    [
      "agy--v147-artifact-list--w119.txt",
      "Artifacts",
      true,
      [
        ["Preview", ["p"]],
        ["Open", ["Enter"]],
        ["Dismiss", ["Escape"]],
      ],
    ],
    [
      "agy--v147-artifact-detail--w119.txt",
      "plan.md",
      true,
      [
        ["Outline", ["t"]],
        ["Hide lines", ["l"]],
        ["Close", ["Escape"]],
      ],
    ],
    [
      "agy--v147-artifact-detail--w50.txt",
      "part1.md",
      true,
      [
        ["Outline", ["t"]],
        ["Hide lines", ["l"]],
        ["Close", ["Escape"]],
      ],
    ],
  ])("%s lifts into a menu card and preserves the bottom statusline", (name, title, upDown, expectedActions) => {
    const lines = load(name);
    expect(agyAdapter.composerReady!(lines)).toBe(false);
    const blocks = agyAdapter.buildBlocks(lines);
    const menuBlock = blocks.find((b) => b.kind === "menu");
    expect(menuBlock?.kind).toBe("menu");
    if (menuBlock?.kind !== "menu") return;
    expect(menuBlock.menu.title).toBe(title);
    expect(menuBlock.menu.nav).toEqual({ upDown });
    expect(menuBlock.menu.actions.map((a) => [a.label, a.keys])).toEqual(expectedActions);
    const status = agyAdapter.extractStatusLines!(lines).map(lineText);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatch(/Gemini 3\.8 Flash \(Low\)\s+plan\s+(?:reviewing|idle)\s+ctx 98%/);
  });

  it("switches the Submit action to Tab+Enter when Dismiss is focused in confirm-exit mode", () => {
    const raw = readFileSync(fixtureFile("agy--v147-artifact-review-submit--w50.txt"), "utf8").replace(
      "  \u001b[0m\u001b[7m\u001b[38;5;2m Submit \u001b[0m \u001b[0m\u001b[38;5;8mDismiss\u001b[0m",
      "  \u001b[0m\u001b[1m\u001b[38;5;2mSubmit\u001b[0m \u001b[0m\u001b[1m\u001b[38;5;3mDismiss\u001b[0m",
    );
    const blocks = agyAdapter.buildBlocks(splitLines(parseAnsi(raw)));
    const menuBlock = blocks.find((b) => b.kind === "menu");
    expect(menuBlock?.kind).toBe("menu");
    if (menuBlock?.kind !== "menu") return;
    expect(menuBlock.menu.nav).toEqual({ upDown: false });
    expect(menuBlock.menu.actions.map((a) => [a.label, a.keys])).toEqual([
      ["Submit", ["Tab", "Enter"]],
      ["Dismiss", ["Escape"]],
    ]);
  });

  it("lifts ArtifactDetailModel outline and unsent-comment confirmation views", () => {
    const outlineText = [
      " part1.md — Outline ",
      "> H1  Plan Part 1",
      "  ↑/↓ navigate · enter jump · t back",
      "Gemini 3.8 Flash (Low)  plan  reviewing  ctx 98%",
    ].join("\n");
    const outlineBlocks = agyAdapter.buildBlocks(splitLines(parseAnsi(outlineText)));
    const outlineMenu = outlineBlocks.find((b) => b.kind === "menu");
    expect(outlineMenu?.kind).toBe("menu");
    if (outlineMenu?.kind === "menu") {
      expect(outlineMenu.menu.title).toBe("part1.md — Outline");
      expect(outlineMenu.menu.nav).toEqual({ upDown: true });
      expect(outlineMenu.menu.actions.map((a) => [a.label, a.keys])).toEqual([
        ["Jump", ["Enter"]],
        ["Back", ["Escape"]],
      ]);
    }

    const unsentText = [
      " part2.md (1 comment) ",
      ">   1 💬   Plan Part 2 ",
      "      │ Looks good",
      "  You have 1 unsent comment(s). Send to agent?",
      "  y send + close · n discard + close · esc cancel",
      "Gemini 3.8 Flash (Low)  plan  reviewing  ctx 98%",
    ].join("\n");
    const unsentBlocks = agyAdapter.buildBlocks(splitLines(parseAnsi(unsentText)));
    const unsentMenu = unsentBlocks.find((b) => b.kind === "menu");
    expect(unsentMenu?.kind).toBe("menu");
    if (unsentMenu?.kind === "menu") {
      expect(unsentMenu.menu.title).toBe("part2.md");
      expect(unsentMenu.menu.nav).toEqual({ upDown: false });
      expect(unsentMenu.menu.actions.map((a) => [a.label, a.keys])).toEqual([
        ["Send & close", ["y"]],
        ["Discard & close", ["n"]],
        ["Cancel", ["Escape"]],
      ]);
    }
  });
});

describe("AGY native Keyboard & scrollPanel modals (1.4.7 / 1.4.8)", () => {
  const load = (name: string) => splitLines(parseAnsi(readFileSync(fixtureFile(name), "utf8")));

  it.each([
    [
      "agy--v147-rewind--w119.txt",
      "Rewind Conversation",
      { upDown: true, leftRight: undefined },
      [
        ["Select", ["Enter"]],
        ["Cancel", ["Escape"]],
      ],
    ],
    [
      "agy--v147-agents--w119.txt",
      "Available Agents",
      { upDown: true, leftRight: undefined },
      [
        ["Select", ["Enter"]],
        ["Go back", ["Escape"]],
      ],
    ],
    [
      "agy--v147-skills--w119.txt",
      "Skills",
      { upDown: true, leftRight: undefined },
      [
        ["View", ["Enter"]],
        ["Cancel", ["Escape"]],
      ],
    ],
    [
      "agy--v147-tasks--w119.txt",
      "Tasks",
      { upDown: false, leftRight: undefined },
      [["Close", ["Escape"]]],
    ],
    [
      "agy--v147-mcp--w119.txt",
      "MCP Servers",
      { upDown: false, leftRight: undefined },
      [["Exit", ["Escape"]]],
    ],
    [
      "agy--v147-settings--w119.txt",
      "Settings",
      { upDown: true, leftRight: { verb: "Change", label: "auto" } },
      [
        ["Select", ["Enter"]],
        ["Exit", ["Escape"]],
      ],
    ],
    [
      "agy--v147-permissions--w119.txt",
      "Permission Config Editor",
      { upDown: true, leftRight: undefined },
      [
        ["Save", ["Enter"]],
        ["Close", ["Escape"]],
      ],
    ],
    [
      "agy--v147-usage--w119.txt",
      "Models & Quota",
      { upDown: true },
      [["Close", ["Escape"]]],
    ],
    [
      "agy--v147-usage--w50.txt",
      "Models & Quota",
      { upDown: true },
      [["Close", ["Escape"]]],
    ],
  ])("%s lifts into a safe MenuModel card without unread-dialog", (name, title, nav, actions) => {
    const lines = load(name);
    for (const adapter of [agyAdapter, antigravityAdapter]) {
      expect(adapter.composerReady!(lines)).toBe(false);
      expect(adapter.extractStatusLines!(lines)).toHaveLength(1);
      const blocks = buildBlocks(lines, { agent: adapter.agent });
      expect(blocks.some((b) => b.kind === "unread-dialog")).toBe(false);
      const menuBlock = blocks.find((b) => b.kind === "menu");
      expect(menuBlock?.kind).toBe("menu");
      if (menuBlock?.kind === "menu") {
        expect(menuBlock.menu.title).toBe(title);
        expect(menuBlock.menu.nav).toEqual(nav);
        expect(menuBlock.menu.actions.map((a) => [a.label, a.keys])).toEqual(actions);
      }
    }
  });

  it("lifts the Context Usage scroll panel ('└ Context Usage') as a MenuModel card", () => {
    const contextUsage = [
      RULE,
      ">",
      RULE,
      "\u001b[1m\u001b[38;5;7m└ Context Usage\u001b[0m",
      "□ □ □ □ □ □ □ □     Gemini 4 Argon (High) · 0/1.0M tokens",
      "□ □ □ □ □ □ □ □     Estimated usage (awaiting generation)",
      "□ □ □ □ □ □ □ □     □ Free space: 1.0M (100.0%)",
      "",
      "Related: /artifact · /skill · /rewind",
      "  ↑/↓ Scroll · pgup/pgdown Page · ctrl+end Bottom · ctrl+home Top · esc Close",
      "Gemini 4 Argon (High)  idle  ctx 100%",
    ].join("\n");
    const lines = splitLines(parseAnsi(contextUsage));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
    expect(agyAdapter.extractStatusLines!(lines)).toHaveLength(1);
    const blocks = buildBlocks(lines, { agent: "agy" });
    expect(blocks.some((b) => b.kind === "unread-dialog")).toBe(false);
    const menuBlock = blocks.find((b) => b.kind === "menu");
    expect(menuBlock?.kind).toBe("menu");
    if (menuBlock?.kind === "menu") {
      expect(menuBlock.menu.title).toBe("Context Usage");
      expect(menuBlock.menu.nav).toEqual({ upDown: true });
      expect(menuBlock.menu.actions.map((a) => [a.label, a.keys])).toEqual([["Close", ["Escape"]]]);
    }
  });

  it("strips trailing dim or ansi-8 inline autocomplete hints (e.g. 'reload' after '/skills') while preserving placeholders", () => {
    for (const ghostSgr of ["\u001b[2m", "\u001b[38;5;8m"]) {
      const skillsDraft = [
        RULE,
        `> /skills\u001b[7m\u001b[47m\u001b[30m \u001b[0m${ghostSgr}reload                                                                                      \u001b[0m`,
        RULE,
        "\u001b[1m\u001b[34m> /skills\u001b[0m  \u001b[38;5;8mList available skills\u001b[0m",
        "  \u001b[38;5;8m↑/↓ Navigate · enter Select · tab Complete\u001b[0m",
        "\u001b[38;5;8mesc to cancel\u001b[0m  \u001b[38;5;4mGemini 3.8 Flash\u001b[0m \u001b[38;5;8m(High)\u001b[0m",
      ].join("\n");
      const lines = splitLines(parseAnsi(skillsDraft));
      const normalized = normalizeAgyScreenRows(lines);
      expect(lineText(normalized[1]!).trim()).toBe("> /skills");
      expect(lineText(normalized[1]!).length).toBe(lineText(lines[1]!).length);
      expect(agyAdapter.composerReady!(lines)).toBe(true);
      expect(agyAdapter.extractInputDraft!(lines)).toBe("/skills");
      expect(agyAdapter.extractStatusLines!(lines)).toHaveLength(1);
    }
  });

  it("recognizes parenthesized command aliases like '/config (settings)' in completion popups", () => {
    const settingsDraft = [
      RULE,
      "> /settings\u001b[7m\u001b[47m\u001b[30m \u001b[0m                                                                                          ",
      RULE,
      "\u001b[1m\u001b[34m> /config (settings)\u001b[0m  \u001b[38;5;8mOpen settings panel\u001b[0m",
      "  \u001b[38;5;8m↑/↓ Navigate · enter Select · tab Complete\u001b[0m",
      "\u001b[38;5;8mesc to cancel\u001b[0m  \u001b[38;5;4mGemini 3.8 Flash\u001b[0m \u001b[38;5;8m(High)\u001b[0m",
    ].join("\n");
    const lines = splitLines(parseAnsi(settingsDraft));
    const normalized = normalizeAgyScreenRows(lines);
    expect(lineText(normalized[3]!)).toBe("> /settings           Open settings panel");
    expect(agyAdapter.composerReady!(lines)).toBe(true);
    expect(agyAdapter.extractInputDraft!(lines)).toBe("/settings");
    expect(agyAdapter.extractStatusLines!(lines)).toHaveLength(1);
  });
});
