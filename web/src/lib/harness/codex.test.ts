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
  "codex--draft-wrapped.txt",
  "codex--draft.txt",
  "codex--fresh-idle.txt",
  "codex--trust-prompt.txt",
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
  it.each(["codex--fresh-idle.txt", "codex--draft.txt", "codex--draft-wrapped.txt", "codex--working.txt"])(
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
    expect(codexAdapter.extractInputDraft(fixtureLines("codex--fresh-idle.txt"))).toBeNull();
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

  it("locates the v0.150.1 status row with Context directly after the model", () => {
    const screen = [
      "› a message waiting to send",
      "",
      "  gpt-5.6-sol high · Context 68% left · main · +295 -1 · weekly 94% left",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));

    expect(locateComposer(lines)).not.toBeNull();
    expect(codexAdapter.composerReady!(lines)).toBe(true);
    expect(codexAdapter.extractInputDraft(lines)).toBe("a message waiting to send");
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

  it("lifts the trust prompt with digit keys — both probed on the captured widget", () => {
    const prompt = codexAdapter.buildBlocks(fixtureLines("codex--trust-prompt.txt")).find(
      (b) => b.kind === "prompt-select",
    );
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("trust");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes, continue", "No, quit"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
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
