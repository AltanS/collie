import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type PromptModel, type StyledLine } from "../../blocks";
import { verifyPromptBinding } from "../../../../../bridge/prompt-binding";
import { describeAdapterConformance } from "../conformance";
import { withUnreadDialog } from "../index";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { kiroAdapter } from "./index";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const ALL = readdirSync(PANES).filter((name) => name.endsWith(".txt")).toSorted();
const OWN = ALL.filter((name) => name.startsWith("kiro--"));
const DIALOGS = OWN.filter((name) => !name.includes("viewport") && /(?:approval-(?:allow|always|deny)|deny-request|(?:read|write|replace).*-(?:allow|always|deny)-w)/.test(name));
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
  return linesOf(text.replace(from, to));
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

  it("binds real captures and refuses a stale resource or selected row", () => {
    // Given: a region from the captured Allow state.
    const region = base().signature;
    // When: the bridge's existing text-binding verifier checks terminal buffers.
    // Then: the same screen passes; another pointer or request does not.
    expect(verifyPromptBinding(raw(baseName), region).ok).toBe(true);
    expect(verifyPromptBinding(raw(movedName), region).ok).toBe(false);
    expect(verifyPromptBinding(raw(baseName).replace("collie_approve_once_probe", "collie_stale_probe"), region).ok).toBe(false);
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
    const region = kiroAdapter.composerPrompt?.(draft);
    if (region == null) throw new Error("Expected a bound composer");
    expect(region).toContain("› collie normal draft probe");
    expect(verifyPromptBinding(raw(`kiro--v3-draft-w${width}.txt`), region).ok).toBe(true);
  });

  it("recovers the captured word-wrapped draft", () => {
    // Given: a real typed single-line message wrapping at 60 columns.
    const lines = load("kiro--v3-draft-wrapped-w60.txt");
    // When: the draft is extracted.
    // Then: the text matches the original typed message.
    expect(kiroAdapter.extractInputDraft(lines)).toBe("collie draft with harmless printable words continued across a narrow terminal input row without submitting");
  });

  it.each(["kiro--v3-approval-edit-w120.txt", "kiro--v3-approval-clipped-w40.txt"])(
    "%s remains visible with the proven Escape control and no composer", (name) => {
      // Given: a real unsupported panel, one with its own › feedback field.
      const lines = load(name);
      // When: the shared unread-dialog post-pass runs.
      const blocks = withUnreadDialog(kiroAdapter, lines, kiroAdapter.buildBlocks(lines));
      // Then: the modal is not mistaken for a composer and the full terminal remains on the card.
      expect(kiroAdapter.composerReady?.(lines)).toBe(false);
      expect(kiroAdapter.composerPrompt?.(lines)).toBeNull();
      expect(kiroAdapter.extractInputDraft(lines)).toBeNull();
      expect(kiroAdapter.extractStatusLines(lines)).toEqual([]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: "unread-dialog", cancel: { key: "Escape", agent: "kiro" }, lines });
    },
  );

  it("rejects a picker that leaves a real composer underneath", () => {
    // Given: the captured composer followed by a synthetic unread overlay tail, not a fixture capture.
    const lines = [...load("kiro--v3-idle-w120.txt"), ...load("kiro--v3-approval-edit-w120.txt")];
    // When: typing readiness is queried.
    // Then: the last modal owns the keyboard even though a composer exists higher up.
    expect(kiroAdapter.composerReady?.(lines)).toBe(false);
    expect(kiroAdapter.composerPrompt?.(lines)).toBeNull();
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

  it("binds a draft under a right-aligned cwd that wraps mid-path", () => {
    // Given: a typed draft while the bar's cwd wraps as `/tmp/kiro-fixture/de` then `mo`.
    const lines = load("kiro--v3-draft-cwd-wrapped-w120.txt");
    // When: readiness, draft extraction and the composer binding run.
    const region = kiroAdapter.composerPrompt?.(lines);
    // Then: the wrapped draft is recovered and the bridge accepts the literal binding.
    expect(kiroAdapter.composerReady?.(lines)).toBe(true);
    expect(kiroAdapter.extractInputDraft(lines)).toBe("Create a new file greet.py: a Python function greet(name) whose body, indented four spaces, sets message = f'hi {name}', then one blank line, then returns message. Do not run anything.");
    if (region == null) throw new Error("Expected a bound composer");
    expect(verifyPromptBinding(raw("kiro--v3-draft-cwd-wrapped-w120.txt"), region).ok).toBe(true);
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
    // Given: a shell, an echoed draft, an idle frame missing its context gauge, and a one-row bar without a cwd.
    const oneRow = raw("kiro--v3-idle-oneline-w120.txt");
    for (const text of ["tester@host $", "› copied text", raw("kiro--v3-idle-w120.txt").replace("◔", "?"), oneRow.replace("/tmp/kiro-fixture/demo", "tmp-kiro-fixture-demo/")]) {
      // When: readiness and positive modal evidence run.
      const lines = linesOf(text);
      // Then: none authorizes a text send or invents a cancel card.
      expect(kiroAdapter.composerReady?.(lines)).toBe(false);
      expect(kiroAdapter.modalOnScreen?.(lines)).toBe(false);
    }
  });
});
