import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { promptsEqual, type PromptModel } from "./prompt-model";
import { describeAdapterConformance } from "./conformance";
import { adapterFor } from "./registry";
import { hermesAdapter } from "./hermes";
import { detectApprovalRegion } from "./hermes/approval";
import { locateInput, parsePrompt, pickerOpen, stripChrome } from "./hermes/chrome";
import { detectClarifyRegion } from "./hermes/clarify";
import { lineText } from "./hermes/markers";
import { unreadDialogSignature } from "./unread-dialog-model";

const PANES = join(import.meta.dirname, "../../fixtures/panes");
const fixtures = readdirSync(PANES).filter((name) => name.endsWith(".txt")).toSorted();
const raw = (name: string) => readFileSync(join(PANES, name), "utf8");
const load = (name: string) => splitLines(parseAnsi(raw(name)));
const hermes = fixtures.filter((name) => name.startsWith("hermes--"));

// The whole corpus, so a capture added later has to be placed in one cohort or the other here.
const PINNED = [
  "hermes--approval-long-full.txt",
  "hermes--approval-long.txt",
  "hermes--approval-moved.txt",
  "hermes--approval-w60.txt",
  "hermes--approval.txt",
  "hermes--clarify-choices-moved.txt",
  "hermes--clarify-choices-w60.txt",
  "hermes--clarify-choices.txt",
  "hermes--clarify-four.txt",
  "hermes--clarify-long.txt",
  "hermes--clarify-multi-toggled.txt",
  "hermes--clarify-multi.txt",
  "hermes--clarify-open.txt",
  "hermes--clarify-other-draft-w60.txt",
  "hermes--clarify-other-draft.txt",
  "hermes--clarify-other-w60.txt",
  "hermes--clarify-other.txt",
  "hermes--clarify-two-second.txt",
  "hermes--clarify-two.txt",
  "hermes--done.txt",
  "hermes--draft-multiline.txt",
  "hermes--draft-six-lines.txt",
  "hermes--draft-w60.txt",
  "hermes--draft-wrapped.txt",
  "hermes--draft.txt",
  "hermes--exited.txt",
  "hermes--idle-w60.txt",
  "hermes--idle.txt",
  "hermes--model-picker.txt",
  "hermes--palette.txt",
  "hermes--running.txt",
  "hermes--slash-popup.txt",
];

// The screens that lift a dialog. Everything else in the corpus is the raw cohort.
const LIFTED = [
  "hermes--approval-long-full.txt",
  "hermes--approval-long.txt",
  "hermes--approval-moved.txt",
  "hermes--approval-w60.txt",
  "hermes--approval.txt",
  "hermes--clarify-choices-moved.txt",
  "hermes--clarify-choices-w60.txt",
  "hermes--clarify-choices.txt",
  "hermes--clarify-four.txt",
  "hermes--clarify-long.txt",
  "hermes--clarify-two-second.txt",
  "hermes--clarify-two.txt",
];

describeAdapterConformance(hermesAdapter, {
  ownFixtures: LIFTED,
  neutralFixtures: hermes.filter((name) => !LIFTED.includes(name)),
  foreignFixtures: fixtures.filter((name) => !name.startsWith("hermes--")),
});

function liftedModel(name: string): PromptModel {
  const block = hermesAdapter.buildBlocks(load(name)).find((b) => b.kind === "prompt-select");
  if (block?.kind !== "prompt-select") throw new Error(`${name} lifts no prompt-select`);
  return block.prompt;
}

const rowsOf = (lines: StyledLine[]) => lines.map(lineText);

const options = (m: PromptModel) => m.options.map((o) => `${o.keys.join("+")} ${o.label}`);

/** The fixture with every row that matches `from` rewritten through `to`, re-parsed. */
function edited(name: string, from: RegExp, to: (row: string) => string): StyledLine[] {
  const text = raw(name)
    .split("\n")
    .map((row) => (from.test(splitLines(parseAnsi(row)).map(lineText).join("")) ? to(row) : row))
    .join("\n");
  return splitLines(parseAnsi(text));
}

