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

  it("the shipped profile names the status row as the list's footer", () => {
    expect(LIST.footer).toEqual({ pattern: "^\\S", maxRows: 4 });
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
    expect(findInputFrame([...base, ...status(4)], OMP)).not.toBeNull();
    expect(findInputFrame([...base, ...status(5)], OMP)).toBeNull();
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
