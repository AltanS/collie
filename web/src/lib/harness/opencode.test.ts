import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines } from "../blocks";
import { opencodeAdapter } from "./opencode";
import {
  composerPrompt,
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  locateComposer,
  modalOnScreen,
  pickerOverlayUp,
} from "./opencode/chrome";
import { detectPermissionDialog } from "./opencode/dialog";
import { describeAdapterConformance } from "./conformance";
import { promptsSameIdentity } from "./prompt-model";

// The opencode adapter's CI gate. Tier 1 chrome (composer strip, status/draft probes, the composer
// gate) plus the Tier-2 permission-dialog lift, gated on the captured corpus:
// web/src/fixtures/panes/oc--*.txt — every capture a sandbox opencode 2.0.8 pane, driven and
// captured 2026-09-20 over the crew (see README.md's opencode section).
//
// The own cohort is the six+ permission-dialog captures (each must lift a `prompt-select`); the
// neutral cohort is every other opencode capture — composer states, the slash palette, the command
// palette, the narrow-width variants — each of which must stay raw AND must say so about the
// keyboard (composerReady true exactly on the live-composer screens). The foreign cohort is every
// other adapter's capture: cross-adapter fail-closed, the same leg the other adapters take.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

function loadLines(name: string) {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

const allOcFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("oc--") && f.endsWith(".txt"))
  .toSorted();

const otherFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt") && !f.startsWith("oc--"))
  .toSorted();

const ownFixtures = allOcFixtures.filter((f) => f.includes("permission"));

/** The pickers in the corpus: every capture of one with its `Search` placeholder showing. */
const PICKERS = ["oc--agents-picker.txt", "oc--command-palette.txt"];

describeAdapterConformance(opencodeAdapter, {
  ownFixtures,
  foreignFixtures: otherFixtures,
  neutralFixtures: allOcFixtures.filter((f) => !ownFixtures.includes(f)),
});

