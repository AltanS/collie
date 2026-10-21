import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import {
  composerDraft, composerPrompt, composerStatusLines, locateComposer, tailRule,
} from "./composer";

function fixture(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(
    new URL(`../../../fixtures/panes/${name}.txt`, import.meta.url), "utf8",
  )));
}

const capture = (name: string) => fixture(`pi--omo-v5130-${name}`);
const stock = (name: string) => fixture(`pi--v0851-${name}`);

function row(value: string): StyledLine {
  return { segments: parseAnsi(value) };
}

const idle = capture("idle");
const rule = lineText(idle[0]!).trimEnd();
const blue = "\x1b[38;2;97;133;204m";

describe("OmO composer", () => {
  it("locates the editor when the captured idle tail has three status rows", () => {
    expect(locateComposer(idle)).toEqual({ layout: "omo", top: 0, bottom: 2, statusStart: 3, end: 6 });
  });

  it("returns no draft when the captured editor is empty", () => {
    expect(composerDraft(idle)).toBeNull();
  });

  it("reads the literal draft when it was typed into the real sandbox editor", () => {
    const lines = capture("draft");
    expect(composerDraft(lines)).toBe("collie composer draft probe");
    expect(composerPrompt(lines)).toBe(`${rule}\n❯ collie composer draft probe\n${rule}`);
  });

  it("binds the exact frame when terminal padding follows the prompt", () => {
    expect(composerPrompt(idle)).toBe(`${rule}\n❯\n${rule}`);
  });

  it("extracts wrapped draft text when only the editor rows change", () => {
    const lines = [idle[0]!, row(`${blue}❯\x1b[0m first draft`), row("  wrapped text"),
      row("  "), row("    indented"), ...idle.slice(2)];
    expect(composerDraft(lines)).toBe("first draft wrapped text indented");
  });

  it("binds all draft rows when a wrapped editor changes", () => {
    const lines = [idle[0]!, row(`${blue}❯\x1b[0m first`), row("  second"), ...idle.slice(2)];
    expect(composerPrompt(lines)).toBe(`${rule}\n❯ first\n  second\n${rule}`);
  });

  it.each([1, 2, 3])("accepts %i styled status rows with trailing blank padding", (count) => {
    const lines = [...idle.slice(0, 3 + count), row("  "), row("")];
    expect(tailRule(lines)).toMatchObject({ bottom: 2, statusStart: 3, end: 3 + count, palette: false });
  });

  it("preserves the captured status rows and their styling", () => {
    expect(composerStatusLines(idle)).toEqual(idle.slice(3, 6));
  });

  it.each(["single-described", "single-described-moved", "single-other-focused", "multi"])(
    "refuses typing on the %s dialog and still reads its status rows", (name) => {
      const lines = capture(name);
      expect(locateComposer(lines)).toBeNull();
      expect(composerDraft(lines)).toBeNull();
      expect(composerPrompt(lines)).toBeNull();
      expect(tailRule(lines)).toMatchObject({ bottom: 15, statusStart: 16, end: 19 });
      expect(composerStatusLines(lines)).toEqual(lines.slice(16, 19));
    },
  );

  it.each([
    ["ordinary appended output", [...idle, row("output after the status")]],
    ["a fourth status row", [...idle, row(`${blue}extra footer`)]],
    ["an intervening blank", [...idle.slice(0, 4), row(""), ...idle.slice(4)]],
    ["a boxed footer", [...idle.slice(0, 5), row(`${blue}╭────────╮`)]],
    ["a double-line boxed footer", [...idle.slice(0, 5), row(`${blue}╔════════╗`)]],
    ["two unstyled rows under the styled ones", [...idle.slice(0, 4), row("ordinary output"), row("more output")]],
    ["an unstyled row between styled ones", [...idle.slice(0, 4), row("ordinary output"), idle[5]!]],
    ["unstyled status fields", [...idle.slice(0, 3), row("cwd • model")]],
    ["a box bottom instead of a plain rule", [idle[0]!, idle[1]!, row(`${blue}╰────────╯`), ...idle.slice(3)]],
  ])("rejects the unknown tail when it contains %s", (_name, lines) => {
    expect(locateComposer(lines)).toBeNull();
    expect(composerStatusLines(lines)).toEqual([]);
  });

  it("accepts one plain last row under styled ones: pi's extension-status line", () => {
    // pi's footer prints every extension's status text on one row after its own, unstyled unless the
    // extension paints it. A default OmO install prints its badge there (pi--omo-v5130-plain-idle).
    const lines = [...idle.slice(0, 5), row("(badge) mem:work-0000 just now")];
    expect(tailRule(lines)).toMatchObject({ bottom: 2, statusStart: 3, end: 6, palette: false });
    expect(locateComposer(lines)?.layout).toBe("omo");
  });

  it.each([
    ["indented prompt", row(`${blue} ❯ draft`)],
    ["unstyled prompt", row("❯ draft")],
    ["dialog choice", row(`${blue} → 1. Choice`)],
  ])("refuses the editor when its prompt is a %s", (_name, prompt) => {
    expect(locateComposer([idle[0]!, prompt, ...idle.slice(2)])).toBeNull();
  });

  it("refuses a boxed continuation when an apparent composer encloses it", () => {
    const lines = [idle[0]!, idle[1]!, row("  │ dialog │"), ...idle.slice(2)];
    expect(locateComposer(lines)).toBeNull();
  });

  it("refuses mismatched rule styling when the frame is torn", () => {
    expect(locateComposer([row(`\x1b[31m${rule}`), ...idle.slice(1)])).toBeNull();
  });

  it("refuses a missing top rule when only the prompt remains", () => {
    expect(locateComposer(idle.slice(1))).toBeNull();
  });

  it("refuses an overlong editor when its prompt lies beyond the scan bound", () => {
    const lines = [idle[0]!, idle[1]!, ...Array.from({ length: 100 }, () => row("  text")),
      ...idle.slice(2)];
    expect(locateComposer(lines)).toBeNull();
  });

  it("refuses an empty buffer", () => {
    expect(tailRule([])).toBeNull();
    expect(locateComposer([])).toBeNull();
  });
});

