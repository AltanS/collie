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

// Claude Code 2.1.328 after a turn fails on an API error (a refused connection, lab 2026-11-19): the
// empty box holds `Resend your message to try again` (a no-break space after the marker). herdr-core
// reads it as plain text, so only the profile's known placeholder text (`idle.placeholders.texts`)
// keeps it from reading as a draft. The rows are the last rows of that plain-text capture.
describe("claude: the resend hint after a failed turn", () => {
  const RULE = "─".repeat(120);
  const screen = (prompt: string) =>
    rowsOf(["", "❯ say hi", "", "● API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", "", RULE, prompt, RULE, "  ⏸ manual mode on · ? for shortcuts"].join("\n"));
  const readPlain = (prompt: string) => readScreen(screen(prompt), agentOf("claude"), idleFor("claude"));

  it("reads as an empty box on a plain-text read", () => {
    const seen = readPlain("❯ Resend your message to try again");
    expect(seen.surface.composer).toBe("empty");
    expect(seen.frame?.placeholder).toBe(true);
    expect(seen.frame?.anchorsHit).toContain("placeholder-text");
  });

  it("keeps other words, and the same words with more typed after them, as a draft", () => {
    for (const draft of ["Resend your note to try again", "Resend your message to try again now please"]) {
      const seen = readPlain(`❯ ${draft}`);
      expect(seen.surface.composer, draft).toBe("draft");
      expect(seen.frame?.interior.text, draft).toBe(draft);
    }
  });
});
