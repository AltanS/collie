import { describe, expect, it } from "vitest";

import { fixtureRows } from "../../test/surface-corpus";
import { commandListNear, ownListUnder, pointsAt, type CommandListRead } from "./command-list";
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