describe("the hermes corpus", () => {
  it("is exactly the captures this adapter was developed against", () => {
    expect(hermes).toEqual(PINNED);
  });

  it("lifts exactly the dialog screens", () => {
    const lifted = hermes.filter((name) => hermesAdapter.buildBlocks(load(name)).some((b) => b.kind !== "raw"));
    expect(lifted).toEqual(LIFTED);
  });

  it("is what the registry hands a Herdr `hermes` pane, and nothing else", () => {
    expect(adapterFor("hermes")).toBe(hermesAdapter);
    expect(adapterFor("hermes-agent")).toBeUndefined();
    expect(adapterFor("Hermes")).toBeUndefined();
  });
});

describe("the clarify panel", () => {
  it("lifts the active question with one digit per choice, Other last", () => {
    const m = liftedModel("hermes--clarify-choices.txt");
    expect(m.question).toBe("Which database should the lab use?");
    expect(m.caption).toBe("Hermes Agent needs your input");
    expect(m.family).toBe("select");
    expect(options(m)).toEqual(["1 Postgres (Recommended)", "2 SQLite", "3 DuckDB", "4 Other (type your answer)"]);
    expect(m.subject).toBeUndefined();
  });

  it("reads the same choices with the pointer moved, at 60 columns, and with five rows", () => {
    expect(options(liftedModel("hermes--clarify-choices-moved.txt"))).toEqual(options(liftedModel("hermes--clarify-choices.txt")));
    expect(options(liftedModel("hermes--clarify-choices-w60.txt"))).toEqual(options(liftedModel("hermes--clarify-choices.txt")));
    expect(options(liftedModel("hermes--clarify-four.txt"))).toEqual([
      "1 Stable (Recommended)",
      "2 Beta",
      "3 Nightly",
      "4 Local",
      "5 Other (type your answer)",
    ]);
  });

  it("joins a wrapped question and a wrapped choice", () => {
    const m = liftedModel("hermes--clarify-long.txt");
    expect(m.question).toBe(
      "The lab needs one more decision before it can continue: should the generated report keep the raw tables beside the summary, or should it link to them from a separate appendix page instead?",
    );
    expect(m.options[0]!.label).toBe(
      "Keep the raw tables inline, directly under each summary paragraph so nothing needs a second click (Recommended)",
    );
  });

  it("asks the active question of several, with the locked ones above it on the card", () => {
    const first = liftedModel("hermes--clarify-two.txt");
    expect(first.question).toBe("Which colour for the badge?");
    expect(options(first)).toEqual(["1 Red (Recommended)", "2 Green", "3 Other (type your answer)"]);
    const second = liftedModel("hermes--clarify-two-second.txt");
    expect(second.question).toBe("Which size for the badge?");
    expect(second.subject?.map(lineText)).toEqual(["2 questions", "✓ Which colour for the badge?", "    Green"]);
  });

  it("leaves a multi-select question raw: a digit there toggles, and Enter submits", () => {
    for (const name of ["hermes--clarify-multi.txt", "hermes--clarify-multi-toggled.txt"]) {
      expect(detectClarifyRegion(load(name)), name).toBeNull();
      expect(hermesAdapter.composerReady!(load(name)), name).toBe(false);
    }
  });

  it("leaves the typed-answer screen raw, where the input is the answer", () => {
    for (const name of ["hermes--clarify-other.txt", "hermes--clarify-open.txt", "hermes--clarify-other-w60.txt"]) {
      expect(detectClarifyRegion(load(name)), name).toBeNull();
      expect(hermesAdapter.composerReady!(load(name)), name).toBe(true);
    }
  });

  it("binds the panel alone: the countdown, spinner and status clocks ticking leave it the same dialog (#354)", () => {
    const before = liftedModel("hermes--clarify-choices.txt");
    const ticked = hermesAdapter.buildBlocks(
      edited("hermes--clarify-choices.txt", /\(\d+s\)$|⏱|❓ Which/, (row) =>
        row.replace(/\(3547s\)/, "(3546s)").replace(/⏱ 53s/, "⏱ 54s").replace(/52\.6s/, "53.6s"),
      ),
    );
    const after = ticked.find((b) => b.kind === "prompt-select");
    expect(after?.kind).toBe("prompt-select");
    if (after?.kind !== "prompt-select") return;
    expect(promptsEqual(after.prompt, before)).toBe(true);
    expect(before.bindTail).toBe(8);
  });

  it("is another dialog when a choice, the question or a locked answer changes", () => {
    const before = liftedModel("hermes--clarify-two-second.txt");
    for (const [from, to] of [
      [/2\. Large/, (r: string) => r.replace("2. Large", "2. Small")],
      [/Which size/, (r: string) => r.replace("Which size", "Which hue ")],
      [/^│ {5}Green/, (r: string) => r.replace("Green", "Red  ")],
    ] as const) {
      const blocks = hermesAdapter.buildBlocks(edited("hermes--clarify-two-second.txt", from, to));
      const m = blocks.find((b) => b.kind === "prompt-select");
      if (m?.kind === "prompt-select") expect(promptsEqual(m.prompt, before), String(from)).toBe(false);
    }
  });

  it("leaves a revisited question raw when its Other row shows an earlier answer", () => {
    // `Other: <answer>`: the digit opens an empty editor, so the label would promise a resend.
    const revisited = edited("hermes--clarify-choices.txt", /4\. Other \(type your answer\)/, (row) =>
      row.replace("Other (type your answer)", "Other: CockroachDB      "),
    );
    expect(detectClarifyRegion(revisited)).toBeNull();
  });

  it("refuses a panel with anything printed under the input", () => {
    const below = splitLines(parseAnsi(`${raw("hermes--clarify-choices.txt")}\n /model  Switch model`));
    expect(detectClarifyRegion(below)).toBeNull();
  });

  it("refuses a panel Hermes clipped so that the active question's own row is gone", () => {
    const clipped = edited("hermes--clarify-choices.txt", /▸ Which database/, (row) => row.replace("▸ Which database should the lab use?", "  more text of the question here "));
    expect(detectClarifyRegion(clipped)).toBeNull();
  });

  it("refuses a panel whose key hint is not the one it knows", () => {
    const reworded = edited("hermes--clarify-choices.txt", /↑\/↓ to select, Enter to lock/, (row) => row.replace("↑/↓ to select", "↑/↓ to choose"));
    expect(detectClarifyRegion(reworded)).toBeNull();
  });

  // The declared tail vouches for every row under the panel (ADR 0104), so a row there that is not
  // Hermes's own spinner refuses the panel rather than being counted.
  it("refuses a panel with a row it does not know between the panel and the hint", () => {
    const inserted = edited("hermes--clarify-choices.txt", /^ {2}❓ Which database/, (row) => `${row}\nunrelated output row`);
    expect(detectClarifyRegion(inserted)).toBeNull();
    const replaced = edited("hermes--clarify-choices.txt", /^ {2}❓ Which database/, () => "  some other output");
    expect(detectClarifyRegion(replaced)).toBeNull();
    const below = edited("hermes--approval.txt", /^ {2}💻 rm -rf/, (row) => `stray line\n${row}`);
    expect(detectApprovalRegion(below)).toBeNull();
    // The spinner that wraps onto a second row is still the spinner.
    expect(detectClarifyRegion(load("hermes--clarify-long.txt"))).not.toBeNull();
  });
});

