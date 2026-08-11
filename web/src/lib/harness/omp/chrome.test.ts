import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import {
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  locateComposer,
  stripChrome,
} from "./chrome";
import { lineText } from "./markers";

// omp's composer chrome. The whole adapter's Tier-1 value — and its safety half — is here: the box
// this scanner finds is the statusline, the stranded draft, AND the answer to "may a phone reply be
// typed right now". A false "yes" types the user's message into whatever modal has the keyboard.

// Anchored on this file's directory (see markers.test.ts for why not `new URL(import.meta.url)`).
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}
function lines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}

// Synthesise omp's composer box at a caller-chosen width. Every row of a real box is padded out to the
// terminal's column count, and the width equality between the three rows is load-bearing in the
// scanner, so the helper pads exactly as omp does.
function boxRows(
  draftTail: string,
  opts: { width?: number; cont?: string[]; status?: string } = {},
): string[] {
  const width = opts.width ?? 60;
  const fill = (open: string, body: string, close: string, filler: string): string =>
    open + body + filler.repeat(Math.max(0, width - open.length - body.length - close.length)) + close;
  return [
    fill("╭──", opts.status ?? " statusline ", "╮", "─"),
    ...(opts.cont ?? []).map((c) => fill("│  ", c, "  │", " ")),
    fill("╰─ ", draftTail, " ─╯", " "),
  ];
}

// Every omp capture in the corpus, split by whether the composer is on screen. The 11 non-composer
// captures are the ones the reply pre-flight has to refuse.
const COMPOSER_FIXTURES = [
  "omp--done--tool-result.txt",
  "omp--done.txt",
  "omp--draft-single.txt",
  "omp--draft-wrapped.txt",
  "omp--fresh-idle.txt",
  "omp--menu-dismissed.txt",
  "omp--slash-palette--filtered.txt",
  "omp--slash-palette.txt",
  "omp--working.txt",
];

const ALL_OMP_FIXTURES = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("omp--") && f.endsWith(".txt"))
  .sort();

const NON_COMPOSER_FIXTURES = ALL_OMP_FIXTURES.filter((f) => !COMPOSER_FIXTURES.includes(f));

describe("locateComposer — the real corpus, pinned so any change to the walk shows up as a diff", () => {
  const PINNED: { fixture: string; top: number; bottom: number; suggestEnd: number; width: number }[] =
    [
      { fixture: "omp--fresh-idle.txt", top: 26, bottom: 27, suggestEnd: 28, width: 189 },
      { fixture: "omp--draft-single.txt", top: 26, bottom: 27, suggestEnd: 28, width: 189 },
      // A draft long enough to wrap: two continuation rows ABOVE the bottom border (omp folds the
      // other way from Claude, which indents continuations BELOW its `❯` line).
      { fixture: "omp--draft-wrapped.txt", top: 26, bottom: 29, suggestEnd: 30, width: 189 },
      { fixture: "omp--done.txt", top: 53, bottom: 54, suggestEnd: 55, width: 189 },
      { fixture: "omp--done--tool-result.txt", top: 49, bottom: 50, suggestEnd: 51, width: 189 },
      { fixture: "omp--working.txt", top: 32, bottom: 33, suggestEnd: 34, width: 189 },
      { fixture: "omp--menu-dismissed.txt", top: 26, bottom: 27, suggestEnd: 28, width: 189 },
      // The slash palette renders BELOW the box, at the box's own width — so `suggestEnd` runs past
      // `bottom + 1` and the strip takes the palette with the box.
      { fixture: "omp--slash-palette.txt", top: 26, bottom: 27, suggestEnd: 31, width: 189 },
      { fixture: "omp--slash-palette--filtered.txt", top: 26, bottom: 27, suggestEnd: 33, width: 189 },
    ];

  it.each(PINNED)("$fixture locates the box", ({ fixture, top, bottom, suggestEnd, width }) => {
    const box = locateComposer(fixtureLines(fixture));
    expect(box).not.toBeNull();
    expect(box!).toEqual({ top, firstDraftRow: top + 1, bottom, suggestEnd, width });
  });

  it("covers every composer capture in the corpus", () => {
    expect(PINNED.map((p) => p.fixture).sort()).toEqual([...COMPOSER_FIXTURES].sort());
  });
});

