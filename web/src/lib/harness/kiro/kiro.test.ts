import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type PromptModel, type StyledLine } from "../../blocks";
import { describeAdapterConformance } from "../conformance";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { kiroAdapter } from "./index";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const ALL = readdirSync(PANES).filter((name) => name.endsWith(".txt")).toSorted();
const OWN = ALL.filter((name) => name.startsWith("kiro--"));
const DIALOGS = OWN.filter((name) => name.includes("workspace-trust-") || (!name.includes("viewport") && /(?:approval|shell|read|write|replace)-.*(?:allow|always|deny)-w/.test(name)));
const raw = (name: string): string => readFileSync(join(PANES, name), "utf8");
const linesOf = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const load = (name: string): StyledLine[] => linesOf(raw(name));
const approval = (lines: StyledLine[]): PromptModel => {
  const block = kiroAdapter.buildBlocks(lines).find((candidate) => candidate.kind === "prompt-select");
  if (block?.kind !== "prompt-select") throw new Error("Expected a captured approval");
  return block.prompt;
};
const baseName = "kiro--v3-approval-allow-w120.txt";
const movedName = "kiro--v3-approval-deny-w120.txt";
const base = (): PromptModel => approval(load(baseName));
const mutate = (from: string, to: string): StyledLine[] => {
  const text = load(baseName).map(lineText).join("\n");
  expect(text).toContain(from);
  return linesOf(text.replaceAll(from, to));
};

// All existing captures are the foreign/neutral negative leg, including other agents' composers.
// Kiro's unsupported modals and ordinary composers belong to neutral: none may emit a hot button.
describeAdapterConformance(kiroAdapter, {
  ownFixtures: DIALOGS,
  foreignFixtures: ALL.filter((name) => !name.startsWith("kiro--")),
  neutralFixtures: OWN.filter((name) => !DIALOGS.includes(name)),
});

