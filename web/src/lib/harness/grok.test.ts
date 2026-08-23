import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { grokAdapter } from "./grok";
import { locateComposer, stripChrome } from "./grok/chrome";
import { lineText } from "./grok/markers";
import { detectAskRegion } from "./grok/ask";
import { detectPermissionRegion } from "./grok/permission";
import { detectPlanMenuRegion } from "./grok/plan-menu";
import { describeAdapterConformance } from "./conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .sort();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();
const allOmpFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("omp--") && f.endsWith(".txt"))
  .sort();

const PINNED = [
  "grok--ask-color-moved.txt",
  "grok--ask-color.txt",
  "grok--ask-esc-park.txt",
  "grok--ask-multi-checked.txt",
  "grok--ask-multi.txt",
  "grok--ask-size.txt",
  "grok--ask-wizard-q1.txt",
  "grok--ask-wizard-q2.txt",
  "grok--ask-z-focused.txt",
  "grok--ask-z-parked.txt",
  "grok--ask-z-typed.txt",
  "grok--done.txt",
  "grok--draft-single.txt",
  "grok--draft-wrapped.txt",
  "grok--fresh-idle.txt",
  "grok--permission-edit.txt",
  "grok--permission-rm-feedback.txt",
  "grok--permission-rm-moved.txt",
  "grok--permission-rm.txt",
  "grok--plan-approval.txt",
  "grok--plan-request-changes.txt",
  "grok--plan-tab-prompt.txt",
  "grok--startup.txt",
  "grok--user-bubble.txt",
  "grok--working.txt",
];

const DIALOG = [
  "grok--ask-color-moved.txt",
  "grok--ask-color.txt",
  "grok--ask-esc-park.txt",
  "grok--ask-size.txt",
  "grok--ask-wizard-q1.txt",
  "grok--ask-wizard-q2.txt",
  "grok--ask-z-focused.txt",
  "grok--ask-z-parked.txt",
  "grok--ask-z-typed.txt",
  "grok--permission-edit.txt",
  "grok--permission-rm-feedback.txt",
  "grok--permission-rm-moved.txt",
  "grok--permission-rm.txt",
  "grok--plan-approval.txt",
  "grok--plan-request-changes.txt",
  "grok--plan-tab-prompt.txt",
];

const ownFixtures = DIALOG;
const neutralFixtures = allGrokFixtures.filter((f) => !DIALOG.includes(f));

describeAdapterConformance(grokAdapter, {
  ownFixtures,
  foreignFixtures: [...allClaudeFixtures, ...allOmpFixtures],
  neutralFixtures,
});

describe("the grok corpus", () => {
  it("is exactly the captures this adapter was developed against", () => {
    expect(allGrokFixtures).toEqual(PINNED);
  });
});

describe("composerReady — the gate the reply path pre-flights on", () => {
  it.each(
    neutralFixtures.filter((f) => f !== "grok--user-bubble.txt" && !f.includes("ask-multi")),
  )("%s: the composer is on screen ⇒ true", (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(grokAdapter.composerReady!(lines)).toBe(true);
  });

  it.each(["grok--user-bubble.txt", "grok--ask-multi.txt", "grok--ask-multi-checked.txt", ...DIALOG])(
    "%s: a modal or torn frame ⇒ false",
    (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });
});

