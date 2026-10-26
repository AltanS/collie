import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual } from "../prompt-model";
import { detectApproval, detectApprovalRegion } from "./approval";
import { ompAdapter, ompBuildBlocks } from "./index";
import { ompModalOnScreen } from "./modal";
import { hasComposer as hasBoxComposer, locateComposer } from "./chrome";

// omp's tool-approval dialog (.adr/0078). Approve runs a shell command or writes a file, so these tests
// pin three things above all: what the card shows of the subject, that every key a tap sends is one the
// footer printed and that both buttons are the plain walk from the pointed row (ADR 0080 carries the
// guarantee that a moved pointer sends nothing, in the action layer), and that the grammar declines
// every shape it was not built against. Two presets are lifted, each from its own captures: omp 18.4.10 `unicode`
// (`omp--v18-4-approval-*.txt`) and omp 18.1.17 `nerd` (`omp--approval-*.txt`).

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const CHEVRON = "\u{F054}";
const UNICODE_FOOTER = "↑/↓ navigate  ⏎ select  ⎋ cancel";
const TEXT_FOOTER = "up/down navigate  enter select  esc cancel";

/** A dialog drawn the way omp draws it, for the shapes no capture holds. */
function dialog({
  title = "Allow tool: bash",
  body = ["Command: echo hi"],
  options = [" ❯ Approve", "   Deny"],
  footer = UNICODE_FOOTER,
  width = 60,
}: { title?: string; body?: string[]; options?: string[]; footer?: string; width?: number } = {}): string[] {
  const row = (text: string) => `│ ${text.padEnd(width - 3)}│`;
  const blank = row("");
  return [
    "transcript above the dialog",
    `╭─ ${title} ${"─".repeat(Math.max(1, width - title.length - 5))}╮`,
    blank,
    ...body.map(row),
    blank,
    ...options.map(row),
    blank,
    row(footer),
    blank,
    `╰${"─".repeat(width - 2)}╯`,
  ];
}

const LIFTED = [
  "omp--approval-bash.txt",
  "omp--approval-write--deny.txt",
  "omp--approval-write.txt",
  "omp--v18-4-approval-bash-moved.txt",
  "omp--v18-4-approval-bash.txt",
  "omp--v18-4-approval-write-long.txt",
  "omp--v18-4-approval-write-moved.txt",
  "omp--v18-4-approval-write.txt",
];

// omp 18.12.6's divided panel, the second shape (see the header of approval.ts).
// omp 18.6.1's `Allow tool: goal`: no body rows at all (approval.ts, BODYLESS_TOOLS).
const GOAL = ["omp--v18-6-1-approval-goal--w120.txt"];

const DIVIDED = ["omp--v18-12-6-approval-bash--w120.txt", "omp--v18-12-6-approval-bash-later--w120.txt"];
// omp 18.12.6's `Allow tool: task`: the divided panel with a summary row that omp always clips (approval.ts, SUMMARY_TOOLS).
const TASK = ["omp--v18-12-6-approval-task--w120.txt"];

