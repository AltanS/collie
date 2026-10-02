import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { ompAdapter } from "./index";
import { ompModalOnScreen, readOmpHintList } from "./modal";

// `ompModalOnScreen` (.adr/0076) is the fifth condition of the unread-dialog card for omp: positive
// evidence that one of omp's modals is up, read off the key-hint footer that names its own way out.
// It is what makes declaring a `cancelKey` safe for an adapter whose composer scanner can answer a
// definite false on a healthy pane, so the two properties pinned here are the whole contract: it is
// true on every modal that prints a way out, and it is false on everything else.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const ALL = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt")).toSorted();

const fixtureLines = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const linesOf = (rows: string[]): StyledLine[] => splitLines(parseAnsi(rows.join("\n")));

// Every omp modal capture whose footer names a way out, in all three footer dialects: the glyph
// keycaps of omp 18.4, the text keycaps of omp 17.x to 18.1, and the approval dialog's lower-case
// `esc cancel`.
const MODALS_WITH_A_WAY_OUT = [
  "omp--approval-bash.txt",
  "omp--approval-write--deny.txt",
  "omp--approval-write.txt",
  "omp--menu-model-moved.txt",
  "omp--menu-model.txt",
  "omp--menu-resume-moved.txt",
  "omp--menu-resume.txt",
  "omp--menu-settings-moved.txt",
  "omp--menu-settings.txt",
  "omp--select-menu-moved.txt",
  "omp--select-menu-noted.txt",
  "omp--select-menu-other.txt",
  "omp--select-menu.txt",
  "omp--select-multi-checked.txt",
  "omp--select-multi-review.txt",
  "omp--select-multi.txt",
  "omp--v18-4-menu-model.txt",
  "omp--v18-4-menu-settings.txt",
  "omp--v18-4-resume-all-projects.txt",
  "omp--v18-4-resume-moved.txt",
  "omp--v18-4-resume-nomatch.txt",
  "omp--v18-4-resume-search.txt",
  "omp--v18-4-resume-untitled-dated.txt",
  "omp--v18-4-resume.txt",
];

// The `/tree` picker is a modal that prints NO way out: omp clips its hint row and neither capture
// holds an Esc segment. It is the one omp modal this gate does not see, on purpose (modal.ts header).
const TREE = ["omp--tree.txt", "omp--v18-4-tree.txt"];

const OMP = ALL.filter((f) => f.startsWith("omp--"));
const OMP_WITHOUT_A_MODAL = OMP.filter((f) => !MODALS_WITH_A_WAY_OUT.includes(f));
const FOREIGN = ALL.filter((f) => !f.startsWith("omp--"));

describe("ompModalOnScreen on the omp corpus", () => {
  it.each(MODALS_WITH_A_WAY_OUT)("%s: a modal that names its way out ⇒ true", (name) => {
    expect(ompModalOnScreen(fixtureLines(name))).toBe(true);
  });

  it.each(OMP_WITHOUT_A_MODAL.filter((f) => !TREE.includes(f)))(
    "%s: a composer, a working pane or an idle pane ⇒ false",
    (name) => {
      expect(ompModalOnScreen(fixtureLines(name))).toBe(false);
    },
  );

  it.each(TREE)("%s: prints no way out, so the gate cannot see it ⇒ false", (name) => {
    const lines = fixtureLines(name);
    expect(ompModalOnScreen(lines)).toBe(false);
    // The claim in the header, checked rather than recalled: no row of the capture names Esc or `⎋`
    // as a key, so there is nothing for any grammar to read and the card must stay off.
    const screen = lines.map(lineText).join("\n");
    expect(screen).not.toMatch(/\besc\b|⎋/i);
  });

  it("covers every omp capture exactly once", () => {
    expect([...MODALS_WITH_A_WAY_OUT, ...TREE, ...OMP_WITHOUT_A_MODAL.filter((f) => !TREE.includes(f))].toSorted())
      .toEqual(OMP);
  });

  it("agrees with composerReady: no screen is both a live composer and a modal", () => {
    for (const name of OMP) {
      const lines = fixtureLines(name);
      if (ompAdapter.composerReady!(lines)) expect(ompModalOnScreen(lines), name).toBe(false);
    }
  });
});

describe("ompModalOnScreen on other harnesses' captures", () => {
  // Every claude, codex, grok, opencode, muse and agy capture: Claude prints `Esc to cancel` on most
  // of its modals and `Esc to close` on some, and neither may read as omp's. The listed spellings are
  // the whole list.
  it("is false on every capture that is not omp's", () => {
    expect(FOREIGN.length).toBeGreaterThan(300);
    const hits = FOREIGN.filter((name) => ompModalOnScreen(fixtureLines(name)));
    expect(hits).toEqual([]);
  });
});