describe("grokBuildBlocks", () => {
  it("stays raw on every neutral capture", () => {
    for (const name of neutralFixtures) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      expect(blocks.every((b) => b.kind === "raw"), name).toBe(true);
    }
  });

  it("lifts the 3-option rm permission card with only Yes, proceed", () => {
    for (const name of DIALOG.filter((f) => f.includes("permission-rm"))) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const prompt = blocks.find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") return;
      expect(prompt.prompt.family).toBe("permission");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, reject"]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["2"], ["3"]]);
    }
  });

  it("lifts the 4-option edit permission card from its bottom Yes/No pair", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--permission-edit.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("permission");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes", "No, reject"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["3"], ["4"]]);
  });

  it("lifts ask_user_question cards to prompt-select with consecutive digit keys", () => {
    for (const name of DIALOG.filter((f) => f.includes("ask-color"))) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const prompt = blocks.find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") return;
      expect(prompt.prompt.family).toBe("select");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
      // Grok's scrollbar column must not ride along as the description's last word.
      expect(prompt.prompt.options[0]!.description).toBe("Warm red palette");
      expect(prompt.prompt.feedback).toEqual({
        key: "z",
        focused: false,
        text: "",
        purpose: "free-text",
      });
    }
  });

  it("lifts plan approval to a menu of footer-named keys, no digits", () => {
    for (const name of ["grok--plan-approval.txt", "grok--plan-tab-prompt.txt", "grok--plan-request-changes.txt"]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const menu = blocks.find((b) => b.kind === "menu");
      expect(menu?.kind, name).toBe("menu");
      if (menu?.kind !== "menu") return;
      expect(menu.menu.actions.some((a) => a.keys.includes("a")), name).toBe(true);
      expect(menu.menu.actions.every((a) => !/^\d+$/.test(a.keys.join(""))), name).toBe(true);
    }
  });

  it("the question rows stay in the raw mirror above the lifted options", () => {
    const cases: [string, string][] = [
      ["grok--permission-rm.txt", "Remove hello.txt as requested"],
      ["grok--permission-edit.txt", "Allow Edit to"],
      ["grok--ask-color.txt", "Which color theme should the dashboard use?"],
      ["grok--ask-wizard-q2.txt", "Dark mode?"],
    ];
    for (const [name, question] of cases) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const raw = blocks[0];
      const prompt = blocks.find((b) => b.kind === "prompt-select");
      expect(raw?.kind, name).toBe("raw");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (raw?.kind !== "raw" || prompt?.kind !== "prompt-select") return;
      // The renderer never repeats the question (aria only) — the mirror above must carry it,
      // and the replaced region must begin at the first lifted row.
      expect(raw.lines.map(lineText).join("\n"), name).toContain(question);
      expect(lineText(prompt.lines[0]!), name).toMatch(/^\s*┃\s+[1-9z]\s/);
    }
  });

  it("checkbox asks stay raw — a digit submits rather than toggles", () => {
    for (const name of ["grok--ask-multi.txt", "grok--ask-multi-checked.txt"]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      expect(grokAdapter.buildBlocks(lines).every((b) => b.kind === "raw"), name).toBe(true);
      expect(grokAdapter.composerReady!(lines), name).toBe(false);
    }
  });

  it("z-focused ask carries feedback and refuses a digit answer", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-focused.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.feedback).toEqual({
      key: "z",
      focused: true,
      text: "",
      purpose: "free-text",
    });
  });

  it("z-typed ask carries the typed text as free-text, not a plan-change row", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-typed.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.feedback).toEqual({
      key: "z",
      focused: true,
      text: "med",
      purpose: "free-text",
    });
  });

  it("esc-parked ask still lifts, with Tab prepended — a bare digit is swallowed in scrollback", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-esc-park.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    // Probed 2026-08-22: parked digit = no-op; Tab (the footer's own key) re-enters, then the
    // digit answers. The badge keeps showing the digit, not Tab.
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([
      ["Tab", "1"],
      ["Tab", "2"],
    ]);
    expect(prompt.prompt.options.map((o) => o.keyLabel)).toEqual(["1", "2"]);
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("z-parked ask locks the buttons — Enter:edit means digits would type into the field", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-parked.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    // The z row reads idle (`z (○)`) and the global footer says Tab:next answer — the inner
    // Enter:edit hint is the one tell that the keyboard is still on the free-text row.
    expect(prompt.prompt.feedback?.focused).toBe(true);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("a footer without the plan preview is not a live menu", () => {
    const lines = splitLines(parseAnsi("ordinary output\na:approve │ q:quit plan"));
    expect(detectPlanMenuRegion(lines)).toBeNull();
    expect(grokAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("output below a plan card does not keep the composer writable or eat the new lines", () => {
    const base = readFileSync(join(PANES_DIR, "grok--plan-approval.txt"), "utf8");
    const lines = splitLines(parseAnsi(`${base}\nlater output\nmore output`));
    expect(detectPlanMenuRegion(lines)).toBeNull();
    expect(locateComposer(lines)).toBeNull();
    expect(grokAdapter.composerReady!(lines)).toBe(false);
    expect(grokAdapter.composerPrompt!(lines)).toBeNull();
    const stripped = stripChrome(lines);
    expect(stripped.map(lineText).join("\n")).toMatch(/later output/);
    expect(stripped.map(lineText).join("\n")).toMatch(/more output/);
  });

  const PERMISSION_FOOTER = (n: number) =>
    `  1/${n}:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback`;

  it("permission refuses a card whose last row is not the reject", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (●) Yes, done",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a multi-digit option number", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  12 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a duplicate digit even when the labels look right", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(4),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a shuffle of the probed labels", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  3 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  1 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses an upper row it cannot prove is a persistent mode change", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, just for this file",
      "  ┃  3 (●) Yes",
      "  ┃  4 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(4),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a Yes row that is itself a persistent mode change", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, allow all edits during this session",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a card whose rows disagree with the footer's 1/N count", () => {
    const spoof = [
      "  ┃  Remove hello.txt as requested",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(4),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a bare Yes/No pair — the footer promises an always-approve row", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes",
      "  ┃  2 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(2),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a card carrying an unclassified control row — no partial lift", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (●) Yes",
      "  ┃  x [ ] unclassified extra action",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses unclassified text below the options", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (●) Yes",
      "  ┃  3 (○) No, reject (type to add feedback)",
      "  ┃  some extra prose the captures never painted here",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses prose that merely contains Enter:submit — the hint must be the hint row", () => {
    const spoof = [
      "  ┃  Press Enter:submit when you are ready to continue",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses unclassified text below the options", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  ┃  some stray prose under the card",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a footer separated from the card by transcript", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      "  later transcript output",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a footer floating far below the card — the gap is bounded", () => {
    const spoof = [
      "  ┃  Remove hello.txt as requested",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      "",
      "",
      "",
      "",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a footer separated from the card by transcript", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  later transcript output",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a radio card with no z row", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a radio card with no Enter:select/submit/edit hint", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  ┃  ↑/↓ navigate · y copy",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a card that paints an a–f option row", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  a (○) Extra  Unprobed letter option",
      "  ┃  z (○) Type your answer here",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("an ordinary composer holding Build anything is still a draft", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ ❯ Build anything                       │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Shift+Tab:mode  │  Ctrl+.:shortcuts",
    ].join("\n");
    expect(grokAdapter.extractInputDraft(splitLines(parseAnsi(screen)))).toBe("Build anything");
  });

  it("the startup screen's composer is usable — the [stable] chip is chrome, not a torn frame", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--startup.txt"), "utf8")));
    expect(grokAdapter.composerReady!(lines)).toBe(true);
    const [block] = grokAdapter.buildBlocks(lines);
    expect(block?.kind).toBe("raw");
    if (block?.kind !== "raw") return;
    const text = block.lines.map(lineText).join("\n");
    // The composer box and the chip row are stripped; the welcome banner box stays as content.
    expect(text).not.toContain("[stable]");
    expect(text).not.toContain("❯");
    expect(text).toContain("Grok 4.6 is here!");
  });

  it("blank rows render unpainted in every block; glyph rows keep their backgrounds", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--permission-edit.txt"), "utf8")));
    // The live frame paints base-coat colour across fully blank rows (the gray-stripe bug) and
    // rgb(36,36,36) as the dialog card's elevated surface. Only empty rows lose their paint.
    const hadPaintedBlank = lines.some(
      (l) => l.segments.every((s) => s.text.trim() === "") &&
        l.segments.some((s) => s.style.backgroundColor !== undefined),
    );
    expect(hadPaintedBlank).toBe(true);
    const rendered = grokAdapter.buildBlocks(lines).flatMap((b) => b.lines);
    for (const l of rendered) {
      if (l.segments.every((s) => s.text.trim() === "")) {
        expect(l.segments.every((s) => s.style.backgroundColor === undefined)).toBe(true);
      }
    }
    expect(
      rendered.some((l) => l.segments.some((s) => s.style.backgroundColor === "rgb(36,36,36)")),
    ).toBe(true);
  });

  it("the raw block is the chrome-stripped buffer, not the original", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--fresh-idle.txt"), "utf8")));
    const [block] = grokAdapter.buildBlocks(lines);
    expect(block?.kind).toBe("raw");
    if (block?.kind !== "raw") return;
    const text = block.lines.map(lineText).join("\n");
    expect(text).not.toContain("╭");
    expect(lines.map(lineText).join("\n")).toContain("╭");
  });
});