describe("omp 18.4.10 (`unicode` preset) lifts as Approve, Deny, Cancel", () => {
  it("approval-bash: the pointer on Approve, the command on the card", () => {
    const model = detectApproval(load("omp--v18-4-approval-bash.txt"))!;
    expect(model.family).toBe("permission");
    expect(model.caption).toBe("Allow tool: bash");
    expect(model.question).toBe("Allow tool: bash\nCommand: echo hello-approval");
    expect(model.options).toEqual([
      { label: "Approve", description: "Command: echo hello-approval", keys: ["Enter"], keyLabel: "❯" },
      { label: "Deny", keys: ["Down", "Enter"], keyLabel: "" },
      { label: "Cancel", keys: ["Escape"], keyLabel: "Esc" },
    ]);
  });

  it("approval-bash-moved: the pointer on Deny, Approve walks Up, Deny is a bare Enter", () => {
    const model = detectApproval(load("omp--v18-4-approval-bash-moved.txt"))!;
    expect(model.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "❯", "Esc"]);
    expect(model.options[0]!.description).toBe("Command: echo hello-approval");
  });

  it("approval-write and its moved twin: the path and the content on the card", () => {
    const write = detectApproval(load("omp--v18-4-approval-write.txt"))!;
    expect(write.caption).toBe("Allow tool: write");
    expect(write.options[0]!.description).toBe(
      "Path: /tmp/omp-sandbox-approval/note.txt ↵ Content: ↵ hello approval",
    );
    expect(write.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"], ["Escape"]]);
    const moved = detectApproval(load("omp--v18-4-approval-write-moved.txt"))!;
    expect(moved.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
    expect(moved.options.map((o) => o.keyLabel)).toEqual(["", "❯", "Esc"]);
  });

  it("approval-write-long: every row of the content is on the card", () => {
    const model = detectApproval(load("omp--v18-4-approval-write-long.txt"))!;
    const sample = (n: number) => `sample line ${n} for the approval dialog`;
    expect(model.options[0]!.description).toBe(
      [
        "Path: /tmp/omp-sandbox-approval/long.txt",
        "Content:",
        ...Array.from({ length: 14 }, (_, i) => sample(i + 1)),
      ].join(" ↵ "),
    );
    expect(model.question.split("\n")).toEqual([
      "Allow tool: write",
      "Path: /tmp/omp-sandbox-approval/long.txt",
      "Content:",
      ...Array.from({ length: 14 }, (_, i) => sample(i + 1)),
    ]);
    // The signature carries every row as well, so any row changing refuses the tap.
    for (const n of [7, 8, 14]) expect(model.signature).toContain(sample(n));
  });
});

describe("omp 18.1.17 (`nerd` preset) lifts the same way, read from its own glyphs", () => {
  it("approval-bash: a Reason row, the chevron pointer, the usage strip under the box", () => {
    const model = detectApproval(load("omp--approval-bash.txt"))!;
    expect(model.caption).toBe("Allow tool: bash");
    expect(model.options[0]).toEqual({
      label: "Approve",
      description: "Reason: Prompt required by bash pattern: gh issue create * ↵ Command: gh issue create --help",
      keys: ["Enter"],
      keyLabel: "❯",
    });
    expect(model.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"], ["Escape"]]);
    // The badge is the `❯` the chevron stands for, never the private-use glyph.
    expect(model.signature).toContain(CHEVRON);
    expect(model.coreSignature).not.toContain(CHEVRON);
    // The usage strip under the border ticks, so it is not part of what binds the tap.
    expect(model.signature.split("\n").at(-1)!.startsWith("╰─")).toBe(true);
    expect(model.signature).not.toContain(" A 0h");
  });

  it("approval-write and approval-write--deny", () => {
    const write = detectApproval(load("omp--approval-write.txt"))!;
    const deny = detectApproval(load("omp--approval-write--deny.txt"))!;
    expect(write.options[0]!.description).toBe("Path: /tmp/collie-omp-sandbox/scratch.txt ↵ Content: ↵ hello");
    expect(write.options.map((o) => o.keyLabel)).toEqual(["❯", "", "Esc"]);
    expect(deny.options.map((o) => o.keyLabel)).toEqual(["", "❯", "Esc"]);
    expect(deny.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
  });

  it("a ticking usage strip leaves the tap valid", () => {
    const texts = textsOf("omp--approval-bash.txt");
    const before = detectApproval(fromTexts(texts))!;
    const ticked = detectApproval(fromTexts(texts.map((t, i) => (i === 52 ? t.replace("A 0h 0%", "A 1h 9%") : t))))!;
    expect(promptsEqual(before, ticked)).toBe(true);
  });
});

describe("the region, and what stays on screen above the card", () => {
  it("the card starts at the title row; the box is not painted twice, so the mirror above stops at the box", () => {
    const lines = load("omp--v18-4-approval-bash.txt");
    const region = detectApprovalRegion(lines)!;
    // The title row, not `Approve` (294): the card prints the title and every body row as its own
    // question, so a box left in the mirror would show the command twice in the Terminal view.
    expect(region.startLine).toBe(290);
    const rows = region.model.signature.split("\n");
    expect(rows[0]!.startsWith("╭─ Allow tool: bash ─")).toBe(true);
    expect(rows.at(-1)!.startsWith("╰─")).toBe(true);
    expect(rows).toHaveLength(10);
    // The transcript's own preview of the call and the working row are not part of it.
    expect(region.model.signature).not.toContain("$ echo hello-approval");
    expect(region.model.signature).not.toContain("Running requested shell command");

    const blocks = ompBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(blocks[1]!.lines).toHaveLength(10);
    const above = blocks[0]!.lines.map(lineText).join("\n");
    expect(above).not.toContain("Allow tool: bash");
    expect(above).not.toContain("Command: echo hello-approval");
    expect(region.model.question).toContain("Command: echo hello-approval");
  });

  it("the long write keeps every content row verbatim, on the card, and none in the mirror above it", () => {
    const blocks = ompBuildBlocks(load("omp--v18-4-approval-write-long.txt"));
    const above = blocks[0]!.lines.map(lineText).join("\n");
    const card = blocks[1]!;
    if (card.kind !== "prompt-select") throw new Error("expected a prompt-select card");
    const shown = card.prompt.question;
    for (let n = 1; n <= 14; n++) {
      expect(shown).toContain(`sample line ${n} for the approval dialog`);
      // The transcript's preview of the call may print some rows above the box; the box's own rows
      // (a `│ ` gutter) must not be in the mirror.
      expect(above).not.toContain(`│ sample line ${n} for the approval dialog`);
    }
  });

  it("the 18.1.17 card carries the usage strip as part of the rows it replaced", () => {
    const region = detectApprovalRegion(load("omp--approval-bash.txt"))!;
    expect(region.startLine).toBe(41);
    expect(ompBuildBlocks(load("omp--approval-bash.txt"))[1]!.lines).toHaveLength(12);
  });
});

describe("the model declares omp's clamp, and the plans stay the plain walk", () => {
  it.each(LIFTED)("%s: clampedEnds is set and at most one option carries [Enter]", (name) => {
    const model = detectApproval(load(name))!;
    expect(model.clampedEnds).toBe(true);
    expect(model.options.filter((o) => o.keys.length === 1 && o.keys[0] === "Enter")).toHaveLength(1);
  });
});

describe("every tap is a key the footer printed, and both buttons are the plain walk", () => {
  it("pins both plans in both pointer states (ADR 0080 splits them: arrows, read back, then Enter)", () => {
    const plans = (name: string) => detectApproval(load(name))!.options.slice(0, 2).map((o) => [o.label, o.keys]);
    // The pointer on Approve: Approve commits at once, Deny walks Down first.
    expect(plans("omp--v18-4-approval-bash.txt")).toEqual([["Approve", ["Enter"]], ["Deny", ["Down", "Enter"]]]);
    // The pointer on Deny: Approve walks Up first, Deny commits at once.
    expect(plans("omp--v18-4-approval-bash-moved.txt")).toEqual([["Approve", ["Up", "Enter"]], ["Deny", ["Enter"]]]);
  });

  it.each(LIFTED)("%s: both buttons walk from the pointer, Cancel is Escape", (name) => {
    const model = detectApproval(load(name))!;
    const [approve, deny, cancel] = model.options;
    expect(model.options).toHaveLength(3);
    expect(approve!.label).toBe("Approve");
    expect(deny!.label).toBe("Deny");
    expect(cancel).toEqual({ label: "Cancel", keys: ["Escape"], keyLabel: "Esc" });
    // The plain walk: nothing is bent to survive a race (ADR 0080 does that, in the action layer).
    const approvePointed = approve!.keyLabel === "❯";
    expect(approve!.keys).toEqual(approvePointed ? ["Enter"] : ["Up", "Enter"]);
    expect(deny!.keys).toEqual(approvePointed ? ["Down", "Enter"] : ["Enter"]);
    // Exactly one badge marks where a bare Enter at the desk would land.
    expect([approve!.keyLabel, deny!.keyLabel].filter((b) => b === "❯")).toHaveLength(1);
    for (const option of model.options) {
      expect(option.keys.every((k) => ["Up", "Down", "Enter", "Escape"].includes(k))).toBe(true);
    }
  });

  it.each(LIFTED)("%s: one prompt-select, no card, a modal the composer refuses", (name) => {
    const lines = load(name);
    const blocks = ompBuildBlocks(lines);
    expect(blocks.at(-1)!.kind).toBe("prompt-select");
    expect(blocks.filter((b) => b.kind !== "raw")).toHaveLength(1);
    expect(ompAdapter.composerReady!(lines)).toBe(false);
    expect(ompModalOnScreen(lines)).toBe(true);
  });
});

describe("the race guard sees the pointer, the tool and every body row", () => {
  it("a pointer moved between render and tap is not the same prompt", () => {
    const first = detectApproval(load("omp--v18-4-approval-bash.txt"))!;
    const moved = detectApproval(load("omp--v18-4-approval-bash-moved.txt"))!;
    expect(promptsEqual(first, moved)).toBe(false);
    expect(promptsEqual(first, detectApproval(load("omp--v18-4-approval-bash.txt"))!)).toBe(true);
    expect(first.coreSignature).toBe(moved.coreSignature);
    expect(first.coreSignature).not.toContain("❯");
  });

  it("a body row is free text: text past its right side still lifts, shows on the card and binds", () => {
    // The one kind of row the grammar reads loosely, as ask.ts reads a question row.
    const texts = textsOf("omp--v18-4-approval-bash.txt");
    const before = detectApproval(fromTexts(texts))!;
    const after = detectApproval(fromTexts(texts.map((t, i) => (i === 292 ? `${t} zqx` : t))))!;
    expect(after.options[0]!.description).toMatch(/^Command: echo hello-approval +│ zqx$/);
    expect(promptsEqual(before, after)).toBe(false);
  });

  it("a different command, path or content under the same tool is not the same prompt", () => {
    const bash = textsOf("omp--v18-4-approval-bash.txt");
    const before = detectApproval(fromTexts(bash))!;
    const swapped = detectApproval(fromTexts(bash.map((t) => t.replace("echo hello-approval", "rm -rf /tmp/xyz  "))))!;
    expect(swapped.options[0]!.description).toBe("Command: rm -rf /tmp/xyz");
    expect(promptsEqual(before, swapped)).toBe(false);

    const long = textsOf("omp--v18-4-approval-write-long.txt");
    const beforeLong = detectApproval(fromTexts(long))!;
    // The last content row binds the tap and shows on the card.
    const edited = long.map((t) => t.replace("sample line 13 for", "sample line 13 FOR"));
    const afterLong = detectApproval(fromTexts(edited))!;
    expect(afterLong.options[0]!.description).toContain("sample line 13 FOR");
    expect(promptsEqual(beforeLong, afterLong)).toBe(false);
  });
});

describe("the card hides nothing", () => {
  const content = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  const write = (rows: string[]) =>
    detectApproval(fromTexts(dialog({ title: "Allow tool: write", body: ["Path: /tmp/a.txt", "Content:", ...rows] })));

  it("shows every content row up to thirty, and declines past that rather than cut one", () => {
    expect(write(content(30))!.options[0]!.description).toBe(
      ["Path: /tmp/a.txt", "Content:", ...content(30)].join(" ↵ "),
    );
    expect(write(content(31))).toBeNull();
    expect(write([])!.options[0]!.description).toBe("Path: /tmp/a.txt ↵ Content:");
  });

  it("content that looks like an elision marker is just content", () => {
    expect(write(["… +4"])!.options[0]!.description).toBe("Path: /tmp/a.txt ↵ Content: ↵ … +4");
  });

  it("never shortens a command, however many rows it takes", () => {
    const rows = ["Command: set -e", ...Array.from({ length: 30 }, (_, i) => `rm -rf /tmp/scratch-${i}`)];
    const model = detectApproval(fromTexts(dialog({ body: rows })))!;
    expect(model.options[0]!.description).toBe(rows.join(" ↵ "));
  });

  it("shows a wrapped path whole, and the FIRST `Content:` row starts the content", () => {
    const body = ["Path: /tmp/a-very-long-folder-name/and-more", "  /of-it.txt", "Content:", ...content(7), "Content:"];
    const wrapped = detectApproval(fromTexts(dialog({ title: "Allow tool: write", body })))!;
    expect(wrapped.options[0]!.description).toBe(body.join(" ↵ "));
  });

  it("a newline in a command is never shown as a space", () => {
    const model = detectApproval(fromTexts(dialog({ body: ["Command: echo hi", "rm -rf ~/scratch"] })))!;
    expect(model.options[0]!.description).toBe("Command: echo hi ↵ rm -rf ~/scratch");
  });
});

describe("fails closed", () => {
  const bash = textsOf("omp--v18-4-approval-bash.txt");
  const nerd = textsOf("omp--approval-bash.txt");
  const TITLE_AT = 290;
  const FOOTER_AT = 297;
  const edit = (texts: string[], at: number, from: string | RegExp, to: string) =>
    detectApproval(fromTexts(texts.map((t, i) => (i === at ? t.replace(from, to) : t))));

  it("positive control: the captures and the drawn dialog lift, so every edit below is what declines", () => {
    expect(detectApproval(fromTexts(bash))).not.toBeNull();
    expect(detectApproval(fromTexts(nerd))).not.toBeNull();
    expect(detectApproval(fromTexts(dialog()))).not.toBeNull();
    expect(bash[FOOTER_AT]).toContain(UNICODE_FOOTER);
    expect(bash[TITLE_AT]!.startsWith("╭─ Allow tool: bash ─")).toBe(true);
  });

  it("with a third option row, such as omp's `Always for this session`", () => {
    const three = dialog({ options: [" ❯ Always for this session", "   Approve", "   Deny"] });
    expect(detectApproval(fromTexts(three))).toBeNull();
    const below = dialog({ options: [" ❯ Approve", "   Deny", "   Always for this session"] });
    expect(detectApproval(fromTexts(below))).toBeNull();
  });

  it("with the pointer on neither row, or on both", () => {
    expect(detectApproval(fromTexts(dialog({ options: ["   Approve", "   Deny"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ options: [" ❯ Approve", " ❯ Deny"] })))).toBeNull();
  });

  it("with other labels, or the two in the other order", () => {
    expect(detectApproval(fromTexts(dialog({ options: [" ❯ Deny", "   Approve"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ options: [" ❯ Allow once", "   Deny"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ options: [" ❯ Approve (y)", "   Deny"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ options: [" ❯ Yes", "   No"] })))).toBeNull();
  });

  it("with a pointer from another preset than the footer's, or the `ascii` preset", () => {
    // The Nerd Font chevron under the 18.4 glyph keycaps: a pair omp does not print.
    expect(detectApproval(fromTexts(dialog({ options: [` ${CHEVRON} Approve`, "   Deny"] })))).toBeNull();
    // `❯` over the text keycaps: uncaptured.
    expect(detectApproval(fromTexts(dialog({ footer: TEXT_FOOTER })))).toBeNull();
    // The nerd capture with a `❯` swapped in, and the unicode capture with the chevron swapped in.
    expect(detectApproval(fromTexts(nerd.map((t) => t.replace(CHEVRON, "❯"))))).toBeNull();
    expect(detectApproval(fromTexts(bash.map((t) => t.replace("  ❯ Approve", `  ${CHEVRON} Approve`))))).toBeNull();
    // The `ascii` preset's pointer.
    expect(detectApproval(fromTexts(dialog({ options: [" > Approve", "   Deny"] })))).toBeNull();
    // The nerd chevron with the 18.4 nerd keycaps (U+F0311, U+F12B7), which no approval capture shows.
    const nerdKeycaps = "↑/↓ navigate  \u{F0311} select  \u{F12B7} cancel";
    expect(detectApproval(fromTexts(dialog({ options: [` ${CHEVRON} Approve`, "   Deny"], footer: nerdKeycaps })))).toBeNull();
  });

  it("with any other footer: clipped, rebound, extended, re-spelled, or without its border", () => {
    expect(edit(bash, FOOTER_AT, "  ⎋ cancel", "")).toBeNull();
    expect(edit(bash, FOOTER_AT, "⎋ cancel", "⎋ canc")).toBeNull();
    expect(edit(bash, FOOTER_AT, "↑/↓ navigate", "ctrl+p/ctrl+n navigate")).toBeNull();
    expect(edit(bash, FOOTER_AT, "⎋ cancel", "⎋ cancel  ctrl+o expand")).toBeNull();
    expect(edit(bash, FOOTER_AT, "⏎ select", "⏎ confirm")).toBeNull();
    expect(edit(bash, FOOTER_AT, /\s*│$/, "")).toBeNull();
    expect(detectApproval(fromTexts(dialog({ footer: "↑/↓ navigate · ⏎ select · ⎋ cancel" })))).toBeNull();
  });

  it("with a countdown in the title, another tool, or another dialog's title", () => {
    expect(edit(bash, TITLE_AT, "Allow tool: bash ──────", "Allow tool: bash (9s) ")).toBeNull();
    for (const title of ["Allow tool: edit", "Allow tool: eval", "Allow tool: mcp__fs__write", "Allow tools: bash", "Ask"]) {
      expect(detectApproval(fromTexts(dialog({ title }))), title).toBeNull();
    }
  });

  it("with a body this grammar was not built against", () => {
    const body = (title: string, rows: string[]) => detectApproval(fromTexts(dialog({ title, body: rows })));
    expect(body("Allow tool: bash", ["Path: /tmp/a"])).toBeNull();
    expect(body("Allow tool: bash", ["Reason: x", "Reason: y", "Command: ls"])).toBeNull();
    expect(body("Allow tool: bash", ["Reason: only a reason"])).toBeNull();
    expect(body("Allow tool: bash", ["", "Command: ls"])).toBeNull();
    expect(body("Allow tool: write", ["Command: ls"])).toBeNull();
    expect(body("Allow tool: write", ["Path: /tmp/a", "hello"])).toBeNull();
    // The optional Reason row is read on both tools, as omp's formatter prints it.
    expect(body("Allow tool: write", ["Reason: always-ask", "Path: /tmp/a", "Content:"])).not.toBeNull();
  });

  it("when omp itself elided part of the subject, even across a wrap", () => {
    const elided = ["Command: printf aaaaaaaa[…1200ch elided…]"];
    expect(detectApproval(fromTexts(dialog({ body: elided })))).toBeNull();
    const wrapped = ["Command: printf aaaaaaaa[…1200ch", "elided…]"];
    expect(detectApproval(fromTexts(dialog({ body: wrapped })))).toBeNull();
    const content = ["Path: /tmp/a", "Content:", "hello", "[…3", "1ch elided…]"];
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: write", body: content })))).toBeNull();
  });

  it("with a provider safety-check section, uncaptured", () => {
    const rows = ["Command: ls", "Provider safety checks:", "- something"];
    expect(detectApproval(fromTexts(dialog({ body: rows })))).toBeNull();
  });

  it("without the spacer under the title or above the options, or with no body at all", () => {
    expect(detectApproval(fromTexts(bash.filter((_, i) => i !== 291)))).toBeNull();
    expect(detectApproval(fromTexts(bash.filter((_, i) => i !== 293)))).toBeNull();
    expect(detectApproval(fromTexts(bash.filter((_, i) => i !== 292)))).toBeNull();
  });

  it("with a search status row, or anything else, between the options and the footer", () => {
    const status = bash.map((t, i) => (i === 296 ? t.replace("│                    ", "│   (1/2)  Search: a") : t));
    expect(detectApproval(fromTexts(status))).toBeNull();
  });

  it("with a row outside the box inside the body", () => {
    expect(detectApproval(fromTexts(bash.map((t, i) => (i === 292 ? "Command: echo hello-approval" : t))))).toBeNull();
  });

  it("without the title, or with the bottom border gone", () => {
    expect(detectApproval(fromTexts(bash.map((t, i) => (i === TITLE_AT ? bash[291]! : t))))).toBeNull();
    expect(detectApproval(fromTexts(bash.slice(0, -1)))).toBeNull();
  });

  it("with two rows under the border, or a frame row standing in for the usage strip", () => {
    expect(detectApproval(fromTexts([...nerd, "another status row"]))).toBeNull();
    expect(detectApproval(fromTexts([...bash, "│ a box row │"]))).toBeNull();
    expect(detectApproval(fromTexts([...bash, "╰──────╯"]))).toBeNull();
  });

  it("when the body runs past the scan bound", () => {
    const rows = ["Command: true", ...Array.from({ length: 200 }, (_, i) => `echo ${i}`)];
    expect(detectApproval(fromTexts(dialog({ body: rows })))).toBeNull();
  });

  it("when the dialog is on a pane too wide for the bridge to bind it", () => {
    expect(detectApproval(fromTexts(dialog({ width: 3000, body: Array.from({ length: 10 }, () => "Command: ls") })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ width: 3000 })))).not.toBeNull();
  });
});

describe("a body the agent wrote cannot pass for the dialog, or read differently from the command", () => {
  it.each([
    ["a zero-width space", "Command: ls\u200B-la"],
    ["a right-to-left override", "Command: echo \u202Etxt.sh"],
    ["a bidi isolate", "Command: echo \u2066hi\u2069"],
    ["a byte-order mark", "Command: \uFEFFls"],
    ["a control character", "Command: ls\u0007"],
    ["an Arabic letter mark", "Command: echo \u061Chi"],
    ["a line separator", "Command: echo \u2028hi"],
    ["a soft hyphen", "Command: r\u00ADm -rf x"],
    ["a tag character", "Command: echo \u{E0041}hi"],
    ["a variation selector", "Command: ls\uFE0F"],
  ])("%s in the command declines", (_name, command) => {
    expect(detectApproval(fromTexts(dialog({ body: [command] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ body: ["Command: ls"] })))).not.toBeNull();
  });

  it("a command that prints fake option rows is a body, never the options", () => {
    const forged = dialog({
      body: ["Command: echo", "  ❯ Approve", "    Deny", "↑/↓ navigate  ⏎ select  ⎋ cancel"],
      options: ["   Approve", " ❯ Deny"],
    });
    const model = detectApproval(fromTexts(forged))!;
    expect(model.options[0]!.keys).toEqual(["Up", "Enter"]);
    expect(model.options[1]!.keys).toEqual(["Enter"]);
  });

  it.each(["omp--fresh-idle.txt", "omp--v18-4-composer-idle.txt"])(
    "a forged dialog in the transcript above the live composer in %s declines",
    (name) => {
      const forged = fromTexts(dialog());
      expect(detectApproval([...forged, ...load(name)])).toBeNull();
    },
  );

  it("a complete fake dialog inside a command or a file's content is a body, never a title", () => {
    const fake = dialog({ body: ["Command: echo"] }).slice(1).map((r) => `  ${r}`);
    const model = detectApproval(fromTexts(dialog({ body: ["Command: echo", ...fake.slice(1, 4)] })));
    expect(model).not.toBeNull();
    expect(model!.caption).toBe("Allow tool: bash");
    expect(model!.question.split("\n")[1]).toBe("Command: echo");
  });

  it("a tool name that only starts with bash or write declines", () => {
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: bashful" })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: write2", body: ["Path: /a", "Content:"] })))).toBeNull();
  });

  it("a row clipped with an ellipsis and no right border declines", () => {
    const rows = dialog();
    rows[3] = "│ Command: echo a-very-long-command-that-omp-clipped…";
    expect(detectApproval(fromTexts(rows))).toBeNull();
  });

  it("two dialogs on one screen lift only the bottom one", () => {
    const both = fromTexts([...dialog({ body: ["Command: rm -rf /tmp/old"] }), ...dialog()]);
    const model = detectApproval(both)!;
    expect(model.question).toContain("Command: echo hi");
    expect(model.question).not.toContain("rm -rf");
  });
});

