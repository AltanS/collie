import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { COMBINING_RANGES, WIDE_RANGES } from "../../text-width";
import {
  composerPrompt,
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

// Synthesise omp's composer box at a caller-chosen width. Nothing in the scanner measures a row any
// more, so the padding is here only to keep these buffers shaped like the captures they stand in for.
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
  const PINNED: { fixture: string; top: number; bottom: number; suggestEnd: number }[] = [
    { fixture: "omp--fresh-idle.txt", top: 26, bottom: 27, suggestEnd: 28 },
    { fixture: "omp--draft-single.txt", top: 26, bottom: 27, suggestEnd: 28 },
    // A draft long enough to wrap: two continuation rows ABOVE the bottom border (omp folds the
    // other way from Claude, which indents continuations BELOW its `❯` line).
    { fixture: "omp--draft-wrapped.txt", top: 26, bottom: 29, suggestEnd: 30 },
    { fixture: "omp--done.txt", top: 53, bottom: 54, suggestEnd: 55 },
    { fixture: "omp--done--tool-result.txt", top: 49, bottom: 50, suggestEnd: 51 },
    { fixture: "omp--working.txt", top: 32, bottom: 33, suggestEnd: 34 },
    { fixture: "omp--menu-dismissed.txt", top: 26, bottom: 27, suggestEnd: 28 },
    // The slash palette renders BELOW the box — so `suggestEnd` runs past `bottom + 1` and the strip
    // takes the palette with the box.
    { fixture: "omp--slash-palette.txt", top: 26, bottom: 27, suggestEnd: 31 },
    { fixture: "omp--slash-palette--filtered.txt", top: 26, bottom: 27, suggestEnd: 33 },
  ];

  // These nine indices are byte-identical to the ones the width-gated scanner produced. That is the
  // evidence that dropping the measurements cost nothing the corpus can see: every composer capture
  // still resolves to the same rows, and the eleven modal captures below still resolve to null.
  it.each(PINNED)("$fixture locates the box", ({ fixture, top, bottom, suggestEnd }) => {
    const box = locateComposer(fixtureLines(fixture));
    expect(box).not.toBeNull();
    expect(box!).toEqual({ top, firstDraftRow: top + 1, bottom, suggestEnd });
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

  it("returns the SAME reference for an empty buffer", () => {
    // The contract's degenerate end. Nothing can have been removed from `[]`, so `result === lines`
    // has to hold there too — it used to hand back a fresh array via `lines.slice(0, 0)`, quietly
    // telling every caller that chrome had been stripped off an empty buffer.
    const empty: StyledLine[] = [];
    expect(stripChrome(empty)).toBe(empty);
    // An all-blank buffer really does lose every row, so that one must NOT be the same reference.
    const blanks = lines("\n\n\n");
    expect(stripChrome(blanks)).not.toBe(blanks);
    expect(stripChrome(blanks)).toHaveLength(0);
  });

  it("never removes content above the box", () => {
    const buffer = lines(["● Wrote the file", "  ⎿  done", "", ...boxRows("")].join("\n"));
    expect(stripChrome(buffer).map(lineText)).toEqual(["● Wrote the file", "  ⎿  done"]);
  });
});

// A NON-clustering width table — the shape used by wcwidth/wcswidth, go-runewidth and Rust's
// unicode-width, i.e. by essentially every TUI: sum each code point independently instead of scoring a
// grapheme cluster by its base. Built from text-width.ts's OWN range tables so the only modelled
// difference is the clustering, and used below to pad a box exactly as a terminal on that table would.
// `displayWidth` says 2 for `👨‍💻` where this says 4, and 2 for `👨‍👩‍👧‍👦` where this says 8.
function perCodePointWidth(text: string): number {
  const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean => {
    for (const [lo, hi] of ranges) {
      if (cp < lo) return false;
      if (cp <= hi) return true;
    }
    return false;
  };
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (inRanges(cp, COMBINING_RANGES)) continue;
    w += inRanges(cp, WIDE_RANGES) ? 2 : 1;
  }
  return w;
}

/** omp's composer, padded to `cols` by the table above rather than by ours — the whole point being
 *  that the scanner must not care which of the two drew it. */
function boxRowsPaddedLikeATerminal(
  status: string,
  draftTail: string,
  cont: string[] = [],
  cols = 189,
): string[] {
  const fill = (open: string, body: string, close: string, filler: string): string =>
    open +
    body +
    filler.repeat(
      cols - perCodePointWidth(open) - perCodePointWidth(body) - perCodePointWidth(close),
    ) +
    close;
  return [
    fill("╭── ", `${status} `, "╮", "─"),
    ...cont.map((c) => fill("│  ", c, "  │", " ")),
    fill("╰─ ", draftTail, " ─╯", " "),
  ];
}