describe("opencode permission dialog lift", () => {
  it("bash dialog: three options, pointer-derived keys, subject as the question", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-bash.txt"));
    expect(region).not.toBeNull();
    expect(region!.model.family).toBe("permission");
    expect(region!.model.question).toBe("$ echo fixture-corpus-probe");
    expect(region!.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
    // The pointer starts on the first option: Enter alone confirms it, forward offsets ride Right.
    expect(region!.model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Right", "Enter"],
      ["Right", "Right", "Enter"],
    ]);
    // The block replaces [option row … tail]; the title and subject stay on the mirror.
    expect(region!.startLine).toBeGreaterThan(0);
  });

  it("moved selection: the keys follow the pointer the screen currently shows", () => {
    const moved = detectPermissionDialog(loadLines("oc--permission-bash--moved.txt"));
    expect(moved?.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
    // The pointer sits on "Always allow": it confirms with Enter alone; reaching "Allow once"
    // wraps forward two steps (probed) rather than sending Left, which was never probed.
    expect(moved?.model.options.map((o) => o.keys)).toEqual([
      ["Right", "Right", "Enter"],
      ["Enter"],
      ["Right", "Enter"],
    ]);
  });

  it("reject selection: the pointer is derivable there too", () => {
    const rejected = detectPermissionDialog(loadLines("oc--permission-bash--reject.txt"));
    expect(rejected?.model.options.at(-1)?.keys).toEqual(["Enter"]);
  });

  it("edit dialog: same shape, the subject names the file", () => {
    const edit = detectPermissionDialog(loadLines("oc--permission-edit.txt"));
    expect(edit?.model.question).toBe("→ Edit probe.txt");
    expect(edit?.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
  });

  it("narrow width: the hint row is its own row and the options row sits above it", () => {
    const narrow = detectPermissionDialog(loadLines("oc--narrow--permission-bash.txt"));
    expect(narrow?.model.question).toBe("$ echo narrow-width-probe");
    expect(narrow?.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
    expect(hasComposer(loadLines("oc--narrow--permission-bash.txt"))).toBe(false);
  });

  it("the lifted signature is the dialog's own rows, stable across spinner frames", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-bash.txt"));
    // The spinner row sits ABOVE the title, outside the region.
    expect(region?.model.signature).not.toContain("⠙");
    expect(region?.model.signature).toContain("Permission required");
    expect(region?.model.signature).toContain("$ echo fixture-corpus-probe");
    // The signature is byte-faithful and ends at the footer — the bridge binds to it.
    expect(region?.model.signature.endsWith("enter confirm")).toBe(true);
  });

  it("a foreign dialog capture never lifts an opencode dialog", () => {
    // The pointer chip is a relative-style rule; a foreign capture must not satisfy it.
    const codex = detectPermissionDialog(loadLines("codex--trust-prompt.txt"));
    expect(codex).toBeNull();
  });
});

describe("opencode Always allow step", () => {
  // "Allow always" + Enter does not allow yet: opencode replaces the dialog with a second step,
  // `△ Always allow`, with Confirm and Cancel (measured on 1.18.32, 2026-09-26). Same lift, same
  // identity and key rules as the first step: a forward walk from the pointer, then Enter.
  it("lifts Confirm and Cancel, with the keys walking from the pointer", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-always-bash.txt"));
    expect(region?.model.family).toBe("permission");
    expect(region?.model.question).toContain("This will allow the following patterns");
    expect(region?.model.options.map((o) => o.label)).toEqual(["Confirm", "Cancel"]);
    // Pointer on Confirm: Enter alone, so the badge is ⏎ (ADR 0055); Cancel walks one Right.
    expect(region?.model.options.map((o) => o.keys)).toEqual([["Enter"], ["Right", "Enter"]]);
    expect(region?.model.signature.startsWith("  ┃  △ Always allow")).toBe(true);
    expect(region?.model.signature.endsWith("enter confirm")).toBe(true);
  });

  it("a pointer on Cancel moves the ⏎ with it, on two chips where no plurality exists", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-always-bash--cancel.txt"));
    expect(region?.model.options.map((o) => o.keys)).toEqual([["Right", "Enter"], ["Enter"]]);
  });

  it("the edit step has no pattern list, and lifts the same way", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-always-edit.txt"));
    expect(region?.model.question).toBe("This will allow edit until OpenCode is restarted.");
    expect(region?.model.options.map((o) => o.label)).toEqual(["Confirm", "Cancel"]);
  });

  it("lifts at 50 columns, where the hints sit on a row of their own", () => {
    const region = detectPermissionDialog(loadLines("oc--narrow--permission-always-bash.txt"));
    expect(region?.model.options.map((o) => [o.label, o.keys])).toEqual([
      ["Confirm", ["Enter"]],
      ["Cancel", ["Right", "Enter"]],
    ]);
  });

  it("is a different dialog from the first step, so a tap on one never fires on the other", () => {
    const first = detectPermissionDialog(loadLines("oc--permission-bash.txt"))!.model;
    const second = detectPermissionDialog(loadLines("oc--permission-always-bash.txt"))!.model;
    expect(promptsSameIdentity(first, second)).toBe(false);
  });

  it("the composer is not ready on either step", () => {
    expect(hasComposer(loadLines("oc--permission-always-bash.txt"))).toBe(false);
    expect(hasComposer(loadLines("oc--narrow--permission-always-bash.txt"))).toBe(false);
  });
});

describe("opencode unread-dialog declarations", () => {
  it("declares Escape as its way out", () => {
    expect(opencodeAdapter.cancelKey).toBe("Escape");
  });

  it("modalOnScreen sees the dialogs and the pickers", () => {
    for (const name of [...ownFixtures, ...PICKERS]) {
      expect(modalOnScreen(loadLines(name)), name).toBe(true);
    }
  });

  it("modalOnScreen is false on the composer screens and on a plain shell", () => {
    const composerScreens = allOcFixtures.filter((f) => hasComposer(loadLines(f)));
    expect(composerScreens.length).toBeGreaterThan(5);
    for (const name of composerScreens) expect(modalOnScreen(loadLines(name)), name).toBe(false);
    // The shell a moment before an agent's first frame and just after it exits: no card there.
    for (const name of ["claude--v2283-shell-before-first-frame.txt", "claude--v2283-shell-after-exit.txt"]) {
      expect(modalOnScreen(loadLines(name)), name).toBe(false);
    }
  });
});

