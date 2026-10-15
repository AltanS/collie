import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, trimTrailingBlank, type StyledLine } from "../../blocks";
import { buildBlocks } from "../index";
import { piAdapter } from "./index";
import { cropLine, panelColumn, piView } from "./panel";

const PANES = join(import.meta.dirname, "../../../fixtures/panes");
const raw = (name: string) => readFileSync(join(PANES, name), "utf8");
const load = (name: string) => splitLines(parseAnsi(raw(name)));
const row = (value: string): StyledLine => ({ segments: parseAnsi(value) });
const text = (line: StyledLine) => lineText(line).trimEnd();

// OmO 5.1.30 in fullscreen mode at 125 columns, the side panel on (fixtures README, #412).
const PANEL = [
  "pi--omo-v5130-panel-draft.txt",
  "pi--omo-v5130-panel-phantom.txt",
  "pi--omo-v5130-panel-picker-tree-cut.txt",
  "pi--omo-v5130-panel-picker-tree.txt",
  "pi--omo-v5130-panel-question-cut-footer.txt",
  "pi--omo-v5130-panel-question-cut.txt",
  "pi--omo-v5130-panel-question.txt",
  "pi--omo-v5130-panel-running.txt",
  "pi--omo-v5130-panel-slash-model.txt",
];

describe("the side panel's signs", () => {
  it("crop only the panel captures: every other screen in the corpus is read as it is", () => {
    const all = readdirSync(PANES).filter((n) => n.endsWith(".txt")).toSorted();
    expect(all.length).toBeGreaterThan(500);
    expect(all.filter((name) => panelColumn(load(name)) !== null)).toEqual(PANEL);
  });

  it("does not crop the panel pane while the panel stays above the editor", () => {
    const lines = load("pi--omo-v5130-panel-idle.txt");
    expect(piView(lines)).toEqual({ lines, cropped: false, column: null });
    expect(piAdapter.composerPrompt?.(lines)).not.toBeNull();
  });

  it("(a) reads the column off a rule that runs straight into the panel, bare or labelled", () => {
    const draft = load("pi--omo-v5130-panel-draft.txt");
    expect(text(draft[13]!)).toMatch(/^─{91}MEMORY/);
    expect(panelColumn(draft)).toBe(91);
    const running = load("pi--omo-v5130-panel-running.txt");
    expect(text(running[13]!)).toMatch(/^── • Working .* ─+facts/);
    expect(panelColumn(running)).toBe(91);
  });

  it("(b) reads it off an editor row padded to the rules' end, then the panel: no phantom draft", () => {
    const lines = load("pi--omo-v5130-panel-phantom.txt");
    expect(text(lines[13]!)).toBe("─".repeat(91));
    expect(text(lines[14]!)).toMatch(/^❯ {90}…/);
    expect(panelColumn(lines)).toBe(91);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
  });

  it("(b) reads it off a picker's header beside the panel", () => {
    expect(panelColumn(load("pi--omo-v5130-panel-picker-tree.txt"))).toBe(93);
  });

  it("(c) reads it off the top rule of a dialog whose bottom rule is off the screen", () => {
    expect(panelColumn(load("pi--omo-v5130-panel-question-cut.txt"))).toBe(91);
    expect(panelColumn(load("pi--omo-v5130-panel-question-cut-footer.txt"))).toBe(91);
    expect(panelColumn(load("pi--omo-v5130-panel-picker-tree-cut.txt"))).toBe(93);
    // A rule run into text with no pi frame under it crops nothing.
    expect(panelColumn([ruleInto(91, "cache   100% hit"), row(" plain prose under it")])).toBeNull();
  });

  // Sign (a) is anchored: W must be the run of the tail frame's own bottom rule, and a sign row must
  // be a row of that frame. So text in the transcript cannot crop the real frame.
  const ruleInto = (width: number, after: string) => row(`\x1b[38;2;112;112;112m${"─".repeat(width)}\x1b[0m${after}`);
  const transcript = (lines: StyledLine[], rows: StyledLine[]) => [...rows, row(""), ...lines];

  it.each(["pi--omo-v5130-plain-idle.txt", "pi--v110-stock-idle.txt", "pi--omo-v5130-plain-question.txt"])(
    "a markdown rule run straight into text in the transcript above %s crops nothing",
    (name) => {
      const lines = load(name);
      const width = Math.max(...lines.map((line) => text(line).length));
      for (const sign of [ruleInto(40, "Heading"), ruleInto(width - 10, "Notes"), row(`── Section ${"─".repeat(20)}text`)]) {
        const spoofed = transcript(lines, [row("Agent reply:"), sign]);
        expect(panelColumn(spoofed)).toBeNull();
        expect(piView(spoofed).cropped).toBe(false);
      }
    },
  );

  it("a short rule run into text gives no small W: not in the transcript, not in a typed draft", () => {
    const lines = load("pi--v110-stock-draft.txt");
    expect(panelColumn(transcript(lines, [ruleInto(8, "x")]))).toBeNull();
    const typed = raw("pi--v110-stock-draft.txt").replace(/collie stock pi draft probe(?![\s\S]*collie stock pi draft probe)/, "────────x");
    expect(typed).not.toBe(raw("pi--v110-stock-draft.txt"));
    expect(panelColumn(splitLines(parseAnsi(typed)))).toBeNull();
    // The same short rule beside the real panel leaves the real W.
    expect(panelColumn(transcript(load("pi--omo-v5130-panel-draft.txt"), [ruleInto(8, "x")]))).toBe(91);
  });

  it("finds no sign in a rule that runs into a box glyph, or with no frame at the tail", () => {
    expect(panelColumn([row(`${"─".repeat(20)}┬${"─".repeat(10)}`)])).toBeNull();
    expect(panelColumn([row(`${"─".repeat(20)}MEMORY`), row(`${"─".repeat(30)}facts`)])).toBeNull();
  });

  it("finds no sign (b) in a row that is longer than the rule but not padded to it", () => {
    const lines = load("pi--omo-v5130-plain-idle.txt");
    const width = text(lines[0]!).length;
    const prompt = lines[1]!.segments[0]!;
    const long = [lines[0]!, { segments: [prompt, { ...prompt, fg: undefined, text: ` ${"x".repeat(width + 5)}` }] }, ...lines.slice(2)];
    expect(panelColumn(long)).toBeNull();
  });
});