describe("the footer spellings", () => {
  const boxed = (inner: string): StyledLine[] =>
    linesOf(["some output", "╭──────────╮", `│ ${inner} │`, "│          │", "╰──────────╯"]);

  it.each([
    "Enter select · ↑/↓ move · ⎋ cancel",
    "Enter select · ↑/↓ move · ⎋ close",
    "Enter select · ↑/↓ move · ⎋ to close",
    "Enter select · ↑/↓ move · Esc cancel",
    "Enter select · ↑/↓ move · Esc close",
    "Enter select · ↑/↓ move · Esc to close",
    "up/down navigate  enter select  esc cancel",
    // The Nerd Font symbol preset (omp 18.4.4, the `ask` tool): enter, then escape, as private-use glyphs.
    "\u{F0311} select · n note · ↑/↓ move · \u{F12B7} cancel",
  ])("%s ⇒ true", (inner) => {
    expect(ompModalOnScreen(boxed(inner))).toBe(true);
  });

  it.each([
    // Claude's spelling and the near misses: the exact list is the guard.
    "Enter select · ↑/↓ move · Esc to cancel",
    "Enter select · ↑/↓ move · ⎋ to cancel",
    "Enter select · ↑/↓ move · Escape cancel",
    "Enter select · ↑/↓ move · Esc dismiss",
    // The way out is the LAST segment: one mid-list is not a footer's closing hint.
    "Esc cancel · Enter select · ↑/↓ move",
    // A way out with nothing beside it is a sentence, not a hint list.
    "Esc cancel",
  ])("%s ⇒ false", (inner) => {
    expect(ompModalOnScreen(boxed(inner))).toBe(false);
  });

  it("reads the hint list into its segments and the verb", () => {
    expect(readOmpHintList("⌦/⌫ delete · ⏎ select · ⇥ all projects · ⎋ cancel")).toEqual({
      segments: ["⌦/⌫ delete", "⏎ select", "⇥ all projects", "⎋ cancel"],
      escapeVerb: "cancel",
    });
    expect(readOmpHintList("⏎/␣ to change · ⎋ to close")?.escapeVerb).toBe("close");
    expect(readOmpHintList("up/down navigate  enter select  esc cancel")?.segments).toEqual([
      "up/down navigate",
      "enter select",
      "esc cancel",
    ]);
  });

  it("refuses a long transcript line that happens to end the same way", () => {
    const prose = `${"the agent said the user may press Enter select and then wait · ".repeat(4)}Esc cancel`;
    expect(readOmpHintList(prose)).toBeNull();
  });

  it("a bare row must be bracketed to be a footer", () => {
    const bare = (row: string): StyledLine[] => linesOf(["output", row, "", "───────────"]);
    expect(ompModalOnScreen(bare("  [Enter select · Esc cancel]"))).toBe(true);
    expect(ompModalOnScreen(bare("  Enter select · Esc cancel"))).toBe(false);
  });
});

describe("tail anchoring", () => {
  it.each(["omp--v18-4-resume.txt", "omp--menu-model.txt", "omp--approval-bash.txt"])(
    "%s: a modal scrolled up with output below it ⇒ false",
    (name) => {
      const scrolled = [...fixtureLines(name), ...linesOf(["● Wrote the file", "  ⎿  done"])];
      expect(ompModalOnScreen(scrolled)).toBe(false);
    },
  );

  it("one trailing row of anything is allowed (the approval box's usage strip), and only one", () => {
    const base = fixtureLines("omp--approval-bash.txt");
    expect(ompModalOnScreen(base)).toBe(true);
    expect(ompModalOnScreen([...base, ...linesOf(["another status row"])])).toBe(false);
  });

  it("trailing blank rows do not move the tail", () => {
    expect(ompModalOnScreen([...fixtureLines("omp--v18-4-resume.txt"), ...linesOf(["", "  ", ""])])).toBe(true);
  });

  it("a footer-shaped line in the transcript, above a live composer ⇒ false", () => {
    const composer = fixtureLines("omp--fresh-idle.txt");
    const quoted = linesOf(["│ Enter select · n note · ↑/↓ move · Esc cancel │", "", ""]);
    expect(ompModalOnScreen([...quoted, ...composer])).toBe(false);
    expect(ompModalOnScreen([...composer.slice(0, -2), ...quoted, ...composer.slice(-2)])).toBe(false);
  });

  it("an empty screen and a screen with no rows ⇒ false", () => {
    expect(ompModalOnScreen([])).toBe(false);
    expect(ompModalOnScreen(linesOf(["", "   ", ""]))).toBe(false);
  });
});

describe("the adapter declares the pair together", () => {
  it("cancelKey is Escape and modalOnScreen is this gate", () => {
    expect(ompAdapter.cancelKey).toBe("Escape");
    expect(ompAdapter.modalOnScreen).toBe(ompModalOnScreen);
  });
});