describe("opencode composer chrome", () => {
  it("composerReady is true on the live composer states", () => {
    for (const name of [
      "oc--fresh-idle.txt",
      "oc--draft-single.txt",
      "oc--draft-wrapped.txt",
      "oc--working.txt",
      "oc--draft-while-working.txt",
      "oc--composer-plan.txt",
      "oc--done--tool-run.txt",
      "oc--narrow--fresh-idle.txt",
      "oc--narrow--draft-wrapped.txt",
      // The slash palette is painted INSIDE the box: the composer still owns the keyboard.
      "oc--slash-palette.txt",
    ]) {
      expect(hasComposer(loadLines(name)), name).toBe(true);
    }
  });

  it("composerReady is false when a modal owns the screen", () => {
    for (const name of ownFixtures) {
      expect(hasComposer(loadLines(name)), name).toBe(false);
    }
  });

  it("extractInputDraft reads the draft, never the run above it", () => {
    expect(extractInputDraft(loadLines("oc--draft-single.txt"))).toBe(
      "hello from the fixture corpus",
    );
    expect(
      extractInputDraft(loadLines("oc--draft-wrapped.txt"))?.startsWith(
        "a reasonably long draft line",
      ),
    ).toBe(true);
    // The decisive case: the tool rows and spinner sit across MORE blanks than the draft's one.
    expect(extractInputDraft(loadLines("oc--draft-while-working.txt"))).toBe(
      "draft typed while the agent was working",
    );
    expect(extractInputDraft(loadLines("oc--narrow--draft-wrapped.txt"))).toBe(
      "draft text at narrow width wrapping over the edge of the box interior to capture the " +
        "composer fold at ninety columns of terminal width, this should wrap twice or more",
    );
  });

  it("an empty composer answers null — the placeholder is content, not a draft", () => {
    expect(extractInputDraft(loadLines("oc--fresh-idle.txt"))).toBeNull();
    expect(extractInputDraft(loadLines("oc--working.txt"))).toBeNull();
  });

  it("extractStatusLines re-surfaces the rows below the rule", () => {
    const status = extractStatusLines(loadLines("oc--fresh-idle.txt"));
    expect(status.length).toBeGreaterThanOrEqual(2); // cwd row + version row
    expect(lineText(status[0]!)).toContain("shift+tab");
  });

  it("the strip keeps the agent's live run and loses only the composer's own rows", () => {
    const lines = loadLines("oc--draft-while-working.txt");
    const raw = opencodeAdapter.buildBlocks(lines).at(-1)!;
    const text = raw.lines.map((l) => lineText(l)).join("\n");
    expect(text).toContain("Press ctrl+b to move running work to the background");
    expect(text).toContain("sleep 8 && echo done");
    // The composer's own model row is gone; the transcript's turn-footer rows ("Build · …") above
    // it are content and stay — hence the distinctive tail of the composer's row.
    expect(text).not.toContain("OpenCode Go · max");
    expect(text).not.toContain("draft typed while the agent was working");
  });

  it("a foreign buffer is returned raw and untouched (same shape, no opencode chrome)", () => {
    const lines = loadLines("codex--fresh-idle.txt");
    const blocks = opencodeAdapter.buildBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    // locateComposer found no rule, so the strip's only change is a trailing blank trim —
    // byte-identical for a buffer that does not end in blank rows.
    expect(blocks[0]!.kind === "raw" && blocks[0]!.lines.length).toBeLessThanOrEqual(lines.length);
  });
});

