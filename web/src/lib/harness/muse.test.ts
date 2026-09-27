import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../blocks";
import { buildBlocks } from "./index";
import { museAdapter } from "./muse";
import { describeAdapterConformance } from "./conformance";
import { detectCheckboxRegion } from "./muse/checkbox";

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
  "muse--approval-network-moved.txt",
  "muse--approval-network.txt",
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
  "muse--draft-blank-row.txt",
  "muse--draft-image-chip.txt",
  "muse--draft-paste-token.txt",
  "muse--draft-quoted-path.txt",
  "muse--draft-single.txt",
  "muse--draft-wrapped.txt",
  "muse--fresh-idle.txt",
  "muse--palette-exact.txt",
  "muse--palette-partial.txt",
  "muse--quoted-dialogs-bare.txt",
  "muse--tasks-popup-approval.txt",
  "muse--tasks-popup-draft.txt",
  "muse--tasks-popup.txt",
  "muse--tip-loop.txt",
  "muse--tip-paste.txt",
  "muse--trust-prompt.txt",
  "muse--working.txt",
];

// The captures buildBlocks up-levels. Everything else stays raw — including the three notes-open
// captures, which decline deliberately (the note input owns the keyboard) while still failing the
// composer gate (NOT_READY below).
const LIFTED = [
  "muse--approval-ls-moved.txt",
  "muse--approval-ls.txt",
  "muse--approval-network-moved.txt",
  "muse--approval-network.txt",
  "muse--ask-color-moved.txt",
  "muse--ask-color.txt",
  "muse--ask-drinks.txt",
  "muse--ask-toppings-checked.txt",
  "muse--ask-toppings-review.txt",
  "muse--ask-toppings.txt",
  "muse--tasks-popup-approval.txt",
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

// Every opencode capture must stay raw under the muse adapter too — the cross-adapter leg.
const allOpencodeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("oc--") && f.endsWith(".txt"))
  .toSorted();

