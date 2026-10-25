import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { describeAdapterConformance } from "./conformance";
import { buildBlocks } from "./index";
import { piAdapter } from "./pi";
import { draftCarriesSend } from "../draft-match";
import { adapterFor } from "./registry";

const PANES = join(import.meta.dirname, "../../fixtures/panes");
const fixtures = readdirSync(PANES).filter((name) => name.endsWith(".txt")).toSorted();
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));
const pi = fixtures.filter((name) => name.startsWith("pi--"));
// Every pi screen that lifts (pi/ask.test.ts names what each one lifts as). The rest of the pi corpus
// is the raw cohort: editors, answer editors, multi-selects, a pointer on the free-text row, an
// incomplete Submit page and pi's own /model picker.
const lifted = pi.filter((name) => piAdapter.buildBlocks(load(name)).some((block) => block.kind !== "raw"));

describeAdapterConformance(piAdapter, {
  ownFixtures: lifted,
  neutralFixtures: pi.filter((name) => !lifted.includes(name)),
  foreignFixtures: fixtures.filter((name) => !name.startsWith("pi--")),
  // The slash palette pushes the editor frame out of the bridge's six-row tail window. Beside OmO's
  // side panel the editor is read from rows cropped at the panel (pi/panel.ts), which the bridge
  // cannot find on the screen, so the write goes out unbound. An extension's footer of five rows under
  // its own widget row does the same to the inset editor (issue 544); the reporter's idle and draft
  // captures have six rows under the box, the widget row among them.
  unboundComposerFixtures: [
    "pi--v130-powerline-editor-running--w254.txt",
    "pi--v130-powerline-editor-idle-footer--w254.txt",
    "pi--v130-powerline-editor-two-row-draft-footer--w254.txt",
    "pi--v110-slash-palette.txt",
    "pi--v120-slash-palette-padded.txt",
    "pi--omo-v5130-panel-draft.txt",
    "pi--omo-v5130-panel-phantom.txt",
    "pi--omo-v5130-panel-running.txt",
    "pi--omo-v5130-panel-slash-model.txt",
  ],
});