// The false-NULL direction, which is the one that costs the user everything: locateComposer answering
// null on a screen that plainly has the composer on it means no statusline strip, no stranded-draft
// chip, `composerReady` false forever, and every reply refused with "the input box isn't on screen"
// while no dialog exists. Every case here is a box omp padded with a per-code-point table; the round
// that compared measured widths (even slackened by an "error bar") returned null on all five.
describe("locateComposer — Unicode anywhere in the box must never produce a null", () => {
  const STATUS = "Auto > ~/scratchpad/omp-sandbox > master > 11.5%/200K";
  const CASES: Array<[string, string, string, string[]]> = [
    // A ZWJ sequence in the statusline template: 2 columns for us, 4 for the terminal that padded it.
    ["ZWJ emoji in the statusline", `👨‍💻 ${STATUS}`, "ship the release notes", []],
    ["skin-tone emoji in the statusline", `👋🏽 ${STATUS}`, "ship the release notes", []],
    // The operator simply typed emoji into their own message. Nothing configurable about it.
    [
      "ZWJ + skin-tone emoji in the user's own draft",
      STATUS,
      "shipping 🎉 nice work 👍🏽👍🏽 great job 👨‍💻👨‍💻 all done 👋🏽👋🏽",
      [],
    ],
    // Six clusters' worth of divergence on a CONTINUATION row: the walk must not end early there,
    // which would strand the scan mid-box and fail the top-border step on a composer that is there.
    [
      "a family emoji on a wrapped draft's continuation row",
      STATUS,
      "and finally print the total count",
      ["the standup went well today 👨‍👩‍👧‍👦 everyone showed up and we closed the sprint"],
    ],
    ["wide CJK in both borders", "作業中 > ~/scratchpad > master", "これはプルリクエストです", []],
    ["nerd-font PUA and ambiguous arrows", `  ${STATUS} `, "→→→ ship it →→→", []],
    ["combining marks, decomposed", `café ${STATUS}`, "résumé the run", []],
    ["a regional-indicator flag", `🇯🇵 ${STATUS}`, "ship it", []],
  ];

  it.each(CASES)("%s", (_name, status, draftTail, cont) => {
    const buffer = lines(
      [" ✔ New session started", "", ...boxRowsPaddedLikeATerminal(status, draftTail, cont)].join("\n"),
    );
    const box = locateComposer(buffer);
    expect(box).not.toBeNull();
    expect(box!.top).toBe(2);
    expect(box!.bottom).toBe(3 + cont.length);
    expect(hasComposer(buffer)).toBe(true);
  });

  it("a keycap in the statusline — the case an error bar built from these tables cannot even see", () => {
    // The cluster is `1` + VS16 + U+20E3. Any bar that short-circuits on the ASCII base scores it as
    // certain ASCII; every terminal that honours VS16 draws it at two columns.
    const buffer = lines(boxRowsPaddedLikeATerminal("1️⃣ deploy > master", "ship it").join("\n"));
    expect(locateComposer(buffer)).not.toBeNull();
  });
});