describe("stock pi composer", () => {
  it("locates the stock pi editor when the draft row carries no prompt glyph", () => {
    const lines = stock("idle");
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, statusStart: 3, end: 5 });
    expect(composerDraft(lines)).toBeNull();
    expect(composerStatusLines(lines)).toEqual(lines.slice(3, 5));
  });

  it("reads the literal draft when it was typed into a real stock pi editor", () => {
    const lines = stock("draft");
    expect(composerDraft(lines)).toBe("collie stock pi draft probe");
    expect(composerPrompt(lines)?.split("\n")[1]).toBe("collie stock pi draft probe");
  });

  it("keeps the editor when a running turn labels the top rule", () => {
    // The label sits inside a rule of the editor's own width and colour (pi--v085-working-editor.txt).
    const labelled = (lines: StyledLine[], label: string): StyledLine[] => {
      const width = lineText(lines[0]!).trimEnd().length;
      const segment = lines[0]!.segments.find((s) => s.text.trim() !== "")!;
      const text = `── ${label} ${"─".repeat(width - label.length - 4)}`;
      return [{ segments: [{ ...segment, text }] }, ...lines.slice(1)];
    };
    expect(locateComposer(labelled(stock("draft"), "⠴ Working"))?.top).toBe(0);
    expect(locateComposer(labelled(idle, "• Working"))?.top).toBe(0);
  });

  it("refuses a stock layout when a row between the rules opens with a space", () => {
    const lines = [...stock("idle").slice(0, 1), row(" Ask user · 30m"), ...stock("idle").slice(2)];
    expect(locateComposer(lines)).toBeNull();
  });

  it("reads a draft with a blank row and indented rows, one space per seam (canary 04 and 07)", () => {
    const lines = stock("draft");
    const draft = (rows: string[]) => composerDraft([lines[0]!, ...rows.map((r) => row(r)), ...lines.slice(2)]);
    expect(draft(["Reply with only OK.", "", "A paragraph after a blank line."])).toBe(
      "Reply with only OK. A paragraph after a blank line.",
    );
    expect(draft(["Reply with only OK.", "    indented code line", "    another indented line"])).toBe(
      "Reply with only OK. indented code line another indented line",
    );
  });

  it("refuses a stock editor whose first row is indented: that is a panel, not a draft", () => {
    const lines = stock("draft");
    expect(locateComposer([lines[0]!, row("    indented first"), row("second"), ...lines.slice(2)])).toBeNull();
    expect(locateComposer([lines[0]!, row(""), row(" Pick a color?"), row("> 1. Red"), ...lines.slice(2)])).toBeNull();
  });

  it("passes over a shorter pasted rule inside the draft and finds the editor's own top rule", () => {
    const lines = stock("draft");
    const pasted = [lines[0]!, row("before"), row("─".repeat(15)), row("after"), ...lines.slice(2)];
    expect(locateComposer(pasted)?.top).toBe(0);
    expect(composerDraft(pasted)).toBe(`before ${"─".repeat(15)} after`);
  });
});

