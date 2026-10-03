import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { ompBuildBlocks } from "./index";
import { detectResumePicker, detectResumePickerRegion } from "./resume";

// The omp `/resume` session picker's own grammar (.adr/0076). Both of its footers print the commit key
// (`⏎ select` / `Enter select`), so a tap is the pointer walk plus a key the screen printed. These tests
// pin what the grammar reads off each real capture, in both layouts, the walk each tap sends, and that
// it fails closed the moment any piece of its evidence is missing.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const NEW_TITLE = "Render Fancy Content in Terminal";

describe("the boxed picker (omp 18.4.10) lifts as a list of sessions", () => {
  it("resume: the pointer on the first session, the second walks Down", () => {
    const model = detectResumePicker(load("omp--v18-4-resume.txt"))!;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Resume Session (current folder)");
    // The card's caption is this dialog's own title, not the generic "Choose an option".
    expect(model.caption).toBe("Resume Session (current folder)");
    expect(model.options.map((o) => o.label)).toEqual([NEW_TITLE, NEW_TITLE, "Cancel"]);
    // Two sessions share a title, so the description is what tells them apart: the whole meta row,
    // age first, with omp's double-spaced separators normalised.
    expect(model.options.map((o) => o.description)).toEqual([
      "7 minutes ago · 138.1KB · current · ✔ done · ⑂ fork",
      "11 minutes ago · 138.0KB · ✔ done",
      undefined,
    ]);
    expect(model.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"], ["Escape"]]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "Esc"]);
  });

  it("resume-moved: the pointer on the second session, the first walks Up", () => {
    const model = detectResumePicker(load("omp--v18-4-resume-moved.txt"))!;
    expect(model.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Escape"]]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "❯", "Esc"]);
  });

  it("resume-search: the typed search leaves the list, and the pointer, readable", () => {
    const model = detectResumePicker(load("omp--v18-4-resume-search.txt"))!;
    // `ab` matched both sessions, in the other order.
    expect(model.options.map((o) => o.description)).toEqual([
      "11 minutes ago · 138.0KB · ✔ done",
      "7 minutes ago · 138.1KB · current · ✔ done · ⑂ fork",
      undefined,
    ]);
    expect(model.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"], ["Escape"]]);
  });

  it("resume-all-projects: the other title, a trailing cwd on every meta row, its own footer", () => {
    const model = detectResumePicker(load("omp--v18-4-resume-all-projects.txt"))!;
    expect(model.question).toBe("Resume Session (all projects)");
    expect(model.options[0]!.description).toBe(
      "7 minutes ago · 138.1KB · current · ✔ done · ⑂ fork · ~/projects/sample-workspace",
    );
    expect(model.options[1]!.description).toBe("11 minutes ago · 138.0KB · ✔ done · ~/projects/sample-workspace");
    expect(model.options.at(-1)).toEqual({ label: "Cancel", keys: ["Escape"], keyLabel: "Esc" });
  });

  it("resume-nomatch: no sessions to list, so the grammar declines and the raw mirror stays", () => {
    expect(detectResumePicker(load("omp--v18-4-resume-nomatch.txt"))).toBeNull();
  });

  it("the region runs from the box's top border to its bottom border", () => {
    const lines = load("omp--v18-4-resume.txt");
    const region = detectResumePickerRegion(lines)!;
    expect(region.startLine).toBe(0);
    const rows = region.model.signature.split("\n");
    expect(rows[0]!.startsWith("╭─ Resume Session (current folder) ")).toBe(true);
    expect(rows.at(-1)!.startsWith("╰─")).toBe(true);
    expect(rows).toHaveLength(59);
  });
});

describe("the unboxed picker (omp 17.x to 18.1) lifts the same way", () => {
  it("menu-resume: a titled session, then two untitled ones that print two rows each", () => {
    const model = detectResumePicker(load("omp--menu-resume.txt"))!;
    expect(model.question).toBe("Resume Session (current folder)");
    // An untitled session's first prompt is the only name it has, so that is its label.
    expect(model.options.map((o) => o.label)).toEqual([
      "1",
      "run the shell command: ls -la",
      "/run the bash command: rm -rf /tmp/omp-sandbox-nope",
      "Cancel",
    ]);
    expect(model.options.map((o) => o.description)).toEqual([
      "1 minute ago · 1.9KB · ✔ done",
      "3 minutes ago · 14.4KB · ⚠ interrupted",
      "12 minutes ago · 2.7KB · ⚠ interrupted",
      undefined,
    ]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "", "Esc"]);
  });

  it("menu-resume-moved: the pointer on the third, a two-row session, walks Up above it", () => {
    const model = detectResumePicker(load("omp--menu-resume-moved.txt"))!;
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Up", "Enter"],
      ["Up", "Enter"],
      ["Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "", "❯", "Esc"]);
  });

  it("the region starts at the title row, below the blank row above it", () => {
    const region = detectResumePickerRegion(load("omp--menu-resume.txt"))!;
    expect(region.startLine).toBe(1);
    expect(region.model.signature.split("\n")[0]).toBe(" Resume Session (current folder)");
  });
});

describe("every tap is the walk plus a key the footer printed", () => {
  const LIFTED = [
    "omp--menu-resume-moved.txt",
    "omp--menu-resume.txt",
    "omp--v18-4-resume-all-projects.txt",
    "omp--v18-4-resume-moved.txt",
    "omp--v18-4-resume-search.txt",
    "omp--v18-4-resume.txt",
  ];

  it.each(LIFTED)("%s: no key is a digit, and each option walks from the pointed row", (name) => {
    const model = detectResumePicker(load(name))!;
    const sessions = model.options.slice(0, -1);
    const pointedAt = model.options.findIndex((o) => o.keyLabel === "❯");
    expect(pointedAt).toBeGreaterThanOrEqual(0);
    sessions.forEach((option, i) => {
      expect(option.keys.some((k) => /\d/.test(k)), `${name}: ${option.label}`).toBe(false);
      expect(option.keys.at(-1)).toBe("Enter");
      const arrows = option.keys.slice(0, -1);
      expect(arrows).toHaveLength(Math.abs(i - pointedAt));
      expect(new Set(arrows).size).toBeLessThanOrEqual(1);
      if (i > pointedAt) expect(arrows.every((k) => k === "Down")).toBe(true);
      if (i < pointedAt) expect(arrows.every((k) => k === "Up")).toBe(true);
    });
    // The pointed row sends exactly Enter, and the way out is Escape alone.
    expect(sessions[pointedAt]!.keys).toEqual(["Enter"]);
    expect(model.options.at(-1)!.keys).toEqual(["Escape"]);
  });

  it.each(LIFTED)("%s: only the pointed row carries a badge, the rest an explicit empty one", (name) => {
    const model = detectResumePicker(load(name))!;
    const badges = model.options.slice(0, -1).map((o) => o.keyLabel);
    expect(badges.filter((b) => b === "❯")).toHaveLength(1);
    expect(badges.filter((b) => b !== "❯").every((b) => b === "")).toBe(true);
  });

  it("the pipeline emits it as a prompt-select block and keeps the rest raw", () => {
    for (const name of LIFTED) {
      const blocks = ompBuildBlocks(load(name));
      expect(blocks.at(-1)!.kind, name).toBe("prompt-select");
      expect(blocks.filter((b) => b.kind !== "raw"), name).toHaveLength(1);
    }
  });
});

describe("the race guard sees the pointer, the rows and the ticking age", () => {
  it("a pointer moved between render and tap is not the same prompt", () => {
    const first = detectResumePicker(load("omp--v18-4-resume.txt"))!;
    const moved = detectResumePicker(load("omp--v18-4-resume-moved.txt"))!;
    // Same screen bar the pointer: the signature carries the `❯` column verbatim, so it moves.
    expect(moved.signature).not.toBe(first.signature);
    // …and so do the walks baked into every option's keys.
    expect(moved.options[0]!.keys).not.toEqual(first.options[0]!.keys);
    expect(promptsEqual(first, moved)).toBe(false);
    // A re-derivation of the unchanged screen is equal, so the guard is not simply always shut.
    expect(promptsEqual(first, detectResumePicker(load("omp--v18-4-resume.txt"))!)).toBe(true);
  });

  it("the same holds in the unboxed layout", () => {
    const first = detectResumePicker(load("omp--menu-resume.txt"))!;
    const moved = detectResumePicker(load("omp--menu-resume-moved.txt"))!;
    expect(moved.signature).not.toBe(first.signature);
    expect(promptsEqual(first, moved)).toBe(false);
  });

  it("the core signature ignores the pointer and nothing else", () => {
    const a = detectResumePicker(load("omp--v18-4-resume.txt"))!;
    const b = detectResumePicker(load("omp--v18-4-resume-moved.txt"))!;
    expect(a.coreSignature).not.toBe("");
    // The pointer is the one difference between these two captures, and the core signature is blind to it.
    expect(a.coreSignature).toBe(b.coreSignature);
    expect(a.coreSignature).not.toContain("❯");
  });

  it.each([
    ["omp--v18-4-resume.txt", "omp--v18-4-resume-moved.txt"],
    ["omp--menu-resume.txt", "omp--menu-resume-moved.txt"],
  ])("%s and %s: the pointer moved, ages may have ticked, and the identity holds both ways", (a, b) => {
    const first = detectResumePicker(load(a))!;
    const moved = detectResumePicker(load(b))!;
    expect(promptsSameIdentity(first, moved)).toBe(true);
    expect(promptsSameIdentity(moved, first)).toBe(true);
    expect(promptsEqual(first, moved)).toBe(false);
  });

  it("the unboxed pair really differs in its ages, which the core signature blanks", () => {
    const first = detectResumePicker(load("omp--menu-resume.txt"))!;
    const moved = detectResumePicker(load("omp--menu-resume-moved.txt"))!;
    expect(first.options.map((o) => o.description)).not.toEqual(moved.options.map((o) => o.description));
    expect(first.coreSignature).toBe(moved.coreSignature);
    expect(first.coreSignature).toContain("<age>");
  });

  it("an age that ticks with the pointer fixed keeps the identity, in both layouts", () => {
    for (const [name, from, to] of [
      ["omp--v18-4-resume.txt", "7 minutes ago ", "8 minutes ago "],
      ["omp--menu-resume.txt", "1 minute ago ", "2 minutes ago "],
    ] as const) {
      const texts = textsOf(name);
      const before = detectResumePicker(fromTexts(texts))!;
      const after = detectResumePicker(fromTexts(texts.map((t) => t.replace(from, to))))!;
      expect(after.signature, name).not.toBe(before.signature);
      expect(promptsSameIdentity(before, after), name).toBe(true);
      expect(promptsEqual(before, after), name).toBe(false);
    }
  });

  it("an age that grows in width keeps the identity in the boxed layout (padding to the border)", () => {
    const texts = textsOf("omp--v18-4-resume.txt");
    // The box keeps its width, so one more character of age is one fewer cell of padding.
    const wide = texts.map((t) =>
      t.includes("7 minutes ago") ? t.replace("7 minutes ago", "17 minutes ago").replace(/ │$/, "│") : t,
    );
    const before = detectResumePicker(fromTexts(texts))!;
    const after = detectResumePicker(fromTexts(wide))!;
    expect(after.signature).not.toBe(before.signature);
    expect(promptsSameIdentity(before, after)).toBe(true);
  });

  it("blanks the age token alone: a changed size or a `done` mark breaks the identity", () => {
    const texts = textsOf("omp--v18-4-resume.txt");
    const before = detectResumePicker(fromTexts(texts))!;
    for (const [from, to] of [
      ["138.1KB", "139.1KB"],
      ["✔ done", "⚠ interrupted"],
    ] as const) {
      const after = detectResumePicker(fromTexts(texts.map((t) => t.replace(from, to))))!;
      expect(promptsSameIdentity(before, after), `${from} to ${to}`).toBe(false);
    }
  });

  it("an age that ticks moves the signature, so a tap across the tick is refused", () => {
    const texts = textsOf("omp--v18-4-resume.txt");
    const ticked = texts.map((t) => t.replace("7 minutes ago ", "8 minutes ago "));
    const before = detectResumePicker(fromTexts(texts))!;
    const after = detectResumePicker(fromTexts(ticked))!;
    expect(after.signature).not.toBe(before.signature);
    expect(promptsEqual(before, after)).toBe(false);
  });

  it("a changed first-prompt row moves the signature although nothing parses it", () => {
    const texts = textsOf("omp--v18-4-resume.txt");
    const edited = texts.map((t, i) => (i === 5 ? t.replace("fancy stuff", "other stuff") : t));
    expect(detectResumePicker(fromTexts(edited))!.signature).not.toBe(
      detectResumePicker(fromTexts(texts))!.signature,
    );
  });

  it("a session added to the list changes the options, so the guard sees it", () => {
    const texts = textsOf("omp--v18-4-resume.txt");
    // Add a third group where the blank rows start (rows 11 to 13), same shape as the others.
    const third = [
      texts[8]!.replace(NEW_TITLE, "Another session title"),
      texts[9]!,
      texts[10]!.replace("11 minutes", "30 minutes"),
    ];
    const grown = [...texts.slice(0, 12), ...third, ...texts.slice(15)];
    expect(grown).toHaveLength(texts.length);
    const model = detectResumePicker(fromTexts(grown))!;
    expect(model.options.map((o) => o.label)).toEqual([NEW_TITLE, NEW_TITLE, "Another session title", "Cancel"]);
    expect(model.options[2]!.keys).toEqual(["Down", "Down", "Enter"]);
  });
});

describe("fails closed", () => {
  const boxed = textsOf("omp--v18-4-resume.txt");
  const bare = textsOf("omp--menu-resume.txt");

  const FOOTER_AT = 56;
  const BARE_FOOTER_AT = 54;

  it("positive control: both unedited captures lift, so every edit below is what declines", () => {
    expect(detectResumePicker(fromTexts(boxed))).not.toBeNull();
    expect(detectResumePicker(fromTexts(bare))).not.toBeNull();
    expect(boxed[FOOTER_AT]).toContain("⎋ cancel");
    expect(bare[BARE_FOOTER_AT]).toContain("Esc cancel");
  });

  it("with the pointer on no session", () => {
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace("│ ❯ ", "│   "))))).toBeNull();
    expect(detectResumePicker(fromTexts(bare.map((t) => t.replace("❯ 1", "  1"))))).toBeNull();
  });

  it("with two pointers", () => {
    const texts = boxed.map((t, i) => (i === 8 ? t.replace("│   ", "│ ❯ ") : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
    const old = bare.map((t) => (t.startsWith("  run the shell") ? t.replace("  run", "❯ run") : t));
    expect(detectResumePicker(fromTexts(old))).toBeNull();
  });

  it("without the commit key in the footer", () => {
    const texts = boxed.map((t) => t.replace("⏎ select · ", ""));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
    const old = bare.map((t) => t.replace("Enter select · ", ""));
    expect(detectResumePicker(fromTexts(old))).toBeNull();
  });

  it("without the way out, or with a different one, ending the footer", () => {
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace("⎋ cancel", "⎋ back"))))).toBeNull();
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace(" · ⎋ cancel", ""))))).toBeNull();
    expect(detectResumePicker(fromTexts(bare.map((t) => t.replace("Esc cancel", "Esc to cancel"))))).toBeNull();
    // `Esc to cancel` is Claude's spelling and not omp's, so it is not a way out here.
    expect(detectResumePicker(fromTexts(bare.map((t) => t.replace(" · Esc cancel", ""))))).toBeNull();
  });

  it("with a truncated or clipped footer", () => {
    // The row cut off mid-hint, closing bracket and all.
    const cut = boxed.map((t, i) => (i === FOOTER_AT ? `│ [⌦/⌫ delete · ⏎ select · ⇥ all pro${" ".repeat(60)}│` : t));
    expect(detectResumePicker(fromTexts(cut))).toBeNull();
    // The right border gone from the footer row.
    const open = boxed.map((t, i) => (i === FOOTER_AT ? t.replace(/\s*│$/, "") : t));
    expect(detectResumePicker(fromTexts(open))).toBeNull();
    // The bracket missing in the unboxed layout, which is that screen's own evidence.
    const bareless = bare.map((t, i) => (i === BARE_FOOTER_AT ? t.replace("[", "").replace("]", "") : t));
    expect(detectResumePicker(fromTexts(bareless))).toBeNull();
  });

  it("without the footer row at all", () => {
    const texts = boxed.map((t, i) => (i === FOOTER_AT ? boxed[1]! : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("without the bottom border, or with a second spacer row under the footer", () => {
    expect(detectResumePicker(fromTexts(boxed.slice(0, -1)))).toBeNull();
    expect(detectResumePicker(fromTexts(bare.slice(0, -1)))).toBeNull();
    const doubled = [...boxed.slice(0, 57), boxed[57]!, ...boxed.slice(57)];
    expect(detectResumePicker(fromTexts(doubled))).toBeNull();
  });

  it("without the title, or under a title that is not one of the known two", () => {
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace("Resume Session", "Pick a Session"))))).toBeNull();
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace("(current folder)", "(this branch)"))))).toBeNull();
    // The unboxed all-projects title is not in the corpus, so it is not guessed.
    expect(detectResumePicker(fromTexts(bare.map((t) => t.replace("(current folder)", "(all projects)"))))).toBeNull();
  });

  it("without the search row, or with a stray row between the header and the list", () => {
    expect(detectResumePicker(fromTexts(boxed.map((t) => (t.startsWith("│ >") ? t.replace("│ >", "│  ") : t))))).toBeNull();
    expect(detectResumePicker(fromTexts(bare.map((t) => (t.trimEnd() === ">" ? "" : t))))).toBeNull();
    const stray = [...boxed.slice(0, 3), boxed[3]!.replace("│                ", "│ a stray row  "), ...boxed.slice(4)];
    expect(detectResumePicker(fromTexts(stray))).toBeNull();
  });

  it("with an unknown row between the list and the footer, such as a scroll counter", () => {
    const counter = boxed.map((t, i) => (i === 20 ? t.replace("│                      ", "│ (1/12)               ") : t));
    expect(detectResumePicker(fromTexts(counter))).toBeNull();
    const old = bare.map((t, i) => (i === 30 ? "  (1/12)" : t));
    expect(detectResumePicker(fromTexts(old))).toBeNull();
  });

  it("when a session's meta row has no age or no size", () => {
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace("7 minutes ago  ·  138.1KB", "7 minutes  ·  138.1KB"))))).toBeNull();
    expect(detectResumePicker(fromTexts(boxed.map((t) => t.replace("7 minutes ago  ·  138.1KB", "7 minutes ago  ·  big"))))).toBeNull();
    expect(detectResumePicker(fromTexts(bare.map((t) => t.replace("1.9KB", "lots"))))).toBeNull();
  });

  it("when a boxed row loses its right border", () => {
    const texts = boxed.map((t, i) => (i === 6 ? t.replace(/\s*│$/, "") : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("when a boxed session has no title row, a shape only the unboxed corpus shows", () => {
    // Two rows (first prompt, meta) in the boxed layout: no capture prints it, so it is not lifted.
    const texts = [...boxed.slice(0, 4), ...boxed.slice(5)];
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("when a first-prompt row reads like a meta row, because the row after it is then not blank", () => {
    const texts = boxed.map((t, i) => (i === 5 ? boxed[6]! : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("when two groups run together with no blank row between them", () => {
    const texts = [...boxed.slice(0, 7), ...boxed.slice(8)];
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("when the picker is on a pane too wide for the bridge to bind it", () => {
    // The bridge refuses a bound region over 32768 characters, so a wider box is a screen this card
    // could not drive. The same capture re-padded to about 600 columns is still the same picker.
    const widen = (t: string): string => {
      const filler = t.startsWith("╭") ? "─" : t.startsWith("╰") ? "─" : " ";
      const close = t.at(-1)!;
      return t.slice(0, -1) + filler.repeat(490) + close;
    };
    expect(detectResumePicker(fromTexts(boxed))).not.toBeNull();
    expect(detectResumePicker(fromTexts(boxed.map(widen)))).toBeNull();
  });

  it("but a 220 column pane, which the old 8192 cap refused, is still lifted", () => {
    const widen = (t: string): string => {
      const filler = t.startsWith("╭") || t.startsWith("╰") ? "─" : " ";
      return t.slice(0, -1) + filler.repeat(111) + t.at(-1)!;
    };
    expect(detectResumePicker(fromTexts(boxed.map(widen)))).not.toBeNull();
  });
});

describe("a boxed picker with an untitled session and a session older than a week (captured)", () => {
  // `omp--v18-4-resume-untitled-dated.txt`: omp 18.4.10, en-US. The first session has no title, so it
  // prints two rows; the last is nine days old, so its age is the date `9/20/2026`. The pointer is on
  // the third session.
  const model = detectResumePicker(load("omp--v18-4-resume-untitled-dated.txt"))!;

  it("lifts all four sessions, the untitled one named by its first prompt", () => {
    expect(model.options).toHaveLength(5);
    expect(model.options[0]!.label).toBe("lets push the boundaries here abit and render some fancy stuff inside the terminal please");
    expect(model.options[0]!.description).toBe("just now · 146.8KB · ✔ done");
    expect(model.options[3]!.description).toBe("9/20/2026 · 138.0KB · ✔ done");
  });

  it("walks from the pointed third session in both directions", () => {
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Up", "Enter"],
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "", "❯", "", "Esc"]);
  });
});

describe("date shapes read from omp 18.4.10's source rather than a capture", () => {
  const boxed = textsOf("omp--v18-4-resume.txt");
  const bare = textsOf("omp--menu-resume.txt");
  // From seven days on, omp prints the session's date with `toLocaleDateString()` instead of an age.
  const dated = (texts: string[], from: string, to: string): StyledLine[] =>
    fromTexts(texts.map((t) => t.replace(from, to)));

  it.each(["9/23/2026", "23.9.2026", "2026-09-23", "23/09/2026"])("a session dated %s still lifts", (date) => {
    const model = detectResumePicker(dated(boxed, "11 minutes ago", date))!;
    expect(model.options[1]!.description).toBe(`${date} · 138.0KB · ✔ done`);
    expect(detectResumePicker(dated(bare, "3 minutes ago", date))).not.toBeNull();
  });

  it.each(["Sep 23, 2026", "2026. 9. 23.", "9/23-2026", "23 days", "1/2/3/4", "20/9"])("a date of another shape, %s, declines", (date) => {
    expect(detectResumePicker(dated(boxed, "11 minutes ago", date))).toBeNull();
  });
});

describe("a `❯` that is not the pointer", () => {
  const boxed = textsOf("omp--v18-4-resume.txt");

  it("inside a title or the search text does not count as a second pointer", () => {
    const texts = boxed.map((t, i) =>
      i === 2 ? t.replace("│ >  ", "│ > ❯") : i === 8 ? t.replace(`│   ${NEW_TITLE}`, `│   ❯ ${NEW_TITLE.slice(2)}`) : t,
    );
    const model = detectResumePicker(fromTexts(texts))!;
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "Esc"]);
    expect(model.options[1]!.label).toBe(`❯ ${NEW_TITLE.slice(2)}`);
    // The core signature blanks the pointer column alone; the other two stay, so they still bind.
    expect(model.coreSignature.match(/❯/g)).toHaveLength(2);
  });
});

describe("tail anchoring", () => {
  it.each(["omp--v18-4-resume.txt", "omp--menu-resume.txt"])(
    "%s: a picker scrolled up with ordinary output below it declines",
    (name) => {
      const scrolled = [...load(name), ...fromTexts(["● Wrote the file", "  ⎿  done"])];
      expect(detectResumePicker(scrolled)).toBeNull();
      expect(ompBuildBlocks(scrolled).every((b) => b.kind === "raw")).toBe(true);
    },
  );

  it("trailing blank rows below the border do not move the tail", () => {
    const padded = [...load("omp--v18-4-resume.txt"), ...fromTexts(["", "   ", ""])];
    expect(detectResumePicker(padded)).not.toBeNull();
  });

  it("transcript above the box stays raw, and the picker block starts at the title", () => {
    const above = fromTexts(["● some earlier output", "  ⎿  done", ""]);
    const lines = [...above, ...load("omp--v18-4-resume.txt")];
    const blocks = ompBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(blocks[0]!.lines.map(lineText)).toEqual(["● some earlier output", "  ⎿  done"]);
    expect(blocks[1]!.lines).toHaveLength(59);
  });
});

describe("the grammar claims nothing else in the corpus", () => {
  const CLAIMED = new Set([
    "omp--menu-resume-moved.txt",
    "omp--menu-resume.txt",
    "omp--v18-4-resume-all-projects.txt",
    "omp--v18-4-resume-moved.txt",
    "omp--v18-4-resume-search.txt",
    "omp--v18-4-resume-untitled-dated.txt",
    "omp--v18-4-resume.txt",
  ]);

  it("lifts exactly the seven captures that list a session, out of every capture in the corpus", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
    expect(all.length).toBeGreaterThan(300);
    const lifted = all.filter((name) => detectResumePicker(load(name)) !== null);
    expect(lifted.toSorted()).toEqual([...CLAIMED].toSorted());
  });
});

// THE OVER-ACCEPT DIRECTION (ADR 0080 point 5). Every blank in `coreSignature` is a safety decision:
// it is the only link between the dialog the user tapped and the Enter that goes out after the walk.
// The tests above prove the blanks do not over-refuse. These start from a real capture, change ONE
// thing, and assert the stated result with `promptsSameIdentity`, in both layouts.
describe("mutations of a real capture: what the verify read must hold and what it must refuse", () => {
  const AGE = /(\d+ \w+ ago|just now|now)(?=  ·  \d)/;
  const BLANKISH = /^(?:│\s*│|\s*)$/;

  const model = (texts: string[]) => {
    const m = detectResumePicker(fromTexts(texts));
    expect(m, "the edited screen must still lift").not.toBeNull();
    return m!;
  };
  const same = (a: string[], b: string[]): boolean => promptsSameIdentity(model(a), model(b));
  const metaRows = (texts: string[]): number[] => texts.flatMap((t, i) => (AGE.test(t) ? [i] : []));
  /** The first row of the session whose meta row is at `meta`: the row after the blank above it. */
  const startOf = (texts: string[], meta: number): number => {
    let at = meta;
    while (at > 0 && !BLANKISH.test(texts[at - 1]!)) at--;
    return at;
  };
  /** Replace `from` with `to` in a row and keep the box's right border where the terminal draws it. */
  const retext = (row: string, from: string | RegExp, to: string): string => {
    const edited = row.replace(from, to);
    if (!row.endsWith("│")) return edited;
    const grew = edited.length - row.length;
    const body = edited.slice(0, -1);
    return (grew > 0 ? body.replace(new RegExp(` {${grew}}$`), "") : body + " ".repeat(-grew)) + "│";
  };
  const setAge = (row: string, age: string): string => retext(row, AGE, age);
  const withAges = (texts: string[], ages: string[]): string[] => {
    const rows = metaRows(texts);
    expect(rows).toHaveLength(ages.length);
    return texts.map((t, i) => (rows.includes(i) ? setAge(t, ages[rows.indexOf(i)]!) : t));
  };
  /** The row's last visible character of text, changed: a title edit of the same width. */
  const touchText = (row: string): string => {
    const edited = row.replace(/([^\s│])(\s*│?)$/, "X$2");
    expect(edited).not.toBe(row);
    return edited;
  };
  const bumpSize = (row: string): string => row.replace(/(\d+\.)(\d)(KB)/, (_, a, b, c) => `${a}${(Number(b) + 1) % 10}${c}`);
  /** Swap two sessions' rows (title, any prompt row, meta), keeping the pointer column where it was. */
  const swapSessions = (texts: string[], a: number, b: number, column: number): string[] => {
    const [startA, startB] = [startOf(texts, metaRows(texts)[a]!), startOf(texts, metaRows(texts)[b]!)];
    const [endA, endB] = [metaRows(texts)[a]!, metaRows(texts)[b]!];
    const rowsA = texts.slice(startA, endA + 1);
    const rowsB = texts.slice(startB, endB + 1);
    const pointerOf = (rows: string[]) => rows[0]![column]!;
    const put = (rows: string[], glyph: string) => [rows[0]!.slice(0, column) + glyph + rows[0]!.slice(column + 1), ...rows.slice(1)];
    return [
      ...texts.slice(0, startA),
      ...put(rowsB, pointerOf(rowsA)),
      ...texts.slice(endA + 1, startB),
      ...put(rowsA, pointerOf(rowsB)),
      ...texts.slice(endB + 1),
    ];
  };

  for (const [layout, name, pointerColumn] of [
    ["boxed", "omp--v18-4-resume.txt", 2],
    ["unboxed", "omp--menu-resume.txt", 0],
  ] as const) {
    describe(`${layout} layout`, () => {
      const base = textsOf(name);
      const metas = metaRows(base);

      it("holds: every age shifted, across a width change (9 to 10 minutes, 59 minutes to 1 hour)", () => {
        const ages = (list: string[]) => withAges(base, metas.map((_, i) => list[i]!));
        const before = ages(["9 minutes ago", "59 minutes ago", "5 minutes ago"]);
        const after = ages(["10 minutes ago", "1 hour ago", "just now"]);
        expect(same(before, after)).toBe(true);
        expect(same(after, before)).toBe(true);
        expect(promptsEqual(model(before), model(after))).toBe(false);
      });

      it("differs: a session title changed", () => {
        const start = startOf(base, metas[1]!);
        // The first row of the group is the name: the title row, or the first prompt of an untitled one.
        const edited = base.map((t, i) => (i === start ? touchText(t) : t));
        expect(same(base, edited)).toBe(false);
      });

      it("differs: a session size changed", () => {
        const edited = base.map((t, i) => (i === metas[1] ? bumpSize(t) : t));
        expect(edited).not.toEqual(base);
        expect(same(base, edited)).toBe(false);
      });

      it("differs: a session removed", () => {
        const last = metas.length - 1;
        const [start, end] = [startOf(base, metas[last]!), metas[last]!];
        const edited = base.filter((_, i) => i < start - 1 || i > end);
        expect(model(edited).options).toHaveLength(model(base).options.length - 1);
        expect(same(base, edited)).toBe(false);
      });

      it("differs: two non-twin sessions swapped (the pointer stays on the first row)", () => {
        const [a, b] = layout === "boxed" ? [0, 1] : [1, 2];
        const edited = swapSessions(base, a, b, pointerColumn);
        expect(edited).not.toEqual(base);
        expect(same(base, edited)).toBe(false);
      });

      it("an age-shaped string inside a title is not blanked: changing it changes the identity", () => {
        const start = startOf(base, metas[1]!);
        const titled = (n: number) =>
          base.map((t, i) => {
            if (i !== start) return t;
            const [, frame, glyph] = /^(│ )?([❯ ] )/.exec(t)!;
            const row = `${frame ?? ""}${glyph}fix the ${n} minutes ago bug`;
            return frame === undefined ? row : row.padEnd(t.length - 1) + "│";
          });
        expect(titled(5)[start]).toContain("fix the 5 minutes ago bug");
        expect(same(titled(5), titled(5))).toBe(true);
        expect(same(titled(5), titled(6))).toBe(false);
      });
    });
  }

  describe("twin rows: same title, same meta apart from the age (boxed)", () => {
    const base = textsOf("omp--v18-4-resume.txt");
    const metas = metaRows(base);
    /** The second session's group again, with its age changed, right after it. */
    const withTwin = (twinAge: string): string[] => {
      const [start, end] = [startOf(base, metas[1]!), metas[1]!];
      const group = base.slice(start, end + 1).map((t, i, g) => (i === g.length - 1 ? setAge(t, twinAge) : t));
      return [...base.slice(0, end + 1), base[start - 1]!, ...group, ...base.slice(end + 1)];
    };
    const twinned = withTwin("30 minutes ago");
    const [first, second, twin] = metaRows(twinned);

    it("the sessions are three, and two are twins", () => {
      expect(model(twinned).options.map((o) => o.description)).toEqual([
        "7 minutes ago · 138.1KB · current · ✔ done · ⑂ fork",
        "11 minutes ago · 138.0KB · ✔ done",
        "30 minutes ago · 138.0KB · ✔ done",
        undefined,
      ]);
    });

    it("keeps the twins' ages verbatim in coreSignature and blanks the other session's age", () => {
      const core = model(twinned).coreSignature;
      expect(core).toContain("11 minutes ago  ·  138.0KB");
      expect(core).toContain("30 minutes ago  ·  138.0KB");
      expect(core).not.toContain("7 minutes ago");
      expect(core.match(/<age>/g)).toHaveLength(1);
    });

    it("swapping the twins changes coreSignature, so the identity is refused", () => {
      const swapped = twinned.map((t, i) => (i === second ? setAge(t, "30 minutes ago") : i === twin ? setAge(t, "11 minutes ago") : t));
      expect(model(swapped).coreSignature).not.toBe(model(twinned).coreSignature);
      expect(same(twinned, swapped)).toBe(false);
    });

    it("a tick on a twin row answers changed, the safe side", () => {
      const ticked = twinned.map((t, i) => (i === twin ? setAge(t, "31 minutes ago") : t));
      expect(same(twinned, ticked)).toBe(false);
    });

    it("a non-twin row's age is still blanked, with twins on screen", () => {
      const ticked = twinned.map((t, i) => (i === first ? setAge(t, "10 minutes ago") : t));
      expect(ticked).not.toEqual(twinned);
      expect(same(twinned, ticked)).toBe(true);
    });
  });
});
