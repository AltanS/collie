import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import type { ColumnRange } from "../column-range";
import { buildBlocks } from "./index";
import { detectMultiSelect } from "./claude/multi-select";
import { detectPreviewSelect } from "./claude/preview-select";
import { detectPromptSelect } from "./claude/prompt-select";
import { detectWizard } from "./claude/wizard";
import { dropClosingRule } from "./claude/closing-rule";
import { dropTaskChecklist } from "./claude/task-checklist";
import { detectMenu } from "./claude/menu";
import { detectResumePicker } from "./claude/resume";
import { detectMarketplaces } from "./claude/marketplaces";

// The client half of the prompt-binding contract. See the sibling test in
// bridge/prompt-binding.test.ts for the full reasoning; in short:
//
// The client sends the bridge a region string derived from ANSI it has already parsed away, and the
// bridge looks for that region in the RAW pane.read. Nothing in the type system couples the two
// normalisations. If either drifts, every legitimate approval starts coming back "prompt changed",
// a failure that looks like the feature working and ends with users turning it off.
//
// prompt-binding-regions.json pins the exact region each detector produces for each real fixture.
// THIS test proves the detectors still produce them byte-for-byte; the bridge test proves the bridge
// still finds them in the raw text. Divergence turns one of the two red.
//
// If a detector legitimately changes what it captures, regenerate the JSON and expect the bridge
// test to confirm the new regions are still findable. Regenerating to silence the BRIDGE test would
// be backwards: that failure means the bridge stopped matching what the client really sends.

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite rewrites).
const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "fixtures");
const PANES_DIR = join(FIXTURES_DIR, "panes");

const fixtureLines = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

/** One committed row of the client/bridge binding golden. A row with `agent` is derived through that
 *  harness's adapter (the public `buildBlocks` dispatch) instead of the Claude detectors below. A row
 *  with `bindColumns` is a region read from those columns of each row (`PromptModel.bindColumns`,
 *  lib/column-range.ts): the bridge cuts its fresh read to them before it looks for the region. */
interface RegionRow {
  fixture: string;
  detector: string;
  region: string;
  agent?: string;
  bindColumns?: ColumnRange;
}

// SAFETY: `prompt-binding-regions.json` is this repo's own committed golden, and every field the
// rows below read is asserted against it by the cases in this file — a drifted shape fails here.
const REGIONS = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "prompt-binding-regions.json"), "utf8"),
) as RegionRow[];

/** The region each detector hands to the bridge, or null when it does not recognise the pane. The
 *  order mirrors the precedence the action layer uses, so a pane is attributed to one detector. */
function detectRegion(input: StyledLine[]): FoundRegion | null {
  // The adapter takes the closing rule a named session draws under a dialog off first (2.1.296,
  // claude/closing-rule.ts), so the region the phone binds to is the one an unnamed session shows.
  // The task checklist 2.1.299 draws below that rule (claude/task-checklist.ts) goes before it.
  const lines = dropClosingRule(dropTaskChecklist(input));
  const prompt = detectPromptSelect(lines);
  if (prompt) return { detector: "prompt-select", region: prompt.signature };
  const wizard = detectWizard(lines);
  if (wizard) return { detector: "wizard", region: wizard.signature };
  const preview = detectPreviewSelect(lines);
  if (preview) return { detector: "preview-select", region: preview.regionSignature };
  const multi = detectMultiSelect(lines);
  if (multi) return { detector: "multi-select", region: multi.regionSignature };
  // The /resume picker (.adr/0058) lifts as a prompt-select block, and claudeBuildBlocks tries it just
  // before the generic menu, which would otherwise claim the same screen.
  const resume = detectResumePicker(lines);
  if (resume) return { detector: "prompt-select", region: resume.signature };
  // The `/plugin` Marketplaces tab and detail screen lift as a menu, and claudeBuildBlocks tries them
  // just before the generic menu too.
  const marketplaces = detectMarketplaces(lines);
  if (marketplaces) return { detector: "menu", region: marketplaces.signature };
  // Last, exactly as claudeBuildBlocks orders it: the generic menu only claims what all six declined.
  const menu = detectMenu(lines);
  if (menu) return { detector: "menu", region: menu.signature };
  return null;
}

/** What a fixture binds to: the detector, its region, and the column range when it has one. */
interface FoundRegion {
  detector: string;
  region: string;
  bindColumns?: ColumnRange;
}

/** The region and column range a harness's adapter binds a prompt-select to, through the public
 *  dispatch the renderer and the race guard use. Only prompt-select rows carry an agent today. */
function adapterRegion(lines: StyledLine[], agent: string): FoundRegion | null {
  const card = buildBlocks(lines, { agent }).find((block) => block.kind === "prompt-select");
  if (card?.kind !== "prompt-select") return null;
  const found: FoundRegion = { detector: "prompt-select", region: card.prompt.signature };
  if (card.prompt.bindColumns !== undefined) found.bindColumns = card.prompt.bindColumns;
  return found;
}

describe("client/bridge binding contract", () => {
  it("covers every dialog detector", () => {
    expect([...new Set(REGIONS.map((r) => r.detector))].toSorted()).toEqual([
      "menu",
      "multi-select",
      "preview-select",
      "prompt-select",
      "wizard",
    ]);
  });

  for (const { fixture, detector, region, agent, bindColumns } of REGIONS) {
    it(`${detector}: ${fixture} still derives byte-identically`, () => {
      const found = agent === undefined ? detectRegion(fixtureLines(fixture)) : adapterRegion(fixtureLines(fixture), agent);
      expect(found).not.toBeNull();
      expect(found!.detector).toBe(detector);
      expect(found!.region).toBe(region);
      // The column range is half of the binding: the bridge cuts its read to it before it compares,
      // so a range that drifted would refuse every tap as surely as a drifted region.
      expect(found!.bindColumns).toEqual(bindColumns);
    });
  }

  it("covers a column-bound region: the panel question's columns are pinned with its rows", () => {
    expect(REGIONS.filter((r) => r.bindColumns !== undefined).map((r) => [r.fixture, r.bindColumns])).toEqual([
      ["pi--omo-v5130-panel-question.txt", { start: 0, end: 91 }],
    ]);
  });

  // Completeness gate: a newly added dialog fixture must not slip past the contract unnoticed. A new
  // capture that some detector recognises but that carries no committed region would otherwise ship
  // an unpinned write path, which is exactly what this pair of tests exists to prevent.
  it("pins every fixture that any detector recognises", () => {
    const pinned = new Set(REGIONS.map((r) => r.fixture));
    const unpinned = readdirSync(PANES_DIR)
      .filter((n) => n.endsWith(".txt"))
      .filter((n) => !pinned.has(n) && detectRegion(fixtureLines(n)) !== null);
    expect(unpinned).toEqual([]);
  });
});
