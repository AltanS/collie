import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { codexAdapter } from "./codex";
import { locateComposer, stripChrome } from "./codex/chrome";
import { lineText } from "./codex/markers";
import { detectApprovalRegion } from "./codex/approval";
import { detectAskRegion } from "./codex/ask";
import { detectTrustRegion } from "./codex/trust";
import { describeAdapterConformance } from "./conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allCodexFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("codex--") && f.endsWith(".txt"))
  .sort();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();
const allOmpFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("omp--") && f.endsWith(".txt"))
  .sort();
const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .sort();

const PINNED = [
  "codex--approval-exec.txt",
  "codex--ask-fruit.txt",
  "codex--ask-notes-focused.txt",
  "codex--ask-wizard-q1.txt",
  "codex--ask-wizard-q2.txt",
  "codex--custom-status-draft.txt",
  "codex--draft-wrapped.txt",
  "codex--draft.txt",
  "codex--fresh-idle.txt",
  "codex--trust-prompt.txt",
  "codex--working-draft-queue-hint.txt",
  "codex--working.txt",
];

// The dialog captures — screens that lift an interactive block. The notes-focused ask is NOT
// here: it is a live modal the adapter deliberately REFUSES (a digit would type into the notes
// box), so it belongs to the neutral (raw-only) cohort with composerReady false.
const DIALOG = [
  "codex--approval-exec.txt",
  "codex--ask-fruit.txt",
  "codex--ask-wizard-q1.txt",
  "codex--ask-wizard-q2.txt",
  "codex--trust-prompt.txt",
];

const ownFixtures = DIALOG;
const neutralFixtures = allCodexFixtures.filter((f) => !DIALOG.includes(f));

describeAdapterConformance(codexAdapter, {
  ownFixtures,
  foreignFixtures: [...allClaudeFixtures, ...allOmpFixtures, ...allGrokFixtures],
  neutralFixtures,
});

describe("the codex corpus", () => {
  it("is exactly the captures this adapter was developed against", () => {
    expect(allCodexFixtures).toEqual(PINNED);
  });
});

