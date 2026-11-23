// The Codex adapter on a status row that wrapped under the box (#838). This reader decides the phone's
// unread-dialog card and the composer's pre-flight; it found the status row at the tail, walked up, met
// the row the status wrapped from, took it for a second status row and gave no composer. On a working pane
// a row naming Escape (`esc to interrupt`) was in reach, so the card "Collie cannot read this dialog"
// stood over a pane that was only working. The wrap is decided by the frame module from the Codex
// profile (`idle.frame.bottomWraps`), so this reader and the Surface agree on it.
//
// The fixtures are constructed, not captured: web/src/lib/surface/frame.bottom-wraps.test.ts and
// web/src/fixtures/panes/README.md say how and why.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { withUnreadDialog } from "../index";
import { codexAdapter } from "./index";
import { composerReady, extractInputDraft, extractStatusLines, locateComposer, stripChrome } from "./chrome";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const raw = (name: string): string[] => readFileSync(join(PANES_DIR, name), "utf8").split("\n");
const linesOf = (rows: readonly string[]): StyledLine[] => splitLines(parseAnsi(rows.join("\n")));
const card = (lines: StyledLine[]): boolean => withUnreadDialog(codexAdapter, lines, codexAdapter.buildBlocks(lines)).some((block) => block.kind === "unread-dialog");

const WRAPPED = [
  { name: "codex--v0166-core-idle-status-wrap--w56.txt", draft: null, status: ["  GPT-6.1-Sol low · /var/home/alice/.cache/collie-", "  lab/codex-lab/project · Run sleep and list files"] },
  { name: "codex--v0166-core-draft-status-wrap--w56.txt", draft: "collie core draft probe", status: ["  GPT-6.1-Sol low · /var/home/alice/.cache/collie-", "  lab/codex-lab/project · Run sleep and list files"] },
  { name: "codex--v0166-core-working-status-wrap--w56.txt", draft: null, status: ["  GPT-6.1-Sol low · /var/home/alice/.cache/collie-", "  lab/codex-lab/project · Run sleep and list files"] },
  { name: "codex--v0167-working-status-wrap--w39.txt", draft: null, status: ["  GPT-6-Luna low · /tmp/collie-codex-", "  lab · Inspect calc.py"] },
] as const;

describe("a Codex status row that wrapped under the box (#838), in the Codex adapter", () => {
  it("finds the composer, with the status row from its first row to its last", () => {
    for (const { name, status } of WRAPPED) {
      const lines = linesOf(raw(name));
      const box = locateComposer(lines);
      expect(box, name).not.toBeNull();
      expect(composerReady(lines), name).toBe(true);
      expect(extractStatusLines(lines).map((line) => lineText(line).trimEnd()), name).toEqual([...status]);
      expect(box?.statusLast, name).toBe(box!.statusRow + 1);
    }
  });

  it("shows no unread-dialog card, also on the working pane whose rows name Escape", () => {
    for (const { name } of WRAPPED) expect(card(linesOf(raw(name))), name).toBe(false);
  });

  it("reads the draft alone, and the empty box as no draft", () => {
    for (const { name, draft } of WRAPPED) expect(extractInputDraft(linesOf(raw(name))), name).toBe(draft);
  });

  it("strips the box and both status rows from the mirror", () => {
    for (const { name, status } of WRAPPED) {
      const kept = stripChrome(linesOf(raw(name))).map((line) => lineText(line).trimEnd());
      for (const row of status) expect(kept, name).not.toContain(row);
      expect(kept.some((row) => row.startsWith("› Ask Codex") || row.startsWith("› collie core")), name).toBe(false);
    }
  });

  it("keeps a status row of one row as it was: no statusLast", () => {
    const box = locateComposer(linesOf(raw("codex--v0166-core-idle--w120.txt")));
    expect(box).not.toBeNull();
    expect(box?.statusLast).toBeUndefined();
  });

  it("a third status-shaped row past the profile's bound gives no composer", () => {
    const rows = raw("codex--v0166-core-working-status-wrap--w56.txt");
    const at = rows.findLastIndex((row) => row.startsWith("  lab/codex-lab"));
    const three = [...rows.slice(0, at + 1), "  and one more · status row", ...rows.slice(at + 1)];
    expect(composerReady(linesOf(three))).toBe(false);
  });

  it("a dialog drawn in the box's place still gives no composer and the card", () => {
    const rows = raw("codex--v0166-core-working-status-wrap--w56.txt");
    const at = rows.findLastIndex((row) => row.startsWith("› Ask Codex"));
    const dialog = [...rows.slice(0, at), "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel"];
    expect(composerReady(linesOf(dialog))).toBe(false);
    expect(card(linesOf(dialog))).toBe(true);
  });
});
