import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectPromptSelect, detectPromptSelectRegion, type PromptFamily } from "./prompt-select";
import { lineText } from "./markers";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite statically
// rewrites into a root-relative asset path) so the fixtures resolve regardless of the run cwd.
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

// The detector is developed and gated entirely against the byte-faithful pane captures in
// web/src/fixtures/panes/*.txt (real ESC bytes; see that README). Each fixture is run through the
// real parseAnsi → splitLines pipeline exactly as the renderer does, so these tests exercise the
// same code path production uses. Hard gates (from the spec): all five blocked-state fixtures detect
// with the correct question / labels / family / keystroke plan; working / fresh-idle / done produce
// ZERO detections; a menu that isn't at the tail must not match.

function fixtureText(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(fixtureText(name)));
}

describe("detectPromptSelect — the five blocked-state fixtures", () => {
  it("folder-trust prompt → trust family, digit-alone keys", () => {
    const model = detectPromptSelect(fixtureLines("claude--trust-prompt.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("trust");
    expect(model!.question).toContain("Is this a project you created or one you trust?");
    expect(model!.options.map((o) => o.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
  });

  it("AskUserQuestion select → select family, digit-THEN-Enter keys, free-text row dropped", () => {
    const model = detectPromptSelect(fixtureLines("claude--select-menu.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("select");
    expect(model!.question).toBe("Which color theme should the dashboard use?");
    // "4. Type something." is a free-text escape row → not up-levelled into a button.
    expect(model!.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Chat about this"]);
    expect(model!.options.map((o) => o.keys)).toEqual([
      ["1", "Enter"],
      ["2", "Enter"],
      ["3", "Enter"],
      ["5", "Enter"], // "Chat about this" keeps its original number (5), not its render position
    ]);
    // Description sub-lines are captured as secondary text.
    expect(model!.options[0]!.description).toContain("warm");
    expect(model!.options[3]!.description).toBeUndefined(); // "Chat about this" has none
  });

  it("edit-permission dialog → permission family, digit-alone keys", () => {
    const model = detectPromptSelect(fixtureLines("claude--permission-edit.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.question).toBe("Do you want to create hello.txt?");
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, allow all edits during this session (shift+tab)",
      "No",
    ]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });

  it("bash-permission dialog → permission family, digit-alone keys", () => {
    const model = detectPromptSelect(fixtureLines("claude--permission-bash.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.question).toBe("Do you want to proceed?");
    expect(model!.options).toHaveLength(3);
    expect(model!.options[0]!.label).toBe("Yes");
    expect(model!.options[1]!.label).toContain("ask again");
    expect(model!.options[1]!.label).toContain("mkfifo fixture-fifo");
    expect(model!.options[2]!.label).toBe("No");
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });

  it("plan-approval dialog → plan family, digit-alone keys, free-text row dropped", () => {
    const model = detectPromptSelect(fixtureLines("claude--plan-approval.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("plan");
    expect(model!.question).toContain("Would you like to proceed?");
    // "4. Tell Claude what to change" is a free-text escape row → dropped, leaving three buttons.
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes, and use auto mode",
      "Yes, manually approve edits",
      "No, refine with Ultraplan on Claude Code on the web",
    ]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });
});

describe("detectPromptSelect — the plan-approval feedback row is an INPUT, in all four states", () => {
  // That row is not an option. It is an inline text input, and "Tell Claude what to change" is its
  // PLACEHOLDER — which is all `isFreeTextLabel` ever matched. The placeholder only holds while the
  // box is empty; type into it and the label becomes the user's own words. Its
  // `shift+tab to approve with this feedback` sub-line comes from a static description field and
  // survives both states, so the DESCRIPTION is what identifies the row.
  //
  // It is never a button. What the model carries instead is the row's two variables — is it FOCUSED
  // (the terminal then swallows every digit as a character, so no button on the dialog can fire) and
  // what TEXT is in it (non-empty means Collie must not type: the caret resets to position 0 on
  // re-entry, so our words would be prepended to someone else's sentence).
  //
  // The four states were walked a keystroke at a time on Claude Code 2.1.228 and again on 2.1.233;
  // PLAN_FEEDBACK_NOTES.md is the ground truth.

  it("state 1 — box empty, pointer elsewhere: the answers are buttons, the row is an offer", () => {
    const model = detectPromptSelect(fixtureLines("claude--plan-approval.txt"));
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(model!.feedback).toEqual({ key: "4", focused: false, text: "" });
  });

  it("state 2 — box empty, FOCUSED: same rows, but every digit would be typed as text", () => {
    // Measured: from here `send_keys ["3"]` leaves the plan unapproved and rewrites the row as
    // `❯ 4. 3`. The three answer rows still parse as an ordinary menu, so nothing in the shape of the
    // screen distinguishes them from working buttons — `focused` is the only signal, and the renderer
    // and lib/prompt-action.ts both refuse on it.
    const model = detectPromptSelect(fixtureLines("claude--plan-approval--feedback-focused.txt"));
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(model!.feedback).toEqual({ key: "4", focused: true, text: "" });
  });

  it("state 3 — text typed, pointer arrowed OFF: the row is not up-levelled into a button", () => {
    // Reachable as `4`, type, `Up`; the text persists while the pointer sits elsewhere, so it is not
    // transient. Upstream 0.28.0 returned FOUR options here, the fourth being
    // { label: "use a guard clause instead", keys: ["4"] } — a live button on the phone carrying
    // whatever half-written sentence the desktop user had left in the box.
    const model = detectPromptSelect(fixtureLines("claude--plan-approval--feedback-typed.txt"));
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes, clear context (4% used) and use auto mode",
      "Yes, and use auto mode",
      "Yes, manually approve edits",
    ]);
    expect(model!.feedback).toEqual({
      key: "4",
      focused: false,
      text: "use a guard clause instead",
    });
  });

  it("the row's DIGIT is install-dependent — nothing may assume a fixed number", () => {
    // Same dialog on an install with `showClearContextOnPlanAccept` OFF: three rows, and the input is
    // row 3. Captured live on 2.1.233. A grammar that hard-coded `4` would offer the feedback flow the
    // wrong key here and type a stray digit into a plan approval.
    const model = detectPromptSelect(fixtureLines("claude--plan-approval--three-row.txt"));
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes, and use auto mode",
      "Yes, manually approve edits",
    ]);
    expect(model!.feedback).toEqual({ key: "3", focused: false, text: "" });
  });

  it("state 4 — text typed AND focused: the row is dropped and every button is dead", () => {
    const model = detectPromptSelect(
      fixtureLines("claude--plan-approval--three-row-typed-focused.txt"),
    );
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(model!.feedback).toEqual({
      key: "3",
      focused: true,
      text: "use a guard clause instead",
    });
  });

  it("a long value WRAPS onto continuation lines, and the row is rejoined from them", () => {
    // The row is not a scrolling window — Claude re-flows the whole value across as many lines as it
    // needs. Two things follow, both of which this capture pins. The value has to be rebuilt from the
    // label plus the lines above the hint; and those lines push the footer away from the options, so
    // MAX_FOOTER_GAP has to make room for them or the dialog stops parsing altogether (it did, before
    // this was understood: a 355-character value dropped the whole thing to the raw mirror).
    const model = detectPromptSelect(fixtureLines("claude--plan-approval--feedback-wrapped.txt"));
    expect(model).not.toBeNull();
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes, and use auto mode",
      "Yes, manually approve edits",
    ]);
    expect(model!.feedback!.text).toBe(
      "Keep the nested structure instead of a guard clause, but extract each condition into a small " +
        "named predicate so the intent reads at the call site, and leave the exported name unchanged.",
    );
    // …and the wrapped row is still not an option, which is the whole hazard: its label alone is the
    // user's own words, and a wrapped block no longer starts with the hint the marker looks for.
    expect(model!.options.map((o) => o.label)).not.toContain(model!.feedback!.text);
  });

  it("a dialog with no such row carries no feedback at all", () => {
    const model = detectPromptSelect(fixtureLines("claude--permission-edit.txt"));
    expect(model!.feedback).toBeUndefined();
  });

  it("AskUserQuestion's free-text row is modelled as a field Collie never types into", () => {
    // "Type something." is never a button. Measured on Claude Code 2.1.283: with the pointer on it a
    // digit is typed into the field, so it is modelled with the `free-text` purpose, which locks the
    // other buttons while focused and never offers the plan flow's editor or keystroke plan.
    const model = detectPromptSelect(fixtureLines("claude--select-menu.txt"))!;
    expect(model.family).toBe("select");
    expect(model.options.map((o) => o.label)).not.toContain("Type something.");
    expect(model.feedback).toEqual({ key: expect.any(String), focused: false, text: "", purpose: "free-text" });
  });

  it("coreSignature survives the flow's OWN first keystroke, where signature must not", () => {
    // The two three-row captures are the same live dialog one keystroke apart: `--three-row` was
    // taken, `3` was sent, `--three-row-focused` was taken. The ONLY difference on screen is where the
    // `❯` sits. That is the exact transition the feedback flow's first poll has to accept, so
    // `coreSignature` (pointer-normalised) must match across it — while `signature` moves, which is
    // what keeps a COMMITTING digit checked against the screen the user actually looked at.
    const before = detectPromptSelect(fixtureLines("claude--plan-approval--three-row.txt"))!;
    const after = detectPromptSelect(fixtureLines("claude--plan-approval--three-row-focused.txt"))!;
    // Anchored at the QUESTION, deliberately: typing grows the dialog, the terminal re-flows to fit,
    // and the plan body ABOVE comes back laid out differently — so a window reaching up into it moves
    // under the flow's own keystrokes. Measured live; the entry guard's full `signature` still covers
    // the subject.
    expect(before.coreSignature.trimStart().startsWith(before.question)).toBe(true);
    expect(before.feedback!.focused).toBe(false);
    expect(after.feedback!.focused).toBe(true);
    expect(after.signature).not.toBe(before.signature);
    expect(after.coreSignature).toBe(before.coreSignature);
    expect(promptsSameIdentity(after, before)).toBe(true);
    expect(promptsEqual(after, before)).toBe(false); // focus alone re-routes every digit

    // A genuinely different plan dialog still breaks the core identity — the property that stops a
    // mid-flight keystroke from landing on a same-shaped successor.
    const other = detectPromptSelect(fixtureLines("claude--plan-approval.txt"))!;
    expect(promptsSameIdentity(other, before)).toBe(false);
    expect(other.coreSignature).not.toBe(before.coreSignature);
  });
});

describe("detectPromptSelect — numbered dialog body above the menu (suffix extraction)", () => {
  it("plan approval whose plan lists numbered steps still detects the real menu", () => {
    // The plan body carries "1. Title / 2. … / 4. Context / 5. TODO stub" and the option-scan window
    // catches the trailing "4./5." — so rows collect as [4,5,1,2,3,4]. The menu is the maximal
    // trailing 1,2,…,m run ([1,2,3,4]); the body rows above it drop out. Before the fix the
    // whole-collection "must be 1..k" check saw rows[0]=4 and bailed to the raw mirror.
    const model = detectPromptSelect(fixtureLines("claude--plan-approval--numbered-body.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("plan");
    expect(model!.question).toContain("ready to execute");
    // "4. Tell Claude what to change" is a free-text escape row → dropped, leaving three buttons.
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes, and use auto mode",
      "Yes, manually approve edits",
      "No, refine with Ultraplan on Claude Code on the web",
    ]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });
});

describe("detectPromptSelect — family → keystroke recipe (regression guard)", () => {
  // Table-driven over all four families: `select` confirms on the digit THEN Enter; the confirm
  // families (trust/permission/plan) fire on the digit ALONE (a trailing Enter there would leak into
  // whatever renders next). A regression flipping any family's plan — e.g. `plan` → digit+Enter — is
  // caught here rather than only in that family's single fixture test.
  const cases: { fixture: string; family: PromptFamily; digitThenEnter: boolean }[] = [
    { fixture: "claude--trust-prompt.txt", family: "trust", digitThenEnter: false },
    { fixture: "claude--select-menu.txt", family: "select", digitThenEnter: true },
    { fixture: "claude--permission-edit.txt", family: "permission", digitThenEnter: false },
    { fixture: "claude--plan-approval.txt", family: "plan", digitThenEnter: false },
  ];
  for (const c of cases) {
    it(`${c.family} → ${c.digitThenEnter ? "digit+Enter" : "digit alone"}`, () => {
      const model = detectPromptSelect(fixtureLines(c.fixture));
      expect(model).not.toBeNull();
      expect(model!.family).toBe(c.family);
      expect(model!.options.length).toBeGreaterThan(0);
      for (const o of model!.options) {
        expect(/^\d+$/.test(o.keys[0]!)).toBe(true); // first key is always the digit
        if (c.digitThenEnter) {
          expect(o.keys.length).toBe(2);
          expect(o.keys[1]).toBe("Enter");
        } else {
          expect(o.keys.length).toBe(1);
          expect(o.keys).not.toContain("Enter");
        }
      }
    });
  }
});

describe("detectPromptSelect — false-positive gate (no menu at the tail)", () => {
  for (const name of ["claude--working.txt", "claude--fresh-idle.txt", "claude--done.txt"]) {
    it(`${name} produces zero detections`, () => {
      expect(detectPromptSelect(fixtureLines(name))).toBeNull();
    });
  }

  it("multi-question AskUserQuestion (stepper header) bails to raw", () => {
    // The wizard shows a "☒ Focus area  ☐ Scope  ✔ Submit" stepper: there are further questions we
    // can't see, and one digit+Enter would submit a half-filled form. Detection must return null so
    // the raw mirror + keys pad drive it instead. (The single-question select-menu fixture, with its
    // lone "☐ Color Theme" chip, still detects — proven above.)
    expect(detectPromptSelect(fixtureLines("claude--select-multi.txt"))).toBeNull();
  });

  it("single-question multiSelect AskUserQuestion is not claimed by prompt-select", () => {
    // A !wizard multiSelect (checkbox "[ ]" options under a "☐ Toppings  ✔ Submit" stepper):
    // prompt-select BAILS on the multi-step stepper glyph (its "☐ …  ✔ Submit" line trips the
    // multi-step-header bail — 2 step glyphs), so detectPromptSelect returns null here. The
    // multi-select grammar (multi-select.ts) is what claims this dialog and lifts it natively.
    expect(detectPromptSelect(fixtureLines("claude--select-multiselect-single.txt"))).toBeNull();
  });

  it("bails on a menu with more than 9 numbered rows (option 10 needs the unsendable key '10')", () => {
    // 10 consecutive rows 1..10 under a select footer would otherwise up-level, emitting a broken
    // keys:["10","Enter"] Herdr rejects. The >9 guard bails to the raw mirror instead. (Claude menus
    // are ≤6 today; the guard is safe headroom.)
    const rows = Array.from({ length: 10 }, (_, i) => `  ${i + 1}. Option ${i + 1}`).join("\n");
    const buf = `Which option should we use?\n\n${rows}\n\nEnter to select · Esc to cancel`;
    expect(detectPromptSelect(splitLines(parseAnsi(buf)))).toBeNull();
    // Control: the same shape with 9 rows still detects (proving the guard, not the shape, rejects).
    const nine = Array.from({ length: 9 }, (_, i) => `  ${i + 1}. Option ${i + 1}`).join("\n");
    const nineBuf = `Which option should we use?\n\n${nine}\n\nEnter to select · Esc to cancel`;
    const model = detectPromptSelect(splitLines(parseAnsi(nineBuf)));
    expect(model).not.toBeNull();
    expect(model!.options).toHaveLength(9);
  });

  it("a menu-shaped block that is NOT at the tail does not match", () => {
    // Take the real select-menu buffer and append ordinary output after it: the footer is no longer
    // the last non-blank line, so the tail anchor fails.
    const withTail = fixtureText("claude--select-menu.txt") + "\n● Wrote the file\n  ⎿  done\n";
    expect(detectPromptSelect(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("empty and whitespace-only buffers do not match", () => {
    expect(detectPromptSelect(splitLines(parseAnsi("")))).toBeNull();
    expect(detectPromptSelect(splitLines(parseAnsi("\n\n   \n")))).toBeNull();
  });
});

describe("detectPromptSelectRegion — render boundary", () => {
  // The region used to start at the first option row and leave the question and the dialog's
  // subject in the raw mirror above the card. The card docks above the belt now (ADR 0059) and the
  // Chat view shows no mirror at all, so the card carries the subject and the question itself, and
  // the region starts at the dialog's own `─` top edge so the mirror does not repeat them.
  it("starts the region at the dialog's top edge (the card shows the question itself)", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    const region = detectPromptSelectRegion(lines);
    expect(region).not.toBeNull();
    expect(lineText(lines[region!.startLine]!).trim()).toMatch(/^─+$/);
    // Everything from the edge to the footer is the dialog: the chip header, the question, the options.
    const inside = lines.slice(region!.startLine).map((l) => lineText(l).trim());
    expect(inside).toContain("Which color theme should the dashboard use?");
    expect(inside.some((t) => /^❯?\s*1\.\s+Red$/.test(t))).toBe(true);
    expect(region!.model).toEqual(detectPromptSelect(lines));
  });

  it("keeps the first option row as the start when no edge is in reach", () => {
    // A dialog with no `─` rule above its question: nothing to frame it, so nothing moves.
    const text = ["Pick a colour?", "❯ 1. Red", "  2. Blue", "", "Enter to select · Esc to cancel"].join("\n");
    const lines = splitLines(parseAnsi(text));
    const region = detectPromptSelectRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(1);
    expect(region!.model.subject).toBeUndefined();
  });
});

// ── THE DIALOG'S SUBJECT ─────────────────────────────────────────────────────────────────────────
// What the dialog asks about, read between its `─` top edge and its question, chrome removed,
// styles kept. The card shows it; on the phone a subagent's permission used to read "Yes / No" alone.
describe("detectPromptSelectRegion — the dialog's subject", () => {
  const subjectTexts = (name: string) =>
    detectPromptSelectRegion(fixtureLines(name))!.model.subject?.map((l) => l.segments.map((s) => s.text).join(""));

  it("Claude Code 2.1.291 subagent Bash permission: header, description, command, warning", () => {
    const lines = fixtureLines("claude--v2291-permission-bash-subagent.txt");
    const region = detectPromptSelectRegion(lines);
    expect(region).not.toBeNull();
    const { model, startLine } = region!;
    expect(model.family).toBe("permission");
    expect(model.question).toBe("Do you want to proceed?");
    expect(model.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(model.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    // The region starts at the dialog's `─` edge, so the raw mirror above ends before it.
    expect(lineText(lines[startLine]!)).toMatch(/^─+$/);
    expect(lineText(lines[startLine + 1]!).trim()).toBe("Bash command · from the general-purpose agent");

    const subject = model.subject!.map((l) => l.segments.map((s) => s.text).join(""));
    expect(subject).toEqual([
      "Bash command · from the general-purpose agent",
      "Restore committed pane route in copy and build",
      "set -e; R=/var/home/devel/apps/sample-forge; T=/tmp/forge-home-build; cd $T/web-forge/src/routes/pane && rm -rf ./* && cd $R && for f in $(git ls-tree -r",
      "--name-only HEAD web-forge/src/routes/pane); do mkdir -p $T/$(dirname $f); git show HEAD:$f > $T/$f; done; cd $T/web-forge && bunx vite build --outDir",
      '/tmp/sample-forge-home --emptyOutDir 2>&1 | grep -E "MISSING|rror|built in" | head -5',
      "Dangerous rm operation on statically-unresolvable target: /var/home/devel/projects/sample-workspace/*",
    ]);
    // No dashed rule and no `│` gutter survives.
    expect(subject.some((t) => /╌/.test(t))).toBe(false);
    expect(subject.some((t) => /^\s*│/.test(t))).toBe(false);
    // The styles are kept: the header's own words stay bold, as the terminal painted them.
    expect(model.subject![0]!.segments.find((s) => s.text.trim() !== "")!.bold).toBe(true);
  });

  it("the subject plays no part in identity: signature and coreSignature are what they were", () => {
    const lines = fixtureLines("claude--v2291-permission-bash-subagent.txt");
    const { model } = detectPromptSelectRegion(lines)!;
    const texts = lines.map(lineText);
    const firstOpt = texts.findIndex((t) => t.endsWith("1. Yes"));
    const footer = texts.length - 1;
    // signature: 40 rows above the first option through the footer; coreSignature: from the question.
    expect(model.signature).toBe(texts.slice(firstOpt - 40, footer + 1).join("\n"));
    expect(model.coreSignature.split("\n")[0]).toBe(" Do you want to proceed?");
  });

  it("2.1.285 lab Bash permission: the auto-mode tip and its wrapped row are not subject", () => {
    expect(subjectTexts("claude-lab--permission-bash--w82.txt")).toEqual([
      "Bash command",
      "",
      "  touch /tmp/claude-lab/project/scratch-one.txt",
      "  Create empty file scratch-one.txt",
    ]);
  });

  it("2.1.283 amend dialog: the tip wrapped at the dash is dropped as well", () => {
    expect(subjectTexts("claude--v2283-permission-amend-focused.txt")).toEqual([
      "Bash command",
      "",
      '  echo "a" >',
      "  /tmp/collie-dialog-debug/amend.txt",
      '  Write "a" to amend.txt',
    ]);
  });

  it("Edit permission: the edge is in reach, so the subject is the file and its diff", () => {
    const lines = fixtureLines("claude--permission-edit.txt");
    const region = detectPromptSelectRegion(lines)!;
    expect(lineText(lines[region.startLine]!)).toMatch(/^─+$/);
    expect(subjectTexts("claude--permission-edit.txt")).toEqual(["Create file", "hello.txt", " 1 hello"]);
  });

  it("plan approval: the edge sits right above the question, so there is no subject", () => {
    expect(subjectTexts("claude--plan-approval.txt")).toBeUndefined();
  });

  // ── The edge reaches into the signature ──────────────────────────────────────────────────────
  // The edge scan stops 30 rows above the question, and the question can sit up to a dozen rows
  // above the first option, so the dialog's top can be 40+ rows above the first option: past the
  // SIGNATURE_LOOKBACK window. A synthetic dialog with a note block between question and options.
  const BOLD = "\x1b[1m";
  const OFF = "\x1b[0m";
  const OPTIONS = [
    " \x1b[0m\x1b[38;2;177;185;249m❯ \x1b[0m1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ];
  /** A tall Edit dialog: `header` is the row right under the edge, 28 diff rows, the question, a note block. */
  function tallEdit(header: string): StyledLine[] {
    return splitLines(
      parseAnsi(
        [
          "─".repeat(60),
          ` ${BOLD}${header}${OFF}`,
          " web/src/foo.ts",
          ...Array.from({ length: 27 }, (_, k) => ` ${k + 1} unchanged line ${k + 1}`),
          " Do you want to make this edit to foo.ts?",
          "",
          ...Array.from({ length: 10 }, (_, k) => `   note ${k + 1}`),
          ...OPTIONS,
        ].join("\n"),
      ),
    );
  }

  it("signature starts at the edge when the subject reaches past the lookback window", () => {
    const a = tallEdit("Edit file foo.ts");
    const b = tallEdit("Edit file bar.ts");
    const ra = detectPromptSelectRegion(a)!;
    const rb = detectPromptSelectRegion(b)!;
    const firstOpt = a.findIndex((l) => /1\. Yes/.test(lineText(l)));
    // Precondition: the one row that differs is above the 40-row lookback, inside the subject.
    expect(firstOpt - ra.startLine).toBeGreaterThan(41);
    expect(ra.model.subject?.[0]?.segments.map((s) => s.text).join("")).toBe("Edit file foo.ts");
    expect(ra.model.signature).not.toBe(rb.model.signature);
    expect(ra.model.signature).toContain("Edit file foo.ts");
    expect(ra.model.coreSignature).toBe(rb.model.coreSignature);
    expect(promptsEqual(ra.model, rb.model)).toBe(false);
  });

  it("a screen with no edge keeps its lookback-window signature", () => {
    // The same dialog under no rule of its own, with transcript prose above instead.
    const texts = [
      ...Array.from({ length: 60 }, (_, k) => `transcript line ${k}`),
      " Do you want to make this edit to foo.ts?",
      ...OPTIONS,
    ];
    const lines = splitLines(parseAnsi(texts.join("\n")));
    const region = detectPromptSelectRegion(lines)!;
    const firstOpt = texts.findIndex((t) => /1\. Yes/.test(t));
    expect(region.startLine).toBe(firstOpt);
    expect(region.model.subject).toBeUndefined();
    expect(region.model.signature).toBe(lines.slice(firstOpt - 40).map(lineText).join("\n"));
  });

  // ── The edge must open a dialog ──────────────────────────────────────────────────────────────
  it("a stray transcript rule above a bare Yes/No is not the dialog's edge", () => {
    const texts = [
      "● Some earlier output",
      "─".repeat(40),
      "A plain prose row that is not a dialog header",
      ...Array.from({ length: 5 }, (_, k) => `more prose ${k}`),
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "",
      "Esc to cancel",
    ];
    const lines = splitLines(parseAnsi(texts.join("\n")));
    const region = detectPromptSelectRegion(lines)!;
    expect(region).not.toBeNull();
    expect(region.model.family).toBe("permission");
    expect(region.model.subject).toBeUndefined();
    expect(region.startLine).toBe(texts.findIndex((t) => t.startsWith("❯ 1.")));
  });

  it("every captured dialog with a subject keeps it", () => {
    for (const name of [
      "claude--permission-bash.txt",
      "claude--permission-edit.txt",
      "claude-lab--permission-bash--w40.txt",
      "claude-lab--permission-bash--w82.txt",
      "claude-lab--permission-webfetch--w82.txt",
      "claude-lab--permission-write--w82.txt",
      "claude--v2283-permission-amend-focused.txt",
      "claude--v2283-permission-amend-no-off-row.txt",
      "claude--v2283-permission-amend-typed.txt",
      "claude--v2291-permission-bash-subagent.txt",
      "claude--trust-prompt.txt",
      "claude--trust-prompt-unnumbered.txt",
      "claude--v2283-trust--w50.txt",
    ]) {
      expect(subjectTexts(name), name).toBeDefined();
    }
  });

  // ── The stepper chip is chrome ───────────────────────────────────────────────────────────────
  it("AskUserQuestion: the `☐ Color Theme` chip is not subject, and the question is unchanged", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    const region = detectPromptSelectRegion(lines)!;
    expect(region.model.subject).toBeUndefined();
    expect(region.model.question).toBe("Which color theme should the dashboard use?");
    for (const name of [
      "claude--v2283-ask-two-line-question.txt",
      "claude--v2283-ask-long-question--w50.txt",
      "claude--v2283-ask-type-something-focused.txt",
    ]) {
      expect(subjectTexts(name), name).toBeUndefined();
    }
  });
});

// ── The POINTED, unnumbered folder-trust prompt (ADR 0055) ───────────────────────────────────────
// Claude Code 2.1.278 dropped the numbers from the trust prompt's rows and parks the pointer on
// "No, exit", which QUITS Claude. There is no digit on screen, so none may be synthesised (ADR
// 0009): a tap is the arrow walk the pointer implies plus the Enter the footer named.
describe("detectPromptSelect — the unnumbered folder-trust prompt", () => {
  // A synthetic pointed screen, used for the variants the corpus cannot hold (the pointer on the
  // other row, the dialog's own words taken away). The real capture is asserted on first.
  function pointedScreen(rows: string[], question = "Is this a project you created or one you trust?"): StyledLine[] {
    return splitLines(
      parseAnsi(
        [
          " Accessing workspace:",
          "",
          " /tmp/m34-lab-untrusted",
          "",
          ` Quick safety check: ${question} (Like your own code).`,
          "",
          " Claude Code'll be able to read, edit, and execute files here.",
          "",
          " Security guide",
          "",
          ...rows,
          "",
          " Enter to confirm · Esc to cancel",
        ].join("\n"),
      ),
    );
  }

  it("lifts both rows in SCREEN order, walked with the arrows and confirmed with Enter", () => {
    const model = detectPromptSelect(fixtureLines("claude--trust-prompt-unnumbered.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("trust");
    expect(model!.question).toContain("Is this a project you created or one you trust?");
    // Screen order, not the old numbered order: the pointer parks on the QUIT row, which is first.
    expect(model!.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"]]);
  });

  it("marks the pointed row, so the card shows which option a bare Enter would take", () => {
    const model = detectPromptSelect(fixtureLines("claude--trust-prompt-unnumbered.txt"));
    // `PromptOption` has no highlighted/default flag, so the badge carries it: the pointed row shows
    // the terminal's own glyph, every other row shows the arrow its tap starts with.
    expect(model!.options.map((o) => o.keyLabel)).toEqual(["❯", undefined]);
  });

  it("synthesises no digit anywhere (ADR 0009 — the screen printed none)", () => {
    const model = detectPromptSelect(fixtureLines("claude--trust-prompt-unnumbered.txt"));
    for (const key of model!.options.flatMap((o) => o.keys)) expect(/\d/.test(key)).toBe(false);
  });

  it("Escape stays the way out (the footer's own cancel, unchanged by this shape)", () => {
    const texts = fixtureLines("claude--trust-prompt-unnumbered.txt").map(lineText);
    expect(texts.findLast((t) => t.trim() !== "")).toContain("Esc to cancel");
  });

  it("walks UPWARD when the pointer sits on the second row", () => {
    const model = detectPromptSelect(
      pointedScreen(["   No, exit", " ❯ Yes, I trust this folder"]),
    );
    expect(model).not.toBeNull();
    expect(model!.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"]]);
    expect(model!.options.map((o) => o.keyLabel)).toEqual([undefined, "❯"]);
  });

  it("stays raw when the dialog's own words are gone (fail closed)", () => {
    // `namesTrustDialog` finds neither the safety question nor the trust option, so `classifyFooter`
    // refuses the family and nothing is lifted — "Enter to confirm" alone is never enough (ADR 0053).
    const lines = pointedScreen(["   No, exit", " ❯ Yes, continue"], "is this folder OK?");
    expect(detectPromptSelect(lines)).toBeNull();
  });

  it("declines a block with no pointer, and one with two", () => {
    expect(detectPromptSelect(pointedScreen(["   No, exit", "   Yes, I trust this folder"]))).toBeNull();
    expect(
      detectPromptSelect(pointedScreen([" ❯ No, exit", " ❯ Yes, I trust this folder"])),
    ).toBeNull();
  });

  it("declines a lone pointed row (a list needs two rows to walk)", () => {
    expect(detectPromptSelect(pointedScreen([" ❯ Yes, I trust this folder"]))).toBeNull();
  });

  it("does not match once the dialog has scrolled off the tail", () => {
    const withTail =
      fixtureText("claude--trust-prompt-unnumbered.txt") + "\n● Wrote the file\n  ⎿  done\n";
    expect(detectPromptSelect(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("the OLD numbered shape is untouched by this arm", () => {
    const model = detectPromptSelect(fixtureLines("claude--trust-prompt.txt"));
    expect(model!.options.map((o) => o.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(model!.options.map((o) => o.keyLabel)).toEqual([undefined, undefined]);
  });

  it("a moved pointer is not the same visible state, though it is the same dialog", () => {
    // The arrow COUNT is measured from where the pointer was, so a pointer that moved between the
    // render and the tap must refuse the tap. `signature` is byte-faithful and carries the `❯`
    // column, which is what `promptsEqual` (the COMMITTING, entry comparison) checks. The walk baked
    // into every option's `keys` is NOT compared by `promptsSameIdentity` (ADR 0080): the pointer is
    // our own choreography's effect, and the walk-verify poll watches it arrive.
    const here = detectPromptSelect(pointedScreen([" ❯ No, exit", "   Yes, I trust this folder"]))!;
    const moved = detectPromptSelect(pointedScreen(["   No, exit", " ❯ Yes, I trust this folder"]))!;
    expect(promptsEqual(here, moved)).toBe(false);
    expect(promptsSameIdentity(here, moved)).toBe(true);
    expect(promptsEqual(here, here)).toBe(true);
  });
});
