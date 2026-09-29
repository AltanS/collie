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
import { draftCarriesSend } from "../reply-action";

// The opencode adapter's CI gate. Tier 1 chrome (composer strip, status/draft probes, the composer
// gate) plus the Tier-2 permission-dialog lift, gated on the captured corpus:
// web/src/fixtures/panes/oc--*.txt — every capture an opencode 1.18.32 pane in a private Herdr
// session with a scratch config, captured 2026-09-26 (see README.md's opencode section).
//
// The own cohort is the permission-step captures (each must lift a `prompt-select`); the
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
    // The `# Shell command` heading names only the kind of request; the command is the question.
    expect(region!.model.question).toBe("$ echo fixture-corpus-probe");
    expect(region!.model.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
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
    expect(moved?.model.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
    // The body does not change with the pointer on 1.18.32.
    expect(moved?.model.question).toBe("$ echo fixture-corpus-probe");
    // The pointer sits on "Allow always": it confirms with Enter alone; reaching "Allow once"
    // wraps forward two steps (probed) rather than sending Left, which the adapter never sends.
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

  it("wrapped selection: Right past Reject lands back on Allow once", () => {
    const wrapped = detectPermissionDialog(loadLines("oc--permission-bash--wrap.txt"));
    expect(wrapped?.model.options[0]?.keys).toEqual(["Enter"]);
  });

  it("edit dialog: same shape, the subject names the file", () => {
    const edit = detectPermissionDialog(loadLines("oc--permission-edit.txt"));
    // The heading names the subject itself here, so it is the question.
    expect(edit?.model.question).toBe("→ Edit probe.txt");
    expect(edit?.model.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
  });

  it("webfetch dialog: same shape, the heading names the URL", () => {
    const fetch = detectPermissionDialog(loadLines("oc--permission-webfetch.txt"));
    expect(fetch?.model.question).toBe("% WebFetch https://example.com");
    expect(fetch?.model.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
  });

  it("50 columns: the hint row is its own row and the options row sits above it", () => {
    const narrow = detectPermissionDialog(loadLines("oc--narrow--permission-bash.txt"));
    expect(narrow?.model.question).toBe("$ echo narrow-width-probe");
    expect(narrow?.model.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
    expect(hasComposer(loadLines("oc--narrow--permission-bash.txt"))).toBe(false);
  });

  it("the lifted signature is the dialog's own rows, from the title to the footer", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-bash.txt"));
    // The pending tool row sits ABOVE the title, outside the region.
    expect(region?.model.signature.startsWith("  ┃  △ Permission required")).toBe(true);
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
    expect(region?.model.question).toBe("This will allow the following patterns until OpenCode is restarted");
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
    // The sentence wraps over two rows here; the question is the whole paragraph.
    expect(region?.model.question).toBe("This will allow the following patterns until OpenCode is restarted");
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
      "oc--narrow--done.txt",
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
    expect(extractInputDraft(loadLines("oc--draft-wrapped.txt"))).toBe(
      "a reasonably long draft line that the composer has to wrap over several interior rows so " +
        "the fixture pins the fold, with more words after the edge of the box interior and then a " +
        "few more to be sure",
    );
    // Typed while a tool ran: the run paints in the transcript above, the draft stays in the box.
    expect(extractInputDraft(loadLines("oc--draft-while-working.txt"))).toBe(
      "draft typed while the agent was working",
    );
    expect(extractInputDraft(loadLines("oc--narrow--draft-wrapped.txt"))).toBe(
      "draft text at narrow width wrapping over the edge of the box interior to capture the " +
        "composer fold at fifty columns",
    );
  });

  it("a draft with a blank line reads whole, and the strip takes all of it off the mirror", () => {
    // Typed: a line, a blank line, an indented line, `❯ ls -la`, a rule, a last line. Stopping at
    // the blank line read only the last paragraph and left the first on the mirror.
    const sent = "first line of the draft\n\n    indented third line\n❯ ls -la\n────────────\nlast line here";
    const lines = loadLines("oc--draft-multiline.txt");
    expect(hasComposer(lines)).toBe(true);
    const draft = extractInputDraft(lines);
    expect(draft).toBe("first line of the draft indented third line ❯ ls -la ──────────── last line here");
    expect(draftCarriesSend(sent, draft)).toBe(true);
    const mirror = opencodeAdapter.buildBlocks(lines).flatMap((b) => b.lines).map((l) => lineText(l)).join("\n");
    expect(mirror).not.toContain("first line of the draft");
    expect(mirror).not.toContain("last line here");
  });

  it("a panel border over the composer reads as no draft, never a phantom", () => {
    // opencode's Models sidebar paints its └─┘ border over the composer's bar run, and the
    // tail walk above cannot tell overlay chrome from typed text — so the border alone
    // surfaced as a "Draft in terminal" card holding just a line, with Take over copying
    // border junk into the composer. A border-only row is never a draft.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          "  ┃            └───────────────────────────────────┘",
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    expect(locateComposer(lines)).not.toBeNull();
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("a typed message under a panel border reads clean, border excluded", () => {
    // Same overlay, box holding a real message: the walk must end at the border row the
    // way it ends at a bar-less row, so the draft is exactly the typed words. Before the
    // walk-stop the join carried the border ("└───┘ test test") and the reply guard's
    // draftCarriesSend never matched the sent text — the send stalled with the message
    // sitting in the box, which is the "Send does nothing" half of the report.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          "  ┃            └───────────────────────────────────┘",
          "  ┃  test test",
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    expect(locateComposer(lines)).not.toBeNull();
    const draft = extractInputDraft(lines);
    expect(draft).toBe("test test");
    expect(draftCarriesSend("test test", draft)).toBe(true);
  });

  it("an empty composer answers null — the placeholder is content, not a draft", () => {
    expect(extractInputDraft(loadLines("oc--fresh-idle.txt"))).toBeNull();
    expect(extractInputDraft(loadLines("oc--working.txt"))).toBeNull();
    expect(extractInputDraft(loadLines("oc--done--tool-run.txt"))).toBeNull();
  });

  it("extractStatusLines re-surfaces the rows below the rule", () => {
    const status = extractStatusLines(loadLines("oc--fresh-idle.txt")).map((l) => lineText(l).trim());
    // The key-hint row, then the cwd/version row at the pane's foot.
    expect(status[0]).toBe("tab agents  ctrl+p commands");
    expect(status.at(-1)).toMatch(/^\/tmp\/\S+\s+1\.18\.32$/);
    // While a turn runs, the row under the rule carries the interrupt hint and the token count.
    expect(lineText(extractStatusLines(loadLines("oc--working.txt"))[0]!)).toContain("esc interrupt");
  });

  it("the strip keeps the agent's live run and loses only the composer's own rows", () => {
    const lines = loadLines("oc--draft-while-working.txt");
    const raw = opencodeAdapter.buildBlocks(lines).at(-1)!;
    const text = raw.lines.map((l) => lineText(l)).join("\n");
    // The running command, with its spinner, and the turn's footer stay on the mirror.
    expect(text).toContain("sleep 10 && echo done");
    expect(text).toContain("▣  Build · GPT-6 Astra Pro");
    // The composer's own model row is gone; the transcript's turn-footer row ("Build · …") above
    // it is content and stays — hence the distinctive tail of the composer's row.
    expect(text).not.toContain("OpenRouter · medium");
    expect(text).not.toContain("draft typed while the agent was working");
    expect(text).not.toContain("esc interrupt");
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