function fixtureLines(name: string) {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

describe("composerReady — the gate the reply path pre-flights on", () => {
  it.each(["codex--fresh-idle.txt", "codex--draft.txt", "codex--draft-wrapped.txt", "codex--working.txt", "codex--working-draft-queue-hint.txt", "codex--custom-status-draft.txt"])(
    "%s: the composer is on screen ⇒ true",
    (name) => {
      expect(codexAdapter.composerReady!(fixtureLines(name))).toBe(true);
    },
  );

  it.each([...DIALOG, "codex--ask-notes-focused.txt"])("%s: a modal owns the screen ⇒ false", (name) => {
    expect(codexAdapter.composerReady!(fixtureLines(name))).toBe(false);
  });
});

describe("chrome", () => {
  it("strips the prompt row and status row; the transcript stays", () => {
    const lines = fixtureLines("codex--fresh-idle.txt");
    const stripped = stripChrome(lines);
    const text = stripped.map(lineText).join("\n");
    expect(text).not.toContain("Ask Codex to do anything");
    expect(text).not.toContain("Context 1");
    expect(text).toContain("OpenAI Codex");
  });

  it("extracts a one-line draft, and null for the placeholder", () => {
    expect(codexAdapter.extractInputDraft(fixtureLines("codex--draft.txt"))).toBe("hi there");
    expect(codexAdapter.extractInputDraft(fixtureLines("codex--custom-status-draft.txt"))).toBe(
      "ship it please",
    );
    expect(codexAdapter.extractInputDraft(fixtureLines("codex--working-draft-queue-hint.txt"))).toBe(
      "finish the current review",
    );
    expect(codexAdapter.extractInputDraft(fixtureLines("codex--fresh-idle.txt"))).toBeNull();
  });

  it("recovers a working draft above the official queue-message footer", () => {
    const lines = fixtureLines("codex--working-draft-queue-hint.txt");
    expect(locateComposer(lines)).not.toBeNull();
    expect(codexAdapter.composerReady!(lines)).toBe(true);
    expect(codexAdapter.extractInputDraft(lines)).toBe("finish the current review");
    const status = codexAdapter.extractStatusLines(lines);
    expect(status).toHaveLength(1);
    expect(lineText(status[0]!).trim()).toMatch(/^tab to queue message/);
  });

  it("accepts live and official bounded queue-footer heights, but not an unbounded gap", () => {
    const screen = (blankRows: number) =>
      splitLines(
        parseAnsi(
          [
            "› finish the current review",
            ...Array.from({ length: blankRows }, () => ""),
            "  tab to queue message                                       100% context left",
          ].join("\n"),
        ),
      );

    for (const blankRows of [0, 1, 6, 12]) {
      expect(codexAdapter.composerReady!(screen(blankRows)), `${blankRows} blank rows`).toBe(true);
      expect(codexAdapter.extractInputDraft(screen(blankRows))).toBe("finish the current review");
    }
    expect(codexAdapter.composerReady!(screen(13))).toBe(false);
    expect(codexAdapter.extractInputDraft(screen(13))).toBeNull();
  });

  it("does not confuse Codex ask/question footers with the working queue footer", () => {
    for (const name of ["codex--ask-fruit.txt", "codex--ask-wizard-q1.txt", "codex--ask-wizard-q2.txt", "codex--ask-notes-focused.txt"]) {
      const lines = fixtureLines(name);
      expect(locateComposer(lines), name).toBeNull();
      expect(codexAdapter.composerReady!(lines), name).toBe(false);
    }
  });

  it("recognises a bounded customized status row without assigning meaning to its fields", () => {
    const lines = fixtureLines("codex--custom-status-draft.txt");
    const box = locateComposer(lines);
    expect(box).not.toBeNull();
    expect(codexAdapter.composerReady!(lines)).toBe(true);
    const status = codexAdapter.extractStatusLines(lines);
    expect(status).toHaveLength(1);
    expect(lineText(status[0]!)).not.toContain("Context");
    expect(lineText(status[0]!)).toContain(" · ");
  });

  it("recognises the strict styled two-field renderer without accepting its plain-text lookalike", () => {
    const styled = [
      "› ship it please",
      "",
      "  \x1b[38;5;6mmodel-example\x1b[0m\x1b[2m · \x1b[0m\x1b[38;5;3mdemo-project\x1b[0m",
    ].join("\n");
    const plain = ["› ship it please", "", "  model-example · demo-project"].join("\n");
    const wrongSeparatorStyle = [
      "› ship it please",
      "",
      "  \x1b[38;5;6mmodel-example\x1b[0m · \x1b[38;5;3mdemo-project\x1b[0m",
    ].join("\n");
    const wrongFieldStyle = [
      "› ship it please",
      "",
      "  model-example\x1b[2m · \x1b[0m\x1b[38;5;3mdemo-project\x1b[0m",
    ].join("\n");

    const styledLines = splitLines(parseAnsi(styled));
    expect(locateComposer(styledLines)).not.toBeNull();
    expect(codexAdapter.composerReady!(styledLines)).toBe(true);
    expect(codexAdapter.extractInputDraft(styledLines)).toBe("ship it please");
    expect(locateComposer(splitLines(parseAnsi(plain)))).toBeNull();
    expect(locateComposer(splitLines(parseAnsi(wrongSeparatorStyle)))).toBeNull();
    expect(locateComposer(splitLines(parseAnsi(wrongFieldStyle)))).toBeNull();
  });

  it("joins a wrapped draft back into the typed sentence", () => {
    expect(codexAdapter.extractInputDraft(fixtureLines("codex--draft-wrapped.txt"))).toBe(
      "please summarize the architecture of this project in detail covering every module and its purpose and how they interact together and also explain the security model plus the deployment story across each environment we support today",
    );
  });

  it("re-surfaces the status row and pairs composerPrompt with the ready screens", () => {
    const lines = fixtureLines("codex--fresh-idle.txt");
    const status = codexAdapter.extractStatusLines(lines);
    expect(status).toHaveLength(1);
    expect(lineText(status[0]!)).toMatch(/ · Context \d+% left/);
    expect(codexAdapter.composerPrompt!(lines)).toMatch(/^› /);
  });

  it("a transcript `› ` echo without a status row beneath is not a composer", () => {
    const screen = ["› some earlier submitted message", "• Working (3s • esc to interrupt)"].join("\n");
    expect(locateComposer(splitLines(parseAnsi(screen)))).toBeNull();
    expect(codexAdapter.composerReady!(splitLines(parseAnsi(screen)))).toBe(false);
  });

  it("a transcript echo above a status-LIKE prose row is not a composer (review repro)", () => {
    // Column-0 prose mentioning a context percentage must not read as the status row…
    const colZero = ["› a submitted transcript message", "", "model · Context 50% left"].join("\n");
    expect(locateComposer(splitLines(parseAnsi(colZero)))).toBeNull();
    // …nor indented prose with only ONE dot-separated field before the token.
    const oneField = ["› a submitted transcript message", "", "  model · Context 50% left"].join("\n");
    expect(locateComposer(splitLines(parseAnsi(oneField)))).toBeNull();
    // The real row shape (two fields before the token) still locates.
    const real = ["› draft text", "", "  model x · /some/dir · Context 50% left"].join("\n");
    expect(locateComposer(splitLines(parseAnsi(real)))).not.toBeNull();
  });

  it("rejects ambiguous or unbounded customized status rows", () => {
    const locate = (status: string) =>
      locateComposer(splitLines(parseAnsi(["› draft text", "", status].join("\n"))));

    expect(locate("model · project · branch")).toBeNull(); // no two-space status indent
    expect(locate("   model · project · branch")).toBeNull(); // continuation/deeper indent
    expect(locate("  model · project")).toBeNull(); // too few fields
    expect(locate("  model ·  · branch")).toBeNull(); // empty field
    expect(locate("  model · project · branch\tname")).toBeNull(); // terminal control
    expect(locate(`  model · ${"x".repeat(161)} · branch`)).toBeNull(); // one field too long
    expect(locate(`  ${Array.from({ length: 13 }, (_, i) => `field-${i}`).join(" · ")}`)).toBeNull();
    expect(locate(`  ${Array.from({ length: 4 }, () => "x".repeat(130)).join(" · ")}`)).toBeNull();
  });

  it("keeps disabled, missing, torn, and transcript-only status evidence fail-closed", () => {
    const screens = [
      ["› draft text"],
      ["› draft text", "", "  model · project"],
      ["› earlier transcript echo", "• Working (3s • esc to interrupt)"],
      ["  model · project · branch", "", "› draft text"],
    ];
    for (const screen of screens) {
      const lines = splitLines(parseAnsi(screen.join("\n")));
      expect(locateComposer(lines), screen.join(" | ")).toBeNull();
      expect(codexAdapter.composerReady!(lines), screen.join(" | ")).toBe(false);
    }
  });

  it("a draft that wraps past 8 rows is still a composer", () => {
    // The old bound of 8 stranded a phone wrap: locateComposer returned null and the pane
    // reported a dialog. 1 prompt + 8 continuations is 9 rows, the first case that failed.
    const cont = Array.from({ length: 8 }, (_, i) => `  word${i}`);
    const lines = splitLines(
      parseAnsi(["› start", ...cont, "", "  model x · /some/dir · Context 50% left"].join("\n")),
    );
    expect(locateComposer(lines)).not.toBeNull();
    expect(codexAdapter.composerReady!(lines)).toBe(true);
    expect(codexAdapter.extractInputDraft(lines)).toBe(
      ["start", ...Array.from({ length: 8 }, (_, i) => `word${i}`)].join(" "),
    );
  });

  it("declines a draft taller than MAX_DRAFT_ROWS", () => {
    const cont = Array.from({ length: 100 }, (_, i) => `  word${i}`);
    const status = "  model x · /some/dir · Context 50% left";
    expect(
      locateComposer(splitLines(parseAnsi(["› start", ...cont, "", status].join("\n")))),
    ).toBeNull();
    expect(
      locateComposer(splitLines(parseAnsi(["› start", ...cont.slice(1), "", status].join("\n")))),
    ).not.toBeNull();
  });
});

describe("codexBuildBlocks", () => {
  it("stays raw on every neutral capture", () => {
    for (const name of neutralFixtures) {
      const blocks = codexAdapter.buildBlocks(fixtureLines(name));
      expect(blocks.every((b) => b.kind === "raw"), name).toBe(true);
    }
  });

  it("hides an empty input box and its status row", () => {
    const lines = fixtureLines("codex--fresh-idle.txt");
    const placeholder = lines
      .flatMap((line) => line.segments)
      .find((segment) => segment.text.includes("Ask Codex to do anything"));
    expect(placeholder?.dim).toBe(true);
    expect(codexAdapter.extractInputDraft(lines)).toBeNull();

    const blocks = codexAdapter.buildBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind !== "raw") return;
    const visible = blocks[0].lines.map(lineText).join("\n");
    expect(visible).not.toContain("› Ask Codex to do anything");
    expect(visible).not.toContain("Context");
    expect(
      blocks[0].lines.at(-1)!.segments.every(
        (segment) => segment.style.backgroundColor === undefined,
      ),
    ).toBe(true);
  });

  it("hides the whole empty three-row composer while Codex is working", () => {
    const blocks = codexAdapter.buildBlocks(fixtureLines("codex--working.txt"));
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind !== "raw") return;
    const visible = blocks[0].lines.map(lineText).join("\n");
    expect(visible).toContain("Working");
    expect(visible).not.toContain("› Ask Codex to do anything");
    expect(visible).not.toContain("Context");
    expect(
      blocks[0].lines.at(-1)!.segments.every(
        (segment) => segment.style.backgroundColor === undefined,
      ),
    ).toBe(true);
  });

  it("keeps the same words when they are an ordinary non-dim draft", () => {
    const lines = splitLines(
      parseAnsi(
        [
          "some output",
          "",
          "› Ask Codex to do anything",
          "",
          "  model-example · demo-project · Context 99% left",
        ].join("\n"),
      ),
    );
    expect(codexAdapter.extractInputDraft(lines)).toBe("Ask Codex to do anything");
    const blocks = codexAdapter.buildBlocks(lines);
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind === "raw") {
      expect(blocks[0].lines.map(lineText).join("\n")).toContain("› Ask Codex to do anything");
    }
  });

  it.each([
    ["codex--draft.txt", "hi there", "Context"],
    ["codex--custom-status-draft.txt", "ship it please", "weekly 80% left"],
    ["codex--working-draft-queue-hint.txt", "finish the current review", "tab to queue message"],
  ])("%s: keeps a non-empty input box visible but removes the status/footer row", (name, draft, status) => {
    const blocks = codexAdapter.buildBlocks(fixtureLines(name));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind !== "raw") return;
    const visible = blocks[0].lines.map(lineText).join("\n");
    expect(visible).toContain(`› ${draft}`);
    expect(visible).not.toContain(status);
    expect(lineText(blocks[0].lines.at(-1)!).trim()).toBe("");
  });

  it("preserves the background-painted row above a non-empty native composer", () => {
    const lines = fixtureLines("codex--draft.txt");
    const box = locateComposer(lines)!;
    const blocks = codexAdapter.buildBlocks(lines);
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind !== "raw") return;
    expect(blocks[0].lines[box.promptRow - 1]).toBe(lines[box.promptRow - 1]);
    expect(
      blocks[0].lines[box.promptRow - 1]!.segments.some(
        (segment) => segment.style.backgroundColor !== undefined,
      ),
    ).toBe(true);
  });

  it("keeps every native blank composer row and removes exactly the queue footer", () => {
    const lines = fixtureLines("codex--working-draft-queue-hint.txt");
    const blocks = codexAdapter.buildBlocks(lines);
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind !== "raw") return;
    const prompt = blocks[0].lines.findIndex((line) => lineText(line).startsWith("› "));
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(blocks[0].lines.slice(prompt + 1).filter((line) => lineText(line) === "")).toHaveLength(6);
    expect(blocks[0].lines.map(lineText).join("\n")).not.toContain("tab to queue message");
  });

  it("lifts the trust prompt with digit keys — both probed on the captured widget", () => {
    const blocks = codexAdapter.buildBlocks(fixtureLines("codex--trust-prompt.txt"));
    const prompt = blocks.find(
      (b) => b.kind === "prompt-select",
    );
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("trust");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes, continue", "No, quit"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(blocks[0]?.kind).toBe("raw");
    if (blocks[0]?.kind === "raw") {
      expect(blocks[0].lines.map(lineText).join("\n")).toContain("Do you trust the contents");
    }
  });

  it("lifts the exec approval from its one-shot Yes / reject pair only", () => {
    const lines = fixtureLines("codex--approval-exec.txt");
    const blocks = codexAdapter.buildBlocks(lines);
    const prompt = blocks.find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("permission");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual([
      "Yes, proceed",
      "No, and tell Codex what to do differently",
    ]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["3"]]);
    expect(prompt.prompt.options.some((o) => /don't ask again/i.test(o.label))).toBe(false);
    // Header, Reason, `$ command`, and the persistent row stay in the raw mirror — swallowing
    // the whole option run hid digit 2 from both the buttons and the phone.
    const raw = blocks[0];
    expect(raw?.kind).toBe("raw");
    if (raw?.kind !== "raw") return;
    const above = raw.lines.map(lineText).join("\n");
    expect(above).toContain("Would you like to run the following command?");
    expect(above).toContain("$ touch /tmp/collie-codex-probe.txt");
    expect(above).toMatch(/2\.\s+Yes, and don't ask again/);
    expect(prompt.lines.map(lineText).join("\n")).not.toMatch(/don't ask again/);
    expect(lineText(prompt.lines[0]!)).toMatch(/3\.\s+No, and tell Codex/);
  });

  it("lifts a question card with per-row digits; the question stays in the mirror", () => {
    const blocks = codexAdapter.buildBlocks(fixtureLines("codex--ask-fruit.txt"));
    const prompt = blocks.find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("select");
    expect(prompt.prompt.question).toBe("Pick a fruit?");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual([
      "Apple (Recommended)",
      "Pear",
      "None of the above",
    ]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(prompt.prompt.options[1]!.description).toBe("Choose a soft, juicy pear.");
    const raw = blocks[0];
    if (raw?.kind !== "raw") return;
    expect(raw.lines.map(lineText).join("\n")).toContain("Pick a fruit?");
  });

  it("steps a multi-question set as consecutive lifted cards", () => {
    for (const [name, question] of [
      ["codex--ask-wizard-q1.txt", "Tabs or spaces?"],
      ["codex--ask-wizard-q2.txt", "Semicolons?"],
    ] as const) {
      const prompt = codexAdapter.buildBlocks(fixtureLines(name)).find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") return;
      expect(prompt.prompt.question, name).toBe(question);
    }
  });

  it("the notes-focused ask refuses to raw — a digit would type into the notes box", () => {
    const lines = fixtureLines("codex--ask-notes-focused.txt");
    expect(detectAskRegion(lines)).toBeNull();
    expect(codexAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("approval refuses an unclassified middle row — no partial lift", () => {
    const spoof = [
      "  Would you like to run the following command?",
      "  $ rm -rf /",
      "› 1. Yes, proceed (y)",
      "  2. Yes, just this directory",
      "  3. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(detectApprovalRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("approval refuses a card whose last row is not the reject", () => {
    const spoof = [
      "  Would you like to run the following command?",
      "  $ ls",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `ls` (p)",
      "  3. Yes, always",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(detectApprovalRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("approval refuses suffix-extended Yes/No labels — only the captured wording earns a key", () => {
    const spoof = [
      "  Would you like to run the following command?",
      "  $ ls",
      "› 1. Yes, proceed and remember forever (y)",
      "  2. Yes, and don't ask again for commands that start with `ls` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(detectApprovalRegion(splitLines(parseAnsi(spoof)))).toBeNull();
    const spoofNo = [
      "  Would you like to run the following command?",
      "  $ ls",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `ls` (p)",
      "  3. No, and tell Codex what to do differently next time (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(detectApprovalRegion(splitLines(parseAnsi(spoofNo)))).toBeNull();
  });

  it("approval refuses when the header is missing — a bare option run is not the card", () => {
    const spoof = [
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `ls` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(detectApprovalRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses non-consecutive digits and a missing header", () => {
    const shuffled = [
      "  Question 1/1 (1 unanswered)",
      "  Pick?",
      "  › 2. B",
      "    1. A",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(shuffled)))).toBeNull();
    const headerless = [
      "  Pick?",
      "  › 1. A",
      "    2. B",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(headerless)))).toBeNull();
  });

  it("trust refuses altered labels — a different pair of stakes is a different widget", () => {
    const spoof = [
      "  Do you trust the contents of this directory? Working with untrusted contents…",
      "› 1. Yes, always trust everything",
      "  2. No, quit",
      "  Press enter to continue",
    ].join("\n");
    expect(detectTrustRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });
});