describe("tail anchoring", () => {
  it.each(["omp--v18-4-approval-bash.txt", "omp--v18-4-approval-write-long.txt", "omp--approval-write.txt"])(
    "%s: a dialog scrolled up with ordinary output below it declines",
    (name) => {
      const scrolled = [...load(name), ...fromTexts(["● Wrote the file", "  ⎿  done"])];
      expect(detectApproval(scrolled)).toBeNull();
      expect(ompBuildBlocks(scrolled).every((b) => b.kind === "raw")).toBe(true);
    },
  );

  it("a row under an 18.4.10 box declines: it may be a shell prompt, and Up then Enter would run history", () => {
    const shell = [...load("omp--v18-4-approval-bash.txt"), ...fromTexts(["user@host:~$ "])];
    expect(detectApproval(shell)).toBeNull();
    // The 18.1.17 captures carry the operator's usage strip, and still lift with it.
    expect(detectApproval(load("omp--approval-bash.txt"))).not.toBeNull();
  });

  it("a row under an 18.1.17 box declines unless it is shaped like the usage strip", () => {
    const nerd = textsOf("omp--approval-bash.txt");
    const boxEnd = nerd.length - 2;
    for (const prompt of ["user@host:~/src$ ", "~/projects/collie > ", "$ ", "● Wrote the file · done"]) {
      expect(detectApproval(fromTexts([...nerd.slice(0, boxEnd + 1), prompt]))).toBeNull();
    }
  });

  it("trailing blank rows below the border do not move the tail", () => {
    expect(detectApproval([...load("omp--v18-4-approval-bash.txt"), ...fromTexts(["", "   ", ""])])).not.toBeNull();
  });
});

