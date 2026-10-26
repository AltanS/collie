import { describe, expect, it } from "vitest";

import { fixtureRows, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { commandListNear, openedByText, openListUnder, ownListUnder, pointsAt, staleListUnder, type CommandListRead } from "./command-list";
import { findInputFrame, rowText } from "./frame";
import { requireProfile } from "./profile";

// Issue 497: omp 18.11.3 draws its slash list with the Nerd Font pointer (U+F054) under that preset,
// and lists a skill as `skill:<name>`. pi-tui's autocomplete.ts `collapseSkillNamespace` lets a skill
// out of its namespace row only when its bare name matches the typed prefix at a tier strictly above
// every plain command's and alias's, so a pointer on `skill:wrap-up` for a typed `/wrap-up` means no
// plain command or alias of that name exists, and Enter runs that skill (editor.ts applies the
// pointed completion, then submits).

const OMP = requireProfile("omp").idle;
const LIST = OMP.volatile.below.commandList!;

const read = (pointed: string | null, entries: readonly string[]): CommandListRead => ({ pointed, side: "under", first: 1, last: entries.length, entries });

describe("pointsAt: a path-like text and the entry that ends it (commandList.notForText)", () => {
  it("the pointer on the entry that ends the typed path is that path's own popup row", () => {
    expect(pointsAt(read("/x.png", ["/x.png"]), "~/.cache/x.png", LIST)).toBe(true);
    expect(pointsAt(read("/w2.png", ["/w2.png"]), "/var/uploads/w2.png", LIST)).toBe(true);
  });

  it("a pointer on any other row is another command's: /loop under /tmp/x, a longer name, a name the path only contains", () => {
    expect(pointsAt(read("/loop", ["/loop"]), "/tmp/x", LIST)).toBe(false);
    expect(pointsAt(read("/loop", ["/loop"]), "/etc/hosts", LIST)).toBe(false);
    expect(pointsAt(read("/xx.png", ["/xx.png"]), "/var/uploads/x.png", LIST)).toBe(false);
    expect(pointsAt(read("/x.png", ["/x.png"]), "/var/uploads/ax.png", LIST)).toBe(false);
    expect(pointsAt(read(null, ["/x.png"]), "/var/uploads/x.png", LIST)).toBe(false);
  });

  it("a text that is no path keeps the rule it had", () => {
    expect(pointsAt(read("/x.png", ["/x.png"]), "look at /var/uploads/x.png", LIST)).toBe(false);
    expect(pointsAt(read("/loop", ["/loop"]), "/loop", LIST)).toBe(true);
  });
});

describe("pointsAt: the list's pointer rests on the typed command", () => {
  it("the typed command itself, and never a longer one", () => {
    expect(pointsAt(read("/model", ["/model", "/models"]), "/model", LIST)).toBe(true);
    expect(pointsAt(read("/model", ["/model", "/models"]), " /model ", LIST)).toBe(true);
    expect(pointsAt(read("/models", ["/model", "/models"]), "/model", LIST)).toBe(false);
    expect(pointsAt(read(null, ["/model", "/models"]), "/model", LIST)).toBe(false);
  });

  it("a skill under its namespace for the bare name, while no entry on screen is the bare name", () => {
    expect(pointsAt(read("/skill:wrap-up", ["/skill:wrap-up"]), "/wrap-up", LIST)).toBe(true);
    expect(pointsAt(read("/skill:ship", ["/skill:ship"]), "/skill:ship", LIST)).toBe(true);
  });

  it("stops where both spellings are listed, on a longer or other-cased name, and on a profile with no namespace", () => {
    expect(pointsAt(read("/skill:ship", ["/ship", "/skill:ship"]), "/ship", LIST)).toBe(false);
    expect(pointsAt(read("/skill:ship", ["/skill:ship", "/ship"]), "/ship", LIST)).toBe(false);
    expect(pointsAt(read("/skill:wrap-up", ["/skill:wrap-up"]), "/wrap", LIST)).toBe(false);
    expect(pointsAt(read("/skill:wrap-up", ["/skill:wrap-up"]), "/Wrap-Up", LIST)).toBe(false);
    expect(pointsAt(read("/skill:wrap-up", ["/skill:wrap-up"]), "wrap-up", LIST)).toBe(false);
    expect(pointsAt(read("/skill:skill:x", ["/skill:skill:x"]), "/skill:x", LIST)).toBe(false);
    expect(pointsAt(read("/skill:", ["/skill:"]), "/", LIST)).toBe(false);
    const { namespaces, ...bare } = LIST;
    void namespaces;
    expect(pointsAt(read("/skill:wrap-up", ["/skill:wrap-up"]), "/wrap-up", bare)).toBe(false);
    expect(pointsAt(read("/skill:wrap-up", ["/skill:wrap-up"]), "/wrap-up", undefined)).toBe(false);
  });
});

describe("omp 18.11's slash list (issue 497)", () => {
  /** The list at the box of a capture, and the box's text. */
  interface ListAt {
    readonly read: CommandListRead | null;
    readonly text: string;
  }
  const listAt = (fixture: string): ListAt => {
    const rows = fixtureRows(fixture);
    const frame = findInputFrame(rows, OMP);
    expect(frame, fixture).not.toBeNull();
    return { read: commandListNear(rows.map(rowText), frame!.top, frame!.bottom, LIST), text: frame!.interior.text };
  };

  it.each(["omp--v18-11-nerd-slash-model--w130.txt", "omp--v18-11-nerd-slash-model--w80.txt"])("%s: the Nerd Font pointer rests on /model", (fixture) => {
    const { read: list, text } = listAt(fixture);
    expect(text).toBe("/model");
    expect(list).toMatchObject({ pointed: "/model", side: "under" });
    expect(pointsAt(list!, "/model", LIST)).toBe(true);
  });

  it.each(["omp--v18-11-nerd-skill-pointed--w130.txt", "omp--v18-11-nerd-skill-pointed--w80.txt", "omp--v18-11-skill-pointed--w130.txt"])(
    "%s: /wrap-up points at the skill skill:wrap-up, the only entry of that name",
    (fixture) => {
      const { read: list, text } = listAt(fixture);
      expect(text).toBe("/wrap-up");
      expect(list).toMatchObject({ pointed: "/skill:wrap-up", entries: ["/skill:wrap-up"] });
      expect(pointsAt(list!, "/wrap-up", LIST)).toBe(true);
      const rows = fixtureRows(fixture);
      const frame = findInputFrame(rows, OMP)!;
      expect(ownListUnder(rows.map(rowText), frame.bottom, "/wrap-up", LIST)).not.toBeNull();
    },
  );

  it("/ship with a command ship and a skill ship: omp lists only the command, and the pointer rests on it", () => {
    const { read: list } = listAt("omp--v18-11-nerd-skill-and-command--w130.txt");
    expect(list?.pointed).toBe("/ship");
    expect(list?.entries).toContain("/ship");
    expect(list?.entries).not.toContain("/skill:ship");
  });

  it("/skill:ship points at the skill by its long name", () => {
    const { read: list, text } = listAt("omp--v18-11-nerd-skill-long-form--w130.txt");
    expect(text).toBe("/skill:ship");
    expect(list).toMatchObject({ pointed: "/skill:ship", entries: ["/skill:ship"] });
  });
});

// Real OMP 18.12.2 (captured 2026-10-22, a goal turn running): with `/goal pause` typed, OMP draws the
// list of /goal's arguments under the box with the pointer on `pause`, and Enter runs the typed text.
// `commandList.argumentList` reads that pointer as the typed command's own; without it the pointer is
// on "another command" and the Send Protocol leaves the text typed with `modal_cue`.
describe("omp 18.12.2's argument list (the /goal capture, 2026-10-22)", () => {
  interface GoalList {
    readonly read: CommandListRead | null;
    readonly text: string;
  }
  const goalListAt = (fixture: string): GoalList => {
    const rows = fixtureRows(fixture);
    const frame = findInputFrame(rows, OMP);
    expect(frame, fixture).not.toBeNull();
    return { read: commandListNear(rows.map(rowText), frame!.top, frame!.bottom, LIST), text: frame!.interior.text };
  };
  const { argumentList, ...withoutFlag } = LIST;

  it("the shipped profile reads the argument list", () => {
    expect(argumentList).toBe(true);
  });

  it.each([
    ["omp--v18-12-2-goal-pause-typed--w119.txt", "/goal pause", "/pause"],
    ["omp--v18-12-2-goal-resume-typed--w119.txt", "/goal resume", "/resume"],
  ])("%s: the pointer rests on the argument typed", (fixture, typed, pointed) => {
    const { read: list, text } = goalListAt(fixture);
    expect(text).toBe(typed);
    expect(list).toMatchObject({ pointed, side: "under", entries: [pointed] });
    expect(pointsAt(list!, typed, LIST)).toBe(true);
    // Without the flag it is the pointer on another command, as before.
    expect(pointsAt(list!, typed, withoutFlag)).toBe(false);
    const rows = fixtureRows(fixture);
    const frame = findInputFrame(rows, OMP)!;
    expect(ownListUnder(rows.map(rowText), frame.bottom, typed, LIST)).not.toBeNull();
  });

  it("the bare /goal's list points at the command itself, with or without the flag", () => {
    const { read: list, text } = goalListAt("omp--v18-12-2-goal-bare-typed--w119.txt");
    expect(text).toBe("/goal");
    expect(list?.pointed).toBe("/goal");
    expect(pointsAt(list!, "/goal", LIST)).toBe(true);
    expect(pointsAt(list!, "/goal", withoutFlag)).toBe(true);
  });

  it("stops where the pointer is not on exactly the argument typed, or the list holds the command word", () => {
    expect(pointsAt(read("/pause", ["/pause"]), "/goal pause", LIST)).toBe(true);
    expect(pointsAt(read("/pause", ["/pause", "/resume"]), "/goal pause", LIST)).toBe(true);
    expect(pointsAt(read("/pause", ["/pause"]), "/goal   pause ", LIST)).toBe(true);
    expect(pointsAt(read("/resume", ["/pause", "/resume"]), "/goal pause", LIST)).toBe(false);
    expect(pointsAt(read("/pause", ["/pause"]), "/goal pa", LIST)).toBe(false);
    expect(pointsAt(read("/pause", ["/pause"]), "/goal paused", LIST)).toBe(false);
    expect(pointsAt(read("/pause", ["/pause"]), "/goal pause now", LIST)).toBe(false);
    expect(pointsAt(read("/pause", ["/pause"]), "pause", LIST)).toBe(false);
    expect(pointsAt(read(null, ["/pause"]), "/goal pause", LIST)).toBe(false);
    // The command word is itself an entry: this is the list of commands, not of /goal's arguments.
    expect(pointsAt(read("/pause", ["/goal", "/pause"]), "/goal pause", LIST)).toBe(false);
    expect(pointsAt(read("/pause", ["/pause"]), "/goal pause", undefined)).toBe(false);
  });

  it("a list of commands with the pointer on an unrelated command is no argument list: /goal pause typed, /model pointed", () => {
    expect(LIST.argumentList).toBe(true);
    expect(pointsAt(read("/model", ["/model", "/models"]), "/goal pause", LIST)).toBe(false);
    expect(pointsAt(read("/model", ["/model"]), "/goal pause", LIST)).toBe(false);
  });
});

// omp 18.6.1 and 18.12.6 (omp-gang testers, 2026-10-25): omp draws a fuzzy list of up to ten rows under the
// box for any text that starts with `/`. `/help` (no such command) lists ten commands that match it in part,
// the pointer on the first; `/mo` points at `model`. The list is the text's own popup (`leadOpens`), so the
// box past it is found and the Surface reads a draft; whether Enter runs what is typed is `pointsAt`'s
// question. 18.12.6 also leaves the last list row under the box after a cancelled `//comment`.
describe("omp's fuzzy list (18.6.1 and 18.12.6, 2026-10-25)", () => {
  const TALL = [
    ["omp--v18-6-1-slash-help-unlisted--w120.txt", "/help", "/plan-review", 10],
    ["omp--v18-6-1-slash-mo-fuzzy--w120.txt", "/mo", "/model", 10],
    ["omp--v18-6-1-slash-nothere-fuzzy--w120.txt", "/nothere", "/skills", 9],
    ["omp--v18-6-1-slash-open-tall--w120.txt", "/", "/skill:", 10],
    ["omp--v18-12-6-slash-help-unlisted--w120.txt", "/help", "/plan-review", 10],
    ["omp--v18-12-6-slash-mo-fuzzy--w120.txt", "/mo", "/model", 10],
    ["omp--v18-12-6-slash-nothere-fuzzy--w120.txt", "/nothere", "/skills", 9],
  ] as const;

  it("the shipped profile names the two rules", () => {
    expect(LIST.leadOpens).toBe(true);
    expect(LIST.staleWhenEmpty).toBe(true);
    expect(LIST.lead).toBe("/");
  });

  it.each(TALL)("%s: the box is found past the list, and the list is read whole", (fixture, typed, pointed, rows) => {
    const sheet = fixtureRows(fixture);
    const frame = findInputFrame(sheet, OMP);
    expect(frame, fixture).not.toBeNull();
    expect(frame!.interior.text).toBe(typed);
    const texts = sheet.map(rowText);
    const list = commandListNear(texts, frame!.top, frame!.bottom, LIST);
    expect(list).toMatchObject({ pointed, side: "under" });
    expect(list!.entries).toHaveLength(rows);
    // The typed text is not what Enter would run, whatever opened the list.
    expect(pointsAt(list!, typed, LIST)).toBe(false);
    expect(openedByText(list!, typed, LIST)).toBe(true);
    expect(openListUnder(texts, frame!.bottom, typed, LIST)).not.toBeNull();
  });

  it("without leadOpens a list that points at another command finds no box, as before", () => {
    const { leadOpens, ...without } = LIST;
    void leadOpens;
    const sheet = fixtureRows("omp--v18-6-1-slash-help-unlisted--w120.txt");
    const idle = { ...OMP, volatile: { ...OMP.volatile, below: { ...OMP.volatile.below, commandList: without } } };
    expect(findInputFrame(sheet, idle)).toBeNull();
    expect(openedByText({ pointed: "/plan-review", side: "under", first: 6, last: 7, entries: ["/plan-review"] }, "/help", without)).toBe(false);
  });

  it("a text that does not start with the lead did not open the list, and neither did a list with no pointer", () => {
    const list = read("/plan-review", ["/plan-review", "/switch"]);
    expect(openedByText(list, "help", LIST)).toBe(false);
    expect(openedByText(list, "", LIST)).toBe(false);
    expect(openedByText(list, "  /help", LIST)).toBe(true);
    expect(openedByText({ ...list, side: "above" }, "/help", LIST)).toBe(false);
    const sheet = fixtureRows("omp--v18-6-1-slash-help-unlisted--w120.txt");
    const frame = findInputFrame(sheet, OMP)!;
    const texts = sheet.map(rowText);
    const unpointed = texts.map((row) => row.replace(/^❯ /u, "  "));
    expect(openListUnder(unpointed, frame.bottom, "/help", LIST)).toBeNull();
  });

  it("a one-row list under a typed //comment is the box's own", () => {
    const sheet = fixtureRows("omp--v18-12-6-slash-comment-loop-row--w120.txt");
    const frame = findInputFrame(sheet, OMP)!;
    expect(frame.interior.text).toBe("//comment");
    const list = commandListNear(sheet.map(rowText), frame.top, frame.bottom, LIST);
    expect(list).toMatchObject({ pointed: "/loop", entries: ["/loop"] });
    expect(openedByText(list!, "//comment", LIST)).toBe(true);
  });

  it("the list row left under an emptied box is stale; under a box with text it is not", () => {
    const sheet = fixtureRows("omp--v18-12-6-stale-list-row-empty-box--w120.txt");
    const frame = findInputFrame(sheet, OMP)!;
    expect(frame.interior.text).toBe("");
    const texts = sheet.map(rowText);
    expect(staleListUnder(texts, frame.bottom, "", LIST)).toMatchObject({ pointed: "/loop", first: frame.bottom + 1, last: frame.bottom + 1 });
    expect(staleListUnder(texts, frame.bottom, "  ", LIST)).not.toBeNull();
    expect(staleListUnder(texts, frame.bottom, "/lo", LIST)).toBeNull();
    const { staleWhenEmpty, ...without } = LIST;
    void staleWhenEmpty;
    expect(staleListUnder(texts, frame.bottom, "", without)).toBeNull();
    expect(staleListUnder(texts, frame.bottom, "", undefined)).toBeNull();
  });
});

// omp gang, tester 15 (2026-10-25): an extension's `ctx.ui.setStatus` draws one plain row per key under
// everything else, so under a slash list too, flush left. A list of four rows or more ended on a row that
// was no entry, the box was not found past it, and the send of `/wx` stopped at `modal_cue` with the text
// left typed. The profile names those rows as the list's footer (`commandList.footer`).
describe("omp's slash list with an extension's status row under it (18.6.1 and 18.12.6, 2026-10-25)", () => {
  const sheet = (name: string) => fixtureRows(name, SURFACE_FIXTURES_DIR);

  it("the shipped profile names the rows an extension keeps under the list as its footer: a widget (one leading space) and a status row", () => {
    expect(LIST.footer).toEqual({ pattern: "^ ?\\S", maxRows: 13 });
    // The widget rows are the ones the frame reader accepts under an open box (`maxWidgetRows`), plus one status row.
    expect(LIST.footer!.maxRows).toBe(OMP.frame.maxWidgetRows! + 1);
  });

  it.each([
    ["omp--v18-12-6-status-row-palette-4.txt", "/wx", "/wx", 4],
    ["omp--v18-6-1-status-row-palette-4.txt", "/wx", "/wx", 4],
    ["omp--v18-12-6-status-row-palette-10.txt", "/w", "/wx", 10],
  ])("%s: the box holds %s, and the list under it is read whole with the status row left out", (fixture, typed, pointed, rows) => {
    const frame = findInputFrame(sheet(fixture), OMP);
    expect(frame, fixture).not.toBeNull();
    expect(frame!.interior.text).toBe(typed);
    const texts = sheet(fixture).map(rowText);
    const list = commandListNear(texts, frame!.top, frame!.bottom, LIST);
    expect(list).toMatchObject({ pointed, side: "under" });
    expect(list!.entries).toHaveLength(rows);
    expect(list!.last).toBe(texts.findLastIndex((row) => row.startsWith("PLAN")) - 1);
    expect(openListUnder(texts, frame!.bottom, typed, LIST)).not.toBeNull();
  });

  it("an extension's status rows up to the footer's bound are passed, one more is not", () => {
    const rows = sheet("omp--v18-12-6-status-row-palette-4.txt");
    const status = (n: number) => Array.from({ length: n }, (_, i) => ({ segments: [{ text: `STATUS ${String(i + 1)}` }] }));
    const base = rows.slice(0, rows.findLastIndex((row) => rowText(row).startsWith("PLAN")));
    const most = LIST.footer!.maxRows;
    expect(findInputFrame([...base, ...status(4)], OMP)).not.toBeNull();
    expect(findInputFrame([...base, ...status(most)], OMP)).not.toBeNull();
    expect(findInputFrame([...base, ...status(most + 1)], OMP)).toBeNull();
  });

  // omp-gang three, 01-regression S2 (2026-10-26): `/wb 6` (a widget of six rows below the box) or `/tfb` (a ticking
  // row below) and then `/wx`: the four-row palette stood over the widget, whose rows are drawn with one leading
  // space and are more than the flush-left footer allowed. The list read as a dialog, `/wx` stayed in the box,
  // and later sends were held or refused. The widget rows under a list are the rows the frame reader accepts
  // under an open box, so the footer takes them too.
  describe("a widget under the palette", () => {
    const CASES = [
      ["omp--v18-6-1-palette-widget-below-6.txt", "wb", 6],
      ["omp--v18-12-6-palette-widget-below-6.txt", "wb", 6],
      ["omp--v18-6-1-palette-widget-and-status.txt", "wb and a status row", 7],
      ["omp--v18-12-6-palette-widget-and-status.txt", "wb and a status row", 7],
      ["omp--v18-6-1-palette-tick-below.txt", "tfb", 1],
      ["omp--v18-12-6-palette-tick-below.txt", "tfb", 1],
    ] as const;

    it.each(CASES)("%s (%s): the box holds /wx, the four-row list is its own, and the %i rows under it are the footer", (fixture, _what, below) => {
      const rows = sheet(fixture);
      const frame = findInputFrame(rows, OMP);
      expect(frame, fixture).not.toBeNull();
      expect(frame!.interior.text).toBe("/wx");
      const texts = rows.map(rowText);
      const list = commandListNear(texts, frame!.top, frame!.bottom, LIST);
      expect(list).toMatchObject({ pointed: "/wx", side: "under" });
      expect(list!.entries).toHaveLength(4);
      expect(texts.length - 1 - list!.last).toBe(below);
      expect(openListUnder(texts, frame!.bottom, "/wx", LIST)).not.toBeNull();
    });

    it("a blank row inside the footer ends it: the rows after it are no widget of the list", () => {
      const rows = sheet("omp--v18-6-1-palette-widget-below-6.txt");
      const gap = [...rows.slice(0, rows.length - 3), { segments: [{ text: "" }] }, ...rows.slice(rows.length - 3)];
      expect(findInputFrame(gap, OMP)).toBeNull();
    });

    it("a widget under a list that points at another command is still not the typed command's list", () => {
      const rows = sheet("omp--v18-6-1-palette-widget-below-6.txt");
      const moved = rows.map((row) => (rowText(row).startsWith("❯ ") ? { segments: [{ text: rowText(row).replace(/^❯ /u, "  ") }] } : row));
      expect(findInputFrame(moved, OMP)).toBeNull();
    });
  });

  it("an indented row under the list is no status row", () => {
    const rows = sheet("omp--v18-12-6-status-row-palette-4.txt");
    const base = rows.slice(0, rows.findLastIndex((row) => rowText(row).startsWith("PLAN")));
    expect(findInputFrame([...base, { segments: [{ text: "  PLAN 3/6" }] }], OMP)).toBeNull();
  });

  it("the status row does not make an unpointed run a list: the pointer decides, as before", () => {
    const fixture = "omp--v18-12-6-status-row-palette-4.txt";
    const unpointed = sheet(fixture).map((row) => (rowText(row).startsWith("❯ ") ? { segments: [{ text: rowText(row).replace(/^❯ /u, "  ") }] } : row));
    expect(findInputFrame(unpointed, OMP)).toBeNull();
  });
});

// omp 18.6.1 and 18.12.6 (omp-gang testers 05 and 12, 2026-10-25): a file path at the start of the box makes
// omp draw its FILE popup under it, one `❯ pic.png` row for the path of one file. A file name has the shape of
// a command, so the profile's patterns took the row for a command list pointing at another command and the
// phone's send of an upload path ended `typed_not_submitted (modal_cue)` with nothing wrong. The profile's
// `notForText` names the texts that open another popup. Of the 44 command lists in the omp gang's captures
// (the whole sweep, 627 screens), 36 are real lists and keep their read, and these 8 are the file popup.
describe("omp's file popup under a path (notForText)", () => {
  const POPUPS = [
    ["omp--v18-6-1-path-popup--w120.txt", "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo3m20o-6e1a9e71.png", "/w2_p1-mvo3m20o-6e1a9e71.png"],
    ["omp--v18-6-1-path-popup-tilde--w120.txt", "~/.cache/collie-lab/omp-gang/12-pickers/state/harness/omp/project/x.png", "/x.png"],
    ["omp--v18-12-6-path-popup--w120.txt", "/home/demo/lab1/.cache/collie-lab/omp-gang/05-images/state/rig/state/uploads/w2_p1-mvo44h6i-fd050f5a.png", "/w2_p1-mvo44h6i-fd050f5a.png"],
  ] as const;

  it("the shipped profile names the rule", () => {
    expect(LIST.notForText).toBeDefined();
  });

  it.each(POPUPS)("%s: the box is found, and the popup row is no command list", (fixture, typed, pointedWithout) => {
    const sheet = fixtureRows(fixture);
    const frame = findInputFrame(sheet, OMP);
    expect(frame, fixture).not.toBeNull();
    expect(frame!.interior.text).toBe(typed);
    const texts = sheet.map(rowText);
    expect(commandListNear(texts, frame!.top, frame!.bottom, LIST, undefined, frame!.interior.prompt, typed)).toBeNull();
    expect(openListUnder(texts, frame!.bottom, typed, LIST)).toBeNull();
    expect(ownListUnder(texts, frame!.bottom, typed, LIST)).toBeNull();
    // Without the profile's rule the same row reads as a list, the pointer on a file name: the rule is what removes it.
    const { notForText, ...without } = LIST;
    void notForText;
    expect(commandListNear(texts, frame!.top, frame!.bottom, without, undefined, frame!.interior.prompt, typed)).toMatchObject({ pointed: pointedWithout, entries: [pointedWithout] });
  });

  it("matches a path at the start of the box, a wrapped draft of two paths, and an @ mention of a path", () => {
    const rule = new RegExp(LIST.notForText!, "u");
    for (const text of ["/var/home/x.png", "  /var/home/x.png", "/tmp/x", "~/x.png", "./a.png", "../a.png", "@/tmp/x.png", "@~/a", "/var/a.png/var/b.png", "/var/a.png /var/b.png"]) {
      expect(rule.test(text), text).toBe(true);
    }
  });

  it("matches no slash command, no fuzzy text and no argument: every one of those keeps its list", () => {
    const rule = new RegExp(LIST.notForText!, "u");
    for (const text of ["", "/", "/mo", "/model", "/help", "//comment", "/skill:wrap-up", "/goal pause", "/mcp enable srv", "/move /tmp/x", "look at /tmp/x", "what is a/b", "~", "~x", ".", "/tmp", "@", "@read"]) {
      expect(rule.test(text), text).toBe(false);
    }
  });

  it("a slash command's list keeps its read with the text passed in", () => {
    const sheet = fixtureRows("omp--v18-12-6-slash-mo-fuzzy--w120.txt");
    const frame = findInputFrame(sheet, OMP)!;
    const list = commandListNear(sheet.map(rowText), frame.top, frame.bottom, LIST, undefined, frame.interior.prompt, "/mo");
    expect(list).toMatchObject({ pointed: "/model", side: "under" });
  });
});
