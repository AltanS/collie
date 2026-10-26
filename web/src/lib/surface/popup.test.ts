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
    // omp-gang 04-readers, 2026-10-26: the first real captures of the emoji popup (one space after the glyph),
    // the one-row path popup of a partial path, and the `@` rows left under an emptied box.
    ["omp--v18-12-6-emoji-popup--w120.txt", "emoji", false, 8],
    ["omp--v18-6-1-emoji-popup--w120.txt", "emoji", false, 8],
    ["omp--v18-12-6-path-popup-partial--w120.txt", "path", false, 1],
    ["omp--v18-6-1-at-popup-stale--w120.txt", "file", true, 2],
    // The same rows read as a command list too (a description column); the popup is what they are.
    ["omp--v18-12-6-at-popup-two-files--w120.txt", "file", false, 2],
    // omp-gang three, 01-regression, 2026-10-26: a text that ends in a bare `#` draws omp's editor-action list
    // (a label, a key-chord column, seven rows). It is the popup that last word opens.
    ["omp--v18-6-1-hash-end-actions--w120.txt", "actions", false, 7],
    ["omp--v18-12-6-hash-end-actions--w120.txt", "actions", false, 7],
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

  it("an empty box opens only the rules that name staleWhenEmpty, and every rule of omp's profile names it", () => {
    expect(popupUnder(texts, bottom, "", POPUPS)?.stale).toBe(true);
    for (const rule of POPUPS.rules) expect(rule.staleWhenEmpty, rule.name).toBe(true);
    const file = screen("omp--v18-6-1-at-popup--w120.txt");
    expect(popupUnder(file.texts, file.bottom, "", POPUPS)).toMatchObject({ name: "file", stale: true });
    const edit = { ...POPUPS, rules: POPUPS.rules.map((rule) => ({ name: rule.name, text: rule.text, rows: rule.rows })) };
    expect(popupUnder(file.texts, file.bottom, "", edit)).toBeNull();
  });

  it("a partial path is the path popup: a bare entry row under a text that is one path, never a slash command", () => {
    const path = screen("omp--v18-12-6-path-popup-partial--w120.txt");
    for (const text of ["~/src/ma", "./src/ma", "../src/ma", "/var/home/x/src/ma"]) {
      expect(popupUnder(path.texts, path.bottom, text, POPUPS), text).toMatchObject({ name: "path", stale: false });
    }
    for (const text of ["/model", "/mod", "/skill:x", "src/ma", "read ~/src/ma now"]) {
      expect(popupUnder(path.texts, path.bottom, text, POPUPS), text).toBeNull();
    }
  });

  it("a path whose last name is already the pointed entry has no popup: omp closes it, and Enter submits (closedWhenTyped)", () => {
    const full = screen("omp--v18-12-6-path-popup--w120.txt");
    const typed = "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo44h6i-fd050f5a.png";
    expect(popupUnder(full.texts, full.bottom, typed, POPUPS)).toBeNull();
    // The same row under a prefix of it is the popup: the entry is not typed yet.
    expect(popupUnder(full.texts, full.bottom, typed.slice(0, -10), POPUPS)).toMatchObject({ name: "path" });
  });

  it("a file popup is for a word that starts with @, never for a slash command", () => {
    const file = screen("omp--v18-6-1-at-popup--w120.txt");
    expect(popupUnder(file.texts, file.bottom, "ok @src/ done", POPUPS)).toBeNull();
    expect(popupUnder(file.texts, file.bottom, "/model @READ", POPUPS)).toBeNull();
    expect(popupUnder(file.texts, file.bottom, "please read@READ", POPUPS)).toBeNull();
  });

  it("the editor-action list a trailing bare `#` opens is the actions popup, and only a text that ends in the bare `#` opens it", () => {
    const rows = ["❯ Copy current line               Alt+⇧L", "  Copy whole prompt               Alt+⇧C"];
    expect(popupUnder(swap(rows), bottom, "ends with hash #", POPUPS)).toMatchObject({ name: "actions", first: bottom + 1, last: bottom + 2, pointed: bottom + 1, stale: false });
    expect(popupUnder(swap(rows), bottom, "#", POPUPS)).toMatchObject({ name: "actions" });
    // Until 2026-10-26 these rows were pinned as no popup, so a send over them read as a dialog (`modal_cue`),
    // and the offered Submit and Discard were refused. A `#` word with more after it opens the issue list, not this one.
    for (const text of ["fix item #1", "tag:#abc", "ends with hash # and more", "no hash"]) {
      expect(popupUnder(swap(rows), bottom, text, POPUPS), text).toBeNull();
    }
  });

  it("another list under the box is no popup: a dialog row, two pointers, none", () => {
    expect(popupUnder(swap(["❯ PR #1                           GitHub pull request", "  Issue #1                        GitHub issue", "Allow tool: bash"]), bottom, "fix item #1", POPUPS)).toBeNull();
    expect(popupUnder(swap(["❯ PR #1                           GitHub pull request", "❯ Issue #1                        GitHub issue"]), bottom, "fix item #1", POPUPS)).toBeNull();
    expect(popupUnder(swap(["  PR #1                           GitHub pull request", "  Issue #1                        GitHub issue"]), bottom, "fix item #1", POPUPS)).toBeNull();
  });

  it("a popup taller than the profile allows is no popup", () => {
    const rows = Array.from({ length: POPUPS.maxRows + 1 }, (_, i) => `${i === 0 ? "❯" : " "} name${String(i)}.png`);
    expect(popupUnder(swap(rows), bottom, "see @name", POPUPS)).toBeNull();
    expect(popupUnder(swap(rows.slice(0, POPUPS.maxRows)), bottom, "see @name", POPUPS)).not.toBeNull();
  });

  it("the emoji popup: a glyph and a :name: shortcode, one space after the glyph on omp 18.6.1 and 18.12.6, the pointer on one row", () => {
    const rows = ["❯ 😄 :smile:", "  😀  :smiley:", "  🙂 :)"];
    const read = popupUnder(swap(rows), bottom, "nice :smi", POPUPS);
    expect(read).toMatchObject({ name: "emoji", first: bottom + 1, last: bottom + 3, pointed: bottom + 1, stale: false });
    // A file name is no emoji row, and an emoji row is no file popup's.
    expect(popupUnder(swap(["❯ smile.png"]), bottom, "nice :smi", POPUPS)).toBeNull();
    expect(popupUnder(swap(rows), bottom, "nice @smi", POPUPS)?.name).toBe("file");
    expect(popupUnder(swap(rows), bottom, "nice smi", POPUPS)).toBeNull();
  });

  it("a slash list with an extension's widget or status row under it (commandList.footer) is no popup, whatever the text", () => {
    for (const name of ["omp--v18-12-6-status-row-palette-4.txt", "omp--v18-6-1-status-row-palette-4.txt", "omp--v18-12-6-status-row-palette-10.txt", "omp--v18-6-1-palette-widget-below-6.txt", "omp--v18-12-6-palette-widget-below-6.txt", "omp--v18-6-1-palette-widget-and-status.txt", "omp--v18-12-6-palette-widget-and-status.txt", "omp--v18-6-1-palette-tick-below.txt", "omp--v18-12-6-palette-tick-below.txt"]) {
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