// The PR 397 captures (pi 1.1.0 with the contributor's question extension, fixtures README): a
// one-row powerbar status line, pi's default two-row footer, a multi-row draft, the running turn and
// the slash palette.
describe("pi 1.1.0 composer (PR 397 captures)", () => {
  it.each([
    ["pi--v110-idle", null, 1],
    ["pi--v110-idle-default-footer", null, 2],
    ["pi--v110-narrow-idle", null, 1],
    ["pi--v110-draft", "Add unit tests for the parser", 1],
    ["pi--v110-draft-multiline", "Add unit tests for the parser and verify edge cases", 1],
    ["pi--v110-working", null, 1],
  ])("reads %s as a stock editor", (name, draft, status) => {
    const lines = fixture(name);
    expect(locateComposer(lines)?.layout).toBe("stock");
    expect(composerDraft(lines)).toBe(draft);
    expect(composerStatusLines(lines)).toHaveLength(status);
    expect(composerPrompt(lines)).not.toBeNull();
  });

  it("reads the slash palette under the editor and leaves the frame unbound past the tail window", () => {
    const lines = fixture("pi--v110-slash-palette");
    const composer = locateComposer(lines);
    expect(composer).not.toBeNull();
    expect(tailRule(lines)?.palette).toBe(true);
    expect(composerDraft(lines)).toBe("/");
    // Six palette rows and the status row sit under the bottom rule: the bridge binds a region only
    // within the last six non-blank rows, so the write goes unbound rather than 409 every time.
    expect(composerPrompt(lines)).toBeNull();
    expect(composerStatusLines(lines)).toHaveLength(1);
  });

  it("refuses a palette under a draft that is not a slash command", () => {
    const lines = fixture("pi--v110-slash-palette");
    const composer = locateComposer(lines)!;
    const edited = [...lines.slice(0, composer.top + 1), row("plain text"), ...lines.slice(composer.bottom)];
    expect(locateComposer(edited)).toBeNull();
  });

  it("keeps the editor when a scrolled editor writes its overflow into the top rule", () => {
    const lines = fixture("pi--v110-draft");
    const composer = locateComposer(lines)!;
    const width = lineText(lines[composer.bottom]!).trimEnd().length;
    const mark = `─── ↑ 2 more ${"─".repeat(width - 13)}`;
    const ruleSegment = lines[composer.top]!.segments.find((s) => s.text.trim() !== "")!;
    const scrolled = [
      ...lines.slice(0, composer.top), { segments: [{ ...ruleSegment, text: mark }] }, ...lines.slice(composer.top + 1),
    ];
    expect(composerDraft(scrolled)).toBe("Add unit tests for the parser");
  });
});

