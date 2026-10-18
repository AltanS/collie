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
