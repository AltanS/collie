import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPromptBinding } from "../../../../../bridge/prompt-binding";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, trimTrailingBlank, type PromptModel, type StyledLine } from "../../blocks";
import { commitKeysFor, promptsEqual, promptsSameIdentity } from "../prompt-model";
import { kiroAdapter } from "./index";
import { detectWorkspaceTrust } from "./workspace-trust";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const WIDTHS = [120, 60, 40] as const;
const CAPTURES = [
  { name: "continue-w120", pointed: 0 },
  { name: "exit-w120", pointed: 1 },
  { name: "continue-w60", pointed: 0 },
  { name: "exit-w60", pointed: 1 },
  { name: "continue-w40", pointed: 0 },
  { name: "exit-w40", pointed: 1 },
  { name: "continue-up-edge-w40", pointed: 0 },
  { name: "exit-down-edge-w40", pointed: 1 },
] as const;
const WORKSPACE = "/tmp/collie-kiro-trust-ABCDEF/new-workspace-with-a-long-name-for-wrapped-path-capture";
const WARNING = "This folder can contain hooks, agents, MCP servers and workflows that run commands on your machine. Only trust folders you know.";
const ACCESS = "Trusting lets Kiro use this workspace's configuration. Kiro will be able to read, edit, and execute files here.";
const LABELS = ["Trust, continue", "Don't trust, exit"];
const raw = (name: string): string => readFileSync(join(PANES, `kiro--v3-workspace-trust-${name}.txt`), "utf8");
const linesOf = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const load = (name: string): StyledLine[] => linesOf(raw(name));
const rowsOf = (lines: StyledLine[]): string[] => lines.map((line) => lineText(line).replace(/ +$/, ""));
const textOf = (name: string): string => rowsOf(load(name)).join("\n");
const modelOf = (lines: StyledLine[]): PromptModel => {
  const block = kiroAdapter.buildBlocks(lines).find((candidate) => candidate.kind === "prompt-select");
  if (block?.kind !== "prompt-select") throw new Error("Expected a captured workspace trust dialog");
  return block.prompt;
};
const changed = (name: string, from: string, to: string): StyledLine[] => {
  const text = textOf(name);
  expect(text).toContain(from);
  return linesOf(text.replace(from, to));
};
const expectRaw = (lines: StyledLine[]): void => {
  expect(detectWorkspaceTrust(lines)).toBeNull();
  expect(kiroAdapter.buildBlocks(lines)).toEqual([{ kind: "raw", lines }]);
  expect(kiroAdapter.composerReady?.(lines)).toBe(false);
  expect(kiroAdapter.extractInputDraft(lines)).toBeNull();
};

