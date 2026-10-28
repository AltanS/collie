import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseAnsi } from "../ansi";
import { splitLines, type Block, type StyledLine } from "../blocks";
import { detectorVerdicts, withUnreadDialog } from "./index";
import { adapterFor } from "./registry";
import type { HarnessAdapter } from "./types";

// THE VERDICTS ON THE UNREAD-DIALOG CARD (ADR 0123, amendment 2026-10-28). Each adapter names the
// dialog detectors its `buildBlocks` runs; the post-pass runs them again on the screen it gives a
// card and records what each said, so a report from the phone says which reader looked and what it
// answered. These tests pin the record, and keep each adapter's list in step with its pipeline.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const FIXTURES = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
const linesOf = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const fixtureLines = (name: string): StyledLine[] => linesOf(readFileSync(join(PANES_DIR, name), "utf8"));

/** Every registered agent string. agy and antigravity are two registrations of one adapter. */
const AGENTS = ["claude", "codex", "grok", "omp", "agy", "antigravity", "muse", "opencode", "hermes", "kiro", "pi"] as const;

function card(agent: string, lines: StyledLine[]): Extract<Block, { kind: "unread-dialog" }> {
  const adapter = adapterFor(agent)!;
  const found = withUnreadDialog(adapter, lines, adapter.buildBlocks(lines)).find((b) => b.kind === "unread-dialog");
  if (found?.kind !== "unread-dialog") throw new Error(`no card for ${agent}`);
  return found;
}

describe("each adapter names its own dialog detectors", () => {
  it.each(AGENTS)("%s declares a list with unique names, next to its cancel key", (agent) => {
    const adapter = adapterFor(agent)!;
    expect(adapter.cancelKey).toBeTypeOf("string");
    const names = (adapter.dialogDetectors ?? []).map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  // The drift guard: a detector added to `buildBlocks` and not to the list would lift a screen on
  // which every listed detector says null. One pass over the corpus per adapter.
  it("on every fixture an adapter lifts, one of its listed detectors says found", { timeout: 60_000 }, () => {
    const parsed = new Map(FIXTURES.map((name) => [name, fixtureLines(name)]));
    for (const agent of AGENTS) {
      const adapter = adapterFor(agent)!;
      for (const [name, lines] of parsed) {
        if (adapter.buildBlocks(lines).every((b) => b.kind === "raw")) continue;
        const verdicts = detectorVerdicts(adapter.dialogDetectors ?? [], lines);
        expect(verdicts.some((v) => v.result === "found"), `${agent} / ${name}`).toBe(true);
      }
    }
  });
});

describe("the post-pass records the verdicts on the card", () => {
  it.each([
    ["claude", "claude-lab--menu-status-screen--w82.txt"],
    ["codex", "codex--ask-notes-focused.txt"],
    ["omp", "omp--select-multi.txt"],
    ["hermes", "hermes--palette.txt"],
    ["muse", "muse--ask-color-notes-open.txt"],
    ["kiro", "kiro--v3-approval-edit-w120.txt"],
  ])("%s on %s: one verdict per listed detector, in order, none found", (agent, fixture) => {
    const { cancel } = card(agent, fixtureLines(fixture));
    const names = adapterFor(agent)!.dialogDetectors!.map((d) => d.name);
    expect(cancel.verdicts?.map((v) => v.name)).toEqual(names);
    expect(cancel.verdicts?.every((v) => v.result === "null")).toBe(true);
  });

  it("a detector that throws gets its message, and the ones after it still run", () => {
    const lines = linesOf("A modal\n\n  esc to cancel");
    const adapter: HarnessAdapter = {
      agent: "test",
      buildBlocks: (rows) => [{ kind: "raw", lines: rows }],
      extractStatusLines: () => [],
      extractInputDraft: () => null,
      composerReady: () => false,
      cancelKey: "Escape",
      dialogDetectors: [
        { name: "first", detect: () => null },
        {
          name: "second",
          detect: () => {
            throw new Error("row 3\n out of range");
          },
        },
        { name: "third", detect: () => ({ startLine: 0 }) },
      ],
    };
    const blocks = withUnreadDialog(adapter, lines, adapter.buildBlocks(lines));
    const only = blocks[0];
    expect(only?.kind).toBe("unread-dialog");
    expect(only?.kind === "unread-dialog" && only.cancel.verdicts).toEqual([
      { name: "first", result: "null" },
      { name: "second", result: "threw: row 3 out of range" },
      { name: "third", result: "found" },
    ]);
    // Not part of the identity: the race guard compares key, agent and signature only.
    expect(only?.kind === "unread-dialog" && Object.keys(only.cancel)).toEqual(["key", "agent", "signature", "verdicts"]);
  });

  it("an adapter that declares no detectors gets a card with no verdicts", () => {
    const lines = linesOf("A modal\n\n  esc to cancel");
    const adapter: HarnessAdapter = {
      agent: "test",
      buildBlocks: (rows) => [{ kind: "raw", lines: rows }],
      extractStatusLines: () => [],
      extractInputDraft: () => null,
      composerReady: () => false,
      cancelKey: "Escape",
    };
    const only = withUnreadDialog(adapter, lines, adapter.buildBlocks(lines))[0];
    expect(only?.kind === "unread-dialog" && only.cancel.verdicts).toBeUndefined();
  });
});
