import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPromptBinding } from "../../../../../bridge/prompt-binding";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type PromptModel, type StyledLine } from "../../blocks";
import { withUnreadDialog } from "../index";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { kiroAdapter } from "./index";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const raw = (name: string): string => readFileSync(join(PANES, `kiro--v3-${name}.txt`), "utf8");
const linesOf = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const load = (name: string): StyledLine[] => linesOf(raw(name));
const modelOf = (lines: StyledLine[]): PromptModel => {
  const block = kiroAdapter.buildBlocks(lines).find((candidate) => candidate.kind === "prompt-select");
  if (block?.kind !== "prompt-select") throw new Error("Expected a captured file approval");
  return block.prompt;
};
const changed = (name: string, from: string, to: string): StyledLine[] => {
  const text = load(name).map(lineText).join("\n");
  expect(text).toContain(from);
  return linesOf(text.replace(from, to));
};

// Tool IDs and capabilities are the ones kiro-cli 2.32.0 prints on its panels. The
// permission capability is not the tool ID: both fs_write and str_replace use fs_write.
const FILES = [
  ["read", "Read File", "fs_read", "read-once.txt"],
  ["write", "Write File", "fs_write", "write-once.txt"],
  ["replace", "Replace in File", "fs_write", "replace.txt"],
  ["read-wrapped", "Read File", "fs_read", "resource rows.txt"],
] as const;

