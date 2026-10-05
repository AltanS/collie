import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines, type MultiSelectModel, type StyledLine, type WizardModel } from "../blocks";
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
import { detectQuestionDialog } from "./opencode/question";
import { detectQuestionTabs } from "./opencode/question-tabs";
import { describeAdapterConformance } from "./conformance";
import { promptsEqual, promptsSameIdentity, splitWalk } from "./prompt-model";
import { draftCarriesSend } from "../reply-action";

// The opencode adapter's CI gate. Tier 1 chrome (composer strip, status/draft probes, the composer
// gate) plus the Tier-2 permission-dialog lift, gated on the captured corpus:
// web/src/fixtures/panes/oc--*.txt — every capture an opencode 1.18.32 pane in a private Herdr
// session with a scratch config, captured 2026-09-26 (see README.md's opencode section).
//
// The own cohort is the permission-step captures and the question-dialog captures the grammars read
// (each must lift a dialog block); the neutral cohort is every other opencode capture — composer states, the slash palette, the command
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

// The question captures that MUST lift. The single-select dialog (one question, up to nine options,
// the free-text row closed or open) lifts into a `prompt-select`; the dialogs with a tab bar lift
// into a `multi-select` or a `wizard` (question-tabs.ts). Every other `oc--question--*` capture is
// NEUTRAL on purpose, so conformance pins that it stays raw: `multi--free-text` (the free-text input
// is open, so a digit would be typed as text), `tall14` (a tenth option has no single key), and the
// two screens where the dialog is gone (`answered`, `dismissed`).
const LIFTED_SINGLE = [
  "oc--question--single.txt",
  "oc--question--single--moved.txt",
  "oc--question--single--narrow.txt",
  "oc--question--single--overlay.txt",
  "oc--question--free-text.txt",
  "oc--question--free-text--typed.txt",
  "oc--question--tall8.txt",
  "oc--question--tall9.txt",
];
const LIFTED_TABS = [
  "oc--question--multi.txt",
  "oc--question--multi--toggled.txt",
  "oc--question--multi--narrow.txt",
  "oc--question--multi--free-text--committed.txt",
  "oc--question--multi--confirm.txt",
  "oc--question--multi--confirm--empty.txt",
  "oc--question--two--q1.txt",
  "oc--question--two--q1-answered.txt",
  "oc--question--two--q2.txt",
  "oc--question--two--review.txt",
  "oc--question--three--q2-multi.txt",
  "oc--question--three--q2-multi--toggled.txt",
  "oc--question--three--review.txt",
  "oc--question--three--review--incomplete.txt",
];
const LIFTED_QUESTIONS = [...LIFTED_SINGLE, ...LIFTED_TABS];
// Question captures that stay raw while a dialog is on screen: the card and the composer lock must
// still work there (modalOnScreen true, composerReady false).
const REFUSED_QUESTION_DIALOGS = ["oc--question--multi--free-text.txt", "oc--question--tall14.txt"];
// The dialog is gone: the composer is back, the answer or the dismissal is in the transcript.
const QUESTION_GONE = ["oc--question--answered.txt", "oc--question--dismissed.txt"];