// Issue 442, pi 1.2.0 with `editorPaddingX` above 0: every editor row, the draft's included, opens with
// that many spaces (pi--v120-*, real pi 1.2.0 reads through Herdr's pane.read; the fixtures README has
// the padding of each). A first row opening with a space is also what a panel's title looks like, so
// the editor is told from a panel by its own cursor cell and by a padding every row shares. The
// two-row footer is pi 1.2.0's: the cwd row, then the stats row.
describe("pi 1.2.0 composer with editorPaddingX (issue 442)", () => {
  it("reads the empty padded editor as a composer with no draft", () => {
    const lines = fixture("pi--v120-idle-padded");
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, statusStart: 3, end: 5 });
    expect(composerDraft(lines)).toBeNull();
    expect(composerStatusLines(lines)).toHaveLength(2);
  });

  it("reads a draft indented by one column of padding", () => {
    const lines = fixture("pi--v120-draft-padded");
    expect(lineText(lines[1]!).startsWith(" hello from the probe")).toBe(true);
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, statusStart: 3, end: 5 });
    expect(composerDraft(lines)).toBe("hello from the probe");
    expect(composerPrompt(lines)?.split("\n")[1]).toBe(" hello from the probe");
  });

  it("reads the same draft at padding zero, the control", () => {
    const lines = fixture("pi--v120-draft-unpadded");
    expect(lineText(lines[1]!).startsWith("hello from the probe")).toBe(true);
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, statusStart: 3, end: 5 });
    expect(composerDraft(lines)).toBe("hello from the probe");
  });

  it("reads a two-line draft indented by two columns of padding", () => {
    const lines = fixture("pi--v120-draft-padded-multiline");
    expect(lineText(lines[1]!).startsWith("  line one")).toBe(true);
    expect(lineText(lines[2]!).startsWith("  line two")).toBe(true);
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 3, statusStart: 4, end: 6 });
    expect(composerDraft(lines)).toBe("line one line two");
    expect(composerPrompt(lines)).not.toBeNull();
  });

  it("still keeps a pasted indented row inside a padded draft", () => {
    const lines = fixture("pi--v120-draft-padded");
    const draft = (rows: StyledLine[]) => composerDraft([lines[0]!, ...rows, ...lines.slice(2)]);
    expect(draft([lines[1]!, row("     indented code line")])).toBe("hello from the probe indented code line");
  });

  it("refuses a padded-looking panel: no cursor cell, or a row the padding did not reach", () => {
    const lines = fixture("pi--v120-draft-padded");
    const tail = lines.slice(2);
    // The same one-space title the question dialogs open with, with no cursor cell in it.
    expect(locateComposer([lines[0]!, row(" Pick a color for the Collie probe?"), ...tail])).toBeNull();
    // A cursor cell, but a pointer row at column zero under a padded title: pi's select dialogs.
    expect(locateComposer([lines[0]!, lines[1]!, row("> 1. Red"), row("  2. Green"), ...tail])).toBeNull();
    // A cursor cell, but a row under the draft that no padding reached: pi pads every row it draws.
    expect(locateComposer([lines[0]!, lines[1]!, row("not padded"), ...tail])).toBeNull();
  });

  it("reads the slash palette that pi pads with the editor, and still binds nothing past the tail window", () => {
    const lines = fixture("pi--v120-slash-palette-padded");
    expect(lineText(lines[3]!).startsWith(" → settings")).toBe(true);
    expect(tailRule(lines)).toMatchObject({ bottom: 2, statusStart: 9, end: 11, palette: true });
    expect(composerDraft(lines)).toBe("/");
    expect(composerPrompt(lines)).toBeNull();
    expect(composerStatusLines(lines)).toHaveLength(2);
  });

  it("refuses the padded palette under a draft that is not a slash command", () => {
    const lines = fixture("pi--v120-slash-palette-padded");
    expect(locateComposer(lines)).not.toBeNull();
    expect(locateComposer([lines[0]!, row(` plain text${"\x1b[7m \x1b[0m"}`), ...lines.slice(2)])).toBeNull();
  });

  it("adds no composer to the pi corpus: the padded path changes none of the captures' answers", () => {
    const PANES = new URL("../../../fixtures/panes/", import.meta.url);
    const dialogs = readdirSync(PANES).filter((n) => /^pi--(v0871|v110|omo-v5130)-.*(question|single|multi|tabs|review|submit|picker|selector|editor)/.test(n) && !/draft|idle/.test(n));
    expect(dialogs.length).toBeGreaterThan(30);
    const found = dialogs.filter((name) => locateComposer(fixture(name.slice(0, -4))) !== null);
    // Pickers and answered rows whose rows start at column zero were already read as a frame before
    // padding existed (index.ts refuses them through piModalOnScreen). No other dialog joins them.
    expect(found).toEqual([
      "pi--omo-v5130-picker-model.txt",
      "pi--omo-v5130-picker-resume.txt",
      "pi--omo-v5130-question-banner.txt",
      // pi 0.87.1's model selector, its rows at column zero between the box's rules (lab, 2026-10-17).
      "pi--v0871-model-selector-empty--w120.txt",
      "pi--v0871-question-answered.txt",
      "pi--v110-core-selector.txt",
      "pi--v110-question-answered.txt",
      "pi--v110-stock-picker-resume.txt",
    ]);
  });
});