describe("the grammar claims nothing else in the corpus", () => {
  it("lifts exactly the eleven approval captures, out of every capture in the corpus", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
    expect(all.length).toBeGreaterThan(300);
    const lifted = all.filter((name) => detectApproval(load(name)) !== null);
    expect(lifted.toSorted()).toEqual([...LIFTED, ...GOAL, ...DIVIDED, ...TASK].toSorted());
  });
});

// ── omp 18.12.6: the divided panel (the second shape, approval.ts header) ─────────────────────────────

const DIVIDED_FOOTER = "↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O details · type to deny and steer";
const BAND = " ⠙ 4s > ◒ Haiku 4.5 > 📁 …/project > $0.02 ▶──6%──────────────────────────┃─────200K─";

/** The panel as omp 18.12.6 draws it, for the shapes no capture holds: the same rows as the capture. */
function panel({
  title = "Allow tool: bash",
  body = ["Command: echo gang-test"],
  choices = ["❯ Approve", "  Approve bash for this session", "  Deny"],
  footer = DIVIDED_FOOTER,
  under = [BAND, "╰─"],
  width = 120,
}: { title?: string; body?: string[]; choices?: string[]; footer?: string; under?: string[]; width?: number } = {}): string[] {
  const row = (text: string) => `│ ${text.padEnd(width - 3)}│`;
  return [
    "transcript above the panel",
    `╭─ ${title} ${"─".repeat(Math.max(1, width - title.length - 5))}╮`,
    ...body.map(row),
    ...choices.map(row),
    `├${"─".repeat(width - 2)}┤`,
    row(footer),
    `╰${"─".repeat(width - 2)}╯`,
    ...under,
  ];
}