describe("the dangerous-command approval", () => {
  it("offers Allow once and Deny, never the rows that change Hermes's standing policy", () => {
    const m = liftedModel("hermes--approval.txt");
    expect(m.family).toBe("permission");
    expect(m.question).toBe("Dangerous Command");
    expect(options(m)).toEqual(["1 Allow once", "4 Deny"]);
    expect(m.subject?.map(lineText)).toEqual(["rm -rf /tmp/collie-hermes-lab/scratch-dir", "", "delete in root path"]);
  });

  it("offers Show full command on a long command, and drops it once the command is shown", () => {
    expect(options(liftedModel("hermes--approval-long.txt"))).toEqual(["1 Allow once", "5 Show full command", "4 Deny"]);
    expect(options(liftedModel("hermes--approval-long-full.txt"))).toEqual(["1 Allow once", "4 Deny"]);
  });

  it("withholds Allow once while Hermes shows the command cut short", () => {
    const cut = edited("hermes--approval-long.txt", /^│ dir\/three/, (row) => row.replace("dir/three   ", "… (choose Show full command)").slice(0, row.length + 17));
    const m = detectApprovalRegion(cut)?.model;
    expect(m === undefined ? null : options(m)).toEqual(["5 Show full command", "4 Deny"]);
  });

  // A panel narrower than the notice (inner width 24 to 27) wraps `… (choose Show full command)` onto
  // two rows, and Hermes's smart-deny set (once, deny, view) is short enough to fit that panel.
  it("withholds Allow once when the cut notice wraps, on the once/deny/view set", () => {
    // Built from the capture's plain rows (the grammar reads text): the command's last row replaced
    // by the notice wrapped onto two rows, and the choice set cut to once, deny and view.
    const box = (inner: string) => `│ ${inner.padEnd(62)} │`;
    const rows: string[] = [];
    for (const row of rowsOf(load("hermes--approval-long.txt"))) {
      if (row.startsWith("│ dir/three")) {
        rows.push(box("… (choose Show"), box("full command)"));
        continue;
      }
      if (/[23]\. (Allow for this session|Add to permanent allowlist)/.test(row)) continue;
      rows.push(row.replace("4. Deny", "2. Deny").replace("5. Show full command", "3. Show full command"));
    }
    const m = detectApprovalRegion(splitLines(parseAnsi(rows.join("\n"))))?.model;
    expect(m === undefined ? null : options(m)).toEqual(["3 Show full command", "2 Deny"]);
  });

  it("stays raw when the terminal cut the command for good, or a choice is one it does not know", () => {
    const forGood = edited("hermes--approval.txt", /^│ rm -rf/, (row) => row.replace("rm -rf /tmp/collie-hermes-lab/scratch-dir", "… (command truncated — use /logs or /debug"));
    expect(detectApprovalRegion(forGood)).toBeNull();
    const unknown = edited("hermes--approval.txt", /3\. Add to permanent/, (row) => row.replace("Add to permanent allowlist", "Allow everything forever  "));
    expect(detectApprovalRegion(unknown)).toBeNull();
  });
});