describe("a cropped screen", () => {
  it.each(PANEL)("%s binds no composer write: the editor's bound prompt is whole rows", (name) => {
    const lines = load(name);
    expect(piView(lines)).toMatchObject({ cropped: true, column: name.includes("picker-tree") ? 93 : 91 });
    expect(piAdapter.composerPrompt?.(lines)).toBeNull();
  });

  it("lifts a question beside the panel, bound to the columns left of it", () => {
    const lines = load("pi--omo-v5130-panel-question.txt");
    expect(piAdapter.modalOnScreen?.(lines)).toBe(true);
    expect(piAdapter.composerReady?.(lines)).toBe(false);
    const blocks = buildBlocks(lines, { agent: "pi" });
    expect(blocks.map((block) => block.kind)).toEqual(["raw", "prompt-select"]);
    const card = blocks[1]!;
    if (card.kind !== "prompt-select") throw new Error("no card");
    const model = card.prompt;
    expect(model.bindColumns).toEqual({ start: 0, end: 91 });
    expect(model.question).toBe("Pick a color?");
    // OmO's `1-9 select`: the printed digit alone (.adr/0098, plan b), and the footer's Escape.
    expect(model.options.map((o) => [o.label, o.keys])).toEqual([
      ["Red", ["1"]],
      ["Green", ["2"]],
      ["Cancel", ["Escape"]],
    ]);
    // Nothing of the panel reaches the region, the card's rows, or the question.
    for (const signed of model.signature.split("\n")) expect(signed.length).toBeLessThanOrEqual(91);
    expect(model.signature).not.toMatch(/MEMORY|CONTEXT|TOOLS|facts/);
    for (const line of card.lines) expect(text(line).length).toBeLessThanOrEqual(91);
  });

  it("binds the same question without a range when no panel is beside it", () => {
    const blocks = piAdapter.buildBlocks(load("pi--omo-v5130-plain-question.txt"));
    const card = blocks.find((block) => block.kind === "prompt-select");
    expect(card?.kind === "prompt-select" ? card.prompt.bindColumns : "none").toBeUndefined();
  });

  it("keeps the screen's own rows on the mirror", () => {
    const lines = load("pi--omo-v5130-panel-draft.txt");
    const [block] = piAdapter.buildBlocks(lines);
    expect(block?.kind === "raw" ? block.lines : []).toEqual(trimTrailingBlank(lines.slice(0, 13)));
  });
});

describe("cropLine", () => {
  it("cuts at display columns and keeps each segment's style", () => {
    const line = row("\x1b[31mab\x1b[0m\x1b[32mcdef\x1b[0m");
    const cut = cropLine(line, 4);
    expect(cut.segments.map((s) => [s.text, s.fg])).toEqual([["ab", line.segments[0]!.fg], ["cd", line.segments[1]!.fg]]);
  });

  it("counts a wide character as two columns and never splits it", () => {
    expect(text(cropLine(row("中文ab"), 4))).toBe("中文");
    expect(text(cropLine(row("中文ab"), 3))).toBe("中");
    expect(lineText(cropLine(row("😺 OmO"), 3))).toBe("😺 ");
  });

  it("returns a row narrower than the column unchanged", () => {
    const line = row("\x1b[31mshort\x1b[0m");
    expect(cropLine(line, 40)).toEqual(line);
  });
});
