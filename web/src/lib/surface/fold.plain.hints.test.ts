import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, PANES_DIR, readScreen, rowsOf } from "../../test/surface-corpus";
import { labelOf } from "../../test/surface-fold";
import { stripSgr } from "./plain";

// M78 spec 01: the hint texts of Codex, Hermes and Muse count as a placeholder through
// `idle.placeholders.patterns`, which a read counts only when it carries no styling at all (herdr-core).
// On a styled read the attribute and colour tests decide, so the same words typed as a plain run in the
// box are a draft.

const CASES: readonly (readonly [fixture: string, hint: string])[] = [
  ["codex--fresh-idle.txt", "Ask Codex to do anything"],
  ["hermes--idle.txt", "Type / to browse commands, or Ctrl+P for the palette"],
  ["hermes--running.txt", "msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel"],
  ["muse--prompt-hint-1410.txt", "Press ? on an empty composer to see keyboard shortcuts"],
];

function read(fixture: string, rows = fixtureRows(fixture)) {
  const harness = labelOf(fixture).harness;
  return readScreen(rows, agentOf(harness), idleFor(harness));
}

/** The fixture's rows with the hint's run restyled as default ink, the way a person's typed text is drawn. */
function typedRows(fixture: string, hint: string) {
  let found = 0;
  const rows = fixtureRows(fixture).map((row) => ({
    segments: row.segments.map((segment) => {
      if (!segment.text.includes(hint)) return segment;
      found++;
      const { fg: _fg, bold: _bold, dim: _dim, italic: _italic, underline: _underline, strike: _strike, ...rest } = segment;
      return { ...rest, style: {} };
    }),
  }));
  expect(found, `${fixture} holds the hint in one run`).toBe(1);
  return rows;
}

describe.each(CASES)("%s", (fixture, hint) => {
  it("reads as an empty box as captured, and as a plain-text read", () => {
    expect(read(fixture).surface.composer).toBe("empty");
    const plain = rowsOf(stripSgr(readFileSync(join(PANES_DIR, fixture), "utf8")));
    const plainRead = read(fixture, plain);
    expect(plainRead.surface.composer).toBe("empty");
    expect(plainRead.frame?.anchorsHit).toContain("placeholder-text");
  });

  it("reads the same words typed as a plain run on a styled read as a draft", () => {
    const typed = read(fixture, typedRows(fixture, hint));
    expect(typed.surface.composer).toBe("draft");
    expect(typed.frame?.placeholder).toBe(false);
    expect(typed.frame?.interior.text).toBe(hint);
  });
});