// Issue 416, OmO 5.1.30 as installed (fixtures README): the badge row is plain, and the `/` list
// stands between the bottom rule and the status rows, two spaces in, four before the others.
describe("OmO default install (issue 416)", () => {
  const omo = (name: string) => fixture(`pi--omo-v5130-${name}`);

  it("reads the editor over a styled status row and the plain badge row under it", () => {
    const lines = omo("plain-idle");
    expect(locateComposer(lines)).toEqual({ layout: "omo", top: 0, bottom: 2, statusStart: 3, end: 5 });
    expect(composerStatusLines(lines)).toEqual(lines.slice(3, 5));
    expect(composerDraft(omo("plain-draft"))).toBe("hello collie draft");
    expect(locateComposer(omo("plain-running"))?.top).toBe(0);
  });

  it("reads the indented completion list under a slash draft and binds the frame inside the tail window", () => {
    const lines = omo("slash-model");
    expect(tailRule(lines)).toMatchObject({ bottom: 2, statusStart: 6, palette: true });
    expect(composerDraft(lines)).toBe("/model");
    expect(composerPrompt(lines)).toBe(lines.slice(0, 3).map((l) => lineText(l).trimEnd()).join("\n"));
    expect(composerDraft(omo("slash-compact"))).toBe("/compact");
  });

  const palette = omo("slash-model");
  const at = (rows: string[]) => [...palette.slice(0, 3), ...rows.map((r) => row(r)), ...palette.slice(6)];

  it("takes the arrow on any one row: the list scrolls under it", () => {
    expect(locateComposer(at(["    model    Select model", "  → scoped-models  Enable", "    favorite-models  Manage"]))).not.toBeNull();
    expect(locateComposer(at(["    model    Select model", "    scoped-models  Enable", "  → favorite-models  Manage"]))).not.toBeNull();
  });

  it.each([
    ["no arrow", ["    model    Select model", "    scoped-models  Enable"]],
    ["two arrows", ["  → model    Select model", "  → scoped-models  Enable"]],
    ["both forms at once", ["  → model    Select model", "  scoped-models  Enable"]],
    ["a stock arrow over OmO rows", ["→ model    Select model", "    scoped-models  Enable"]],
  ])("refuses a list with %s", (_name, rows) => {
    expect(locateComposer(at(rows))).toBeNull();
  });

  it("refuses the list under a draft that is not a slash command", () => {
    const draft = (text: string) => [palette[0]!, row(`\x1b[38;2;112;112;112m❯\x1b[0m ${text}`), ...palette.slice(2)];
    expect(locateComposer(draft("/model"))).not.toBeNull();
    expect(locateComposer(draft("plain text"))).toBeNull();
  });

  it("leaves the frame unbound when a longer list pushes it out of the bridge's tail window", () => {
    const long = at(["  → model    Select model", "    a  b", "    c  d", "    e  f"]);
    expect(composerDraft(long)).toBe("/model");
    expect(composerPrompt(long)).toBeNull();
  });
});

describe("pi with an empty footer (issue 445)", () => {
  const bare = (draft: string) => [row(rule), row(draft), row(rule)];

  it("reads the editor when the bottom rule is the last non-blank row", () => {
    const lines = [...bare("hello"), row(""), row("")];
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, statusStart: 3, end: 3 });
    expect(composerDraft(lines)).toBe("hello");
    expect(composerPrompt(lines)).toBe(`${rule}\nhello\n${rule}`);
    expect(composerStatusLines(lines)).toEqual([]);
  });

  it("reads the empty editor with no draft", () => {
    expect(composerDraft(bare(""))).toBeNull();
    expect(locateComposer(bare(""))).not.toBeNull();
  });

  it("still reads the editor when status rows stand under the rule", () => {
    const lines = [...bare("hello"), row(`${blue}~/proj`), row(`${blue}model`)];
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, statusStart: 3, end: 5 });
  });

  it("refuses a lone rule, a rule with no matching top rule, and a differently styled pair", () => {
    expect(locateComposer([row(rule)])).toBeNull();
    expect(locateComposer([row("some text"), row("more"), row(rule)])).toBeNull();
    expect(locateComposer([row(`${blue}${rule}`), row("hello"), row(rule)])).toBeNull();
  });

  it("refuses a pane whose last row is not a full-width rule", () => {
    expect(tailRule([row(rule), row("hello"), row("───")])).toBeNull();
    expect(tailRule([row(rule), row("hello")])).toBeNull();
  });
});