// The operator can turn the status bar off (`/statusbar`, `display` config); Hermes then removes the
// row rather than leaving it blank. Each screen below is a capture with that one row taken out.
describe("with the status bar turned off", () => {
  const withoutStatus = (name: string, also?: (text: string) => boolean) =>
    load(name).filter((l) => {
      const text = lineText(l);
      return !text.startsWith(" ☤ lab-model") && !(also?.(text) ?? false);
    });

  it("still lifts the clarify and the approval, with the hint straight above the input", () => {
    const clarify = detectClarifyRegion(withoutStatus("hermes--clarify-choices.txt"));
    expect(clarify?.model.question).toBe("Which database should the lab use?");
    expect(detectApprovalRegion(withoutStatus("hermes--approval.txt"))?.model.question).toBe("Dangerous Command");
  });

  it("keeps an idle input ready under a reply's box", () => {
    const idle = withoutStatus("hermes--idle.txt");
    expect(hermesAdapter.composerReady!(idle)).toBe(true);
    expect(hermesAdapter.extractStatusLines(idle)).toEqual([]);
  });

  it("still refuses the input while a picker holds the keyboard", () => {
    // Under a picker the bar renders blank, so turning it off removes that blank row.
    const lastBlankAboveRule = (name: string) => {
      const lines = load(name);
      const rule = lines.findIndex((l, i) => i > 0 && /^─{8,}$/.test(lineText(l)) && lineText(lines[i + 1]!).startsWith("❯"));
      return lines.filter((_, i) => i !== rule - 1);
    };
    for (const name of ["hermes--palette.txt", "hermes--model-picker.txt"]) {
      const screen = lastBlankAboveRule(name);
      expect(pickerOpen(screen), name).toBe(true);
      expect(hermesAdapter.composerReady!(screen), name).toBe(false);
    }
  });
});