describe("omp 18.12.6 (`unicode` preset) lifts the divided panel as Approve, the session row and Deny", () => {
  it.each(DIVIDED)("%s: the three rows, the command on the card, Deny as Escape", (name) => {
    const model = detectApproval(load(name))!;
    expect(model.family).toBe("permission");
    expect(model.caption).toBe("Allow tool: bash");
    expect(model.question).toBe("Allow tool: bash\nCommand: echo gang-test");
    expect(model.options).toEqual([
      { label: "Approve", description: "Command: echo gang-test", keys: ["Enter"], keyLabel: "❯" },
      { label: "Approve bash for this session", keys: ["Down", "Enter"], keyLabel: "" },
      { label: "Deny", keys: ["Escape"], keyLabel: "Esc" },
    ]);
  });

  it.each(DIVIDED)("%s: the card starts at the title and the build keeps the transcript above as raw", (name) => {
    const lines = load(name);
    const region = detectApprovalRegion(lines)!;
    expect(lineText(lines[region.startLine]!)).toMatch(/^╭─ Allow tool: bash ─+╮$/);
    const blocks = ompBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
  });

  it.each(DIVIDED)("%s: the list wraps, so the model never declares clampedEnds", (name) => {
    expect(detectApproval(load(name))!.clampedEnds).toBeUndefined();
  });

  it("the pointer on the session row: Approve walks Up, the session row is a bare Enter, Deny stays Escape", () => {
    const model = detectApproval(fromTexts(panel({ choices: ["  Approve", "❯ Approve bash for this session", "  Deny"] })))!;
    expect(model.options.map((o) => [o.label, o.keys, o.keyLabel])).toEqual([
      ["Approve", ["Up", "Enter"], ""],
      ["Approve bash for this session", ["Enter"], "❯"],
      ["Deny", ["Escape"], "Esc"],
    ]);
  });

  it("the pointer on Deny: Approve walks Up twice, the session row Up once, Deny is still Escape", () => {
    const model = detectApproval(fromTexts(panel({ choices: ["  Approve", "  Approve bash for this session", "❯ Deny"] })))!;
    expect(model.options.map((o) => o.keys)).toEqual([["Up", "Up", "Enter"], ["Up", "Enter"], ["Escape"]]);
  });

  it("a call that cannot be granted for the session has two rows (source: `session` is optional)", () => {
    const model = detectApproval(fromTexts(panel({ choices: ["❯ Approve", "  Deny"] })))!;
    expect(model.options.map((o) => [o.label, o.keys])).toEqual([
      ["Approve", ["Enter"]],
      ["Deny", ["Escape"]],
    ]);
  });

  it("a Reason row above the command shows on the card", () => {
    const model = detectApproval(fromTexts(panel({ body: ["Reason: matched a config pattern", "Command: rm -rf build"] })))!;
    expect(model.question).toBe("Allow tool: bash\nReason: matched a config pattern\nCommand: rm -rf build");
    expect(model.options[0]!.description).toBe("Reason: matched a config pattern ↵ Command: rm -rf build");
  });

  it("the pointer moves the signature but not the coreSignature, and a different command moves both", () => {
    const a = detectApproval(fromTexts(panel()))!;
    const moved = detectApproval(fromTexts(panel({ choices: ["  Approve", "❯ Approve bash for this session", "  Deny"] })))!;
    expect(a.signature).not.toBe(moved.signature);
    expect(a.coreSignature).toBe(moved.coreSignature);
    expect(promptsEqual(a, moved)).toBe(false);
    const other = detectApproval(fromTexts(panel({ body: ["Command: echo something-else"] })))!;
    expect(other.coreSignature).not.toBe(a.coreSignature);
  });

  it("the composer's band under the panel stays out of the signature: it ticks", () => {
    const a = detectApproval(fromTexts(panel()))!;
    const b = detectApproval(fromTexts(panel({ under: [BAND.replace("4s", "9s"), "╰─"] })))!;
    expect(promptsEqual(a, b)).toBe(true);
  });

  it("no band at all under the border lifts too (a short read)", () => {
    expect(detectApproval(fromTexts(panel({ under: [] })))).not.toBeNull();
  });

  it("the 18.4.10 and 18.1.17 shapes still lift beside it, each as before", () => {
    expect(detectApproval(load("omp--v18-4-approval-bash.txt"))!.options.map((o) => o.label)).toEqual(["Approve", "Deny", "Cancel"]);
    expect(detectApproval(load("omp--approval-bash.txt"))!.options.map((o) => o.label)).toEqual(["Approve", "Deny", "Cancel"]);
  });
});

