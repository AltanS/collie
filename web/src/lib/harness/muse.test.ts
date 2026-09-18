import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { museAdapter } from "./muse";
import { describeAdapterConformance } from "./conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allMuseFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("muse--") && f.endsWith(".txt"))
  .toSorted();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .toSorted();
const allOmpFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("omp--") && f.endsWith(".txt"))
  .toSorted();
const allCodexFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("codex--") && f.endsWith(".txt"))
  .toSorted();
const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .toSorted();
const allAgyFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("agy--") && f.endsWith(".txt"))
  .toSorted();

const PINNED = [
  "muse--approval-ls-moved.txt",
  "muse--approval-ls.txt",
  "muse--ask-color-moved.txt",
  "muse--ask-color-notes-open.txt",
  "muse--ask-color-notes-typed.txt",
  "muse--ask-color.txt",
  "muse--ask-drinks.txt",
  "muse--ask-toppings-checked.txt",
  "muse--ask-toppings-notes-open.txt",
  "muse--ask-toppings-review.txt",
  "muse--ask-toppings.txt",
  "muse--done.txt",
  "muse--draft-paste-token.txt",
  "muse--draft-single.txt",
  "muse--draft-wrapped.txt",
  "muse--fresh-idle.txt",
  "muse--trust-prompt.txt",
  "muse--working.txt",
];

// The captures buildBlocks up-levels. Everything else stays raw — including the three notes-open
// captures, which decline deliberately (the note input owns the keyboard) while still failing the
// composer gate (NOT_READY below).
const LIFTED = [
  "muse--approval-ls-moved.txt",
  "muse--approval-ls.txt",
  "muse--ask-color-moved.txt",
  "muse--ask-color.txt",
  "muse--ask-drinks.txt",
  "muse--ask-toppings-checked.txt",
  "muse--ask-toppings-review.txt",
  "muse--ask-toppings.txt",
  "muse--trust-prompt.txt",
];

const NOT_READY = [
  ...LIFTED,
  "muse--ask-color-notes-open.txt",
  "muse--ask-color-notes-typed.txt",
  "muse--ask-toppings-notes-open.txt",
];

const ownFixtures = LIFTED;
const neutralFixtures = allMuseFixtures.filter((f) => !LIFTED.includes(f));

describeAdapterConformance(museAdapter, {
  ownFixtures,
  foreignFixtures: [
    ...allClaudeFixtures,
    ...allOmpFixtures,
    ...allCodexFixtures,
    ...allGrokFixtures,
    ...allAgyFixtures,
  ],
  neutralFixtures,
});

describe("the muse corpus", () => {
  it("is exactly the captures this adapter was developed against", () => {
    expect(allMuseFixtures).toEqual(PINNED);
  });
});

describe("composerReady — the gate the reply path pre-flights on", () => {
  it.each(
    neutralFixtures.filter(
      (f) => !f.includes("notes-open") && !f.includes("notes-typed"),
    ),
  )("%s: the composer is on screen ⇒ true", (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(museAdapter.composerReady!(lines)).toBe(true);
  });

  it.each(NOT_READY)("%s: a dialog or open note ⇒ false", (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(museAdapter.composerReady!(lines)).toBe(false);
  });
});