// Issue 544: an extension's editor (pi-powerline-footer, `ctx.ui.setEditorComponent`) draws both rules
// and a ` > ` prompt one column in, its ` ↳ ` widget under the bottom rule, and a footer of five rows.
describe("an extension's inset editor (issue 544)", () => {
  const raw = readFileSync(new URL("../../../fixtures/panes/pi--v130-powerline-editor-running--w254.txt", import.meta.url), "utf8").split("\n");
  const [TOP, PROMPT_ROW, BOTTOM] = [14, 15, 16];
  const screen = (edit: (rows: string[]) => void): StyledLine[] => {
    const rows = [...raw];
    edit(rows);
    return splitLines(parseAnsi(rows.join("\n")));
  };
  const glyph = (draft: string) => ` \x1b[0m\x1b[38;2;200;200;200m>\x1b[0m${draft}`;
  const idleRule = (rows: string[]) => { rows[TOP] = rows[BOTTOM]!; };

  it("reads the captured running editor as a composer with no draft and five status rows", () => {
    const lines = fixture("pi--v130-powerline-editor-running--w254");
    expect(locateComposer(lines)).toEqual({ layout: "inset", top: TOP, bottom: BOTTOM, statusStart: 18, end: 23 });
    expect(composerDraft(lines)).toBeNull();
    expect(composerStatusLines(lines).map((l) => lineText(l).slice(0, 6))).toEqual(["~/.pi/", "↑9 ↓28", "System", "Estima", "⏱ 3.5s"]);
    // The widget row and the footer put the frame past the bridge's six-row tail window: unbound.
    expect(composerPrompt(lines)).toBeNull();
  });

  it("reads a draft on the prompt row and a later row three spaces in", () => {
    expect(composerDraft(screen((r) => { idleRule(r); r[PROMPT_ROW] = glyph(" hello from the probe"); }))).toBe("hello from the probe");
    expect(composerDraft(screen((r) => { idleRule(r); r[PROMPT_ROW] = glyph(" hello"); r.splice(BOTTOM, 0, "   line two"); }))).toBe("hello line two");
    expect(locateComposer(screen((r) => { idleRule(r); r.splice(BOTTOM + 1, 1); }))?.layout).toBe("inset");
  });

  it.each([
    ["a top rule in column zero", (r: string[]) => { r[TOP] = `${r[BOTTOM]!.slice(1)} `; }],
    ["a bottom rule in column zero", (r: string[]) => { idleRule(r); r[BOTTOM] = `${r[BOTTOM]!.slice(1)} `; }],
    ["the prompt in column zero", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = r[PROMPT_ROW]!.slice(1); }],
    ["the whole frame two columns in", (r: string[]) => { idleRule(r); for (const i of [TOP, PROMPT_ROW, BOTTOM]) r[i] = ` ${r[i]!}`; }],
    ["the bash-mode `$` glyph", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = ` \x1b[38;2;200;200;200m$\x1b[0m ls`; }],
    ["a list row one column in under the prompt", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = glyph(" 1. Red"); r.splice(BOTTOM, 0, " 2. Green"); }],
    ["no prompt row first inside", (r: string[]) => { idleRule(r); r[PROMPT_ROW] = " Which color?"; }],
    ["two widget rows", (r: string[]) => { idleRule(r); r.splice(BOTTOM + 1, 0, " ↳ an earlier prompt"); }],
    ["a tail of nine status rows", (r: string[]) => { idleRule(r); r.push(...Array<string>(4).fill("\x1b[38;2;126;136;142mextra\x1b[0m")); }],
    ["two plain status rows at the end", (r: string[]) => { idleRule(r); r.push("plain one", "plain two"); }],
  ])("refuses %s", (_name, edit) => {
    expect(locateComposer(screen(edit))).toBeNull();
  });

  // Live, pi-powerline-footer 0.20.2 with no other extension's footer (2026-10-20): the bottom rule, or
  // the widget row under it, ends the screen. A draft that wraps and a walky talky message (header row,
  // body row) put their later rows three spaces in.
  it.each([
    ["pi--v130-powerline-editor-idle-widget--w120", null, 1],
    ["pi--v130-powerline-editor-two-row-draft--w120", 'Use the question tool exactly once: ask "Which fruit do you like?" with the options Apple, Banana, Cherry. Do nothing else.', 0],
    ["pi--v130-powerline-editor-walky-draft--w120", "[walky-talky wt_0a1b2c3d4e5f] from operator (Phone) Reply with exactly WALKY-1 and nothing else.", 0],
  ] as const)("reads %s with no status row under the box", (name, draft, widget) => {
    const lines = fixture(name);
    const composer = locateComposer(lines);
    expect(composer).toMatchObject({ layout: "inset", statusStart: lines.length, end: lines.length });
    expect(composer!.bottom).toBe(lines.length - 1 - widget);
    expect(composerDraft(lines)).toBe(draft);
    expect(composerStatusLines(lines)).toEqual([]);
  });

  it("finds no inset editor without its top rule, under two widget rows, or on pi's own selector", () => {
    const live = readFileSync(new URL("../../../fixtures/panes/pi--v130-powerline-editor-idle-widget--w120.txt", import.meta.url), "utf8").split("\n");
    const at = (edit: (rows: string[]) => void): StyledLine[] => {
      const rows = [...live];
      edit(rows);
      return splitLines(parseAnsi(rows.join("\n")));
    };
    // eslint-disable-next-line no-control-regex
    const top = live.findIndex((line) => /^ \x1b\[[0-9;]*m─{8}/u.test(line));
    expect(locateComposer(at((r) => { r[top] = r[top]!.replace("────", ""); }))).toBeNull();
    expect(locateComposer(at((r) => { r.splice(top, 2); }))).toBeNull();
    expect(locateComposer(at((r) => { r.push(" ↳ a second widget row"); }))).toBeNull();
    // pi's selector fills its own column-zero rules, as without the extension (the stock layout, and
    // index.ts's modal check keeps it off the composer): never the inset one.
    expect(locateComposer(fixture("pi--v130-powerline-model-selector--w120"))?.layout).not.toBe("inset");
  });
});