describe("Kiro V3 approvals captured from kiro-cli 2.32.0", () => {
  it("shows the exact request and exposes only one-shot choices and the printed close key", () => {
    // Given: the captured first row is pointed.
    const model = base();
    // When: the panel is lifted through the adapter's public pipeline.
    // Then: the resource stays visible and persistent choices are not buttons.
    expect(model.family).toBe("permission");
    expect(model.question).toBe("Print the probe message requires approval");
    expect(model.subject?.map(lineText).join("\n")).toContain("shell → printf collie_approve_once_probe");
    expect(model.options).toEqual([
      { label: "Allow", keys: ["Enter"], keyLabel: "❯" },
      { label: "Deny", keys: ["Down", "Down", "Enter"], keyLabel: "" },
      { label: "Close", keys: ["Escape"], keyLabel: "Esc" },
    ]);
    expect(model.clampedEnds).toBeUndefined();
    expect(model.signature).toContain("Always deny");
    expect(model.options.flatMap((option) => option.keys).some((key) => /^\d+$/.test(key))).toBe(false);
  });

  it("retains walk identity while the pointer and trust-row footer change", () => {
    // Given: three real captures of one request, with a different selected row.
    const allow = base();
    const deny = approval(load(movedName));
    const trust = approval(load("kiro--v3-approval-always-w120.txt"));
    // When: committing and walk comparisons run independently.
    // Then: entry refuses a moved pointer, but walking through the hidden trust row is safe.
    for (const next of [deny, trust]) {
      expect(promptsEqual(allow, next)).toBe(false);
      expect(promptsSameIdentity(allow, next)).toBe(true);
      expect(promptsSameIdentity(next, allow)).toBe(true);
    }
    expect(deny.options.map((option) => option.keys)).toEqual([
      ["Up", "Up", "Enter"], ["Enter"], ["Escape"],
    ]);
    expect(trust.options.map((option) => option.keys)).toEqual([
      ["Up", "Enter"], ["Down", "Enter"], ["Escape"],
    ]);
  });

  it.each([
    ["printf collie_approve_once_probe", "printf collie_other_request"],
    ["Print the probe message", "Run a different operation"],
  ])("refuses identity when %s changes", (from, to) => {
    // Given: only one request field changes in a real capture.
    const changed = approval(mutate(from, to));
    // When: a mid-walk poll compares the requests.
    // Then: the new request cannot receive the old approval.
    expect(promptsSameIdentity(base(), changed)).toBe(false);
    expect(promptsEqual(base(), changed)).toBe(false);
  });

  it.each([
    ["   Always allow", "   Allow all tools"],
    ["   Deny", "   Deny\n   Extra action"],
    ["   Always deny", "   Always deny\n ❯ Allow"],
    [" ❯ Allow", "   Allow"],
    [" shell → printf", " fs_read → printf"],
    ["printf collie_approve_once_probe", "printf collie_approve…"],
    ["requires approval", "requires approval · Modify request"],
    ["esc to close", "esc to approve"],
    ["↑↓ to navigate", "1-4 to choose"],
    [" ❯ Allow", " ❯ Allow and remember forever"],
  ])("declines an uncaptured or incomplete layout: %s", (from, to) => {
    // Given: a mutation of the real approval's labels, ownership or shape.
    const lines = mutate(from, to);
    // When: the adapter tries to lift it.
    // Then: no interactive prompt is emitted and text typing is blocked.
    expect(kiroAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
    expect(kiroAdapter.composerReady?.(lines)).toBe(false);
  });

  it("binds the shell arguments that only the preview above the panel shows", () => {
    // Given: two calls of one command, with and without `timeout`, that draw the same panel.
    const withTimeout = load("kiro--v3-shell-args-allow-w120.txt");
    const without = load("kiro--v3-shell-args-no-timeout-allow-w120.txt");
    const panel = (lines: StyledLine[]): string[] => lines.slice(lines.findIndex((line) => lineText(line).startsWith("─"))).map(lineText);
    expect(panel(withTimeout)).toEqual(panel(without));
    // When: both are lifted.
    const first = approval(withTimeout);
    const second = approval(without);
    // Then: the card shows every argument, and one call's approval cannot answer the other.
    expect(first.subject?.map(lineText).join("\n")).toContain("cwd=sub, run_in_background=true, timeout=5000");
    expect(promptsSameIdentity(first, second)).toBe(false);
  });

  it("stays on the terminal when the shell preview is missing or names another command", () => {
    // Given: the real panel without its preview, and under a preview of a different command.
    const lines = load(baseName);
    const divider = lines.findIndex((line) => lineText(line).startsWith("─"));
    const bare = lines.slice(divider);
    const other = mutate("↓ Shell printf collie_approve_once_probe", "↓ Shell printf collie_other_request");
    // When: the adapter tries to lift them.
    // Then: neither is a native card, because the panel alone hides the other arguments.
    for (const buffer of [bare, other]) {
      expect(kiroAdapter.buildBlocks(buffer).every((block) => block.kind === "raw")).toBe(true);
    }
  });

  it("does not lift transcript quotations or a modal left above a normal composer", () => {
    // Given: copied transcript text, and a dismissed modal followed by the real idle frame.
    const quoted = linesOf(load(baseName).map((line) => `  ${lineText(line)}`).join("\n"));
    const remnants = [...load(baseName), ...load("kiro--v3-idle-w120.txt")];
    // When: these buffers are read through the adapter.
    // Then: neither copied dialog is actionable; only the actual composer is typeable.
    for (const lines of [quoted, remnants]) {
      expect(kiroAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
    }
    expect(kiroAdapter.composerReady?.(quoted)).toBe(false);
    expect(kiroAdapter.composerReady?.(remnants)).toBe(true);
    expect(kiroAdapter.modalOnScreen?.(remnants)).toBe(false);
  });
});

describe("normal composer and unsupported Kiro panels", () => {
  it.each([120, 60])("extracts a literal draft and styled status at %i columns", (width) => {
    // Given: actual idle and typed frames at this width.
    const idle = load(`kiro--v3-idle-w${width}.txt`);
    const draft = load(`kiro--v3-draft-w${width}.txt`);
    // When: the public chrome probes run.
    // Then: normal text can be verified without authorizing a modal.
    expect(kiroAdapter.composerReady?.(idle)).toBe(true);
    expect(kiroAdapter.composerReady?.(draft)).toBe(true);
    expect(kiroAdapter.extractInputDraft(idle)).toBeNull();
    expect(kiroAdapter.extractInputDraft(draft)).toBe("collie normal draft probe");
    expect(kiroAdapter.extractStatusLines(draft).map(lineText).join("\n")).toContain("qwen3-coder-next");
    expect(kiroAdapter.extractStatusLines(draft).some((line) => line.segments.some((segment) => segment.fg !== undefined))).toBe(true);
  });

  it("recovers the captured word-wrapped draft", () => {
    // Given: a real typed single-line message wrapping at 60 columns.
    const lines = load("kiro--v3-draft-wrapped-w60.txt");
    // When: the draft is extracted.
    // Then: the text matches the original typed message.
    expect(kiroAdapter.extractInputDraft(lines)).toBe("collie draft with harmless printable words continued across a narrow terminal input row without submitting");
  });

  it("rejects a picker that leaves a real composer underneath", () => {
    // Given: the captured composer followed by a synthetic unread overlay tail, not a fixture capture.
    const lines = [...load("kiro--v3-idle-w120.txt"), ...load("kiro--v3-approval-edit-w120.txt")];
    // When: typing readiness is queried.
    // Then: the last modal owns the keyboard even though a composer exists higher up.
    expect(kiroAdapter.composerReady?.(lines)).toBe(false);
  });

  it("reads a draft as tall as the bridge's frame allows", () => {
    // Given: the captured draft with 45 wrapped rows under its prompt, past the old 40-row bound.
    const wrapped = Array.from({ length: 45 }, (_, i) => `  row${i + 1}`).join("\n");
    const lines = linesOf(raw("kiro--v3-draft-w120.txt").replace("collie normal draft probe", `collie normal draft probe\n${wrapped}`));
    // When: readiness and draft extraction run.
    // Then: the box is typeable and every wrapped row is part of the draft.
    expect(kiroAdapter.composerReady?.(lines)).toBe(true);
    expect(kiroAdapter.extractInputDraft(lines)).toBe(`collie normal draft probe ${Array.from({ length: 45 }, (_, i) => `row${i + 1}`).join(" ")}`);
  });

  it("accepts the cwd right-aligned on the context bar's own row", () => {
    // Given: a 120-column idle frame from kiro-cli 2.32.0 whose short cwd fits beside the gauge.
    const lines = load("kiro--v3-idle-oneline-w120.txt");
    // When: readiness, draft and status extraction run.
    // Then: the frame is a typeable composer with no draft, and the bar keeps its cwd.
    expect(kiroAdapter.composerReady?.(lines)).toBe(true);
    expect(kiroAdapter.extractInputDraft(lines)).toBeNull();
    expect(kiroAdapter.extractStatusLines(lines).map(lineText).join("\n")).toContain("/tmp/kiro-fixture/demo");
  });

  it("reads a draft under a right-aligned cwd that wraps mid-path", () => {
    // Given: a typed draft while the bar's cwd wraps as `/tmp/kiro-fixture/de` then `mo`.
    const lines = load("kiro--v3-draft-cwd-wrapped-w120.txt");
    // When: readiness and draft extraction run.
    // Then: the box is typeable and the wrapped draft is recovered.
    expect(kiroAdapter.composerReady?.(lines)).toBe(true);
    expect(kiroAdapter.extractInputDraft(lines)).toBe("Create a new file greet.py: a Python function greet(name) whose body, indented four spaces, sets message = f'hi {name}', then one blank line, then returns message. Do not run anything.");
  });

  it("accepts the V2 engine's composer, which prints only the copy hint", () => {
    // Given: an idle `kiro-cli chat --v2` frame from kiro-cli 2.32.0.
    const lines = load("kiro--v2-idle-w119.txt");
    // When: readiness runs.
    // Then: the phone may type into it, as it could before Kiro had an adapter.
    expect(kiroAdapter.composerReady?.(lines)).toBe(true);
    expect(kiroAdapter.extractInputDraft(lines)).toBeNull();
  });

  it("fails closed on a shell or torn composer frame", () => {
    // Given: a shell, an echoed draft, and an idle frame missing its context gauge.
    for (const text of ["tester@host $", "› copied text", raw("kiro--v3-idle-w120.txt").replace("◔", "?")]) {
      // When: readiness and positive modal evidence run.
      const lines = linesOf(text);
      // Then: none authorizes a text send or invents a cancel card.
      expect(kiroAdapter.composerReady?.(lines)).toBe(false);
      expect(kiroAdapter.modalOnScreen?.(lines)).toBe(false);
    }
  });
});
