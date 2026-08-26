import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { detectMultiSelect } from "./claude/multi-select";
import { detectPreviewSelect } from "./claude/preview-select";
import { detectPromptSelect } from "./claude/prompt-select";
import { detectWizard } from "./claude/wizard";
import { detectMenu } from "./claude/menu";

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

const REGIONS = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "prompt-binding-regions.json"), "utf8"),
) as { fixture: string; detector: string; region: string }[];

/** The region each detector hands to the bridge, or null when it does not recognise the pane. The
 *  order mirrors the precedence the action layer uses, so a pane is attributed to one detector. */
function detectRegion(lines: StyledLine[]): { detector: string; region: string } | null {
  const prompt = detectPromptSelect(lines);
  if (prompt) return { detector: "prompt-select", region: prompt.signature };
  const wizard = detectWizard(lines);
  if (wizard) return { detector: "wizard", region: wizard.signature };
  const preview = detectPreviewSelect(lines);
  if (preview) return { detector: "preview-select", region: preview.regionSignature };
  const multi = detectMultiSelect(lines);
  if (multi) return { detector: "multi-select", region: multi.regionSignature };
  // Last, exactly as claudeBuildBlocks orders it: the generic menu only claims what all four declined.
  const menu = detectMenu(lines);
  if (menu) return { detector: "menu", region: menu.signature };
  return null;
}

describe("client/bridge binding contract", () => {
  it("covers every dialog detector", () => {
    expect([...new Set(REGIONS.map((r) => r.detector))].sort()).toEqual([
      "menu",
      "multi-select",
      "preview-select",
      "prompt-select",
      "wizard",
    ]);
  });

  for (const { fixture, detector, region } of REGIONS) {
    it(`${detector}: ${fixture} still derives byte-identically`, () => {
      const found = detectRegion(fixtureLines(fixture));
      expect(found).not.toBeNull();
      expect(found!.detector).toBe(detector);
      expect(found!.region).toBe(region);
    });
  }

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
