import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual } from "../prompt-model";
import { detectApproval, detectApprovalRegion } from "./approval";
import { ompAdapter, ompBuildBlocks } from "./index";
import { ompModalOnScreen } from "./modal";

// omp's tool-approval dialog (.adr/0078). Approve runs a shell command or writes a file, so these tests
// pin three things above all: what the card shows of the subject, that every key a tap sends is one the
// footer printed and that Deny can never land on Approve, and that the grammar declines every shape it
// was not built against. Two presets are lifted, each from its own captures: omp 18.4.10 `unicode`
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

  it("approval-bash-moved: the pointer on Deny, Approve walks Up, Deny still sends Down", () => {
    const model = detectApproval(load("omp--v18-4-approval-bash-moved.txt"))!;
    expect(model.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Down", "Enter"], ["Escape"]]);
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
    expect(moved.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Down", "Enter"], ["Escape"]]);
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
    expect(deny.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Down", "Enter"], ["Escape"]]);
  });

  it("a ticking usage strip leaves the tap valid", () => {
    const texts = textsOf("omp--approval-bash.txt");
    const before = detectApproval(fromTexts(texts))!;
    const ticked = detectApproval(fromTexts(texts.map((t, i) => (i === 52 ? t.replace("A 0h 0%", "A 1h 9%") : t))))!;
    expect(promptsEqual(before, ticked)).toBe(true);
  });
});

describe("the region, and what stays on screen above the card", () => {
  it("the card starts at Approve; the title and the body stay in the raw mirror above it", () => {
    const lines = load("omp--v18-4-approval-bash.txt");
    const region = detectApprovalRegion(lines)!;
    expect(region.startLine).toBe(294);
    const rows = region.model.signature.split("\n");
    expect(rows[0]!.startsWith("╭─ Allow tool: bash ─")).toBe(true);
    expect(rows.at(-1)!.startsWith("╰─")).toBe(true);
    expect(rows).toHaveLength(10);
    // The transcript's own preview of the call and the working row are not part of it.
    expect(region.model.signature).not.toContain("$ echo hello-approval");
    expect(region.model.signature).not.toContain("Running requested shell command");

    const blocks = ompBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(blocks[1]!.lines).toHaveLength(6);
    const above = blocks[0]!.lines.map(lineText).join("\n");
    expect(above).toContain("Allow tool: bash");
    expect(above).toContain("Command: echo hello-approval");
  });

  it("the long write keeps every content row verbatim in the raw mirror", () => {
    const blocks = ompBuildBlocks(load("omp--v18-4-approval-write-long.txt"));
    const above = blocks[0]!.lines.map(lineText).join("\n");
    for (let n = 1; n <= 14; n++) expect(above).toContain(`sample line ${n} for the approval dialog`);
  });

  it("the 18.1.17 card carries the usage strip as part of the rows it replaced", () => {
    const region = detectApprovalRegion(load("omp--approval-bash.txt"))!;
    expect(region.startLine).toBe(46);
    expect(ompBuildBlocks(load("omp--approval-bash.txt"))[1]!.lines).toHaveLength(7);
  });
});

describe("every tap is a key the footer printed, and Deny never lands on Approve", () => {
  it.each(LIFTED)("%s: Approve walks from the pointer, Deny is Down then Enter, Cancel is Escape", (name) => {
    const model = detectApproval(load(name))!;
    const [approve, deny, cancel] = model.options;
    expect(model.options).toHaveLength(3);
    expect(approve!.label).toBe("Approve");
    expect(deny!.label).toBe("Deny");
    expect(cancel).toEqual({ label: "Cancel", keys: ["Escape"], keyLabel: "Esc" });
    // Down clamps on the last of two rows, so this is Deny from either row.
    expect(deny!.keys).toEqual(["Down", "Enter"]);
    expect(approve!.keys).toEqual(approve!.keyLabel === "❯" ? ["Enter"] : ["Up", "Enter"]);
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
    expect(model.options[1]!.keys).toEqual(["Down", "Enter"]);
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

  it("trailing blank rows below the border do not move the tail", () => {
    expect(detectApproval([...load("omp--v18-4-approval-bash.txt"), ...fromTexts(["", "   ", ""])])).not.toBeNull();
  });
});

describe("the grammar claims nothing else in the corpus", () => {
  it("lifts exactly the eight approval captures, out of every capture in the corpus", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
    expect(all.length).toBeGreaterThan(300);
    const lifted = all.filter((name) => detectApproval(load(name)) !== null);
    expect(lifted.toSorted()).toEqual(LIFTED);
  });
});
