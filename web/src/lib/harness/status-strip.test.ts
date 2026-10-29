// The status strip re-surfaces only the rows an adapter took off the mirror (types.ts,
// `extractStatusLines`). A row the adapter's own blocks still show, in the mirror or in a lifted
// card, must not also stand in the strip: that is the doubled status lines of the 2026-10-20 field
// report (pi, then muse). One check over every captured screen of every registered adapter, so an
// adapter added later is held to it too.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../ansi";
import { lineText, splitLines } from "../blocks";
import { adapterFor, registeredAgents } from "./registry";

const PANES = join(import.meta.dirname, "../../fixtures/panes");
// Fixture prefixes that are not the adapter's agent string.
const PREFIX_AGENT = new Map([
  ["claude-lab", "claude"],
  ["oc", "opencode"],
]);
// Hermes classic CLI draws its clarify and approval panels above the status bar and input row, so its
// lifted region reaches the tail and includes the status bar; its adapter is outside this unit's scope.
const EXEMPT_AGENTS = new Set(["hermes"]);

function agentOf(name: string): string | undefined {
  const prefix = name.split("--")[0]!;
  if (EXEMPT_AGENTS.has(prefix)) return undefined;
  return PREFIX_AGENT.get(prefix) ?? (registeredAgents().includes(prefix) ? prefix : undefined);
}

const fixtures = readdirSync(PANES)
  .filter((name) => name.endsWith(".txt") && agentOf(name) !== undefined)
  .toSorted();

describe("the status strip never doubles a row the blocks still show", () => {
  it("covers every adapter that has captures", () => {
    const covered = new Set(fixtures.map(agentOf));
    for (const agent of ["agy", "claude", "codex", "grok", "muse", "omp", "opencode", "pi"]) expect(covered.has(agent), agent).toBe(true);
  });

  // The check below passes trivially for a strip that is always empty, so each adapter must still
  // show its strip somewhere, and Muse on its ready composer in particular.
  it("still shows the strip on at least one captured screen of every adapter", () => {
    const stripped = new Set(
      fixtures
        .filter((name) => adapterFor(agentOf(name))!.extractStatusLines(splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")))).length > 0)
        .map(agentOf),
    );
    expect([...new Set(fixtures.map(agentOf))].filter((agent) => !stripped.has(agent))).toEqual([]);
  });

  it("shows Muse's statusline once on its ready composer", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES, "muse--fresh-idle.txt"), "utf8")));
    const muse = adapterFor("muse")!;
    expect(muse.composerReady!(lines)).toBe(true);
    const strip = muse.extractStatusLines(lines).map(lineText);
    expect(strip).toHaveLength(1);
    expect(strip[0]!.trim()).toMatch(/^muse-spark-/u);
  });

  it.each(fixtures)("%s", (name) => {
    const adapter = adapterFor(agentOf(name))!;
    const lines = splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));
    const shown = new Set(adapter.buildBlocks(lines).flatMap((block) => ("lines" in block ? block.lines : [])));
    expect(adapter.extractStatusLines(lines).filter((row) => shown.has(row))).toEqual([]);
  });
});
