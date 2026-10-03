import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { claudeBuildBlocks } from "./index";
import { detectResumePicker } from "./resume";

// The `/resume` session picker's own grammar (.adr/0058). Its footer never names Enter or the arrows,
// so the generic menu could only cancel it. These tests pin what the dedicated grammar reads off each
// real capture — the sessions, their meta rows, the pointed row and the walk each tap sends — and
// that it fails closed the moment any piece of its evidence is missing.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

/** A fixture's screen as plain text rows, for the hand-edited negatives below. */
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const LAB_SESSIONS = ["Count to three", "Name a colour", "say ok", "Say hi in one word"];

describe("the real captures lift as a list of sessions", () => {
  it("w120-first: the pointer on the first session, each other row walks Down", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-first.txt"))!;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Resume session");
    // The card's caption is this dialog's own title, not the generic "select" family caption.
    expect(model.caption).toBe("Resume session");
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options[0]!.description).toBe("44 seconds ago · master · 177.4KB");
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options[0]!.keyLabel).toBe("❯");
  });

  it("w120-third: the pointer on the third session walks Up above it and Down below it", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-third.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options.map((o) => o.description)).toEqual([
      "1 minute ago · master · 177.4KB",
      "1 minute ago · master · 177.5KB",
      "2 minutes ago · master · 176.8KB",
      "2 minutes ago · master · 177.5KB",
      undefined,
    ]);
    expect(model.options[0]!.keys).toEqual(["Up", "Up", "Enter"]);
    expect(model.options[1]!.keys).toEqual(["Up", "Enter"]);
    expect(model.options[2]!.keys).toEqual(["Enter"]);
    expect(model.options[3]!.keys).toEqual(["Down", "Enter"]);
    // Every non-pointed session row carries the explicit "no badge" marker, never left unset — the
    // block renders it as an empty, same-width slot rather than falling back to the raw key name.
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "", "❯", "", "Esc"]);
  });

  it("w80-second: the pointer on the second session", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w80-second.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Escape"],
    ]);
  });

  it("w60-first: the footer wrapped onto three rows still reads, and the list is the same", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w60-first.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options[0]!.keys).toEqual(["Enter"]);
    expect(model.options[3]!.keys).toEqual(["Down", "Down", "Down", "Enter"]);
    // The whole wrapped footer is inside the signature, down to its last row.
    expect(model.signature.endsWith("· Type to search · Esc to cancel")).toBe(true);
  });

  it("w120-search: one match and no pointer — its tap is Enter, and Esc clears the search", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-search.txt"))!;
    expect(model.options).toEqual([
      { label: "Say hi in one word", description: "4 minutes ago · master · 177.5KB", keys: ["Enter"] },
      { label: "Clear", keys: ["Escape"], keyLabel: "Esc" },
    ]);
  });

  it("w120-all-sanitized: the all-projects title, a `now` age, and the `↓` scroll row as a session", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-all-sanitized.txt"))!;
    expect(model.question).toBe("Resume session (1 of 50)");
    expect(model.caption).toBe("Resume session (1 of 50)");
    expect(model.options).toHaveLength(10);
    expect(model.options[0]!.description).toBe(
      "now · main · 1.1MB · /home/user/projects/example-company-platform",
    );
    expect(model.options[0]!.keyLabel).toBe("❯");
    // The last session carries the `↓` marker in the pointer column: listed, walked to, not pointed.
    expect(model.options[8]!.label).toBe("classifier milestone m09");
    expect(model.options[8]!.keyLabel).toBe("");
    expect(model.options[8]!.keys).toEqual([...Array<string>(8).fill("Down"), "Enter"]);
    expect(model.options[9]!.keys).toEqual(["Escape"]);
  });

  it("the older lab capture at 83 columns lifts the same way", () => {
    const model = detectResumePicker(load("claude-lab--menu-resume-picker--w83.txt"))!;
    expect(model.options.map((o) => [o.label, o.keys])).toEqual([
      ["Read README.md", ["Enter"]],
      ["README review", ["Down", "Enter"]],
      ["Cancel", ["Escape"]],
    ]);
  });

  it("no key anywhere is a digit, and only the Esc row lacks Enter", () => {
    for (const name of RESUME_FIXTURES) {
      for (const option of detectResumePicker(load(name))!.options) {
        expect(option.keys.some((k) => /\d/.test(k)), `${name}: ${option.label}`).toBe(false);
        const last = option.keys.at(-1);
        expect(last === "Enter" || (option.keys.length === 1 && last === "Escape"), name).toBe(true);
      }
    }
  });

  it("the pipeline emits it as a prompt-select block, not the generic menu", () => {
    for (const name of RESUME_FIXTURES) {
      const blocks = claudeBuildBlocks(load(name));
      expect(blocks.at(-1)!.kind, name).toBe("prompt-select");
      expect(blocks.filter((b) => b.kind !== "raw"), name).toHaveLength(1);
    }
  });
});