describe("the composer gate — a dialog on screen means a phone reply must NOT be typed", () => {
  // This is the assertion that matters most in the file. With no adapter at all, omp panes took
  // reply-action.ts's legacy one-shot path (type AND submit in one call), so a reply sent while one
  // of these modals held the keyboard fired the submit key at THAT modal, confirming whatever row it
  // had highlighted. `composerReady === false` on every one of these captures is what makes the
  // pre-flight refuse before a byte is typed.
  it.each(NON_COMPOSER_FIXTURES)("%s: no composer, so no send", (name) => {
    expect(locateComposer(fixtureLines(name))).toBeNull();
    expect(hasComposer(fixtureLines(name))).toBe(false);
  });

  it.each(COMPOSER_FIXTURES)("%s: the composer IS on screen", (name) => {
    expect(hasComposer(fixtureLines(name))).toBe(true);
  });
});

describe("extractInputDraft", () => {
  const DRAFTS: { fixture: string; draft: string | null }[] = [
    { fixture: "omp--draft-single.txt", draft: "list the files in this repo" },
    {
      fixture: "omp--draft-wrapped.txt",
      // Three fragments folded into one line: the two continuation rows, top-down, then the tail off
      // the bottom border. Joined with a single space — omp soft-wraps at word boundaries, so the
      // break it removed was one.
      draft:
        "list the files in this repo and then write a one sentence summary for each file, keep every " +
        "summary under twenty words, sort the whole list alphabetically by file name, skip anything " +
        "inside the dot git directory, and finally print the total count of files at the very bottom " +
        "of the answer so it is easy to check the result quickly against a manual count taken by hand",
    },
    // A slash command mid-typing is a draft like any other — the palette below the box is chrome.
    { fixture: "omp--slash-palette.txt", draft: "/" },
    { fixture: "omp--slash-palette--filtered.txt", draft: "/new" },
    // Empty composers. omp paints NO placeholder in an empty box, which is why this adapter ships no
    // INPUT_PLACEHOLDERS allow-list — there is nothing to filter out.
    { fixture: "omp--fresh-idle.txt", draft: null },
    { fixture: "omp--done.txt", draft: null },
    { fixture: "omp--done--tool-result.txt", draft: null },
    { fixture: "omp--working.txt", draft: null },
    { fixture: "omp--menu-dismissed.txt", draft: null },
  ];

  it.each(DRAFTS)("$fixture reads its draft", ({ fixture, draft }) => {
    expect(extractInputDraft(fixtureLines(fixture))).toBe(draft);
  });

  it.each(NON_COMPOSER_FIXTURES)("%s: no box at the tail ⇒ no draft", (name) => {
    expect(extractInputDraft(fixtureLines(name))).toBeNull();
  });
});

describe("extractStatusLines", () => {
  it.each(COMPOSER_FIXTURES)("%s: re-surfaces exactly one styled row", (name) => {
    const rows = extractStatusLines(fixtureLines(name));
    expect(rows).toHaveLength(1);
    // STYLED, not flattened: omp colours each powerline field separately, and that is what makes the
    // strip readable at a glance once the mirror can no longer show it.
    expect(rows[0]!.segments.length).toBeGreaterThan(1);
  });

  it.each(COMPOSER_FIXTURES.filter((f) => f !== "omp--done.txt"))(
    "%s: trims the border glyphs off both ends, keeping the whole powerline",
    (name) => {
      const text = lineText(extractStatusLines(fixtureLines(name))[0]!);
      expect(text.startsWith("π")).toBe(true);
      expect(text.endsWith("▶")).toBe(true);
      // By glyph class, never by content: nothing here reads `⬢`, `⑂`, `◫` or `(sub)`, all of which
      // are user-configurable in omp's statusline template (see the fixtures README's warning).
      expect(text).toContain("master");
    },
  );

  it.each(NON_COMPOSER_FIXTURES)("%s: no box at the tail ⇒ the strip hides", (name) => {
    expect(extractStatusLines(fixtureLines(name))).toEqual([]);
  });

  it("returns [] when the statusline has been configured away entirely", () => {
    // A bare `╭────╮` has nothing but border left. No special case: the strip simply hides, which is
    // the honest answer for a user who turned their statusline off.
    const buffer = lines(["output above", ...boxRows("", { status: "──" })].join("\n"));
    expect(locateComposer(buffer)).not.toBeNull();
    expect(extractStatusLines(buffer)).toEqual([]);
  });
});

describe("known limitation — the `◀ N` transcript-scroll indicator", () => {
  // omp splices a scroll indicator into the SAME border it paints the statusline into, and it is not
  // a border glyph: the trailing trim stops at the `1` segment, so this one capture's strip keeps the
  // rule run and `◀ 1` on the end. A tighter rule would have to read the `◀ N` CONTENT, which is
  // exactly the content-anchoring this function refuses to do. Pinned rather than hidden.
  it("keeps the rule run and `◀ 1` on omp--done.txt", () => {
    const text = lineText(extractStatusLines(fixtureLines("omp--done.txt"))[0]!);
    expect(text.startsWith("π")).toBe(true);
    expect(text.endsWith("◀ 1")).toBe(true);
    expect(text).toContain("▶───");
  });
});