describe("the divided panel declines everything it was not built against", () => {
  const declines = (rows: string[]) => expect(detectApproval(fromTexts(rows))).toBeNull();

  it("the unmodified synthetic panel is the capture's shape (the controls below start from a lifting screen)", () => {
    expect(detectApproval(fromTexts(panel()))).not.toBeNull();
  });

  it.each([
    ["a nerd preset footer", "up/down choose · enter select · Ctrl+Enter/Ctrl+Q approve · esc deny · Ctrl+O details · type to deny and steer"],
    ["a rebound approve key", DIVIDED_FOOTER.replace("Ctrl+Q", "Ctrl+Y")],
    ["a footer that scrolls", `${DIVIDED_FOOTER} · PgUp/PgDn scroll`],
    ["a footer with a draft in the composer", "⏎ deny and send · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O details"],
    ["the first shape's footer", UNICODE_FOOTER],
  ])("%s", (_name, footer) => declines(panel({ footer })));

  it("a draft in the composer relabels Deny and moves the pointer onto it", () => {
    declines(panel({ choices: ["  Approve", "  Approve bash for this session", "❯ Deny and send message"] }));
  });

  it("a draft in the composer shows under the panel", () => {
    declines(panel({ under: [BAND, "╰─ please check the build"] }));
  });

  it.each([
    ["an always-ask-cached grant row", ["  Remember across sessions", "  Approve Directory: ~/src", "❯ Approve Once", "  Deny"]],
    ["a session row naming another tool", ["❯ Approve", "  Approve write for this session", "  Deny"]],
    ["a session row with no Approve above it", ["  Approve bash for this session", "❯ Deny"]],
    ["a fourth row", ["❯ Approve", "  Approve bash for this session", "  Approve all", "  Deny"]],
    ["two pointers", ["❯ Approve", "❯ Approve bash for this session", "  Deny"]],
    ["no pointer", ["  Approve", "  Approve bash for this session", "  Deny"]],
    ["Deny relabelled", ["❯ Approve", "  Approve bash for this session", "  Reject"]],
    ["the nerd pointer", ["\u{F054} Approve", "  Approve bash for this session", "  Deny"]],
  ])("%s", (_name, choices) => declines(panel({ choices })));

  it.each([
    ["a write", "Allow tool: write", ["Path: /tmp/a.txt · Content: hello …"]],
    ["an edit", "Allow tool: edit", ["Command: x"]],
    ["a title with a countdown", "Allow tool: bash (27s)", ["Command: echo hi"]],
  ])("%s", (_name, title, body) => declines(panel({ title, body })));

  it.each([
    ["a command cut to the box", ["Command: echo a-very-long-command-that-omp-clipped…"]],
    ["a command with more lines (omp's ` …`)", ["Command: for i in 1 2 3; do …"]],
    ["a command that is a space and an ellipsis", ["Command: ls …"]],
    ["a row that is not a command", ["echo hi"]],
    ["a Reason row that was cut", ["Reason: a long reason that omp cut to the box…", "Command: ls"]],
    ["two commands", ["Command: ls", "Command: pwd"]],
    ["a Reason alone", ["Reason: because"]],
    ["three body rows", ["Reason: a", "Command: b", "Path: c"]],
    ["omp's own elision mark", ["Command: echo […4000ch elided…]"]],
    ["a zero-width space", ["Command: ls​-la"]],
    ["a right-to-left override", ["Command: ls ‮fdp.txt"]],
  ])("%s", (_name, body) => declines(panel({ body })));

  it("no body row at all", () => declines(panel({ body: [] })));

  it("no divider, or a blank row where the first shape keeps its own", () => {
    const rows = panel();
    declines(rows.map((r) => (r.startsWith("├") ? `│${" ".repeat(118)}│` : r)));
  });

  it.each([
    ["a shell prompt", ["user@host:~$ "]],
    ["a band with nothing after it", [BAND]],
    ["an empty prompt row without a band", ["╰─"]],
    ["a band, the prompt row and a third row", [BAND, "╰─", "stray"]],
    ["a pi composer rule", ["────────────────────────────────"]],
  ])("under the border: %s declines", (_name, under) => declines(panel({ under })));

  it("a panel scrolled up with ordinary output below it declines", () => {
    declines([...panel({ under: [] }), "● Ran the command", "  ⎿  done"]);
  });

  it("two panels on one screen lift only the bottom one", () => {
    const both = fromTexts([...panel({ body: ["Command: rm -rf /tmp/old"], under: [] }), ...panel()]);
    const model = detectApproval(both)!;
    expect(model.question).toContain("echo gang-test");
    expect(model.question).not.toContain("rm -rf");
  });

  it("trailing blank rows below the band do not move the tail", () => {
    expect(detectApproval(fromTexts([...panel(), "", "   ", ""]))).not.toBeNull();
  });

  it("a panel narrower than the footer cannot lift: the footer is one exact string", () => {
    declines(panel({ footer: DIVIDED_FOOTER.slice(0, 60) }));
  });
});

