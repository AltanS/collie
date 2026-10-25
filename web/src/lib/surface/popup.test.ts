import { describe, expect, it } from "vitest";

import { fixtureRows, idleFor, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { findInputFrame } from "./frame";
import { own } from "../../test/surface-fold";
import { rowText } from "./frame";
import { popupUnder } from "./popup";

const POPUPS = idleFor("omp")!.volatile.below.popups!;

/** A screen's rows as texts, the box's bottom edge, and the text in the box. */
interface Screen {
  readonly texts: string[];
  readonly bottom: number;
  readonly text: string;
}

function screen(name: string): Screen {
  const frame = own(name).frame!;
  return { texts: fixtureRows(name).map(rowText), bottom: frame.bottom, text: frame.interior.text };
}

describe("the typeahead popups of omp's profile (idle.volatile.below.popups)", () => {
  const READS = [
    ["omp--v18-6-1-at-popup--w120.txt", "file", false, 1],
    ["omp--v18-6-1-at-popup-path--w120.txt", "file", false, 1],
    ["omp--v18-6-1-hash-popup--w120.txt", "issue", false, 2],
    ["omp--v18-6-1-hash-popup-single--w120.txt", "issue", false, 1],
    ["omp--v18-6-1-hash-popup-stale--w120.txt", "issue", true, 2],
  ] as const;

  it.each(READS)("%s: read as the %s popup (stale %s) of %i rows, the pointer on the first", (name, rule, stale, rows) => {
    const { texts, bottom, text } = screen(name);
    const read = popupUnder(texts, bottom, text, POPUPS);
    expect(read).toEqual({ name: rule, first: bottom + 1, last: bottom + rows, pointed: bottom + 1, stale });
  });

  it("omp's submit key ignores them: the profile says so, as data", () => {
    expect(POPUPS.submitIgnores).toBe(true);
  });

  const { texts, bottom } = screen("omp--v18-6-1-hash-popup--w120.txt");
  const swap = (rows: string[]): string[] => [...texts.slice(0, bottom + 1), ...rows];

  it("reads nothing for a box text that opened no popup", () => {
    expect(popupUnder(texts, bottom, "fix item", POPUPS)).toBeNull();
    expect(popupUnder(texts, bottom, "fix item #1 done", POPUPS)).toBeNull();
    expect(popupUnder(texts, bottom, "tag:#abc", POPUPS)).toBeNull();
  });

  it("an empty box opens only the rule that names staleWhenEmpty", () => {
    expect(popupUnder(texts, bottom, "", POPUPS)?.stale).toBe(true);
    const file = screen("omp--v18-6-1-at-popup--w120.txt");
    expect(popupUnder(file.texts, file.bottom, "", POPUPS)).toBeNull();
  });

  it("a file popup is for a word that starts with @, never for a slash command", () => {
    const file = screen("omp--v18-6-1-at-popup--w120.txt");
    expect(popupUnder(file.texts, file.bottom, "ok @src/ done", POPUPS)).toBeNull();
    expect(popupUnder(file.texts, file.bottom, "/model @READ", POPUPS)).toBeNull();
    expect(popupUnder(file.texts, file.bottom, "please read@READ", POPUPS)).toBeNull();
  });

  it("another list under the box is no popup: the hotkeys list `#` opens alone, a dialog row, two pointers, none", () => {
    expect(popupUnder(swap(["❯ Copy current line               Alt+⇧L", "  Copy whole prompt               Alt+⇧C"]), bottom, "ends with hash #", POPUPS)).toBeNull();
    expect(popupUnder(swap(["❯ PR #1                           GitHub pull request", "  Issue #1                        GitHub issue", "Allow tool: bash"]), bottom, "fix item #1", POPUPS)).toBeNull();
    expect(popupUnder(swap(["❯ PR #1                           GitHub pull request", "❯ Issue #1                        GitHub issue"]), bottom, "fix item #1", POPUPS)).toBeNull();
    expect(popupUnder(swap(["  PR #1                           GitHub pull request", "  Issue #1                        GitHub issue"]), bottom, "fix item #1", POPUPS)).toBeNull();
  });

  it("a popup taller than the profile allows is no popup", () => {
    const rows = Array.from({ length: POPUPS.maxRows + 1 }, (_, i) => `${i === 0 ? "❯" : " "} name${String(i)}.png`);
    expect(popupUnder(swap(rows), bottom, "see @name", POPUPS)).toBeNull();
    expect(popupUnder(swap(rows.slice(0, POPUPS.maxRows)), bottom, "see @name", POPUPS)).not.toBeNull();
  });

  it("the emoji popup (omp's source, no capture yet): a glyph and a :name: shortcode, the pointer on one row", () => {
    const rows = ["❯ 😄  :smile:", "  😀  :smiley:", "  🙂  :)"];
    const read = popupUnder(swap(rows), bottom, "nice :smi", POPUPS);
    expect(read).toMatchObject({ name: "emoji", first: bottom + 1, last: bottom + 3, pointed: bottom + 1, stale: false });
    // A file name is no emoji row, and an emoji row is no file popup's.
    expect(popupUnder(swap(["❯ smile.png"]), bottom, "nice :smi", POPUPS)).toBeNull();
    expect(popupUnder(swap(rows), bottom, "nice @smi", POPUPS)?.name).toBe("file");
    expect(popupUnder(swap(rows), bottom, "nice smi", POPUPS)).toBeNull();
  });

  it("a slash list with an extension's status row under it (commandList.footer) is no popup, whatever the text", () => {
    for (const name of ["omp--v18-12-6-status-row-palette-4.txt", "omp--v18-6-1-status-row-palette-4.txt", "omp--v18-12-6-status-row-palette-10.txt"]) {
      const rows = fixtureRows(name, SURFACE_FIXTURES_DIR);
      const frame = findInputFrame(rows, idleFor("omp")!)!;
      const sheet = rows.map(rowText);
      for (const text of [frame.interior.text, "/wx @a", "/wx #1"]) {
        expect(popupUnder(sheet, frame.bottom, text, POPUPS), `${name} ${text}`).toBeNull();
      }
    }
  });

  it("reads nothing on a profile with no popups", () => {
    expect(popupUnder(texts, bottom, "fix item #1", undefined)).toBeNull();
  });
});
