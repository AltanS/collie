import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual } from "../prompt-model";
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