// ── omp 18.12.6: `Allow tool: task`, a summary tool (approval.ts, SUMMARY_TOOLS) ─────────────────────────
// Read off `omp--v18-12-6-approval-task--w120.txt` (omp-gang 04-readers X1, 2026-10-26): the divided panel, one
// `Context: …` row that omp clipped with a `…`, and the session row `Approve task for this session`.

describe("omp 18.12.6 `Allow tool: task` lifts with its summary row as the screen shows it", () => {
  const SUMMARY = "Context: # Goal · Batch agents: scout ×1 · Agent: scout · Task: Read README.md, guide.md, main entry points (src/ma…";

  it.each(TASK)("%s: the three rows, the clipped summary on the card, Deny as Escape", (name) => {
    const model = detectApproval(load(name))!;
    expect(model.family).toBe("permission");
    expect(model.caption).toBe("Allow tool: task");
    expect(model.question).toBe(`Allow tool: task\n${SUMMARY}`);
    expect(model.options).toEqual([
      { label: "Approve", description: SUMMARY, keys: ["Enter"], keyLabel: "❯" },
      { label: "Approve task for this session", keys: ["Down", "Enter"], keyLabel: "" },
      { label: "Deny", keys: ["Escape"], keyLabel: "Esc" },
    ]);
    expect(model.clampedEnds).toBeUndefined();
  });

  it.each(TASK)("%s: the card starts at the title and the build keeps the rest as raw", (name) => {
    const lines = load(name);
    const region = detectApprovalRegion(lines)!;
    expect(lineText(lines[region.startLine]!)).toMatch(/^╭─ Allow tool: task ─+╮$/);
    expect(ompBuildBlocks(lines).map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(locateComposer(lines)).toBeNull();
  });

  it("the pointer on the session row walks like bash's, and a different summary moves the signature", () => {
    const moved = detectApproval(fromTexts(panel({ title: "Allow tool: task", body: [SUMMARY], choices: ["  Approve", "❯ Approve task for this session", "  Deny"] })))!;
    expect(moved.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
    const a = detectApproval(fromTexts(panel({ title: "Allow tool: task", body: [SUMMARY], choices: ["❯ Approve", "  Approve task for this session", "  Deny"] })))!;
    const other = detectApproval(fromTexts(panel({ title: "Allow tool: task", body: ["Task: something else"], choices: ["❯ Approve", "  Approve task for this session", "  Deny"] })))!;
    expect(a.coreSignature).toBe(moved.coreSignature);
    expect(other.coreSignature).not.toBe(a.coreSignature);
  });

  const declines = (body: string[], choices: string[] = ["❯ Approve", "  Approve task for this session", "  Deny"]) => expect(detectApproval(fromTexts(panel({ title: "Allow tool: task", body, choices })))).toBeNull();

  it.each([
    ["a row that opens with no task detail", ["echo hi"]],
    ["a Command row", ["Command: ls"]],
    ["a Reason alone", ["Reason: because"]],
    ["three body rows", ["Reason: a", "Task: b", "Agent: c"]],
    ["omp's own elision mark", ["Task: do […4000ch elided…]"]],
    ["a zero-width space", ["Task: do​it"]],
    ["a right-to-left override", ["Task: do ‮fdp.txt"]],
  ])("declines %s", (_name, body) => declines(body));

  it("declines a session row that names another tool", () => {
    declines([SUMMARY], ["❯ Approve", "  Approve bash for this session", "  Deny"]);
  });

  it("accepts a Reason row above the summary, and a summary that fits whole (no clip mark)", () => {
    const choices = ["❯ Approve", "  Approve task for this session", "  Deny"];
    expect(detectApproval(fromTexts(panel({ title: "Allow tool: task", choices, body: ["Reason: matched a config pattern", "Agent: scout · Task: read the readme"] })))).not.toBeNull();
    expect(detectApproval(fromTexts(panel({ title: "Allow tool: task", choices, body: ["Agent: scout · Task: read the readme"] })))).not.toBeNull();
  });
});

describe("a lifted panel owns the keyboard even though the composer stays mounted under it", () => {
  const screens = DIVIDED.map((name) => [name, load(name)] as const);

  it.each(screens)("%s: no composer, no reply path, no draft, no binding region", (_name, lines) => {
    expect(locateComposer(lines)).toBeNull();
    expect(hasBoxComposer(lines)).toBe(false);
    expect(ompAdapter.composerReady!(lines)).toBe(false);
    expect(ompAdapter.composerPrompt!(lines)).toBeNull();
  });

  it("the same band with the panel gone is a composer again", () => {
    const lines = load("omp--v18-12-band-idle--w130.txt");
    expect(ompAdapter.composerReady!(lines)).toBe(true);
  });

  it("a panel the grammar declines (a draft in the composer) leaves the old verdict alone", () => {
    const lines = fromTexts(panel({ under: [BAND, "╰─ please check the build"] }));
    expect(detectApproval(lines)).toBeNull();
  });
});

// ── omp 18.6.1: `Allow tool: goal`, a dialog with no body (approval.ts, BODYLESS_TOOLS) ──────────────────
// Read off `omp--v18-6-1-approval-goal--w120.txt` (omp-gang tester 02, 2026-10-25): the title, the spacer,
// a second blank row, Approve and Deny, and the first shape's footer. omp's `goal` tool has no
// `formatApprovalDetails`, and the card names the tool and nothing else.
describe("omp 18.6.1 `Allow tool: goal` lifts with no body", () => {
  const GOAL_CAPTURE = "omp--v18-6-1-approval-goal--w120.txt";

  it("the capture: Approve, Deny, Cancel; the card shows only the title", () => {
    const region = detectApprovalRegion(load(GOAL_CAPTURE))!;
    expect(region).not.toBeNull();
    const model = region.model;
    expect(model.family).toBe("permission");
    expect(model.caption).toBe("Allow tool: goal");
    expect(model.question).toBe("Allow tool: goal");
    expect(model.options).toEqual([
      { label: "Approve", keys: ["Enter"], keyLabel: "❯" },
      { label: "Deny", keys: ["Down", "Enter"], keyLabel: "" },
      { label: "Cancel", keys: ["Escape"], keyLabel: "Esc" },
    ]);
    expect(model.clampedEnds).toBe(true);
    // The card starts at the title row, so the box is not painted twice.
    expect(textsOf(GOAL_CAPTURE)[region.startLine]).toMatch(/^╭─ Allow tool: goal ─+╮$/);
  });

  it("the pointer on Deny walks the other way", () => {
    const moved = dialog({ title: "Allow tool: goal", body: [], options: ["   Approve", " ❯ Deny"] });
    const model = detectApproval(fromTexts(moved))!;
    expect(model.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
  });

  it("a synthetic goal dialog of the same shape lifts", () => {
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: goal", body: [] })))).not.toBeNull();
  });

  it("declines a goal dialog with a body row, a Reason row or a third option, and other bodyless tools", () => {
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: goal", body: ["Command: echo hi"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: goal", body: ["Reason: pattern"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: goal", body: [], options: [" ❯ Always for this session", "   Approve", "   Deny"] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: edit", body: [] })))).toBeNull();
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: bash", body: [] })))).toBeNull();
  });

  it("declines when the footer is another dialect, as the other shapes do", () => {
    expect(detectApproval(fromTexts(dialog({ title: "Allow tool: goal", body: [], footer: "↑/↓ navigate  ⏎ select" })))).toBeNull();
  });
});