describe("stripChrome", () => {
  it.each(["omp--fresh-idle.txt", "omp--slash-palette.txt"])(
    "%s: peels the box (and anything below it) off the tail, keeping the transcript",
    (name) => {
      const original = fixtureLines(name);
      const stripped = stripChrome(original);
      // 25 rows survive in both: the box at 26, the blank at 25 exposed above it, and — for the
      // palette capture — the three autocomplete rows below it, all gone. `✔ New session started`
      // (row 24) stays. The palette going with the box is deliberate: it is composer chrome, and
      // collie draws its own for an omp pane from lib/agent-commands.ts's `omp` catalog, so keeping
      // omp's here would draw a palette twice. (Before that catalog existed `commandsFor("omp")`
      // returned [] and composer.tsx hid the button — this strip took the palette and gave back
      // nothing, which is the Tier-0 regression the catalog closes.)
      expect(stripped).toHaveLength(25);
      expect(lineText(stripped[24]!).trim()).toBe("✔ New session started");
    },
  );

  it.each(NON_COMPOSER_FIXTURES)(
    "%s: returns the SAME reference when there is no chrome to strip",
    (name) => {
      // The conservatism contract: callers may treat `result === lines` as "nothing was removed".
      // Every modal capture qualifies — no composer box at the tail, and no trailing blank run
      // either, so not a single line is dropped.
      const original = fixtureLines(name);
      expect(stripChrome(original)).toBe(original);
    },
  );

  it("never removes content above the box", () => {
    const buffer = lines(["● Wrote the file", "  ⎿  done", "", ...boxRows("")].join("\n"));
    expect(stripChrome(buffer).map(lineText)).toEqual(["● Wrote the file", "  ⎿  done"]);
  });
});

describe("locateComposer — what it must decline", () => {
  it("declines a `╰─ … ─╯` with no `╭…╮` above it", () => {
    expect(locateComposer(lines(["some output", boxRows("hi")[1]!].join("\n")))).toBeNull();
  });

  it("declines a top border narrower than the bottom one", () => {
    const [top, bottom] = boxRows("hi");
    const narrowTop = top!.replace(/─{4}/, "");
    expect(locateComposer(lines([narrowTop, bottom!].join("\n")))).toBeNull();
  });

  it("declines a wrong-width row below the box (that is real output, not a palette)", () => {
    // Width equality is what makes the positional (never content-parsed) suggestion walk safe: a row
    // of a different width means the box has scrolled up, and claiming it would strip the transcript.
    expect(locateComposer(lines([...boxRows(""), "● Wrote the file"].join("\n")))).toBeNull();
  });

  it("declines a BLANK row between the box and the tail", () => {
    const palette = " ".repeat(59) + "│"; // right width, but a blank line intervenes
    expect(locateComposer(lines([...boxRows(""), "", palette].join("\n")))).toBeNull();
  });

  it("declines a run below the box taller than MAX_SUGGESTION_ROWS", () => {
    // 64 rows — the cap is deliberately set above every viewport height in the corpus (59), so this
    // boundary is only ever reached by a buffer no real omp pane can paint. See chrome.ts for why
    // being too LOW is the unsafe direction (a blocked send on an ordinary screen).
    const paletteRow = "❯ some command" + " ".repeat(60 - 15) + "│";
    const run = Array.from({ length: 64 }, () => paletteRow);
    expect(locateComposer(lines([...boxRows(""), ...run].join("\n")))).toBeNull();
    // …and accepts one row fewer, so the cap is what rejected it rather than the shape.
    expect(locateComposer(lines([...boxRows(""), ...run.slice(1)].join("\n")))).not.toBeNull();
  });

  it("declines a draft taller than MAX_DRAFT_ROWS", () => {
    const cont = Array.from({ length: 101 }, (_, i) => `line ${i}`);
    expect(locateComposer(lines(boxRows("tail", { cont }).join("\n")))).toBeNull();
    expect(locateComposer(lines(boxRows("tail", { cont: cont.slice(1) }).join("\n")))).not.toBeNull();
  });

  it("declines an empty buffer and a buffer of nothing but blanks", () => {
    expect(locateComposer([])).toBeNull();
    expect(locateComposer(lines("\n\n\n"))).toBeNull();
  });
});