describe("installed V3 filesystem approvals", () => {
  it.each(FILES)("%s keeps its full preview and one-shot menu at both widths", (stem, title, capability, path) => {
    // Given: real captures of one pending tool with Allow and Deny pointed.
    for (const width of [120, 60]) {
      const allowName = `${stem}-allow-w${width}`;
      const denyName = `${stem}-deny-w${width}`;
      const allow = modelOf(load(allowName));
      const deny = modelOf(load(denyName));
      // When: the adapter produces a card and the bridge checks its literal binding.
      // Then: the whole pending preview is visible and the real three-row menu is walked.
      expect(allow.question).toBe(`${title} requires approval`);
      const subject = allow.subject?.map(lineText).join("\n") ?? "";
      expect(subject).toContain(`${capability} →`);
      expect(subject).toContain(path);
      expect(subject).toContain("↓ ");
      expect(allow.options).toEqual([
        { label: "Allow", keys: ["Enter"], keyLabel: "❯" },
        { label: "Deny", keys: ["Down", "Enter"], keyLabel: "" },
        { label: "Close", keys: ["Escape"], keyLabel: "Esc" },
      ]);
      expect(deny.options.map((option) => option.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
      expect(allow.clampedEnds).toBeUndefined();
      expect(allow.signature).toContain("Always deny");
      expect(promptsEqual(allow, deny)).toBe(false);
      expect(promptsSameIdentity(allow, deny)).toBe(true);
      expect(promptsSameIdentity(deny, allow)).toBe(true);
      expect(verifyPromptBinding(raw(allowName), allow.signature).ok).toBe(true);
      expect(verifyPromptBinding(raw(denyName), allow.signature).ok).toBe(false);
    }
  });

  it("shows every line of the captured multiline write diff", () => {
    // Given: an actual fifteen-line proposal whose preview fits the viewport.
    const allow = modelOf(load("write-lines-allow-w120"));
    const deny = modelOf(load("write-lines-deny-w120"));
    const narrow = modelOf(load("write-lines-deny-w60"));
    // When: the full pending diff is lifted and bound to the request.
    // Then: both one- and two-digit line numbers survive, and the pointer remains walkable.
    for (const model of [allow, deny, narrow]) {
      const subject = model.subject?.map(lineText).join("\n") ?? "";
      for (let i = 1; i <= 15; i++) expect(subject).toContain(`collie_clipped_line_${i}`);
      expect(subject).toContain("added 15 lines");
    }
    expect(promptsSameIdentity(allow, deny)).toBe(true);
    expect(verifyPromptBinding(raw("write-lines-allow-w120"), allow.signature).ok).toBe(true);
  });

  it("binds changed replacement content even when the real permission panel is identical", () => {
    // Given: actual first and successor edits of the same disposable file.
    const first = modelOf(load("replace-allow-w120"));
    const successor = modelOf(load("replace-denied-request-allow-w120"));
    // When: comparing the panels separately from their bound pending previews.
    // Then: the panel text is identical, but the changed edit cannot receive the old decision.
    expect(first.signature.slice(first.signature.indexOf("─"))).toBe(successor.signature.slice(successor.signature.indexOf("─")));
    expect(promptsSameIdentity(first, successor)).toBe(false);
    expect(first.subject?.map(lineText).join("\n")).toContain("collie_after_replace");
    expect(successor.subject?.map(lineText).join("\n")).toContain("collie_should_never_replace");
    expect(verifyPromptBinding(raw("replace-denied-request-allow-w120"), first.signature).ok).toBe(false);
  });

  it.each([
    ["read-allow-w120", "(L1-1)", "(L1-2)"],
    ["write-allow-w120", "collie_write_once_marker", "collie_changed_content"],
    ["replace-allow-w120", "collie_after_replace", "collie_changed_content"],
    ["read-wrapped-allow-w60", "resource rows.txt", "successor rows.txt"],
  ])("%s changes identity when its subject changes", (name, from, to) => {
    // Given: a captured approval whose read range, content or path changes.
    const initial = modelOf(load(name));
    const successor = modelOf(changed(name, from, to));
    // When: the generic walk identity compares the two requests.
    // Then: a successor is never authorized by pointer movement.
    expect(promptsSameIdentity(initial, successor)).toBe(false);
    expect(promptsEqual(initial, successor)).toBe(false);
  });

  it.each([
    ["read-allow-w120", " fs_read → read-once.txt", " network → read-once.txt"],
    ["read-allow-w120", " fs_read → read-once.txt", " read_file → read-once.txt"],
    ["read-allow-w120", " Read File requires approval", " Unknown Tool requires approval"],
    ["read-allow-w120", "   Deny", "   Always allow\n   Deny"],
    ["read-allow-w120", " fs_read → read-once.txt", " fs_read → read-once…"],
    ["read-allow-w120", " fs_read → read-once.txt", " fs_read → read-once.txt\u200b"],
    ["read-allow-w120", " fs_read → read-once.txt", " fs_read → read-once.txt\t"],
    ["read-allow-w120", " fs_read → read-once.txt", " fs_read → read-once.txt\u202e"],
    ["read-allow-w120", "(L1-1)", "...+2 hidden lines"],
    ["write-allow-w120", "added 1 line", "added 2 lines"],
    ["write-allow-w120", "collie_write_once_marker", "...+1 hidden line"],
    ["write-allow-w120", "collie_write_once_marker", "collie_write_once_marker\u2066"],
    ["replace-allow-w120", "removed 1 line", "removed 2 lines"],
    ["replace-allow-w120", " Replace in File requires approval", " Replace in File requires approval · Modify request"],
    ["replace-allow-w120", "     1+", "      1+"],
    ["read-wrapped-allow-w60", "\n resource rows.txt", "\n fs_write → another.txt"],
  ])("%s declines an incomplete or unknown subject: %s", (name, from, to) => {
    // Given: a mutation of a captured subject or menu, not a new claimed capture.
    const lines = changed(name, from, to);
    // When: lifting and composer-readiness checks run.
    // Then: the unknown shape remains fully raw and does not authorize typing.
    expect(kiroAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
    expect(kiroAdapter.composerReady?.(lines)).toBe(false);
  });

  it.each(["read", "write", "replace"])("%s refuses a viewport missing the pending preview", (stem) => {
    // Given: only the complete-looking permission panel survived the read window.
    const original = load(`${stem}-allow-w120`);
    const panel = original.slice(original.findIndex((line) => lineText(line).startsWith("─")));
    // When: the adapter sees only its path and menu.
    // Then: it cannot recover the full request and offers no one-shot approval.
    expect(kiroAdapter.buildBlocks(panel).every((block) => block.kind === "raw")).toBe(true);
    expect(kiroAdapter.composerReady?.(panel)).toBe(false);
  });

  it("declines an oversized visible subject", () => {
    // Given: a captured resource changed to exceed the adapter's bounded region size.
    const lines = changed("read-allow-w120", "read-once.txt", "a".repeat(32_001));
    // When: the region is considered for a card.
    // Then: it stays raw rather than hiding part of the subject to fit.
    expect(kiroAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
  });
});

describe("verified MCP key behavior does not prove complete MCP input visibility", () => {
  it.each([
    "mcp-allow-w120", "mcp-deny-w120", "mcp-allow-w60", "mcp-deny-w60",
    "mcp-denied-request-allow-w120", "mcp-denied-request-deny-w120",
    "mcp-wrapped-allow-w120", "mcp-wrapped-deny-w120",
    "mcp-wrapped-allow-w60", "mcp-wrapped-deny-w60", "mcp-wrapped-clipped-w40",
    "replace-edit-w120",
    "write-viewport-allow-w120", "write-viewport-deny-w120",
    "write-viewport-allow-w60", "write-viewport-deny-w60",
  ])("%s preserves all rows with only the proven Escape control", (name) => {
    // Given: a real local stdio echo approval or a native replacement feedback editor.
    const lines = load(name);
    // When: the universal unread-dialog pass handles the unsupported shape.
    const blocks = withUnreadDialog(kiroAdapter, lines, kiroAdapter.buildBlocks(lines));
    // Then: no Allow or Deny button claims that the formatter displayed every argument.
    expect(kiroAdapter.composerReady?.(lines)).toBe(false);
    expect(kiroAdapter.composerPrompt?.(lines)).toBeNull();
    expect(kiroAdapter.extractInputDraft(lines)).toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "unread-dialog", cancel: { key: "Escape", agent: "kiro" }, lines });
  });
});

describe("write and replace panels from an agent that trusts tools", () => {
  it("lifts a write whose diff has indented and blank rows, and walks past Always allow", () => {
    // Given: kiro-cli 2.32.0 captures of one write with Allow, Always allow and Deny pointed.
    const allow = modelOf(load("write-trusted-allow-w120"));
    const always = modelOf(load("write-trusted-always-w120"));
    const deny = modelOf(load("write-trusted-deny-w120"));
    // When: the adapter lifts each pointer position.
    // Then: the full diff is the subject, Deny skips the trust row, and all three are one request.
    const subject = allow.subject?.map(lineText).join("\n") ?? "";
    expect(subject).toContain("     2+      message = f'hi {name}'");
    expect(subject).toMatch(/^ {5}3\+ *$/m);
    expect(allow.options.map((option) => option.keys)).toEqual([["Enter"], ["Down", "Down", "Enter"], ["Escape"]]);
    expect(always.options.map((option) => option.keys)).toEqual([["Up", "Enter"], ["Down", "Enter"], ["Escape"]]);
    expect(deny.options.map((option) => option.keys)).toEqual([["Up", "Up", "Enter"], ["Enter"], ["Escape"]]);
    for (const next of [always, deny]) {
      expect(promptsEqual(allow, next)).toBe(false);
      expect(promptsSameIdentity(allow, next)).toBe(true);
    }
  });

  it("lifts a replace whose preview shows an unchanged line as its bare number", () => {
    // Given: a kiro-cli 2.32.0 replace of line 2, which prints line 1 as `     1`.
    const allow = modelOf(load("replace-trusted-allow-w120"));
    // When: the adapter reads the preview.
    // Then: the changed rows are the subject and the context row does not count as a change.
    const subject = allow.subject?.map(lineText).join("\n") ?? "";
    expect(allow.question).toBe("Replace in File requires approval");
    expect(subject).toContain("     2-  beta");
    expect(subject).toContain("     2+  gamma");
  });

  it("still declines a diff whose counts disagree with its summary", () => {
    // Given: the trusted write with one diff row turned into an extra bare-number row.
    const lines = changed("write-trusted-allow-w120", "     3+", "     3");
    // When: the adapter reads the preview.
    // Then: three counted rows cannot satisfy "added 4 lines", so no card is offered.
    expect(kiroAdapter.buildBlocks(lines).some((block) => block.kind === "prompt-select")).toBe(false);
  });
});