describe("museBuildBlocks", () => {
  it("stays raw on every neutral capture", () => {
    for (const name of neutralFixtures) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = museAdapter.buildBlocks(lines);
      expect(blocks.every((b) => b.kind === "raw"), name).toBe(true);
    }
  });

  it("lifts the ls approval (both pointer positions) with digit-alone keys", () => {
    for (const name of ["muse--approval-ls.txt", "muse--approval-ls-moved.txt"]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const prompt = museAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") continue;
      expect(prompt.prompt.family).toBe("permission");
      expect(prompt.prompt.question).toBe("Would you like to run the following command?");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual([
        "Allow this stage once (y)",
        "Always allow in this workspace: ls ... (p)",
        "Abort the entire command (esc)",
      ]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    }
  });

  it("lifts the color question (both pointer positions) with digit+Enter keys", () => {
    for (const name of ["muse--ask-color.txt", "muse--ask-color-moved.txt"]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const prompt = museAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") continue;
      expect(prompt.prompt.family).toBe("select");
      expect(prompt.prompt.question).toBe("Which color do you prefer?");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual([
        "Red (Recommended)",
        "Green",
        "Blue",
        "None of the above",
      ]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([
        ["1", "Enter"],
        ["2", "Enter"],
        ["3", "Enter"],
        ["4", "Enter"],
      ]);
    }
  });

  it("lifts both checkbox geometries in pointer mode", () => {
    for (const [name, count] of [
      ["muse--ask-toppings.txt", 4],
      ["muse--ask-drinks.txt", 3],
    ] as const) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const multi = museAdapter.buildBlocks(lines).find((b) => b.kind === "multi-select");
      expect(multi?.kind, name).toBe("multi-select");
      if (multi?.kind !== "multi-select" || multi.multi.phase !== "checkbox") continue;
      expect(multi.multi.toggle).toBe("pointer");
      expect(multi.multi.options.map((o) => o.n)).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
      expect(multi.multi.pointerRow).toBe(1);
      expect(multi.multi.escape).toBeNull();
      expect(multi.multi.advanceLabel).toBe("Submit answer");
      // The Submit digit floats with the option count (5 on toppings, 4 on drinks): the geometry
      // pin is the differing option count itself, asserted above.
    }
  });

  it("reads the checked box and count off the checked twin", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "muse--ask-toppings-checked.txt"), "utf8")),
    );
    const multi = museAdapter.buildBlocks(lines).find((b) => b.kind === "multi-select");
    expect(multi?.kind).toBe("multi-select");
    if (multi?.kind !== "multi-select" || multi.multi.phase !== "checkbox") return;
    expect(multi.multi.options.map((o) => o.checked)).toEqual([false, true, false, false]);
  });

  it("lifts the review phase with a pointer-mode submit", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "muse--ask-toppings-review.txt"), "utf8")),
    );
    const multi = museAdapter.buildBlocks(lines).find((b) => b.kind === "multi-select");
    expect(multi?.kind).toBe("multi-select");
    if (multi?.kind !== "multi-select" || multi.multi.phase !== "review") return;
    expect(multi.multi.submit).toBe("pointer");
    expect(multi.multi.pointer).toBe("submit");
    expect(multi.multi.incomplete).toBe(false);
  });

  it("lifts the trust prompt with digit-alone keys", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "muse--trust-prompt.txt"), "utf8")),
    );
    const prompt = museAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("trust");
    expect(prompt.prompt.question).toBe("Do you trust this workspace?");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Trust and continue", "Quit"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
  });

  it("declines open notes to raw (the note owns the keyboard)", () => {
    for (const name of [
      "muse--ask-color-notes-open.txt",
      "muse--ask-color-notes-typed.txt",
      "muse--ask-toppings-notes-open.txt",
    ]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = museAdapter.buildBlocks(lines);
      expect(blocks.every((b) => b.kind === "raw"), name).toBe(true);
    }
  });

  it("does not lift a dialog that has scrolled up above a live composer", () => {
    // Splice two transcript rows between the dialog and the tail chrome: the dialog is stale (the
    // agent moved on) while the composer below is live. Buttons here would answer a dead dialog.
    const raw = readFileSync(join(PANES_DIR, "muse--ask-color.txt"), "utf8");
    const voiceAt = raw.indexOf("Voice input");
    expect(voiceAt).toBeGreaterThan(0);
    const spliced =
      raw.slice(0, voiceAt) + "◆ Working (3s · esc to interrupt)\r\n\r\n" + raw.slice(voiceAt);
    const lines = splitLines(parseAnsi(spliced));
    const blocks = museAdapter.buildBlocks(lines);
    expect(blocks.every((b) => b.kind === "raw")).toBe(true);
    expect(museAdapter.composerReady!(lines)).toBe(true);
  });
});