const ownFixtures = allOcFixtures.filter((f) => f.includes("permission") || LIFTED_QUESTIONS.includes(f));

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

  it("the pointer is a style, so the text is identical and only the plans tell two pointers apart", () => {
    const here = detectPermissionDialog(loadLines("oc--permission-bash.txt"))!.model;
    const moved = detectPermissionDialog(loadLines("oc--permission-bash--moved.txt"))!.model;
    // The signature (also the bridge's text binding) cannot see the pointer.
    expect(moved.signature).toBe(here.signature);
    expect(moved.coreSignature).toBe(here.coreSignature);
    // Every plan is walk-class (Right arrows, then Enter), so the identity ignores the counts ...
    for (const o of [...here.options, ...moved.options]) expect(splitWalk(o.keys)).not.toBeNull();
    expect(promptsSameIdentity(here, moved)).toBe(true);
    // ... and `promptsEqual` is what refuses a stale tap: it compares the exact plans.
    expect(promptsEqual(here, moved)).toBe(false);
    expect(promptsEqual(here, detectPermissionDialog(loadLines("oc--permission-bash.txt"))!.model)).toBe(true);
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
    for (const name of [...ownFixtures, ...REFUSED_QUESTION_DIALOGS, ...PICKERS]) {
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

  // THESE TWO CASES ARE HAND-TYPED, against `HARNESS_CONTRIBUTING.md`'s fixtures-first rule, and that
  // is a known debt rather than an oversight. The overlay could not be captured here: opencode
  // 1.18.32's Models sidebar draws its panel with a BACKGROUND and no box glyphs at all (checked
  // 2026-09-30 on a live pane at 226 and at 112 columns, with `/models` open), so the `└───┘` in the
  // report comes from a panel this build does not paint. The fixture is owed by the reporter, who has
  // the screen. What IS captured is the regression these rows risk: `oc--draft-tree-glyphs.txt`.
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

  it("the #337 capture: sidebar glyphs stay out of the draft, the typed words stay in", () => {
    // The reporter's real screen (oc--draft-sidebar-overlay.txt, opencode 1.18.31, Models sidebar open):
    // the panel's right edge and bottom border share rows with the composer.
    const lines = loadLines("oc--draft-sidebar-overlay.txt");
    expect(locateComposer(lines)).not.toBeNull();
    const draft = extractInputDraft(lines);
    expect(draft).not.toBeNull();
    expect(draft).not.toMatch(/[│└┘┌┐─]/);
    expect(draft).toBe("stell mir eine Frage mit dem Frage tool");
    expect(draftCarriesSend("stell mir eine Frage mit dem Frage tool", draft)).toBe(true);
  });

  it("a sidebar edge row and a shared-row border read as the typed words alone", () => {
    // Live shape from a Models-sidebar pane: an edge-only row above the message, and the
    // message sharing its row with the panel's bottom border. Both leaked into the join
    // and the reply guard never verified the send.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          "  ┃                                                                                                                                │                                   │",
          "  ┃  stell mir eine Frage mit dem Frage tool                                                                                       └───────────────────────────────────┘",
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen                                                                     ~/repos/omarchy",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    expect(locateComposer(lines)).not.toBeNull();
    const draft = extractInputDraft(lines);
    expect(draft).toBe("stell mir eine Frage mit dem Frage tool");
    expect(draftCarriesSend("stell mir eine Frage mit dem Frage tool", draft)).toBe(true);
  });
  it("a sidebar row over an empty composer reads as no draft, never a phantom", () => {
    // Spliced, not hand-typed: the fixture owns the composer shape, the overlay row is the
    // only foreign part. The tail walk climbs it (a bar row with words, never a panel
    // border), so without the parts-loop skip it joins into a phantom draft.
    const lines = loadLines("oc--fresh-idle.txt");
    const tail = locateComposer(lines);
    expect(tail).not.toBeNull();
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(120)}│ oracle muse-spark-1.3-contributor │\n`))[0]!;
    const spliced = [...lines.slice(0, tail!.draftStart), overlay, ...lines.slice(tail!.draftStart)];
    expect(locateComposer(spliced)).not.toBeNull();
    expect(extractInputDraft(spliced)).toBeNull();
  });
  it("a sidebar row over a typed draft reads the typed words alone", () => {
    // Same splice on a box holding a real message: the overlay row must not join the
    // draft, or the reply guard's draftCarriesSend never matches the sent text.
    const lines = loadLines("oc--draft-single.txt");
    const tail = locateComposer(lines);
    expect(tail).not.toBeNull();
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(120)}│ oracle muse-spark-1.3-contributor │\n`))[0]!;
    const spliced = [...lines.slice(0, tail!.draftStart), overlay, ...lines.slice(tail!.draftStart)];
    expect(locateComposer(spliced)).not.toBeNull();
    const draft = extractInputDraft(spliced);
    expect(draft).toBe("hello from the fixture corpus");
    expect(draftCarriesSend("hello from the fixture corpus", draft)).toBe(true);
  });
  it("a deeply-indented typed line without panel glyphs stays in the draft", () => {
    // The conjoin half of the parts-loop skip: the width gate alone fires here (30 cells
    // past the bar), but with no panel box glyphs aboard the row is typed code, not
    // sidebar chrome. A width-only skip would eat it.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          `  ┃${" ".repeat(30)}return foo()`,
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    expect(locateComposer(lines)).not.toBeNull();
    const draft = extractInputDraft(lines);
    expect(draft).toBe("return foo()");
    expect(draftCarriesSend("return foo()", draft)).toBe(true);
  });
  it("a typed table row at the gutter keeps its dividers", () => {
    // The other half of the conjoin: panel glyphs aboard, but at the gutter (indent 2),
    // so the width gate never fires and the row reads as typed text. Stripping it would
    // break the reply guard's contiguity check — the edge stays, fails safe.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          "  ┃  │ a │ b │",
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    expect(locateComposer(lines)).not.toBeNull();
    const draft = extractInputDraft(lines);
    expect(draft).toBe("│ a │ b │");
    expect(draftCarriesSend("│ a │ b │", draft)).toBe(true);
  });
  it("a palette-box blank row of bars reads as blank, never a one-glyph draft", () => {
    // Live shape (w1:pD slash palette): a box paints `┃` + pad + `┃` blank rows over the
    // composer run. Without this rule the lone `┃` joins the draft ("┃ /models/models")
    // and the reply guard can never verify the real message. Blank rows only: a row WITH
    // words keeps everything, including a trailing `┃` (tables).
    const lines = loadLines("oc--fresh-idle.txt");
    const tail = locateComposer(lines);
    expect(tail).not.toBeNull();
    const blank = splitLines(parseAnsi(`  ┃${" ".repeat(100)}┃\n`))[0]!;
    const spliced = [...lines.slice(0, tail!.draftStart), blank, ...lines.slice(tail!.draftStart)];
    expect(locateComposer(spliced)).not.toBeNull();
    expect(extractInputDraft(spliced)).toBeNull();
  });
  it("a palette-box blank row above a typed draft leaves the words alone", () => {
    const lines = loadLines("oc--draft-single.txt");
    const tail = locateComposer(lines);
    expect(tail).not.toBeNull();
    const blank = splitLines(parseAnsi(`  ┃${" ".repeat(100)}┃\n`))[0]!;
    const spliced = [...lines.slice(0, tail!.draftStart), blank, ...lines.slice(tail!.draftStart)];
    expect(locateComposer(spliced)).not.toBeNull();
    const draft = extractInputDraft(spliced);
    expect(draft).toBe("hello from the fixture corpus");
    expect(draftCarriesSend("hello from the fixture corpus", draft)).toBe(true);
  });
  it("a pasted tree sharing a row with an overlay border keeps its words", () => {
    // Suffix strip, opposite risk: the overlay corner run goes, the pasted words stay.
    // A lone trailing `│` after words is deliberately NOT stripped — textually identical
    // to a table cell divider, only geometry could tell them apart (needs a column-aware
    // strip, out of scope) — so such a row keeps its edge and fails safe.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          "  ┃  ├── src",
          "  ┃  └── leaf   └─┘",
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen                                                                     ~/repos/omarchy",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    const draft = extractInputDraft(lines);
    expect(draft).toBe("├── src └── leaf");
    expect(draftCarriesSend("├── src └── leaf", draft)).toBe(true);
  });

  it("a typed row ending in a plain rule keeps the rule", () => {
    // The suffix strip demands a corner, junction, vertical or rule-block inside the run:
    // bare horizontals never strip, so a typed emphasis divider survives verbatim.
    const lines = splitLines(
      parseAnsi(
        [
          "some transcript above",
          "  ┃  summary ───",
          "  ┃",
          "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen                                                                     ~/repos/omarchy",
          "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
          "   /tmp/probe   1.18.32",
        ].join("\n"),
      ),
    );
    const draft = extractInputDraft(lines);
    expect(draft).toBe("summary ───");
    expect(draftCarriesSend("summary ───", draft)).toBe(true);
  });
  it("a pasted box row closing its own corner one space after its words stays whole", () => {
    for (const row of ["╭─ title ─╮", "┌ Name ┐"]) {
      const lines = splitLines(
        parseAnsi(
          [
            "some transcript above",
            `  ┃  ${row}`,
            "  ┃",
            "  ┃  Sisyphus - Ultraworker · Muse Spark 1.3 Free OpenCode Zen                                                                     ~/repos/omarchy",
            "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
            "   /tmp/probe   1.18.32",
          ].join("\n"),
        ),
      );
      const draft = extractInputDraft(lines);
      expect(draft).toBe(row);
      expect(draftCarriesSend(row, draft)).toBe(true);
    }
  });

  // THE REGRESSION THE FIRST SHAPE OF THAT RULE CAUSED, on a real capture rather than a hand-typed
  // string. A junction ANYWHERE on a row read as a panel border, so a pasted `tree` stopped the walk
  // at its first branch: these four typed lines read back as "and that is all" alone, and "Take over"
  // would have copied a quarter of the message while the reply guard failed to verify the send. A
  // border is never words; a tree is words.
  it("a pasted tree inside a draft reads whole — a junction alone is not a border", () => {
    const lines = loadLines("oc--draft-tree-glyphs.txt");
    expect(extractInputDraft(lines)).toBe("here is the tree ├── src └── web and that is all");
  });

  // The other half of the same rule, from the corpus: a row that is nothing but a typed RULE has no
  // junction, so the walk reads through it and the draft above it survives. This is why the anchor
  // cannot simply be "chrome and no words".
  it("a typed rule inside a draft is still not a border", () => {
    expect(extractInputDraft(loadLines("oc--draft-multiline.txt"))).toBe(
      "first line of the draft indented third line ❯ ls -la ──────────── last line here",
    );
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

/** `lines` with every cell of row `index` painted on background `bg`. */
function repaint(lines: StyledLine[], index: number, bg: string | undefined): StyledLine[] {
  const out = lines.slice();
  out[index] = { segments: out[index]!.segments.map((s) => Object.assign({}, s, { bg })) };
  return out;
}

describe("opencode question dialog lift", () => {
  // The `question` tool's dialog (opencode 1.18.33, issue 329). Ground truth: QUESTION_NOTES.md and
  // the `oc--question--*` captures. One question, single select, up to nine options lifts here; the
  // dialogs with a tab bar lift in the next describe, and what neither reads stays raw and is covered
  // by the unread-dialog card (ADR 0053).
  const lift = (name: string) => detectQuestionDialog(loadLines(`oc--question--${name}.txt`));

  it("single: three options, each one's own digit alone, the free-text row is not an option", () => {
    const region = lift("single");
    expect(region).not.toBeNull();
    const { model } = region!;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Which colour?");
    expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
    expect(model.options.map((o) => o.description)).toEqual(["warm", "calm", "cool"]);
    // A digit submits at once and ignores the pointer, and the screen printed it (ADR 0009).
    expect(model.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    // The free-text row is modelled, closed, and Collie never types into it.
    expect(model.feedback).toEqual({ key: "4", focused: false, text: "", purpose: "free-text" });
    // The pointer chip sits on option 1 here. Read, never sent.
    expect(region!.pointed).toBe(1);
  });

  it("the block replaces the question down to the footer; the mirror keeps what is above it", () => {
    const lines = loadLines("oc--question--single.txt");
    const blocks = opencodeAdapter.buildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    const raw = blocks[0]!.lines.map((l) => lineText(l).trimEnd());
    // The pending tool row stays on the mirror, and no bare bar row hangs at its end.
    expect(raw.some((t) => t.includes("→ Asked 1 question"))).toBe(true);
    expect(raw.at(-1)).not.toMatch(/^\s*┃$/);
    const lifted = blocks[1]!.lines.map((l) => lineText(l).trimEnd());
    expect(lifted[0]).toContain("Which colour?");
    expect(lifted.some((t) => t.includes("esc dismiss"))).toBe(true);
  });

  it("the signature is the dialog's own rows from the question to the footer", () => {
    const sig = lift("single")!.model.signature;
    expect(sig.startsWith("  ┃  Which colour?")).toBe(true);
    expect(sig.endsWith("enter submit  esc dismiss")).toBe(true);
    expect(sig).toContain("4. Type your own answer");
  });

  it("moved: the pointer is on option 2, and the keys do not move with it", () => {
    const single = lift("single")!;
    const moved = lift("single--moved")!;
    expect(moved.pointed).toBe(2);
    expect(moved.model.options.map((o) => o.keys)).toEqual(single.model.options.map((o) => o.keys));
    // The chip is a STYLE: the text rows are the same, so is the identity. A digit does not read the
    // pointer, so a pointer that moved between the render and the tap changes nothing.
    expect(moved.model.signature).toBe(single.model.signature);
    expect(promptsSameIdentity(single.model, moved.model)).toBe(true);
  });

  it("narrow (50 columns): the same options, the same keys", () => {
    const wide = lift("single")!;
    const narrow = lift("single--narrow")!;
    expect(narrow.model.options).toEqual(wide.model.options);
    expect(narrow.model.question).toBe("Which colour?");
    expect(narrow.pointed).toBe(1);
  });

  it("free-text, opened: the field has the keyboard, so every button locks", () => {
    const open = lift("free-text")!;
    expect(open.pointed).toBe(4);
    expect(open.model.feedback).toEqual({ key: "4", focused: true, text: "", purpose: "free-text" });
    // The options are the same three. The renderer locks them on `feedback.focused`.
    expect(open.model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
  });

  it("free-text, typed: the row holds what was typed", () => {
    const typed = lift("free-text--typed")!;
    expect(typed.model.feedback).toEqual({ key: "4", focused: true, text: "hello", purpose: "free-text" });
    const open = lift("free-text")!;
    // Typing is a change the guard sees: the visible text and the feedback text both differ...
    expect(typed.model.signature).not.toBe(open.model.signature);
    // ...while the identity the free-text flow compares mid-flight does not move.
    expect(typed.model.coreSignature).toBe(open.model.coreSignature);
  });

  it("tall8 and tall9 lift every option with its own digit; the free-text row takes the next number", () => {
    const tall8 = lift("tall8")!;
    expect(tall8.model.options.map((o) => o.keys)).toEqual(
      Array.from({ length: 8 }, (_, i) => [String(i + 1)]),
    );
    const tall9 = lift("tall9")!;
    expect(tall9.model.options).toHaveLength(9);
    expect(tall9.model.options.map((o) => o.keys)).toEqual(
      Array.from({ length: 9 }, (_, i) => [String(i + 1)]),
    );
    // A two-digit row: the free-text key is the number the screen printed.
    expect(tall9.model.feedback?.key).toBe("10");
    // The pointer starts off option 1 on a nine-option list (QUESTION_NOTES.md); nothing assumes it.
    expect(tall9.pointed).toBe(2);
    expect(tall9.model.options.map((o) => o.keys)).toEqual(
      Array.from({ length: 9 }, (_, i) => [String(i + 1)]),
    );
  });

  it("the pointer is read from the chip, whichever row it sits on", () => {
    // The captures start the pointer on 1, 2 and 4; read each one off the screen.
    expect(lift("single")!.pointed).toBe(1);
    expect(lift("single--moved")!.pointed).toBe(2);
    expect(lift("free-text")!.pointed).toBe(4);
  });

  it("refuses what it cannot answer, and says nothing about it", () => {
    // More than nine options: a tenth has no single key.
    expect(lift("tall14")).toBeNull();
    // A tab bar is another grammar's (question-tabs.ts): a multi select, several questions, the
    // Confirm tab. The single lift never claims one, on any tab or width.
    for (const name of LIFTED_TABS) {
      expect(lift(name.slice("oc--question--".length, -".txt".length)), name).toBeNull();
    }
    // The dialog is gone.
    for (const name of ["answered", "dismissed"]) expect(lift(name), name).toBeNull();
  });

  it("refuses without a pointer chip, or with two", () => {
    const lines = loadLines("oc--question--single.txt");
    const base = lines.map((l) => lineText(l)).findIndex((t) => t.includes("1. Red"));
    // The footer's own background is the reference. Paint the pointed row on it: no chip left.
    const footer = lines.findLast((l) => lineText(l).includes("esc dismiss"))!;
    const footerBg = footer.segments.find((s) => s.text.includes("esc"))!.bg;
    const none = repaint(lines, base, footerBg);
    expect(detectQuestionDialog(none)).toBeNull();
    // The unedited screen lifts, so the refusal above is the missing chip and nothing else.
    expect(detectQuestionDialog(lines)).not.toBeNull();
    // A second chip: paint option 2's row like the pointed one.
    const two = lines.findIndex((l) => lineText(l).includes("2. Green"));
    const pointedBg = lines[base]!.segments.find((s) => s.text.includes("1."))!.bg;
    const both = repaint(lines, two, pointedBg);
    expect(detectQuestionDialog(both)).toBeNull();
  });

  it("an overlay row above the first option does not kill the walk", () => {
    // Live shape: a sidebar model row sits between the question paragraph and option 1.
    // The paragraph walk skips it; the question still reads whole.
    const lines = loadLines("oc--question--single.txt");
    const at = lines.findIndex((l) => lineText(l).includes("1. Red"));
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(120)}│ oracle muse-spark-1.3-contributor │\n`))[0]!;
    const lifted = detectQuestionDialog([...lines.slice(0, at), overlay, ...lines.slice(at)]);
    expect(lifted).not.toBeNull();
    expect(lifted!.model.question).toBe("Which colour?");
    expect(lifted!.model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
  });

  it("an overlay row as the only padding above the question still lifts", () => {
    // Same rule one level up: when the sidebar paints over the padding row itself, the
    // overlay counts as the separator and the dialog above it must still be transcript.
    const lines = loadLines("oc--question--single.txt");
    const at = lines.findIndex((l) => lineText(l).includes("Which colour?"));
    expect(at).toBeGreaterThan(1);
    expect(lineText(lines[at - 1]!).trim()).toBe("┃");
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(120)}│ oracle muse-spark-1.3-contributor │\n`))[0]!;
    const lifted = detectQuestionDialog([...lines.slice(0, at - 1), overlay, ...lines.slice(at)]);
    expect(lifted).not.toBeNull();
    expect(lifted!.model.question).toBe("Which colour?");
  });

  it("an overlay row under the free-text row does not fake an open input", () => {
    // Live shape: a panel overlay paints a right-aligned path row where the closed dialog
    // specifies a bare bar row. The chip is on option 1, so the row is foreign chrome, not
    // input: the dialog lifts with the free-text row closed and empty. The signature stays
    // screen-faithful (the bridge binds byte-exact), so it still carries the overlay row.
    const lines = loadLines("oc--question--single.txt");
    const at = lines.findIndex((l) => lineText(l).includes("4. Type your own answer"));
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(140)}~/repos/omarchy:master\n`))[0]!;
    const lifted = detectQuestionDialog([...lines.slice(0, at + 1), overlay, ...lines.slice(at + 1)]);
    expect(lifted).not.toBeNull();
    expect(lifted!.model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
    expect(lifted!.model.feedback).toEqual({ key: "4", focused: false, text: "", purpose: "free-text" });
    expect(lifted!.pointed).toBe(1);
  });

  it("an overlay-shaped row with the chip on the free-text row reads closed", () => {
    // A far-right row is provably not input, so even with the chip on the free-text row the
    // dialog offers its buttons instead of locking: locking was the fail-safe approximation.
    const lines = loadLines("oc--question--single.txt");
    const one = lines.map((l) => lineText(l)).findIndex((t) => t.includes("1. Red"));
    const four = lines.map((l) => lineText(l)).findIndex((t) => t.includes("4. Type your own answer"));
    const footer = lines.findLast((l) => lineText(l).includes("esc dismiss"))!;
    const footerBg = footer.segments.find((s) => s.text.includes("esc"))!.bg;
    const pointedBg = lines[one]!.segments.find((s) => s.text.includes("1."))!.bg;
    const moved = repaint(repaint(lines, one, footerBg), four, pointedBg);
    const at = moved.findIndex((l) => lineText(l).includes("4. Type your own answer"));
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(140)}~/repos/omarchy:master\n`))[0]!;
    const lifted = detectQuestionDialog([...moved.slice(0, at + 1), overlay, ...moved.slice(at + 1)]);
    expect(lifted).not.toBeNull();
    expect(lifted!.pointed).toBe(4);
    expect(lifted!.model.feedback).toEqual({ key: "4", focused: false, text: "", purpose: "free-text" });
  });

  it("an overlay row inside the options keeps the lift, description polluted", () => {
    // Documents current behavior: an overlay row absorbed as an option's description does not
    // refuse the lift (descriptions are display-only). A column-aware strip would clean it;
    // until then the polluted text rides along, fail-safe.
    const lines = loadLines("oc--question--single.txt");
    const at = lines.findIndex((l) => lineText(l).includes("2. Green"));
    const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(140)}~/repos/omarchy:master\n`))[0]!;
    const lifted = detectQuestionDialog([...lines.slice(0, at + 1), overlay, ...lines.slice(at + 1)]);
    expect(lifted).not.toBeNull();
    expect(lifted!.model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
  });

  it("refuses when ordinary output follows the footer (a dialog that scrolled up)", () => {
    const lines = loadLines("oc--question--single.txt");
    const tail = (text: string) => splitLines(parseAnsi(text));
    expect(detectQuestionDialog([...lines, ...tail("a\nb\nc\n")])).toBeNull();
  });

  it("the permission lift and the question lift never claim each other's screens", () => {
    for (const name of allOcFixtures) {
      const lines = loadLines(name);
      const permission = detectPermissionDialog(lines);
      const question = detectQuestionDialog(lines);
      const tabs = detectQuestionTabs(lines);
      const claims = [permission, question, tabs].filter((r) => r !== null);
      expect(claims.length, name).toBeLessThanOrEqual(1);
      if (name.startsWith("oc--question--")) expect(permission, name).toBeNull();
      if (name.includes("permission")) expect([question, tabs], name).toEqual([null, null]);
    }
  });

  it("a foreign capture never lifts a question dialog", () => {
    for (const name of otherFixtures) {
      expect(detectQuestionDialog(loadLines(name)), name).toBeNull();
      expect(detectQuestionTabs(loadLines(name)), name).toBeNull();
    }
  });
  it("a real sidebar-overlaid dialog lifts whole: shared rows read clean, byte-exact kept", () => {
    // Live capture (w1:p8, opencode 1.18.31, Models panel open): every dialog row shares
    // its row with sidebar chrome, truncating dialog text mid-word ("schl", "unveränd"),
    // the path row sits at indent ~58, and no bare padding row exists. The model keeps
    // the truncated-but-clean text; the signature keeps the overlay rows byte-exact
    // (the bridge binds against the still-open sidebar).
    const lines = loadLines("oc--question--single--overlay.txt");
    const lifted = detectQuestionDialog(lines);
    expect(lifted).not.toBeNull();
    expect(lifted!.model.question).toBe("Soll ich den bear-blog-Tab (w1:tD) auflassen oder schl");
    expect(lifted!.model.options.map((o) => o.label)).toEqual(["So lassen", "Bear-Tab schließen"]);
    expect(lifted!.model.options.map((o) => o.description)).toEqual([
      "Alles bleibt wie es ist, Tabs und Sessions unveränd",
      "Bear-Blog-Tab schließen, war nur temporär",
    ]);
    expect(lifted!.model.feedback).toEqual({ key: "3", focused: false, text: "", purpose: "free-text" });
    expect(lifted!.pointed).toBe(1);
    expect(lifted!.model.signature).toContain("│ Models");
  });
});

describe("opencode tab-bar question dialogs lift", () => {
  // The `question` tool's dialogs with a tab bar (opencode 1.18.33 and 1.18.34, issue 329): a lone
  // multi select and its Confirm tab, and a call with several questions, its steps and its Confirm
  // tab. Every key plan below was measured one key at a time (QUESTION_NOTES.md), and the captures
  // pin the screens.
  const tabs = (name: string) => detectQuestionTabs(loadLines(`oc--question--${name}.txt`));
  const multi = (name: string): MultiSelectModel => {
    const region = tabs(name);
    if (region?.kind !== "multi-select") throw new Error(`${name} lifts no multi-select block`);
    return region.model;
  };
  const wizard = (name: string): WizardModel => {
    const region = tabs(name);
    if (region?.kind !== "wizard") throw new Error(`${name} lifts no wizard block`);
    return region.model;
  };
  /** A checkbox phase, narrowed. */
  const checkbox = (name: string) => {
    const model = multi(name);
    if (model.phase !== "checkbox") throw new Error(`${name} is not a checkbox`);
    return model;
  };
  /** A multi-select review, narrowed. */
  const multiReview = (name: string) => {
    const model = multi(name);
    if (model.phase !== "review") throw new Error(`${name} is not a review`);
    return model;
  };
  const question = (name: string) => {
    const model = wizard(name);
    if (model.phase !== "question") throw new Error(`${name} is not a question step`);
    return model;
  };
  const wizardReview = (name: string) => {
    const model = wizard(name);
    if (model.phase !== "review") throw new Error(`${name} is not a review`);
    return model;
  };
  const chips = (steps: { label: string; answered: boolean; current: boolean }[]) =>
    steps.map((s) => `${s.label}:${s.answered ? "answered" : "open"}${s.current ? ":current" : ""}`);

  describe("a lone multi select", () => {
    it("lifts into a checkbox phase: a digit toggles, Tab advances to Confirm, there is no escape row", () => {
      const model = checkbox("multi");
      expect(model.question).toBe("Which colours? (select all that apply)");
      expect(model.options.map((o) => [o.n, o.label, o.description, o.checked])).toEqual([
        [1, "Red", "warm", false],
        [2, "Green", "calm", false],
        [3, "Blue", "cool", false],
        [4, "Yellow", "bright", false],
      ]);
      expect(model.toggle).toBe("digit");
      expect(model.advanceKeys).toEqual(["Tab"]);
      // The next tab's own word, and no stepper: one question has nowhere to navigate.
      expect(model.advanceLabel).toBe("Confirm");
      expect(model.steps).toBeNull();
      expect(model.escape).toBeNull();
      // The chip sits on option 1; the free-text row (5) is not an option.
      expect(model.pointer).toBe("option");
      expect(model.pointerRow).toBe(1);
    });

    it("toggled: the box is read from the glyph, and the signature does not move with it", () => {
      const plain = checkbox("multi");
      const toggled = checkbox("multi--toggled");
      expect(toggled.options.map((o) => o.checked)).toEqual([true, false, false, false]);
      expect(toggled.signature).toBe(plain.signature);
      // The literal region is what the bridge binds, so it does carry the box.
      expect(toggled.regionSignature).not.toBe(plain.regionSignature);
      expect(toggled.regionSignature).toContain("1. [✓] Red");
      expect(plain.signature).toContain("1. [ ] Red");
      expect(toggled.signature).not.toContain("[✓]");
    });

    it("narrow (50 columns): the question wraps and the footer gaps shrink, the options are the same", () => {
      const model = checkbox("multi--narrow");
      expect(model.question).toBe(
        "Which of these many different colours would you like to see used in the new design, if several are allowed? (select all that apply)",
      );
      expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Yellow"]);
      expect(model.options[0]!.description).toBe("a very warm colour that is bright");
      expect(model.advanceKeys).toEqual(["Tab"]);
    });

    it("committed free text lifts, and the free-text row is still not an option", () => {
      const model = checkbox("multi--free-text--committed");
      expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Black"]);
      // The chip is on the free-text row (`5.`): "other", with no option's `n` to report.
      expect(model.pointer).toBe("other");
      expect(model.pointerRow).toBeNull();
      expect(model.regionSignature).toContain("5. [✓] Type your own answer");
    });

    it("an OPEN free-text input stays raw: the placeholder, or typed text in the bright ink", () => {
      // The placeholder row (`Type your own answer` under the row) is the capture.
      expect(tabs("multi--free-text")).toBeNull();
      // Typed text that is not committed is bright; the committed capture's row is grey. Paint the
      // committed text in the footer's bright ink and the same screen refuses.
      const lines = loadLines("oc--question--multi--free-text--committed.txt");
      expect(detectQuestionTabs(lines)).not.toBeNull();
      const row = lines.findIndex((l) => lineText(l).trim() === "┃     mine");
      expect(row).toBeGreaterThan(0);
      const footer = lines.findLast((l) => lineText(l).includes("esc dismiss"))!;
      const bright = footer.segments.find((s) => s.text.startsWith("esc"))!.fg;
      const typed = lines.slice();
      typed[row] = { segments: typed[row]!.segments.map((s) => (s.text === "mine" ? Object.assign({}, s, { fg: bright }) : s)) };
      expect(detectQuestionTabs(typed)).toBeNull();
      // An ink that is neither the footer's bright nor its grey refuses too.
      const odd = lines.slice();
      odd[row] = { segments: odd[row]!.segments.map((s) => (s.text === "mine" ? Object.assign({}, s, { fg: "rgb(1,2,3)" }) : s)) };
      expect(detectQuestionTabs(odd)).toBeNull();
    });

    it("an overlay row under the free-text row lifts with it, not raw", () => {
      // The shared walk skips far-right rows, so the tabbed flow sees a closed free-text row
      // and lifts: the remaining #347 follow-up covers only near-gutter rows no geometry
      // can tell apart.
      const lines = loadLines("oc--question--multi.txt");
      const at = lines.findIndex((l) => lineText(l).includes("5. [ ] Type your own answer"));
      expect(at).toBeGreaterThan(0);
      const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(140)}~/repos/omarchy:master\n`))[0]!;
      const region = detectQuestionTabs([...lines.slice(0, at + 1), overlay, ...lines.slice(at + 1)]);
      if (region?.kind !== "multi-select" || region.model.phase !== "checkbox") {
        throw new Error("overlay multi did not lift as checkbox");
      }
      // The unedited screen lifts identically, so the overlay row changes nothing.
      const plain = detectQuestionTabs(lines);
      if (plain?.kind !== "multi-select" || plain.model.phase !== "checkbox") {
        throw new Error("plain multi fixture did not lift as checkbox");
      }
      expect(region.model.question).toBe(plain.model.question);
    });

    it("an overlay row above the first option does not kill the head walk", () => {
      // Same shape on the tabbed path: the head walk skips the sidebar row and the tabs lift.
      const lines = loadLines("oc--question--multi.txt");
      const at = lines.findIndex((l) => lineText(l).includes("1. [ ] Red"));
      expect(at).toBeGreaterThan(0);
      const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(120)}│ oracle muse-spark-1.3-contributor │\n`))[0]!;
      const region = detectQuestionTabs([...lines.slice(0, at), overlay, ...lines.slice(at)]);
      expect(region).not.toBeNull();
      expect(region!.kind).toBe("multi-select");
    });

    it("an overlay row as the only padding above the tab row still lifts", () => {
      // Live shape (bear-blog pane): the sidebar paints over the very row separating the tab
      // row from the transcript, so no bare padding row exists. Overlay counts as padding —
      // it is panel chrome, neither transcript nor another dialog.
      const lines = loadLines("oc--question--multi.txt");
      const tab = lines.findIndex((l) => lineText(l).includes("Confirm"));
      expect(tab).toBeGreaterThan(0);
      expect(lineText(lines[tab - 1]!).trim()).toBe("┃");
      const overlay = splitLines(parseAnsi(`  ┃${" ".repeat(120)}│ oracle muse-spark-1.3-contributor │\n`))[0]!;
      const region = detectQuestionTabs([...lines.slice(0, tab - 1), overlay, ...lines.slice(tab)]);
      expect(region).not.toBeNull();
      expect(region!.kind).toBe("multi-select");
    });
  });

  describe("a lone multi select's Confirm tab", () => {
    it("lifts into a review: Enter submits, Escape dismisses the whole dialog, Left goes back", () => {
      const review = multiReview("multi--confirm");
      expect(review.submit).toBe("keys");
      if (review.submit !== "keys") return;
      expect(review.submitKeys).toEqual(["Enter"]);
      expect(review.cancelKeys).toEqual(["Escape"]);
      // The footer's own word: Escape ends the turn, so "Cancel" would promise less than the key does.
      expect(review.cancelLabel).toBe("Dismiss");
      expect(review.backKeys).toEqual(["Left"]);
      // A back key is one Left and no Enter, so it is not a pointer walk and is sent as it is.
      expect(splitWalk(review.backKeys ?? [])).toBeNull();
      expect(review.answers).toEqual([{ question: "Colour", answer: "Red" }]);
      expect(review.incomplete).toBe(false);
      expect(review.pointer).toBeNull();
    });

    it("nothing toggled reads `(not answered)` and is incomplete", () => {
      const review = multiReview("multi--confirm--empty");
      expect(review.answers).toEqual([{ question: "Colour", answer: "(not answered)" }]);
      expect(review.incomplete).toBe(true);
    });
  });

  describe("a many-question call", () => {
    it("a single-select step lifts into a wizard question: a digit selects AND advances", () => {
      const step = question("two--q1");
      expect(step.question).toBe("Which colour?");
      expect(chips(step.steps)).toEqual(["Colour:open:current", "Size:open"]);
      expect(step.options.map((o) => [o.label, o.description, o.keys, o.chosen, o.escape])).toEqual([
        ["Red", "warm", ["1"], false, false],
        ["Green", "calm", ["2"], false, false],
        ["Blue", "cool", ["3"], false, false],
      ]);
    });

    it("an answered option reads ` ✓`, which is stripped from the label; the chip stays current", () => {
      const step = question("two--q1-answered");
      expect(step.options.map((o) => [o.label, o.chosen])).toEqual([
        ["Red", true],
        ["Green", false],
        ["Blue", false],
      ]);
      // The active chip's own colours are inverted, so its answer comes from the body; `Size` is
      // painted in the bright ink in the capture.
      expect(chips(step.steps)).toEqual(["Colour:answered:current", "Size:answered"]);
      // The text differs from the untouched step (the ✓), so the signature does.
      expect(step.signature).not.toBe(question("two--q1").signature);
    });

    it("the second step: the first tab is bright (answered), the second is current", () => {
      const step = question("two--q2");
      expect(step.question).toBe("Which size?");
      expect(chips(step.steps)).toEqual(["Colour:answered", "Size:open:current"]);
      expect(step.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    });

    it("a multi-select step lifts into the checkbox phase with a stepper and the next tab's word", () => {
      const model = checkbox("three--q2-multi");
      expect(model.question).toBe("Which toppings? (select all that apply)");
      expect(model.steps).not.toBeNull();
      expect(chips(model.steps!)).toEqual(["Colour:answered", "Toppings:open:current", "Size:open"]);
      expect(model.advanceLabel).toBe("Size");
      expect(model.advanceKeys).toEqual(["Tab"]);
      expect(model.toggle).toBe("digit");
      expect(model.options.map((o) => o.label)).toEqual(["Cheese", "Olives", "Ham", "Basil"]);
    });

    it("a toggle turns the active chip answered, from the body, and moves the signature only by the box", () => {
      const before = checkbox("three--q2-multi");
      const after = checkbox("three--q2-multi--toggled");
      expect(after.options.map((o) => o.checked)).toEqual([false, true, false, false]);
      expect(chips(after.steps!)).toEqual(["Colour:answered", "Toppings:answered:current", "Size:open"]);
      expect(after.pointerRow).toBe(2);
      expect(after.signature).toBe(before.signature);
    });

    it("the Confirm tab lifts into a wizard review with the declared plans", () => {
      const review = wizardReview("three--review");
      expect(chips(review.steps)).toEqual(["Colour:answered", "Toppings:answered", "Size:answered"]);
      expect(review.answers).toEqual([
        { question: "Colour", answer: "Red" },
        { question: "Toppings", answer: "Ham" },
        { question: "Size", answer: "Large" },
      ]);
      expect(review.incomplete).toBe(false);
      expect(review.submitKeys).toEqual(["Enter"]);
      expect(review.cancelKeys).toEqual(["Escape"]);
      expect(review.cancelLabel).toBe("Dismiss");
      // No question chip is current on Confirm.
      expect(review.steps.some((s) => s.current)).toBe(false);
    });

    it("an unanswered question reads `(not answered)`, is incomplete, and its tab is grey", () => {
      const review = wizardReview("three--review--incomplete");
      expect(review.incomplete).toBe(true);
      expect(review.answers.at(-1)).toEqual({ question: "Size", answer: "(not answered)" });
      expect(chips(review.steps)).toEqual(["Colour:answered", "Toppings:answered", "Size:open"]);
    });

    it("two questions: the review lists both in tab order", () => {
      const review = wizardReview("two--review");
      expect(review.answers).toEqual([
        { question: "Colour", answer: "Red" },
        { question: "Size", answer: "Small" },
      ]);
    });
  });

  it("every lifted block replaces the dialog from the tab row; the mirror keeps what is above it", () => {
    for (const name of LIFTED_TABS) {
      const blocks = opencodeAdapter.buildBlocks(loadLines(name));
      expect(blocks, name).toHaveLength(2);
      expect(blocks[0]!.kind, name).toBe("raw");
      expect(["wizard", "multi-select"], name).toContain(blocks[1]!.kind);
      const raw = blocks[0]!.lines.map((l) => lineText(l).trimEnd());
      // No bare bar row (the dialog's top padding) or blank row hangs at the mirror's end.
      expect(raw.at(-1), name).not.toMatch(/^\s*┃?$/);
      const lifted = blocks[1]!.lines.map((l) => lineText(l).trimEnd());
      expect(lifted[0], name).toMatch(/^\s*┃ {3}\S/);
      expect(lifted.some((t) => t.includes("esc dismiss")), name).toBe(true);
    }
  });

  it("the signatures run from the tab row to the footer, and end inside the bridge's tail window", () => {
    for (const name of LIFTED_TABS) {
      const region = tabs(name.slice("oc--question--".length, -".txt".length))!;
      const model = region.model;
      const literal = "regionSignature" in model ? model.regionSignature : model.signature;
      expect(literal.startsWith("  ┃   "), name).toBe(true);
      expect(literal, name).toMatch(/esc\s+dismiss$/);
      expect(model.signature.length, name).toBeGreaterThan(0);
    }
  });

  it("refuses an unknown frame, and says nothing about it", () => {
    const lines = loadLines("oc--question--two--q1.txt");
    const texts = lines.map((l) => lineText(l));
    const tabRow = texts.findIndex((t) => t.includes("Colour   Size   Confirm"));
    expect(detectQuestionTabs(lines)).not.toBeNull();
    const footer = lines.findLast((l) => lineText(l).includes("esc dismiss"))!;
    const baseBg = footer.segments.find((s) => s.text.startsWith("esc"))!.bg;
    const retext = (row: number, from: string, to: string) => {
      const out = lines.slice();
      out[row] = { segments: out[row]!.segments.map((s) => (s.text.includes(from) ? Object.assign({}, s, { text: s.text.replace(from, to) }) : s)) };
      return out;
    };
    // No active chip: every chip on the footer's background.
    expect(detectQuestionTabs(repaint(lines, tabRow, baseBg))).toBeNull();
    // The last chip is not `Confirm`.
    expect(detectQuestionTabs(retext(tabRow, "Confirm", "Finish "))).toBeNull();
    // Two chips with one label.
    expect(detectQuestionTabs(retext(tabRow, "Size", "Colour"))).toBeNull();
    // A chip that is neither bright nor grey.
    const odd = lines.slice();
    odd[tabRow] = { segments: odd[tabRow]!.segments.map((s) => (s.text === "Size" ? Object.assign({}, s, { fg: "rgb(1,2,3)" }) : s)) };
    expect(detectQuestionTabs(odd)).toBeNull();
    // The footer's two inks must differ, or a chip's ink says nothing.
    const sameInk = lines.slice();
    const footerRow = lines.findLastIndex((l) => lineText(l).includes("esc dismiss"));
    const brightInk = footer.segments.find((s) => s.text.startsWith("esc"))!.fg;
    sameInk[footerRow] = { segments: footer.segments.map((s) => Object.assign({}, s, { fg: brightInk })) };
    expect(detectQuestionTabs(sameInk)).toBeNull();
  });

  it("refuses a single-select step whose free-text row has a row under it", () => {
    const lines = loadLines("oc--question--two--q1.txt");
    const freeRow = lines.findIndex((l) => lineText(l).includes("4. Type your own answer"));
    const description = lines.findIndex((l) => lineText(l).trim() === "┃     warm");
    const open = [...lines.slice(0, freeRow + 1), lines[description]!, ...lines.slice(freeRow + 1)];
    expect(detectQuestionTabs(lines)).not.toBeNull();
    expect(detectQuestionTabs(open)).toBeNull();
  });

  it("refuses a review whose row is not `Header: value` in tab order", () => {
    const lines = loadLines("oc--question--two--review.txt");
    const row = lines.findIndex((l) => lineText(l).includes("Size: Small"));
    const wrong = lines.slice();
    wrong[row] = { segments: wrong[row]!.segments.map((s) => (s.text.includes("Size:") ? Object.assign({}, s, { text: s.text.replace("Size:", "Sizes:") }) : s)) };
    expect(detectQuestionTabs(lines)).not.toBeNull();
    expect(detectQuestionTabs(wrong)).toBeNull();
  });

  it("refuses without a pointer chip, or with two, on a checkbox step", () => {
    const lines = loadLines("oc--question--multi.txt");
    const first = lines.findIndex((l) => lineText(l).includes("1. [ ] Red"));
    const second = lines.findIndex((l) => lineText(l).includes("2. [ ] Green"));
    const footer = lines.findLast((l) => lineText(l).includes("esc dismiss"))!;
    const baseBg = footer.segments.find((s) => s.text.startsWith("esc"))!.bg;
    const chipBg = lines[first]!.segments.find((s) => s.text.includes("1."))!.bg;
    expect(detectQuestionTabs(repaint(lines, first, baseBg))).toBeNull();
    expect(detectQuestionTabs(repaint(lines, second, chipBg))).toBeNull();
  });

  it("refuses when ordinary output follows the footer (a dialog that scrolled up)", () => {
    const lines = loadLines("oc--question--multi.txt");
    expect(detectQuestionTabs([...lines, ...splitLines(parseAnsi("a\nb\nc\n"))])).toBeNull();
  });

  it("the footer alone does not lift a screen: a foreign body under a tab bar footer", () => {
    // The tail of the Confirm tab, without its tab row: nothing to anchor the frame on.
    const lines = loadLines("oc--question--multi--confirm.txt");
    const tabRow = lines.findIndex((l) => lineText(l).includes("Colour   Confirm"));
    const headless = [...lines.slice(0, tabRow - 1), ...lines.slice(tabRow + 1)];
    expect(detectQuestionTabs(headless)).toBeNull();
  });
});

describe("opencode question dialog chrome", () => {
  it("modalOnScreen is true on every dialog capture, lifted or refused", () => {
    for (const name of [...LIFTED_QUESTIONS, ...REFUSED_QUESTION_DIALOGS]) {
      expect(modalOnScreen(loadLines(name)), name).toBe(true);
    }
  });

  it("modalOnScreen is false once the dialog is gone", () => {
    for (const name of QUESTION_GONE) expect(modalOnScreen(loadLines(name)), name).toBe(false);
  });

  it("composerReady is false on every dialog capture, so a reply never types into the dialog", () => {
    for (const name of [...LIFTED_QUESTIONS, ...REFUSED_QUESTION_DIALOGS]) {
      const lines = loadLines(name);
      expect(hasComposer(lines), name).toBe(false);
      expect(opencodeAdapter.composerReady?.(lines), name).toBe(false);
      expect(composerPrompt(lines), name).toBeNull();
      expect(locateComposer(lines), name).toBeNull();
    }
  });

  it("composerReady is true again once the dialog is answered or dismissed", () => {
    for (const name of QUESTION_GONE) expect(hasComposer(loadLines(name)), name).toBe(true);
  });

  it("the dialogs no grammar reads lift no block, so the raw mirror keeps them", () => {
    for (const name of REFUSED_QUESTION_DIALOGS) {
      const blocks = opencodeAdapter.buildBlocks(loadLines(name));
      expect(blocks.map((b) => b.kind), name).toEqual(["raw"]);
    }
  });
});