describe("pi adapter routing", () => {
  it("lifts every question screen the corpus proves, and no fewer", () => {
    expect(lifted).toHaveLength(53);
  });

  it.each([
    ["pi--omo-v5130-single-described.txt", "prompt-select"],
    ["pi--omo-v5130-panel-question.txt", "prompt-select"],
    ["pi--omo-v5130-panel-question-cut.txt", "prompt-select"],
    ["pi--v0871-nocolor-question.txt", "prompt-select"],
    ["pi--omo-v5130-nocolor-question.txt", "prompt-select"],
    ["pi--v0871-question-single.txt", "prompt-select"],
    ["pi--v0871-permission-gate.txt", "prompt-select"],
    ["pi--v110-questionnaire-submit-ready.txt", "wizard"],
  ])("lifts %s through the public pi dispatch", (name, kind) => {
    const lines = load(name);
    expect(buildBlocks(lines, { agent: "pi" }).map((block) => block.kind)).toContain(kind);
    expect(adapterFor("pi")?.composerReady?.(lines)).toBe(false);
  });

  it.each([
    "pi--omo-v5130-multi.txt",
    "pi--omo-v5130-single-other-focused.txt",
    "pi--omo-v5130-answer-editor.txt",
    "pi--v0871-question-other-focused.txt",
    "pi--v0871-question-answer-editor.txt",
    "pi--v110-questionnaire-submit-incomplete.txt",
    "pi--v110-multi.txt",
    "pi--v110-core-selector.txt",
    "pi--omo-v5130-picker-model.txt",
    "pi--omo-v5130-picker-tree.txt",
    "pi--omo-v5130-picker-resume.txt",
    "pi--omo-v5130-panel-picker-tree.txt",
    "pi--omo-v5130-panel-question-cut-footer.txt",
    "pi--omo-v5130-panel-picker-tree-cut.txt",
    "pi--v110-stock-picker-resume.txt",
    "pi--v110-stock-picker-tree.txt",
  ])("offers only the printed Escape key on the unmodelled %s", (name) => {
    const lines = load(name);
    expect(piAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
    expect(piAdapter.composerReady?.(lines)).toBe(false);
    expect(buildBlocks(lines, { agent: "pi" }).map((block) => block.kind)).toContain("unread-dialog");
  });

  // pi 1.2.0's /settings and /scoped-models were read as a ready editor (found capturing padded screens
  // for #442). They hold the send now, as an unread dialog: the phone shows the raw mirror and the
  // printed keys, the same block as pi's /model. The options are NOT readable as a pointed list yet, so
  // nothing here is answerable; a raw modal that blocks sending is the 1.21.3 scope.
  it.each([
    "pi--v120-settings-padded2.txt",
    "pi--v120-scoped-models-padded2.txt",
  ])("holds the send on %s as an unread, unanswerable dialog, the same block kind as /model", (name) => {
    const lines = load(name);
    const kinds = (l: typeof lines) => buildBlocks(l, { agent: "pi" }).map((block) => block.kind);
    expect(piAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
    expect(piAdapter.composerReady?.(lines)).toBe(false);
    expect(piAdapter.modalOnScreen?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(kinds(lines)).toContain("unread-dialog");
    expect(kinds(lines)).toEqual(kinds(load("pi--v110-core-selector.txt")));
  });

  // Issue 416: a default OmO install, whose last status row is a plain badge, and its slash
  // commands, whose completion list stands under the editor.
  it.each([
    ["pi--omo-v5130-plain-idle.txt", null],
    ["pi--omo-v5130-plain-draft.txt", "hello collie draft"],
    ["pi--omo-v5130-plain-running.txt", null],
    ["pi--omo-v5130-slash-model.txt", "/model"],
    ["pi--omo-v5130-slash-compact.txt", "/compact"],
    ["pi--omo-v5130-question-banner.txt", null],
    ["pi--omo-v5130-panel-idle.txt", null],
  ])("sends to the default OmO install: %s is a composer bound to its frame", (name, draft) => {
    const lines = load(name);
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBe(draft);
    expect(piAdapter.composerPrompt?.(lines)).not.toBeNull();
    expect(piAdapter.modalOnScreen?.(lines)).toBe(false);
  });

  // NO_COLOR=1 (captured 2026-10-15, fixtures README): pi 0.87.1 and OmO 5.1.30 both had the variable
  // in their environment and painted every row as before, so the paint-based readers read them as
  // they read the colour captures. No monochrome pi screen exists to read, so none is guessed at.
  it.each([
    ["pi--v0871-nocolor-draft.txt", "collie stock pi draft probe"],
    ["pi--omo-v5130-nocolor-idle.txt", null],
  ])("reads %s, run with NO_COLOR=1, as a composer bound to its frame", (name, draft) => {
    const lines = load(name);
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBe(draft);
    expect(piAdapter.composerPrompt?.(lines)).not.toBeNull();
    expect(piAdapter.modalOnScreen?.(lines)).toBe(false);
    // Painted, as without NO_COLOR: the status rows carry colour.
    expect(piAdapter.extractStatusLines(lines)[0]!.segments.some((s) => s.fg !== undefined)).toBe(true);
  });

  // The side panel (#412): the editor is read from rows cropped at the panel, so no panel text
  // reaches the draft, and the write is unbound because the bridge matches whole screen rows.
  it.each([
    ["pi--omo-v5130-panel-draft.txt", "hello collie draft"],
    ["pi--omo-v5130-panel-phantom.txt", null],
    ["pi--omo-v5130-panel-running.txt", null],
    ["pi--omo-v5130-panel-slash-model.txt", "/model"],
  ])("reads %s beside the side panel without the panel's text", (name, draft) => {
    const lines = load(name);
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBe(draft);
    expect(piAdapter.composerPrompt?.(lines)).toBeNull();
    // The status rows end at the panel's column too: 91 here, the editor's rule.
    const status = piAdapter.extractStatusLines?.(lines) ?? [];
    expect(status.length).toBeGreaterThan(0);
    for (const line of status) expect(line.segments.map((s) => s.text).join("").trimEnd().length).toBeLessThanOrEqual(91);
  });

  it("keeps pi's own /model picker on the mirror and reads no draft from it", () => {
    const lines = load("pi--v110-core-selector.txt");
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(piAdapter.buildBlocks(lines)).toEqual([{ kind: "raw", lines }]);
  });

  it("retains the raw mirror when the terminal view disables grammars", () => {
    const lines = load("pi--omo-v5130-single-described.txt");
    expect(buildBlocks(lines, { agent: "pi", grammars: false })).toEqual([{ kind: "raw", lines }]);
  });

  it("allows the captured OmO composer and binds its input frame", () => {
    const lines = load("pi--omo-v5130-idle.txt");
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(piAdapter.composerPrompt?.(lines)).not.toBeNull();
    expect(buildBlocks(lines, { agent: "pi" }).every((block) => block.kind === "raw")).toBe(true);
  });

  it.each([
    ["pi--v0851-idle.txt", "pi--v0851-draft.txt"],
    ["pi--v0871-idle.txt", "pi--v0871-draft.txt"],
    ["pi--v110-stock-idle.txt", "pi--v110-stock-draft.txt"],
  ])("keeps stock pi sendable: %s is a composer and its draft reads back", (idleName, draftName) => {
    const idle = load(idleName);
    expect(piAdapter.composerReady?.(idle)).toBe(true);
    expect(piAdapter.extractInputDraft(load(draftName))).toBe("collie stock pi draft probe");
    expect(buildBlocks(idle, { agent: "pi" }).every((block) => block.kind === "raw")).toBe(true);
  });

  // Issue 442: with `editorPaddingX` above 0 the typed draft opens with a space. The guarded send
  // (lib/reply-action.ts) types only on a ready composer and presses Enter only when composerReady
  // still holds and the draft reads back, so each fixture must pass both reads.
  it.each([
    ["pi--v120-idle-padded.txt", null],
    ["pi--v120-draft-unpadded.txt", "hello from the probe"],
    ["pi--v120-draft-padded.txt", "hello from the probe"],
    ["pi--v120-draft-padded-multiline.txt", "line one line two"],
    ["pi--v120-slash-palette-padded.txt", "/"],
  ])("keeps a pi pane with editor padding sendable: %s", (name, draft) => {
    const lines = load(name);
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBe(draft);
    expect(piAdapter.modalOnScreen?.(lines)).toBe(false);
    expect(buildBlocks(lines, { agent: "pi" }).every((block) => block.kind === "raw")).toBe(true);
    if (draft !== null) expect(draftCarriesSend(draft, piAdapter.extractInputDraft(lines))).toBe(true);
  });

  // Issue 544: pi-powerline-footer's editor, one column in, under its widget row and a five-row footer.
  it("reads an extension's inset editor as a composer and takes it off the mirror", () => {
    const lines = load("pi--v130-powerline-editor-running--w254.txt");
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(piAdapter.modalOnScreen?.(lines)).toBe(false);
    expect(piAdapter.extractStatusLines(lines)).toHaveLength(5);
    const [block] = buildBlocks(lines, { agent: "pi" });
    expect(block?.kind === "raw" ? block.lines.length : 0).toBe(14);
  });

  // Issue 594, live (2026-10-25): the same editor under a goal widget that ticks its seconds over the
  // box, idle and in a running turn with five rows under the box, and a fresh session's welcome splash
  // that the first key clears. Each is a ready composer with no draft and no dialog.
  it.each([
    ["pi--v130-powerline-goal-widget-idle--w254.txt", 4],
    ["pi--v130-powerline-goal-widget-running--w254.txt", 4],
    ["pi--v130-powerline-welcome-idle--w254.txt", 4],
    ["pi--v130-powerline-welcome-gone--w254.txt", 4],
  ] as const)("reads %s as a ready composer with %i status rows (the running one has its prompt widget row too)", (name, under) => {
    const lines = load(name);
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(piAdapter.modalOnScreen?.(lines)).toBe(false);
    expect(piAdapter.extractStatusLines(lines)).toHaveLength(under);
  });

  // Issue 544, live: the same editor with no footer under it, a wrapped draft, and pi's own selector.
  it("reads the live inset editor with no footer, and never pi's selector under the extension", () => {
    const draft = load("pi--v130-powerline-editor-walky-draft--w120.txt");
    expect(piAdapter.composerReady?.(draft)).toBe(true);
    expect(piAdapter.extractInputDraft(draft)).toBe("[walky-talky wt_0a1b2c3d4e5f] from operator (Phone) Reply with exactly WALKY-1 and nothing else.");
    const selector = load("pi--v130-powerline-model-selector--w120.txt");
    expect(piAdapter.composerReady?.(selector)).toBe(false);
    expect(piAdapter.modalOnScreen?.(selector)).toBe(true);
  });

  it.each(["pi--v0871-narrow-idle.txt", "pi--v110-stock-narrow-idle.txt", "pi--v0871-question-answered.txt"])(
    "reads %s as a ready composer",
    (name) => {
      expect(piAdapter.composerReady?.(load(name))).toBe(true);
    },
  );

  it.each([
    "pi--prose-quoted-dialog-above-editor.txt",
    "pi--prose-quoted-omo-dialog-above-editor.txt",
    "pi--prose-quoted-dialog-in-tool-result.txt",
  ])("keeps %s sendable: the quoted dialog stays prose, the editor below is the composer", (name) => {
    const lines = load(name);
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(buildBlocks(lines, { agent: "pi" }).every((block) => block.kind === "raw")).toBe(true);
  });

  it("shows a quoted dialog under which pi exited as raw text with no card", () => {
    const lines = load("pi--prose-quoted-dialog-then-shell.txt");
    expect(piAdapter.composerReady?.(lines)).toBe(false);
    expect(buildBlocks(lines, { agent: "pi" })).toEqual([{ kind: "raw", lines }]);
  });

  it("strips the editor off the mirror on an idle screen", () => {
    const lines = load("pi--v0871-draft.txt");
    const [block] = buildBlocks(lines, { agent: "pi" });
    expect(block?.kind).toBe("raw");
    expect(block?.kind === "raw" ? block.lines.length : 0).toBeLessThan(lines.length);
  });
});

describe("pi: the folder trust prompt lifts as a walked trust card (1.2.0)", () => {
  const promptOf = (lines: ReturnType<typeof load>) => {
    const block = piAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    return block?.kind === "prompt-select" ? block.prompt : null;
  };

  it("walks from the pointer to each option, and Escape cancels, as the footer names them", () => {
    const prompt = promptOf(load("pi--trust-prompt.txt"));
    expect(prompt?.family).toBe("trust");
    expect(prompt?.question).toBe("Trust project folder?");
    expect(prompt?.options.map((o) => [o.label, o.keys.join("+")])).toEqual([
      ["Trust", "Enter"],
      ["Trust parent folder", "Down+Enter"],
      ["Trust (this session only)", "Down+Down+Enter"],
      ["Do not trust", "Down+Down+Down+Enter"],
      ["Do not trust (this session only)", "Down+Down+Down+Down+Enter"],
      ["Cancel", "Escape"],
    ]);
    expect(piAdapter.composerReady?.(load("pi--trust-prompt.txt"))).toBe(false);
  });

  it("names the parent folder, wrapped on screen, as that option's description", () => {
    const parent = promptOf(load("pi--trust-prompt.txt"))?.options[1];
    expect(parent?.description).toMatch(/^\(\/tmp\/collie-pi-sandbox\/\S+\/sandboxdir\)$/);
  });

  it("walks up from a moved pointer; the signature moves and the core does not", () => {
    const first = promptOf(load("pi--trust-prompt.txt"));
    const moved = promptOf(load("pi--trust-prompt-moved.txt"));
    expect(moved?.options.slice(0, 3).map((o) => o.keys.join("+"))).toEqual(["Up+Enter", "Enter", "Down+Enter"]);
    expect(moved?.signature).not.toBe(first?.signature);
    expect(moved?.coreSignature).toBe(first?.coreSignature);
  });

  it("starts the card at the first option, so the folder and the explanation stay in the mirror", () => {
    const [raw, card] = piAdapter.buildBlocks(load("pi--trust-prompt.txt"));
    expect(card?.kind === "prompt-select" && card.lines.map((l) => l.segments.map((g) => g.text).join(""))[0]?.trim()).toBe(
      "→ Trust",
    );
    const mirror = raw?.kind === "raw" ? raw.lines.map((l) => l.segments.map((g) => g.text).join("")).join("\n") : "";
    expect(mirror).toContain("This allows pi to load .pi settings");
  });

  it("does not lift a list holding an option it does not know", () => {
    const rows = load("pi--trust-prompt.txt").map((l) =>
      l.segments.map((g) => g.text).join("").replace("Do not trust (this session only)", "Trust everything forever        "),
    );
    expect(promptOf(splitLines(parseAnsi(rows.join("\n"))))).toBeNull();
  });
});