// Design point 1 of issue 416 loosened the status rows by one plain last row. Nothing outside pi's
// own captures reads as a pi editor because of it: the same three agy screens did before.
describe("the status rule across the whole corpus", () => {
  const PANES = new URL("../../../fixtures/panes/", import.meta.url);
  const foreign = readdirSync(PANES).filter((n) => n.endsWith(".txt") && !n.startsWith("pi--")).toSorted();

  it("finds a pi editor in no other harness's capture but agy's prompt rows and Hermes's frame", () => {
    expect(foreign.length).toBeGreaterThan(400);
    const found = foreign.filter((name) => locateComposer(fixture(name.slice(0, -4))) !== null);
    // Hermes's classic CLI draws pi's own shape around its input: a rule, the input rows, a rule, and
    // a status row the other side. pi's grammar runs on a pi pane only (the registry picks the adapter
    // by agent), so the match is shape, not a misread. The exception stays honest: Hermes still draws it.
    const drawnByHermes = (name: string): boolean => name.startsWith("hermes--");
    expect(found.filter((name) => !drawnByHermes(name))).toEqual(["agy--after-plan-idle.txt", "agy--done.txt", "agy--fresh-idle.txt"]);
    expect(found.some(drawnByHermes)).toBe(true);
  });

  it("keeps prose under a markdown rule out: a plain row straight under the rule is not a status row", () => {
    const prose = [row(rule), row(" Some reply text."), row(rule), row("plain prose under the rule")];
    expect(tailRule(prose)).toBeNull();
    expect(tailRule([...prose.slice(0, 3), row(`${blue}styled`), row("one"), row("two")])).toBeNull();
  });
});