// Every positive is a sanitized kiro-cli 2.33.0 capture. Mutations below are refusal/identity probes.
describe("Kiro V3 startup workspace trust", () => {
  it.each(CAPTURES)("$name retains the complete wrapped subject and exact two-row walk", ({ name, pointed }) => {
    const lines = load(name);
    const found = detectWorkspaceTrust(lines);
    const model = modelOf(lines);
    expect(found).toEqual({ startLine: 0, model });
    expect(kiroAdapter.buildBlocks(lines)).toEqual([{ kind: "prompt-select", prompt: model, lines }]);
    expect(model.family).toBe("trust");
    expect(model.question).toBe("Trust this workspace?");
    expect(model.options).toEqual([
      { label: LABELS[0], keys: pointed === 0 ? ["Enter"] : ["Up", "Enter"], keyLabel: pointed === 0 ? "❯" : "" },
      { label: LABELS[1], keys: pointed === 1 ? ["Enter"] : ["Down", "Enter"], keyLabel: pointed === 1 ? "❯" : "" },
    ]);
    expect(model.clampedEnds).toBe(true);
    expect(commitKeysFor(model, 0)).toEqual(["Up", "Enter"]);
    expect(commitKeysFor(model, 1)).toEqual(["Down", "Enter"]);
    expect(model.feedback).toBeUndefined();

    const rows = rowsOf(lines);
    const firstOption = rows.findIndex((row) => row === " ❯ Trust, continue" || row === "   Trust, continue");
    expect(model.subject).toEqual(trimTrailingBlank(lines.slice(3, firstOption)));
    const subject = rowsOf(model.subject ?? []).map((row) => row.slice(1)).join("\n").split("\n\n");
    expect(subject).toHaveLength(3);
    // Paths wrap mid-word; prose wraps between words. Neither may lose a continuation row.
    expect(subject[0]?.replaceAll("\n", "")).toBe(WORKSPACE);
    expect(subject[1]?.replaceAll("\n", " ")).toBe(WARNING);
    expect(subject[2]?.replaceAll("\n", " ")).toBe(ACCESS);
    expect(model.signature).toBe(rowsOf(trimTrailingBlank(lines)).join("\n"));
    expect(model.signature).toContain("Revoke later by removing");
    expect(model.signature).toContain("workspaceTrusted from");
    expect(model.signature.endsWith(".yaml")).toBe(true);
    expect(model.askRegion).toBeUndefined();
    expect(kiroAdapter.composerReady?.(lines)).toBe(false);
    expect(kiroAdapter.extractInputDraft(lines)).toBeNull();
    expect(kiroAdapter.extractStatusLines(lines)).toEqual([]);
  });

  it.each(WIDTHS)("at %i columns a stale pointer fails entry while the captured walk holds identity", (width) => {
    const initial = modelOf(load(`continue-w${width}`));
    const moved = modelOf(load(`exit-w${width}`));
    expect(promptsEqual(initial, moved)).toBe(false);
    expect(promptsEqual(moved, initial)).toBe(false);
    expect(promptsSameIdentity(initial, moved)).toBe(true);
    expect(promptsSameIdentity(moved, initial)).toBe(true);
    expect(initial.coreSignature).toBe(moved.coreSignature);
    for (const model of [initial, moved]) {
      const pointedRows = model.signature.split("\n").filter((row) => /^ ❯ (?:Trust, continue|Don't trust, exit)$/.test(row));
      expect(pointedRows).toHaveLength(1);
      expect(model.coreSignature).toBe(model.signature.replace(pointedRows[0]!, pointedRows[0]!.replace(" ❯ ", "   ")));
    }
  });

  it.each([
    ["continue-w40", "continue-up-edge-w40", 0],
    ["exit-w40", "exit-down-edge-w40", 1],
  ] as const)("%s remains selected after the captured clamped arrow", (before, after, index) => {
    const initial = modelOf(load(before));
    const edge = modelOf(load(after));
    expect(promptsEqual(initial, edge)).toBe(true);
    expect(promptsSameIdentity(initial, edge)).toBe(true);
    expect(edge.options[index].keys).toEqual(["Enter"]);
    expect(commitKeysFor(edge, index)).toEqual(index === 0 ? ["Up", "Enter"] : ["Down", "Enter"]);
  });

  it.each(WIDTHS)("at %i columns every changed bound field refuses or changes identity", (width) => {
    const name = `continue-w${width}`;
    const initial = modelOf(load(name));
    for (const [from, to] of [
      ["ABCDEF", "GHIJKL"],
      ["hooks", "tasks"],
      ["execute", "delete"],
      ["Trust, continue", "Trust everything"],
      ["Don't trust, exit", "Don't trust, continue"],
      ["to exit", "to trust"],
      ["workspaceTrusted", "workspaceAllowed"],
      ["/home/tester", "/home/reader"],
      [".yaml", ".json"],
    ]) {
      const successor = changed(name, from!, to!);
      const found = detectWorkspaceTrust(successor);
      if (found !== null) {
        expect(promptsEqual(initial, found.model), from).toBe(false);
        expect(promptsSameIdentity(initial, found.model), from).toBe(false);
        expect(promptsSameIdentity(found.model, initial), from).toBe(false);
      } else expectRaw(successor);
      expect(verifyPromptBinding(successor.map(lineText).join("\n"), initial.signature).ok, from).toBe(false);
    }
  });

  it("normalizes only the parsed option pointer, never a pointer glyph in the workspace path", () => {
    const initial = modelOf(load("continue-w120"));
    const successor = modelOf(changed("continue-w120", "ABCDEF", "ABC❯EF"));
    expect(successor.signature).toContain("ABC❯EF");
    expect(successor.coreSignature).toContain("ABC❯EF");
    expect(successor.coreSignature).not.toContain(" ❯ Trust, continue");
    expect(promptsSameIdentity(initial, successor)).toBe(false);
  });

  it.each(CAPTURES)("$name binds its complete ANSI read but rejects a successor workspace", ({ name }) => {
    const model = modelOf(load(name));
    expect(verifyPromptBinding(raw(name), model.signature)).toEqual({ ok: true });
    expect(verifyPromptBinding(raw(name).replace("ABCDEF", "GHIJKL"), model.signature).ok).toBe(false);
    expect(verifyPromptBinding(raw(name).replace("/home/tester", "/home/reader"), model.signature).ok).toBe(false);
  });

  it.each(WIDTHS)("at %i columns clipped edges, missing paragraphs and missing rows stay raw", (width) => {
    const lines = load(`continue-w${width}`);
    const rows = rowsOf(lines);
    const firstBlank = rows.indexOf("", 3);
    expectRaw([...lines.slice(0, 3), ...lines.slice(firstBlank)]);
    expectRaw(lines.slice(1));
    expectRaw(lines.slice(3));
    expectRaw(lines.slice(0, -1));
    for (const marker of ["This folder", "Trusting lets", "❯ Trust, continue", "Don't trust, exit", "esc to", "Revoke later"]) {
      const index = rows.findIndex((row) => row.includes(marker));
      expect(index, marker).toBeGreaterThanOrEqual(0);
      expectRaw([...lines.slice(0, index), ...lines.slice(index + 1)]);
    }
  });

  it.each(WIDTHS)("at %i columns unknown rows, pointers and footer controls stay raw", (width) => {
    const name = `continue-w${width}`;
    for (const [from, to] of [
      ["Trust this workspace?", "Trust this workspace?\n Unknown heading"],
      ["\n This folder", "\n Extra paragraph\n\n This folder"],
      ["hooks", "hooks\n Unknown warning row"],
      [" ❯ Trust, continue", "   Trust, continue"],
      ["   Don't trust, exit", " ❯ Don't trust, exit"],
      ["   Don't trust, exit", "   Don't trust, exit\n   Extra action"],
      [" ❯ Trust, continue\n   Don't trust, exit", "   Don't trust, exit\n ❯ Trust, continue"],
      ["↑↓", "1-2"],
      ["to navigate", "to execute"],
      [".yaml", ".yaml\n Unknown tail row"],
    ]) expectRaw(changed(name, from!, to!));
  });

  it.each(WIDTHS)("at %i columns hidden characters and ellipses anywhere in the region stay raw", (width) => {
    const name = `continue-w${width}`;
    for (const marker of ["ABCDEF", "hooks", "execute", "Trust, continue", "to exit", "/home/tester"]) {
      for (const hidden of ["\u0000", "\t", "\u007f", "\u0085", "\u00ad", "\u061c", "\u180e", "\u200b", "\u200e", "\u2028", "\u202e", "\u2066", "\ufe0f", "\ufeff", "\u{e0001}", "…"]) {
        expectRaw(changed(name, marker, `${marker}${hidden}`));
      }
    }
  });

  it.each(WIDTHS)("at %i columns quoted dialogs and dismissed history above a live composer stay raw", (width) => {
    const lines = load(`continue-w${width}`);
    expectRaw(linesOf(lines.map((line) => `  ${lineText(line)}`).join("\n")));
    expectRaw(linesOf(lines.map((line) => `> ${lineText(line)}`).join("\n")));
    expectRaw(linesOf(`\`\`\`\n${textOf(`continue-w${width}`)}\n\`\`\``));
    const idle = linesOf(readFileSync(join(PANES, "kiro--v3-idle-w120.txt"), "utf8"));
    const remnants = [...lines, ...idle];
    expect(detectWorkspaceTrust(remnants)).toBeNull();
    const blocks = kiroAdapter.buildBlocks(remnants);
    expect(blocks.every((block) => block.kind === "raw")).toBe(true);
    expect(kiroAdapter.composerReady?.(remnants)).toBe(true);
    expect(kiroAdapter.extractInputDraft(remnants)).toBeNull();
  });

  it("declines a region that exceeds the bridge's bounded size or row budget", () => {
    expectRaw(changed("continue-w120", "ABCDEF", "a".repeat(32_001)));
    expectRaw(changed("continue-w40", "\n This folder", `${"\n".repeat(81)} This folder`));
  });
});