const RESUME_FIXTURES = [
  "claude--menu-resume-picker--w120-first.txt",
  "claude--menu-resume-picker--w120-third.txt",
  "claude--menu-resume-picker--w120-search.txt",
  "claude--menu-resume-picker--w60-first.txt",
  "claude--menu-resume-picker--w80-second.txt",
  "claude--menu-resume-picker--w120-all-sanitized.txt",
  "claude-lab--menu-resume-picker--w83.txt",
];

describe("the race guard sees the pointer", () => {
  it("a pointer moved between render and tap is not the same prompt", () => {
    const first = detectResumePicker(load("claude--menu-resume-picker--w120-first.txt"))!;
    const texts = textsOf("claude--menu-resume-picker--w120-first.txt");
    const pointedAt = texts.findIndex((t) => t.startsWith("   ❯ Count to three"));
    const nextAt = texts.findIndex((t) => t.startsWith("     Name a colour"));
    const moved = [...texts];
    moved[pointedAt] = texts[pointedAt]!.replace("❯", " ");
    moved[nextAt] = texts[nextAt]!.replace("     Name", "   ❯ Name");
    const after = detectResumePicker(fromTexts(moved))!;
    expect(after.options[1]!.keys).toEqual(["Enter"]);
    expect(after.signature).not.toBe(first.signature);
    expect(promptsEqual(first, after)).toBe(false);
    // And a re-derivation of the unchanged screen is equal, so the guard is not simply always shut.
    expect(promptsEqual(first, detectResumePicker(fromTexts(texts))!)).toBe(true);
  });
});

describe("a relative age ticks without a key, and the verify step of a walked tap survives it", () => {
  const FIRST = "claude--menu-resume-picker--w120-first.txt";
  const THIRD = "claude--menu-resume-picker--w120-third.txt";

  it("two real captures, the pointer moved and four ages ticked, are one dialog both ways", () => {
    const first = detectResumePicker(load(FIRST))!;
    const third = detectResumePicker(load(THIRD))!;
    // The ages differ (`44 seconds ago` against `1 minute ago`), and so does the pointer.
    expect(first.options[0]!.description).not.toBe(third.options[0]!.description);
    expect(promptsSameIdentity(first, third)).toBe(true);
    expect(promptsSameIdentity(third, first)).toBe(true);
    // The entry guard still refuses: the byte-faithful signature carries the pointer and every age.
    expect(promptsEqual(first, third)).toBe(false);
  });

  it("an age that ticks with the pointer fixed keeps the identity and moves the signature", () => {
    const texts = textsOf(FIRST);
    const ticked = texts.map((t) => t.replace("44 seconds ago", "1 minute ago"));
    const before = detectResumePicker(fromTexts(texts))!;
    const after = detectResumePicker(fromTexts(ticked))!;
    expect(after.signature).not.toBe(before.signature);
    expect(after.coreSignature).toBe(before.coreSignature);
    expect(promptsSameIdentity(before, after)).toBe(true);
    expect(promptsEqual(before, after)).toBe(false);
  });

  it("blanks the age token alone: a changed size, branch or title still breaks the identity", () => {
    const texts = textsOf(FIRST);
    const before = detectResumePicker(fromTexts(texts))!;
    for (const [from, to] of [
      ["177.4KB", "177.9KB"],
      ["master", "main"],
      ["Count to three", "Count to four"],
    ] as const) {
      const edited = texts.map((t) => t.replace(from, to));
      const after = detectResumePicker(fromTexts(edited))!;
      expect(promptsSameIdentity(before, after), `${from} to ${to}`).toBe(false);
    }
  });

  it("an age word in a title is not an age: only the meta row's own token is blanked", () => {
    const texts = textsOf(FIRST);
    const edited = texts.map((t) => t.replace("Name a colour", "Name a colour 2 hours ago"));
    const before = detectResumePicker(fromTexts(edited))!;
    const ticked = edited.map((t) => t.replace("2 hours ago", "3 hours ago"));
    const after = detectResumePicker(fromTexts(ticked))!;
    expect(promptsSameIdentity(before, after)).toBe(false);
  });

  it("the all-projects view's `now` age is blanked too", () => {
    const texts = textsOf("claude--menu-resume-picker--w120-all-sanitized.txt");
    const at = texts.findIndex((t) => /^\s+now · /.test(t));
    expect(at).toBeGreaterThan(0);
    const aged = texts.map((t, i) => (i === at ? t.replace("now", "1 minute ago") : t));
    const before = detectResumePicker(fromTexts(texts))!;
    const after = detectResumePicker(fromTexts(aged))!;
    expect(promptsSameIdentity(before, after)).toBe(true);
    expect(promptsEqual(before, after)).toBe(false);
  });
});