describe("locateComposer — what it must decline", () => {
  it("declines a `╰─ … ─╯` with no `╭…╮` above it", () => {
    expect(locateComposer(lines(["some output", boxRows("hi")[1]!].join("\n")))).toBeNull();
  });

  it("declines omp's other panels, which all close corner-to-corner", () => {
    // This is what actually keeps the pickers out, and it is a literal rather than a measurement: the
    // one-space gutters in `╰─ … ─╯` are the composer's alone. A `/model`-shaped box drawn at the
    // composer's own width — which is what omp really does — is declined for the same reason all
    // eleven modal captures are.
    const picker = [
      "╭──" + "─".repeat(55) + "╮",
      "│  ❯ 1. claude-opus" + " ".repeat(60 - 21) + "  │",
      "╰──" + "─".repeat(55) + "╯",
    ];
    expect(locateComposer(lines(picker.join("\n")))).toBeNull();
    expect(hasComposer(lines(picker.join("\n")))).toBe(false);
  });

  it("does not let a picker stacked directly above the composer become its top border", () => {
    // The walk stops on the composer's OWN `╭─…─╮`, because the picker's bottom border is not a
    // continuation row. Nothing here depends on the picker being narrower than the composer.
    const buffer = lines(
      [
        "╭─ oh-my-pi " + "─".repeat(86) + "╮",
        "│  press ? for help" + " ".repeat(80) + "  │",
        "╰─" + "─".repeat(96) + "─╯",
        ...boxRowsPaddedLikeATerminal("Auto > master", "ship it"),
      ].join("\n"),
    );
    const box = locateComposer(buffer);
    expect(box).not.toBeNull();
    expect(box!.top).toBe(3); // the composer's own border, not the panel's
  });

  it("declines a BLANK row between the box and the tail", () => {
    const palette = " ".repeat(59) + "│";
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

  it("KNOWN COST: a non-blank, non-box row below the box is claimed as chrome, whatever it says", () => {
    // The run below the bottom border used to have to measure the box's width, which on a padded
    // capture meant "reaches the right edge". That check is gone — it is a false NULL the moment a
    // palette row carries a glyph our table and omp's disagree about, and it only ever held on the two
    // palette captures because omp paints a scrollbar column there. What it bought was this: on a torn
    // frame the strip takes real transcript off the mirror along with the box. Bounded by
    // MAX_SUGGESTION_ROWS and pinned here rather than hidden. What it does NOT cost is a modal going
    // missing off the mirror or a wrong `hasComposer`: every widget omp can draw over the composer is
    // a box, and the case below pins that a box in this run is refused outright.
    const box = locateComposer(lines([...boxRows(""), "● Wrote the file"].join("\n")));
    expect(box).not.toBeNull();
    expect(box!.bottom).toBe(1);
    expect(box!.suggestEnd).toBe(3); // …past the output row, which the strip therefore swallows
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

describe("the tail anchor — a modal drawn UNDER the composer means the composer has no keyboard", () => {
  // The rule this whole block exists for: `hasComposer` must answer "is the composer taking keys
  // NOW", not "is a composer border somewhere in the last 64 rows". The run below the bottom border
  // is allowed to hold omp's slash palette and nothing else that omp itself draws — and everything
  // omp draws over a composer is a BOX. Before the box rule, the only thing separating these screens
  // from an ordinary idle composer was the blank row omp happens to paint above a dialog.

  const askDialog = (width: number): string[] => {
    const fill = (open: string, body: string, close: string, filler: string): string =>
      open + body + filler.repeat(Math.max(0, width - open.length - body.length - close.length)) + close;
    return [
      fill("╭─ Ask ", "", "╮", "─"),
      fill("│ ", "Delete every file in /?", " │", " "),
      fill("├", "", "┤", "─"),
      fill("│ ", "❯ ○ Yes", " │", " "),
      fill("│ ", "  ○ No", " │", " "),
      fill("├", "", "┤", "─"),
      fill("│ ", "Enter select · n note · ↑/↓ move · Esc cancel", " │", " "),
      fill("╰", "", "╯", "─"),
    ];
  };

  it("declines a composer with a dialog ABUTTING it, blank separator or not", () => {
    const withGap = lines([...boxRows("leftover"), "", ...askDialog(60)].join("\n"));
    const abutting = lines([...boxRows("leftover"), ...askDialog(60)].join("\n"));
    // The blank row was already enough on its own; that is exactly the problem — it is a row omp
    // happens to emit, so it was carrying a safety property nothing tested.
    expect(hasComposer(withGap)).toBe(false);
    expect(hasComposer(abutting)).toBe(false);
    expect(locateComposer(abutting)).toBeNull();
  });

  it("declines the REAL Ask dialog stacked onto the REAL composer, from corpus bytes", () => {
    // The two halves are verbatim rows of two captures: `omp--draft-single.txt` through its composer
    // (which holds the draft "list the files in this repo"), then the live `ask` screen out of
    // `omp--select-multi.txt` — the one whose options include a free-text "Other (type your own)".
    const composer = fixtureLines("omp--draft-single.txt").slice(0, 28);
    const dialog = fixtureLines("omp--select-multi.txt").slice(47, 59);
    const spliced = [...composer, ...dialog];
    expect(hasComposer(spliced)).toBe(false);
    expect(extractInputDraft(spliced)).toBeNull();
    expect(extractStatusLines(spliced)).toEqual([]);
    // …and the dialog stays on the mirror, where the user can read and answer it. A `true` here used
    // to cut 15 rows — the whole dialog — out of the raw block.
    expect(stripChrome(spliced)).toBe(spliced);
  });

  it("declines a two-row labelled box in ordinary output that has a dialog under it", () => {
    // omp draws `╭─── ✘ Error: … ───╮` / `╰────╯` at column 0 at the composer's own width
    // (omp--select-multi.txt:40-41). Give that widget a label in its BOTTOM border and it is spelled
    // exactly like a composer. What refuses it here is not the shape of the box — it is the live
    // dialog underneath, which says the screen belongs to something else.
    const spliced = [
      ...fixtureLines("omp--select-multi.txt").slice(30, 40),
      ...lines(
        [
          "╭─── ✘ Error: No question provided " + "─".repeat(153) + "╮",
          "╰─ retry with /model " + " ".repeat(165) + "─╯",
        ].join("\n"),
      ),
      ...fixtureLines("omp--select-multi.txt").slice(47, 59),
    ];
    expect(hasComposer(spliced)).toBe(false);
    expect(stripChrome(spliced)).toBe(spliced);
  });

  it("still accepts omp's slash palette, which is what the run below the box is FOR", () => {
    // The two palette captures are the reason the run is tolerated at all; the box rule must not cost
    // them. Their rows open with `❯ ` or a two-space gutter — omp reserves column 0 for boxes.
    for (const name of ["omp--slash-palette.txt", "omp--slash-palette--filtered.txt"]) {
      expect(hasComposer(fixtureLines(name))).toBe(true);
    }
  });

  it("rejects on the box glyph itself, at column 0, whichever corner it is", () => {
    for (const opener of ["╭", "│", "├", "╰", "┌", "└", "─"]) {
      const buffer = lines([...boxRows(""), opener + " something".padEnd(58) + "│"].join("\n"));
      expect(hasComposer(buffer)).toBe(false);
    }
    // …and a row that merely CONTAINS one is ordinary output, not a box being opened.
    expect(hasComposer(lines([...boxRows(""), " a tree: ├── src"].join("\n")))).toBe(true);
  });
});

describe("locateComposer — U+2028/U+2029 are glyphs like any other", () => {
  // `.` in a JS regex excludes them. `rstrip` only takes them off the END of a row, so one anywhere
  // else survives into `lineText` and used to decline the row silently — a permanent null: no
  // statusline, no draft, the box duplicated on the mirror, and every reply refused with "the input
  // box isn't on screen" while no dialog exists. They arrive by paste (PDF, Word, a JS string
  // literal); nothing on the send path normalises text.
  const SEPARATORS = { "U+2028 LINE SEPARATOR": "\u2028", "U+2029 PARAGRAPH SEPARATOR": "\u2029" };

  for (const [name, ch] of Object.entries(SEPARATORS)) {
    it(`locates a box with ${name} on the bottom border`, () => {
      const buffer = lines(boxRows(`here is the paragraph${ch}please review it`).join("\n"));
      expect(locateComposer(buffer)).not.toBeNull();
      expect(extractInputDraft(buffer)).toBe(`here is the paragraph${ch}please review it`);
    });

    it(`locates a box with ${name} on a continuation row and in the statusline`, () => {
      const buffer = lines(
        boxRows("tail", {
          cont: [`first${ch}fragment`],
          status: ` Auto${ch}> master `,
        }).join("\n"),
      );
      const box = locateComposer(buffer);
      expect(box).not.toBeNull();
      expect(box!.top).toBe(0);
      expect(box!.bottom).toBe(2);
    });
  }
});

describe("composerPrompt — the region a destructive write is bound to", () => {
  it("is the composer's own `╰─ … ─╯` row, verbatim minus trailing padding", () => {
    const buffer = fixtureLines("omp--draft-single.txt");
    const row = composerPrompt(buffer);
    expect(row).not.toBeNull();
    expect(row).toBe(lineText(buffer[locateComposer(buffer)!.bottom]!).replace(/\s+$/, ""));
    expect(row).toContain("list the files in this repo");
    expect(row!.startsWith("╰─ ")).toBe(true);
    expect(row!.endsWith("─╯")).toBe(true);
  });

  it("is null on exactly the screens composerReady refuses", () => {
    for (const name of NON_COMPOSER_FIXTURES) {
      expect(composerPrompt(fixtureLines(name))).toBeNull();
    }
    for (const name of COMPOSER_FIXTURES) {
      expect(composerPrompt(fixtureLines(name))).not.toBeNull();
    }
  });

  it("sits inside the tail window the bridge will accept a binding within", () => {
    // bridge/prompt-binding.ts requires the bound region to still match within the last
    // DEFAULT_PROMPT_TAIL_LINES (6) NON-BLANK rows of a fresh read, so a region with more rows than
    // that below it would refuse legitimate sweeps. omp paints at most the slash palette down there.
    const BRIDGE_TAIL_LINES = 6;
    for (const name of COMPOSER_FIXTURES) {
      const buffer = fixtureLines(name);
      const box = locateComposer(buffer)!;
      const below = buffer
        .slice(box.bottom + 1)
        .filter((l) => lineText(l).trim().length > 0).length;
      expect(below).toBeLessThan(BRIDGE_TAIL_LINES);
    }
  });
});