describe("the input frame", () => {
  it("reads the prompt prefix as the input's state", () => {
    expect(parsePrompt("❯ hello")).toEqual({ state: "idle", length: 2 });
    expect(parsePrompt("assistant ❯ hello")).toEqual({ state: "idle", length: 12 });
    expect(parsePrompt("☤ ❯ msg=interrupt")).toMatchObject({ state: "running" });
    expect(parsePrompt("✎ ❯ answer")).toEqual({ state: "freetext", length: 4 });
    expect(parsePrompt("✎ answer")).toEqual({ state: "freetext", length: 2 });
    expect(parsePrompt("? ❯")).toMatchObject({ state: "clarify" });
    expect(parsePrompt("?")).toMatchObject({ state: "clarify" });
    expect(parsePrompt("⚠ ❯")).toMatchObject({ state: "approval" });
    expect(parsePrompt("🔐 ❯")).toMatchObject({ state: "other" });
    expect(parsePrompt("hello there")).toBeNull();
  });

  const READY = [
    ["hermes--idle.txt", true],
    ["hermes--idle-w60.txt", true],
    ["hermes--draft.txt", true],
    ["hermes--running.txt", true],
    ["hermes--slash-popup.txt", true],
    ["hermes--clarify-other-draft.txt", true],
    ["hermes--clarify-choices.txt", false],
    ["hermes--approval.txt", false],
    ["hermes--model-picker.txt", false],
    ["hermes--palette.txt", false],
    ["hermes--exited.txt", false],
  ] as const;
  for (const [name, ready] of READY) {
    it(`${name}: the composer is ${ready ? "" : "not "}ready`, () => {
      expect(hermesAdapter.composerReady!(load(name))).toBe(ready);
    });
  }

  it("reads the draft as typed: no placeholder, no auto-suggestion, wrapped rows joined, newlines kept", () => {
    expect(hermesAdapter.extractInputDraft(load("hermes--idle.txt"))).toBeNull();
    expect(hermesAdapter.extractInputDraft(load("hermes--running.txt"))).toBeNull();
    expect(hermesAdapter.extractInputDraft(load("hermes--draft.txt"))).toBe("CLARIFY-OPEN");
    expect(hermesAdapter.extractInputDraft(load("hermes--draft-w60.txt"))).toBe("CLARIFY-ONE");
    expect(hermesAdapter.extractInputDraft(load("hermes--slash-popup.txt"))).toBe("/mo");
    expect(hermesAdapter.extractInputDraft(load("hermes--clarify-other-draft.txt"))).toBe("CockroachDB 23.2");
    expect(hermesAdapter.extractInputDraft(load("hermes--clarify-other-draft-w60.txt"))).toBe("Firebird");
    expect(hermesAdapter.extractInputDraft(load("hermes--draft-multiline.txt"))).toBe(
      "line one of the probe\nline two of the probe\nline three",
    );
    expect(hermesAdapter.extractInputDraft(load("hermes--draft-wrapped.txt"))).toBe(
      "This is a deliberately long single line draft for the wrap probe, it keeps going past the width of the lab pane so the composer has to wrap it onto a second row and maybe a third",
    );
  });

  it("binds a reply to the typed-answer row with its prefix, so it cannot land in the input once the question closes", () => {
    expect(hermesAdapter.composerPrompt!(load("hermes--clarify-other-draft.txt"))).toBe("✎ ❯ CockroachDB 23.2");
    expect(hermesAdapter.composerPrompt!(load("hermes--clarify-other-draft-w60.txt"))).toBe("✎ Firebird");
    expect(hermesAdapter.composerPrompt!(load("hermes--draft.txt"))).toBe("❯ CLARIFY-OPEN");
    expect(hermesAdapter.composerPrompt!(load("hermes--clarify-choices.txt"))).toBeNull();
  });

  it("re-surfaces the status bar and takes it and the input off the mirror", () => {
    const lines = load("hermes--idle.txt");
    expect(hermesAdapter.extractStatusLines(lines).map(lineText)[0]).toMatch(/^ ☤ lab-model │/);
    const stripped = stripChrome(lines).map(lineText);
    expect(stripped.some((t) => t.includes("☤ lab-model"))).toBe(false);
    expect(stripped.some((t) => t.startsWith("❯ "))).toBe(false);
  });

  it("tells an open picker from an idle input, and a status bar turned off from a picker", () => {
    expect(pickerOpen(load("hermes--model-picker.txt"))).toBe(true);
    expect(pickerOpen(load("hermes--palette.txt"))).toBe(true);
    expect(pickerOpen(load("hermes--idle.txt"))).toBe(false);
    // No status bar at all: the slot is gone, not blank, so an idle input with a reply box above it
    // is still an idle input.
    const noStatus = load("hermes--idle.txt").filter((l) => !lineText(l).startsWith(" ☤ lab-model"));
    expect(locateInput(noStatus)?.statusRow).toBeNull();
    expect(pickerOpen(noStatus)).toBe(false);
    expect(hermesAdapter.composerReady!(noStatus)).toBe(true);
  });

  it("offers the unread-dialog key on a picker, and only there", () => {
    expect(hermesAdapter.cancelKey).toBe("ctrl+c");
    expect(hermesAdapter.modalOnScreen!(load("hermes--model-picker.txt"))).toBe(true);
    expect(hermesAdapter.modalOnScreen!(load("hermes--palette.txt"))).toBe(true);
    expect(hermesAdapter.modalOnScreen!(load("hermes--idle.txt"))).toBe(false);
    expect(hermesAdapter.modalOnScreen!(load("hermes--exited.txt"))).toBe(false);
  });

  it("claims no modal under a panel, where the card's own rows tick and no tap could land", () => {
    // The card signs the screen's last non-blank rows (unreadDialogSignature). Under a clarify or an
    // approval those are the spinner, the countdown and the status clocks; a tick moves them.
    const ticked = (name: string) =>
      edited(name, /\(\d+s\)$|⏱/, (row) => row.replace(/\((\d+)s\)/, (_m, n: string) => `(${Number(n) - 1}s)`).replace(/⏱ (\d+)s/, (_m, n: string) => `⏱ ${Number(n) + 1}s`));
    for (const name of ["hermes--clarify-multi.txt", "hermes--approval.txt", "hermes--clarify-choices.txt"]) {
      expect(unreadDialogSignature(rowsOf(load(name))), name).not.toBe(unreadDialogSignature(rowsOf(ticked(name))));
      expect(hermesAdapter.modalOnScreen!(load(name)), name).toBe(false);
    }
    // Under a picker they hold still: the status bar renders empty while one is open.
    const picker = load("hermes--model-picker.txt");
    expect(unreadDialogSignature(rowsOf(picker))).not.toMatch(/⏱|\(\d+s\)/);
  });
});