describe("opencode composer at 50 columns (1.18.32)", () => {
  // opencode 1.18.32 at 50 columns paints a bare bar row between the model row and the rule, and
  // squeezes the model row's dots (`Build ·GPT-6 Astra Pro OpenRouter· medium`). Reading only the
  // row on the rule found no composer on this healthy idle pane, so every reply was refused.
  const NARROW = "oc--narrow--fresh-idle.txt";

  it("finds the composer over the bare bar row, and reads the placeholder as no draft", () => {
    const lines = loadLines(NARROW);
    expect(hasComposer(lines)).toBe(true);
    // The placeholder wraps over two rows here; it is still the placeholder.
    expect(extractInputDraft(lines)).toBeNull();
    const status = extractStatusLines(lines).map((l) => lineText(l).trim());
    expect(status[0]).toBe("tab agents  ctrl+p commands");
    expect(status.at(-1)).toContain("1.18.32");
  });

  it("binds a region from the model row down to the rule, inside the bridge's tail window", () => {
    const lines = loadLines(NARROW);
    const region = composerPrompt(lines)!.split("\n");
    expect(region[0]).toContain("Build ·GPT-6");
    expect(region.at(-1)!.trim()).toMatch(/^╹▀+$/);
    // A fresh session's tip wraps over two rows at this width, so the model row is seventh from
    // the bottom and outside the bridge's 6-row window; the rule is fifth.
    const nonBlank = lines.map((l) => lineText(l).replace(/\s+$/, "")).filter((t) => t.length > 0);
    expect(nonBlank.length - 1 - nonBlank.lastIndexOf(region.at(-1)!)).toBeLessThan(6);
  });

  it("steps over bare bar rows only, and only two of them", () => {
    const lines = loadLines(NARROW);
    const texts = lines.map((l) => lineText(l));
    const rule = texts.findIndex((t) => /^\s*╹▀+\s*$/.test(t));
    const bare = lines[rule - 1]!;
    expect(lineText(bare).trim()).toBe("┃");
    // A third bare bar row: past the bound, not a composer bottom.
    const tooTall = [...lines.slice(0, rule), bare, bare, ...lines.slice(rule)];
    expect(hasComposer(tooTall)).toBe(false);
    // A text row on the rule is never stepped over: it would have to BE the model row.
    const draftOnRule = [...lines.slice(0, rule), ...splitLines(parseAnsi("  ┃  stray text")), ...lines.slice(rule)];
    expect(hasComposer(draftOnRule)).toBe(false);
  });
});

describe("opencode composerPrompt binding", () => {
  it("binds the model row down to the rule — rows the destructive sweep does not move", () => {
    const lines = loadLines("oc--draft-single.txt");
    const region = composerPrompt(lines)!.split("\n");
    expect(region[0]).toContain("Build ·");
    expect(region.at(-1)!.trim()).toMatch(/^╹▀+$/);
    // The status rows below keep the region inside the bridge's tail window.
    const nonBlank = lines.map((l) => lineText(l).replace(/\s+$/, "")).filter((t) => t.length > 0);
    expect(nonBlank.length - 1 - nonBlank.lastIndexOf(region.at(-1)!)).toBeLessThan(6);
  });

  it("no region on the screens composerReady refuses", () => {
    for (const name of ownFixtures) {
      expect(composerPrompt(loadLines(name)), name).toBeNull();
    }
    for (const name of PICKERS) expect(composerPrompt(loadLines(name)), name).toBeNull();
  });
});

describe("opencode pickers", () => {
  // Every opencode picker shares one frame: a title row whose title is followed by `esc`, over a
  // `Search` row in the title's column. It floats over the screen and can leave the composer's tail
  // intact, so the tail alone would say the composer holds the keyboard.
  it("composerReady is false while a picker is up", () => {
    for (const name of PICKERS) {
      expect(pickerOverlayUp(loadLines(name)), name).toBe(true);
      expect(hasComposer(loadLines(name)), name).toBe(false);
    }
  });

  it("the /agents picker leaves the composer tail intact, and still refuses", () => {
    // 1.18.32's `/agents` picker: `Select agent … esc` over `Search`. Before the shape check only
    // the ctrl+p palette's own words were known, and this screen answered true.
    const lines = loadLines("oc--agents-picker.txt");
    expect(locateComposer(lines)).not.toBeNull();
    expect(hasComposer(lines)).toBe(false);
  });

  it("no capture without a picker shows the picker shape, in any agent's corpus", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt") && !PICKERS.includes(f));
    for (const name of all) expect(pickerOverlayUp(loadLines(name)), name).toBe(false);
  });

  // Known gap: a typed filter replaces the `Search` placeholder, so the shape is gone while the
  // picker still holds the keyboard. The reply guard still withholds Enter there (the words never
  // show in the composer). Flip to `it` when the check learns the typed state.
  it.fails("the ctrl+p palette with a typed filter refuses too (known gap)", () => {
    expect(hasComposer(loadLines("oc--command-palette-query.txt"))).toBe(false);
  });
});
