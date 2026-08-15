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

  it("AskUserQuestion's free-text row is DROPPED but never modelled", () => {
    // "Type something." is a free-text row too, and it has always been dropped — but nothing about
    // its focus or typed-in behaviour has been measured, and it carries no static description
    // sub-line to identify it once typed into. Modelling it would hand the plan flow's copy ("Sends
    // the plan back…") and its keystroke plan to a dialog where Enter means something else. Only the
    // plan row's verified marker earns a model.
    const model = detectPromptSelect(fixtureLines("claude--select-menu.txt"))!;
    expect(model.family).toBe("select");
    expect(model.options.map((o) => o.label)).not.toContain("Type something.");
    expect(model.feedback).toBeUndefined();
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
  it("starts the menu region at the first option row (question + preamble stay above it)", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    const region = detectPromptSelectRegion(lines);
    expect(region).not.toBeNull();
    // The region's first line is the first option; the question sits on the line just above it.
    expect(lineText(lines[region!.startLine]!).trim()).toMatch(/^❯?\s*1\.\s+Red$/);
    expect(lineText(lines[region!.startLine - 1]!).trim()).toBe("");
    expect(region!.model).toEqual(detectPromptSelect(lines));
  });
});