describe("fails closed", () => {
  const base = textsOf("claude--menu-resume-picker--w120-third.txt");

  it("without the search box", () => {
    const at = base.findIndex((t) => t.includes("⌕"));
    const texts = base.filter((_, i) => i < at - 1 || i > at + 1);
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("without the `Resume session` title", () => {
    const texts = base.map((t) => (t.trim() === "Resume session" ? "   Pick a session" : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("with several sessions and no pointer", () => {
    const texts = base.map((t) => t.replace("❯", " "));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("with two pointers", () => {
    const texts = base.map((t) => (t.startsWith("     Count to three") ? t.replace("     Count", "   ❯ Count") : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("without `Esc to cancel` in the footer", () => {
    const texts = base.map((t) => t.replace("Esc to cancel", "Esc to go back"));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("on a numbered list below a `Resume session` line of prose", () => {
    const texts = [
      "",
      "   Resume session",
      "",
      "   ❯ 1. Count to three",
      "     2. Name a colour",
      "",
      "   Enter to select · Esc to cancel",
    ];
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("never turns the project heading into an option", () => {
    const model = detectResumePicker(fromTexts(base))!;
    expect(model.options.map((o) => o.label)).not.toContain("resume-lab");
    // Even with the blank row under the heading removed, the heading has no meta row of its own.
    const at = base.findIndex((t) => t.trim() === "resume-lab");
    const tight = base.filter((_, i) => i !== at + 1);
    expect(detectResumePicker(fromTexts(tight))!.options.map((o) => o.label)).toEqual([
      ...LAB_SESSIONS,
      "Cancel",
    ]);
  });

  it("claims no other Claude capture in the corpus", () => {
    const others = readdirSync(PANES_DIR).filter(
      (f) => /^claude(-lab)?--/.test(f) && f.endsWith(".txt") && !f.includes("resume-picker"),
    );
    expect(others.length).toBeGreaterThan(100);
    for (const name of others) {
      expect(detectResumePicker(load(name)), name).toBeNull();
    }
  });
});

// THE OVER-ACCEPT DIRECTION (ADR 0080 point 5). Every blank in `coreSignature` is a safety decision:
// it is the only link between the dialog the user tapped and the Enter that goes out after the walk.
// The tests above prove the blanks do not over-refuse. These start from a real capture, change ONE
// thing, and assert the stated result with `promptsSameIdentity`.
describe("mutations of a real capture: what the verify read must hold and what it must refuse", () => {
  const FIRST = "claude--menu-resume-picker--w120-first.txt";
  const AGE_ROW = /^(\s+)(\d+ \w+ ago|now)( · .*)$/;

  const metaRows = (texts: string[]): number[] =>
    texts.flatMap((t, i) => (AGE_ROW.test(t) ? [i] : []));
  const setAge = (row: string, age: string): string => row.replace(AGE_ROW, `$1${age}$3`);
  /** `texts` with the nth meta row's age set, one age per session in order. */
  const withAges = (texts: string[], ages: string[]): string[] => {
    const rows = metaRows(texts);
    expect(rows).toHaveLength(ages.length);
    return texts.map((t, i) => (rows.includes(i) ? setAge(t, ages[rows.indexOf(i)]!) : t));
  };
  const model = (texts: string[]) => {
    const m = detectResumePicker(fromTexts(texts));
    expect(m, "the edited screen must still lift").not.toBeNull();
    return m!;
  };
  const same = (a: string[], b: string[]): boolean => promptsSameIdentity(model(a), model(b));
  /** The session's title row index: the row above its meta row. */
  const titleOf = (texts: string[], session: number): number => metaRows(texts)[session]! - 1;

  const base = textsOf(FIRST);

  it("holds: every age shifted, across a width change (9 to 10 minutes, 59 minutes to 1 hour)", () => {
    const before = withAges(base, ["9 minutes ago", "59 minutes ago", "2 minutes ago", "1 minute ago"]);
    const after = withAges(base, ["10 minutes ago", "1 hour ago", "3 minutes ago", "now"]);
    expect(same(before, after)).toBe(true);
    expect(same(after, before)).toBe(true);
    expect(promptsEqual(model(before), model(after))).toBe(false);
  });

  it("differs: a session title changed", () => {
    const edited = base.map((t) => t.replace("say ok", "say no"));
    expect(same(base, edited)).toBe(false);
  });

  it("differs: a session size changed", () => {
    const edited = base.map((t) => t.replace("176.8KB", "176.9KB"));
    expect(edited).not.toEqual(base);
    expect(same(base, edited)).toBe(false);
  });

  it("differs: a session removed", () => {
    const at = titleOf(base, 2);
    const edited = base.filter((_, i) => i !== at && i !== at + 1);
    expect(model(edited).options).toHaveLength(model(base).options.length - 1);
    expect(same(base, edited)).toBe(false);
  });

  it("differs: two non-twin sessions swapped (the pointer stays on the first row)", () => {
    const a = titleOf(base, 1);
    const b = titleOf(base, 2);
    const edited = [...base];
    [edited[a], edited[b]] = [base[b], base[a]];
    [edited[a + 1], edited[b + 1]] = [base[b + 1], base[a + 1]];
    expect(same(base, edited)).toBe(false);
  });

  it("an age-shaped string inside a title is not blanked: changing it changes the identity", () => {
    const at = titleOf(base, 1);
    const titled = (n: number) => base.map((t, i) => (i === at ? t.replace("Name a colour", `fix the ${n} minutes ago bug`) : t));
    expect(titled(5)[at]).toContain("fix the 5 minutes ago bug");
    expect(same(titled(5), titled(5))).toBe(true);
    expect(same(titled(5), titled(6))).toBe(false);
  });

  describe("twin rows: same title, same meta apart from the age", () => {
    /** The base with a second `Count to three` (same meta but for the age) after the third session. */
    const withTwin = (twinAge: string): string[] => {
      const first = titleOf(base, 0);
      const last = metaRows(base)[2]!;
      const title = base[first]!.replace("❯", " ");
      const meta = setAge(base[first + 1]!, twinAge);
      return [...base.slice(0, last + 1), title, meta, ...base.slice(last + 1)];
    };
    const twinned = withTwin("3 minutes ago");
    const first = metaRows(twinned)[0]!;
    const twin = metaRows(twinned)[3]!;

    it("the sessions really are twins, and the others are not", () => {
      const m = model(twinned);
      expect(m.options.map((o) => o.label)).toEqual(["Count to three", "Name a colour", "say ok", "Count to three", "Say hi in one word", "Cancel"]);
    });

    it("keeps the twins' ages verbatim in coreSignature and blanks every other age", () => {
      const core = model(twinned).coreSignature;
      expect(core).toContain("44 seconds ago · master · 177.4KB");
      expect(core).toContain("3 minutes ago · master · 177.4KB");
      expect(core.match(/<age>/g)).toHaveLength(3);
    });

    it("swapping the twins changes coreSignature, so the identity is refused", () => {
      const swapped = twinned.map((t, i) => (i === first ? setAge(t, "3 minutes ago") : i === twin ? setAge(t, "44 seconds ago") : t));
      expect(model(swapped).coreSignature).not.toBe(model(twinned).coreSignature);
      expect(same(twinned, swapped)).toBe(false);
    });

    it("a tick on a twin row answers changed, the safe side", () => {
      const ticked = twinned.map((t, i) => (i === twin ? setAge(t, "4 minutes ago") : t));
      expect(same(twinned, ticked)).toBe(false);
    });

    it("a non-twin row's age is still blanked, with a twin on screen", () => {
      const second = metaRows(twinned)[1]!;
      const ticked = twinned.map((t, i) => (i === second ? setAge(t, "7 minutes ago") : t));
      expect(ticked).not.toEqual(twinned);
      expect(same(twinned, ticked)).toBe(true);
    });

    it("without a twin the same age swap is blanked, as before", () => {
      const ticked = base.map((t, i) => (i === metaRows(base)[0] ? setAge(t, "3 minutes ago") : t));
      expect(same(base, ticked)).toBe(true);
    });
  });
});