describeAdapterConformance(museAdapter, {
  ownFixtures,
  foreignFixtures: [
    ...allClaudeFixtures,
    ...allOmpFixtures,
    ...allCodexFixtures,
    ...allGrokFixtures,
    ...allAgyFixtures,
    ...allOpencodeFixtures,
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

  it("lifts the ls approval from under the tasks popup, signature above the rule", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "muse--tasks-popup-approval.txt"), "utf8")),
    );
    const prompt = museAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("permission");
    expect(prompt.prompt.question).toBe("Would you like to run the following command?");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual([
      "Allow this stage once (y)",
      "Always allow in this workspace: ls ... (p)",
      "Abort the entire command (esc)",
    ]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    // The popup's ticking elapsed must not enter the signature, or every tap races the clock.
    expect(prompt.prompt.signature).not.toContain("to select");
    expect(prompt.prompt.signature).not.toContain("muse-spark-1.3");
  });

  it("lifts the network approval (both pointer positions) with digit-alone keys", () => {
    for (const name of ["muse--approval-network.txt", "muse--approval-network-moved.txt"]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const prompt = museAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") continue;
      expect(prompt.prompt.family).toBe("permission");
      expect(prompt.prompt.question).toBe("Would you like to allow this network access?");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual([
        "Yes, proceed (y)",
        "Yes, don't ask again this session (p)  www.gt:443 (https)",
        "Always allow this network destination  www.gt:443 (https)",
        "No, and tell Muse Code what to do differently (esc)",
      ]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"], ["4"]]);
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

// ── What a lift keeps and requires (PR #244, maintainer changes at merge) ──────────────────────

describe("muse: a lift shows its subject and needs a live dialog", () => {
  const load = (name: string): StyledLine[] =>
    splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  const row = (text: string): StyledLine => splitLines(parseAnsi(text))[0]!;
  const rawText = (block: Block): string => (block.kind === "raw" ? block.lines.map(lineText).join("\n") : "");
  /** `lines` with the LAST row matching `match` replaced by plain `text`. */
  const replaceLast = (lines: StyledLine[], match: RegExp, text: string): StyledLine[] => {
    const i = lines.findLastIndex((l) => match.test(lineText(l)));
    if (i < 0) throw new Error(`no row matches ${match}`);
    return [...lines.slice(0, i), row(text), ...lines.slice(i + 1)];
  };
  const DRAFT = /^❯\s*$/;

  it("an approval keeps its question and command on screen above the buttons, without the Voice rule", () => {
    const blocks = museAdapter.buildBlocks(load("muse--approval-ls.txt"));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    const above = rawText(blocks[0]!);
    expect(above).toContain("Would you like to run the following command?");
    expect(above).toContain("$ ls -la /private/tmp/collie-muse-sandbox");
    expect(above).toContain('Current argv: ["ls","-la","/private/tmp/collie-muse-sandbox"]');
    expect(above).not.toContain("Voice input");
  });

  it("a network approval keeps its question and destination on screen above the buttons", () => {
    const blocks = museAdapter.buildBlocks(load("muse--approval-network.txt"));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    const above = rawText(blocks[0]!);
    expect(above).toContain("Would you like to allow this network access?");
    expect(above).toContain("network: www.gt:443 https");
    expect(above).toContain("full URL: https://www.gt/sitio/faq.php#faq-47");
    expect(above).not.toContain("Voice input");
  });

  it("a trust prompt keeps the folder it asks about on screen", () => {
    const blocks = museAdapter.buildBlocks(load("muse--trust-prompt.txt"));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(rawText(blocks[0]!)).toContain("Workspace: /private/tmp/collie-muse-sandbox");
  });

  it("a question keeps its header and question text above the buttons", () => {
    const blocks = museAdapter.buildBlocks(load("muse--ask-color.txt"));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(rawText(blocks[0]!)).toContain("Which color do you prefer?");
  });

  it("the review screen's cancel row carries its own label, Interrupt turn", () => {
    const blocks = museAdapter.buildBlocks(load("muse--ask-toppings-review.txt"));
    const multi = blocks.find((b) => b.kind === "multi-select");
    expect(multi?.kind === "multi-select" && multi.multi.phase === "review" && multi.multi.cancelLabel).toBe(
      "Interrupt turn",
    );
  });

  // A draft in the box means the dialog above it is not the one with the keyboard: a quote, or a
  // screen this adapter cannot vouch for. Enter would submit the draft, so nothing is lifted — but
  // the box below a quote is still live, so a reply is allowed there. Refusing on the broad match
  // stalled every send until the transcript moved (#260); a live dialog always holds a bare box.
  it.each(["muse--ask-color.txt", "muse--ask-toppings.txt", "muse--ask-toppings-review.txt"])(
    "%s with a draft in the box stays raw, and a reply is still allowed",
    (name) => {
      const live = load(name);
      expect(museAdapter.buildBlocks(live).some((b) => b.kind !== "raw")).toBe(true);
      const drafted = replaceLast(live, DRAFT, "❯ ship it");
      expect(museAdapter.buildBlocks(drafted).every((b) => b.kind === "raw")).toBe(true);
      expect(museAdapter.composerReady!(drafted)).toBe(true);
    },
  );

  // Quoted facsimiles (#260): the model paraphrased the review pointer (`│`), so this capture
  // matches no detector — and stays raw and sendable. The exact facsimile (one glyph restored)
  // DOES match the broad detector, and must still stay raw and sendable without a live header.
  it("quoted facsimiles above a bare box stay raw, and a reply is allowed", () => {
    const quoted = load("muse--quoted-dialogs-bare.txt");
    expect(museAdapter.buildBlocks(quoted).every((b) => b.kind === "raw")).toBe(true);
    expect(museAdapter.composerReady!(quoted)).toBe(true);
  });

  it("an exact quoted review (no live header) stays raw, and a reply is allowed", () => {
    const exact = replaceLast(
      load("muse--quoted-dialogs-bare.txt"),
      /│ Submit answers/,
      "  > Submit answers",
    );
    const checkbox = detectCheckboxRegion(exact);
    expect(checkbox?.model.phase).toBe("review"); // non-vacuous: the shape really matches
    expect(museAdapter.buildBlocks(exact).every((b) => b.kind === "raw")).toBe(true);
    expect(museAdapter.composerReady!(exact)).toBe(true);
  });

  // The review rows are short and fixed, so a transcript can quote them word for word. Only a live
  // dialog shows the `— running` header right above them.
  it("a review screen without the live header above it stays raw", () => {
    const quoted = replaceLast(
      load("muse--ask-toppings-review.txt"),
      /Request user input Toppings — running/,
      "◆ Here is what the review screen looks like:",
    );
    expect(museAdapter.buildBlocks(quoted).every((b) => b.kind === "raw")).toBe(true);
  });

  it("with grammars off (the raw-terminal pref) no Muse dialog is lifted and no chrome is stripped", () => {
    for (const name of ["muse--approval-ls.txt", "muse--ask-color.txt", "muse--ask-toppings-review.txt"]) {
      const lines = load(name);
      const blocks = buildBlocks(lines, { agent: "muse", grammars: false });
      expect(blocks.every((b) => b.kind === "raw")).toBe(true);
      expect(blocks.map(rawText).join("\n")).toContain("muse-spark-1.3");
      expect(buildBlocks(lines, { agent: "muse" }).some((b) => b.kind !== "raw")).toBe(true);
    }
  });
});

// ── The tasks popup under a dialog (#304, maintainer changes at merge) ─────────────────────────
//
// A lifted dialog's first write binds its region, and the bridge accepts that binding only when it
// ends within the last 6 non-blank rows (bridge/prompt-binding.ts). The popup adds a header and one
// row per task under the bottom rule, so it can push a region out of that window, and then every tap
// is refused. Such a screen is not lifted: it keeps the unread-dialog card and its Escape, the answer
// it had before the popup was read. The screens below are built from the captures: the popup rows
// are the captured ones, and a task row added to them is plain text in the captured shape.

describe("muse: a dialog over the tasks popup lifts only where the bridge can bind it", () => {
  const load = (name: string): StyledLine[] =>
    splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  const row = (text: string): StyledLine => splitLines(parseAnsi(text))[0]!;
  const text = (lines: StyledLine[]) => lines.map((l) => lineText(l).trimEnd());
  const EXTRA_TASK = "├ ◆ Run another sleep command  running      12s";

  /** `lines` with `extra` task rows added at the top of its popup (above the captured `└` row). */
  const moreTasks = (lines: StyledLine[], extra: number): StyledLine[] => {
    const last = text(lines).findLastIndex((t) => t.startsWith("└ "));
    if (last < 0) throw new Error("no task row");
    return [...lines.slice(0, last), ...Array.from({ length: extra }, () => row(EXTRA_TASK)), ...lines.slice(last)];
  };

  /** `lines` with the captured popup (header + one task) put between its bottom rule and statusline. */
  const withPopup = (lines: StyledLine[]): StyledLine[] => {
    const popup = load("muse--tasks-popup.txt");
    const header = text(popup).findLastIndex((t) => t.startsWith("main"));
    const texts = text(lines);
    const status = texts.findLastIndex((t) => t.startsWith("  muse-spark-1.3"));
    if (header < 0 || status < 0 || !/^─{8,}$/.test(texts[status - 1]!)) throw new Error("unexpected tail");
    return [...lines.slice(0, status), popup[header]!, popup[header + 1]!, ...lines.slice(status)];
  };

  const kinds = (lines: StyledLine[]) => buildBlocks(lines, { agent: "muse" }).map((b) => b.kind);

  it("an approval over one or two tasks lifts; over three it keeps the card", () => {
    const captured = load("muse--tasks-popup-approval.txt");
    expect(kinds(captured)).toEqual(["raw", "prompt-select"]);
    expect(kinds(moreTasks(captured, 1))).toEqual(["raw", "prompt-select"]);

    const three = moreTasks(captured, 2);
    expect(museAdapter.buildBlocks(three).every((b) => b.kind === "raw")).toBe(true);
    expect(museAdapter.composerReady!(three)).toBe(false);
    const card = buildBlocks(three, { agent: "muse" });
    expect(card.map((b) => b.kind)).toEqual(["unread-dialog"]);
    expect(card[0]!.kind === "unread-dialog" && card[0]!.cancel.key).toBe("Escape");
  });

  it.each(["muse--ask-color.txt", "muse--ask-toppings.txt", "muse--ask-toppings-review.txt"])(
    "%s over the popup keeps the card, its region would sit 6 rows up",
    (name) => {
      const plain = load(name);
      expect(kinds(plain)).not.toContain("unread-dialog"); // non-vacuous: it lifts without the popup
      const popped = withPopup(plain);
      expect(museAdapter.composerReady!(popped)).toBe(false);
      expect(kinds(popped)).toEqual(["unread-dialog"]);
    },
  );
});

