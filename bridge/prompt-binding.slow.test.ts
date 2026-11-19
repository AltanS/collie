// The slow cases of prompt-binding.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { normalizePromptRegion, verifyPromptBinding } from "./prompt-binding.ts";
import { type ColumnRange } from "../web/src/lib/column-range.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir, "..", "web", "src", "fixtures", "panes");

/** One committed expectation: which region of which pane fixture a given detector must bind to, and,
 *  for a region read from part of each row, the columns the bridge cuts its read to first. */
interface BindingRegion {
  fixture: string;
  detector: string;
  region: string;
  bindColumns?: ColumnRange;
}

// SAFETY: the fixture file is committed alongside this test and is regenerated only by it; the
// assertions below check every field of every row.
const REGIONS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "web", "src", "fixtures", "prompt-binding-regions.json"), "utf8"),
) as BindingRegion[];

/** Fixtures that show ONE dialog and so legitimately share a region: the `-named-` captures of Claude
 *  Code 2.1.296 beside their unnamed twins, the wizard review step at both widths, and the `/effort`
 *  slider on `high` at 120 columns captured twice. That last pair differed only in the label spliced
 *  into the `▔` edge, which the menu's region leaves out since 1.22.5 (Claude puts timed notices
 *  there). */
const SAME_DIALOG: string[][] = [
  ["claude--menu-effort-slider--w120.txt", "claude--v2283-slash-effort.txt"],
  ["claude-lab--ask-multi-named-v2296--w82.txt", "claude-lab--ask-multi-v2296--w82.txt"],
  ["claude-lab--ask-multi-named-v2296--w40.txt", "claude-lab--ask-multi-v2296--w40.txt"],
  ["claude-lab--ask-single-named-v2296--w40.txt", "claude-lab--ask-single-v2296--w40.txt"],
  ["claude-lab--ask-wizard-named-v2296--w82.txt", "claude-lab--ask-wizard-v2296--w82.txt"],
  [
    "claude-lab--ask-wizard-review-named-v2296--w82.txt",
    "claude-lab--ask-wizard-review-named-v2296--w40.txt",
    "claude-lab--ask-wizard-review-v2296--w82.txt",
    "claude-lab--ask-wizard-review-v2296--w40.txt",
  ],
  ["claude-lab--menu-config-panel-named-v2296--w40.txt", "claude-lab--menu-config-panel-v2296--w40.txt"],
  // The survey over the context row (issue 705), once with its styling and once as herdr-core's plain text.
  ["claude--v2317-survey-context-row--w160.txt", "claude--v2317-survey-context-row-plain--w160.txt"],
];

describe("client/bridge binding contract", () => {
  test("a region from a different dialog is never accepted", () => {
    const rawCache = new Map<string, string>();
    const rawOf = (fixture: string): string => {
      const hit = rawCache.get(fixture);
      if (hit !== undefined) return hit;
      const text = readFileSync(join(FIXTURE_DIR, fixture), "utf8");
      rawCache.set(fixture, text);
      return text;
    };

    let compared = 0;
    let identicalPairs = 0;
    let sameDialogPairs = 0;
    for (const a of REGIONS) {
      const raw = rawOf(a.fixture);
      for (const b of REGIONS) {
        if (a.fixture === b.fixture) continue;
        // Two fixtures can be the same screen, byte for byte: the /effort slider sits in the corpus
        // twice, once as `claude--menu-effort-slider.txt` and once as the capture-lab original it
        // was copied from. A match between those two is the contract working, not a collision. The
        // exemption is keyed on the RAW FILE BYTES, never on the region text — two different dialogs
        // that declared the same region would be exactly the collision this test exists to catch.
        if (raw === rawOf(b.fixture)) {
          identicalPairs++;
          continue;
        }
        // The same dialog captured twice, with different bytes around it: a session named with
        // `/rename` and an unnamed one draw the same dialog (Claude Code 2.1.296 adds a closing
        // rule under it in the named one), and the wizard's review step reads the same at 40 and 82
        // columns. The exemption is a NAMED list, not a comparison of region text, and a group is
        // only legitimate while its members really hold one region, as the bridge reads a region:
        // normalized, so a capture with trailing spaces on its blank rows is still the same one.
        if (SAME_DIALOG.some((group) => group.includes(a.fixture) && group.includes(b.fixture))) {
          expect(normalizePromptRegion(b.region), `${a.fixture} and ${b.fixture} are listed as one dialog`).toEqual(normalizePromptRegion(a.region));
          sameDialogPairs++;
          continue;
        }
        compared++;
        expect(verifyPromptBinding(raw, b.region, undefined, b.bindColumns).ok).toBe(false);
      }
    }
    expect(compared).toBeGreaterThan(0);
    // The exemption must not go vacuous: if the duplicate capture ever leaves the corpus, the skip
    // above is dead code and this line says so.
    expect(identicalPairs).toBeGreaterThan(0);
    expect(sameDialogPairs).toBeGreaterThan(0);
  });
});
