// INVARIANTS THAT NEED NO CAPTURE (M37 spec 04). The conformance suite (conformance.ts) replays
// frozen captures, so it only knows the drafts and the paint that were on screen the day a capture
// was taken. Agents vary both on every release, and on 2026-09-26 two such variations broke the
// readers while every capture test stayed green (#293, #294):
//
//   - a Claude draft holding a pasted `────` rule or a `❯ ls` line hid the input box;
//   - Codex 0.156.1 painted its status separators with a foreground colour instead of SGR 2, and
//     every idle Codex pane lost its composer.
//
// This file varies exactly those two things over the captured idle frames:
//
//   1. DRAFT ROUND-TRIP. Generated drafts (rules, `❯` and `│` lines, CJK, emoji, indented and blank
//      lines, long wraps) are painted into each adapter's composer at the box's own width. The
//      composer must stay ready, and the draft the adapter reads back must be send evidence for the
//      text that was typed (`draftCarriesSend`, the reply guard's own check).
//   2. PAINT INVARIANCE. The composer band and the status and separator rows under it are
//      repainted (dim to plain, dim to a muted foreground, one colour to another, bold on and off,
//      the fill and muted colour a client-less pane loses, no paint at all). Whether the composer is
//      ready must not change.
//
// A case a reader does not pass yet is pinned as `it.fails` in KNOWN_DRAFT_GAPS or
// KNOWN_PAINT_GAPS, with its reason, never silently left out.
//
// Frames are repainted at the SGR level and re-parsed, so every derived field (`style`, `muted`) is
// what the parser would give a real pane. The generator is hand-written with a fixed seed: a failure
// names its seed and replays exactly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi, type AnsiSegment } from "../ansi";
import { lineText, splitLines, type StyledLine } from "../blocks";
import { draftCarriesSend } from "../reply-action";
import { displayWidth } from "../text-width";
import { agyAdapter } from "./agy";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { grokAdapter } from "./grok";
import { museAdapter } from "./muse";
import { ompAdapter } from "./omp";
import type { HarnessAdapter } from "./types";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

function loadLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

// ---------------------------------------------------------------------------------------------
// SGR round-trip: a StyledLine[] back to bytes, so a repainted or redrafted frame is re-parsed.
// ---------------------------------------------------------------------------------------------

/** The paint of one segment, as the parser reports it. `style` and `muted` are derived, not paint. */
type Paint = Pick<AnsiSegment, "fg" | "bg" | "bold" | "dim" | "italic" | "underline" | "strike">;

/** SGR parameters for a colour the parser produced. Throws on a spelling the parser never emits. */
function colourParams(colour: string, fg: boolean): string {
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colour);
  if (rgb !== null) return `${fg ? 38 : 48};2;${rgb[1]};${rgb[2]};${rgb[3]}`;
  const slot = /^var\(--ansi-(\d+)\)$/.exec(colour);
  if (slot !== null) {
    const n = Number(slot[1]);
    return String(n < 8 ? (fg ? 30 : 40) + n : (fg ? 90 : 100) + n - 8);
  }
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (hex !== null) {
    const [r, g, b] = [hex[1]!, hex[2]!, hex[3]!].map((h) => parseInt(h, 16));
    return `${fg ? 38 : 48};2;${r};${g};${b}`;
  }
  throw new Error(`colour the parser does not produce: ${colour}`);
}

function sgr(paint: Paint): string {
  const params = ["0"];
  if (paint.bold === true) params.push("1");
  if (paint.dim === true) params.push("2");
  if (paint.italic === true) params.push("3");
  if (paint.underline === true) params.push("4");
  if (paint.strike === true) params.push("9");
  if (paint.fg !== undefined) params.push(colourParams(paint.fg, true));
  if (paint.bg !== undefined) params.push(colourParams(paint.bg, false));
  return `\x1b[${params.join(";")}m`;
}

/** A frame as bytes. Every segment opens with a reset, so no paint leaks between segments or rows. */
function serialize(lines: StyledLine[]): string {
  return lines.map((line) => line.segments.map((s) => sgr(s) + s.text).join("") + "\x1b[0m").join("\r\n");
}

function reparse(lines: StyledLine[]): StyledLine[] {
  return splitLines(parseAnsi(serialize(lines)));
}

function plainRow(text: string): StyledLine {
  return { segments: [{ text, style: {}, muted: false }] };
}

// ---------------------------------------------------------------------------------------------
// A seeded generator of drafts.
// ---------------------------------------------------------------------------------------------

/** mulberry32: a 32-bit seeded PRNG, enough for test input and fully reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "please", "move", "the", "images", "across", "then", "verify", "copy", "parser", "fix", "tests",
  "branch", "deploy", "output", "config", "rename", "delete", "check", "why", "does", "this", "fail",
];
const CJK = ["これは", "テスト", "です", "请检查", "这个", "文件", "한국어", "문장", "입니다", "変更を", "確認して"];
const EMOJI = ["🎉", "👩‍👧‍👦", "🚀", "✅", "🔥", "👍🏽", "🇩🇪"];

type Pick1 = <T>(items: readonly T[]) => T;

/** One draft line of a given kind. Every kind is something a person pastes or types. */
const LINE_KINDS = {
  words: (pick, rand) => Array.from({ length: 2 + Math.floor(rand() * 8) }, () => pick(WORDS)).join(" "),
  // A long line, so it wraps across rows of the box.
  long: (pick, rand) => Array.from({ length: 25 + Math.floor(rand() * 30) }, () => pick(WORDS)).join(" "),
  // The 1.13.1 failure: a pasted rule of box-drawing glyphs.
  rule: (_pick, rand) => "─".repeat(3 + Math.floor(rand() * 60)),
  // The other 1.13.1 failure: a pasted shell prompt line.
  chevron: (pick) => `❯ ${pick(["ls -la", "git status", "bun run test", "cd ~/src"])}`,
  // A pasted table or box row.
  pipe: (pick) => `│ ${pick(WORDS)} │ ${pick(WORDS)} │`,
  // CJK has no spaces, so a long run wraps mid-word.
  cjk: (pick, rand) => Array.from({ length: 3 + Math.floor(rand() * 30) }, () => pick(CJK)).join(""),
  emoji: (pick, rand) =>
    Array.from({ length: 2 + Math.floor(rand() * 6) }, () => `${pick(WORDS)} ${pick(EMOJI)}`).join(" "),
  indented: (pick, rand) => `${" ".repeat(2 + Math.floor(rand() * 6))}${pick(WORDS)} ${pick(WORDS)}`,
  blank: () => "",
} satisfies Record<string, (pick: Pick1, rand: () => number) => string>;

type LineKind = keyof typeof LINE_KINDS;

// SAFETY: `LINE_KINDS` is a literal declared right above, so its own keys are exactly `LineKind`.
const ALL_KINDS = Object.keys(LINE_KINDS) as LineKind[];

/** A multi-line draft. The first line is never blank (an agent drops a leading empty line). `omit`
 *  names the kinds of line this draft leaves out (see `Composer.draft.omit`). */
function generateDraft(seed: number, omit: readonly LineKind[]): string[] {
  const rand = prng(seed);
  const pick: Pick1 = (items) => items[Math.floor(rand() * items.length)]!;
  const kinds = ALL_KINDS.filter((k) => !omit.includes(k));
  const count = 1 + Math.floor(rand() * 6);
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const kind = pick(i === 0 ? kinds.filter((k) => k !== "blank") : kinds);
    lines.push(LINE_KINDS[kind](pick, rand));
  }
  // The rule and the chevron line are the known failures; make sure most drafts carry one of them.
  if (seed % 3 !== 0 && !lines.some((l) => l.startsWith("─") || l.startsWith("❯"))) {
    const known = pick([LINE_KINDS.rule(pick, rand), LINE_KINDS.chevron(pick)]);
    lines.splice(1 + Math.floor(rand() * lines.length), 0, known);
  }
  // A trailing blank line is dropped by every agent on send; keep the draft's end non-blank.
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Soft-wrap one draft line to `width` display columns the way a TUI composer does: break after the
 * last space that fits (the space itself is dropped), or mid-run when no space fits (CJK, a rule, a
 * long token). Graphemes are never split.
 */
function wrapLine(text: string, width: number): string[] {
  if (text === "") return [""];
  const rows: string[] = [];
  let rest = text;
  while (displayWidth(rest) > width) {
    let used = 0;
    let cut = 0;
    let lastSpace = -1;
    for (const { segment, index } of GRAPHEMES.segment(rest)) {
      const w = displayWidth(segment);
      if (used + w > width) break;
      if (segment === " " && index > 0) lastSpace = index;
      used += w;
      cut = index + segment.length;
    }
    if (lastSpace > 0) {
      rows.push(rest.slice(0, lastSpace));
      rest = rest.slice(lastSpace + 1);
    } else {
      rows.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
  }
  rows.push(rest);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Composer shapes. Each locates, by text alone and independently of the reader under test, where an
// adapter's composer sits in a captured idle frame, and paints a draft into it the way the agent
// does (per the draft captures named on each composer).
// ---------------------------------------------------------------------------------------------

interface Band {
  /** First row of the composer band (a top border, rule or fill row). Paint varies from here down. */
  top: number;
  /** The prompt row. */
  prompt: number;
  /** One past the last draft row: the rows from here on are kept as captured. */
  draftEnd: number;
  /** The display width a draft row wraps at. */
  width: number;
}

interface Composer {
  name: string;
  adapter: HarnessAdapter;
  /** Captured idle frames: the composer is on screen, and no dialog. */
  frames: string[];
  band(texts: string[]): Band | null;
  /** How a draft is painted into the band. Absent where no capture shows the agent's wrapped draft. */
  draft?: {
    /**
     * Kinds of line left out of this composer's drafts, each with its reason: no capture shows how the
     * agent paints that line, or the reader has a known gap there (pinned in KNOWN_DRAFT_GAPS).
     */
    omit: Partial<Record<LineKind, string>>;
    rows(wrapped: { first: boolean; text: string }[], band: Band, texts: string[]): StyledLine[];
  };
}

const atColumnZero = (t: string) => t.length > 0 && !/^\s/.test(t);
const isBareRule = (t: string) => /^─+$/.test(t.trimEnd());
const isBlank = (t: string) => t.trim() === "";

/** The lowest column-0 row starting with `glyph` whose next column-0 non-blank row passes `closes`. */
function promptAboveCloser(
  texts: string[],
  glyph: string,
  closes: (t: string) => boolean,
): { prompt: number; closer: number } | null {
  for (let p = texts.length - 1; p >= 0; p--) {
    if (!atColumnZero(texts[p]!) || !texts[p]!.startsWith(glyph)) continue;
    let j = p + 1;
    while (j < texts.length && !atColumnZero(texts[j]!)) j++;
    if (j < texts.length && closes(texts[j]!)) return { prompt: p, closer: j };
  }
  return null;
}

/** Prompt row `glyph + " " + text`, continuation rows `"  " + text`, a blank line an empty row.
 *  Claude (claude--v2283-draft-rule.txt), Codex (codex--v0156-draft-blank-line.txt), Muse
 *  (muse--draft-blank-row.txt) and omp's rule composer (omp--v18-rule-wrapped.txt) all paint this. */
function gutterRows(glyph: string) {
  return (wrapped: { first: boolean; text: string }[]): StyledLine[] =>
    wrapped.map(({ first, text }) => plainRow(first ? `${glyph} ${text}` : text === "" ? "" : `  ${text}`));
}

const COMPOSERS: Composer[] = [
  {
    name: "claude",
    adapter: claudeAdapter,
    frames: [
      "claude--fresh-idle.txt",
      "claude--done.txt",
      "claude--draft-footer-empty.txt",
      "claude--v2283-draft-rule.txt",
      "claude-lab--idle-fresh--w40.txt",
      "claude-lab--idle-fresh--w82.txt",
      "claude-lab--idle-fresh--w200.txt",
      "claude-lab--idle-after-turn--w40.txt",
      "claude-lab--idle-after-turn--w82.txt",
      "claude-lab--idle-after-turn--w200.txt",
      "claude-lab--idle-labelled-top-border--w41.txt",
      "claude-lab--idle-labelled-top-border--w83.txt",
      "claude-lab--statusline-3row--w82.txt",
      "claude-lab--statusline-10row--w82.txt",
      "claude-lab--statusline-none--w82.txt",
      "claude-lab--statusline-rule-row--w82.txt",
    ],
    band(texts) {
      const found = promptAboveCloser(texts, "❯", isBareRule);
      if (found === null) return null;
      return { top: found.prompt - 1, prompt: found.prompt, draftEnd: found.closer, width: displayWidth(texts[found.closer]!.trimEnd()) - 2 };
    },
    draft: { omit: {}, rows: gutterRows("❯") },
  },
  {
    name: "codex",
    adapter: codexAdapter,
    frames: [
      "codex--fresh-idle.txt",
      "codex--draft.txt",
      "codex--v0150-idle.txt",
      "codex--v0150-nogit-idle.txt",
      "codex--v0150-custom-status.txt",
      "codex--v0151-draft-indented-line.txt",
      "codex--v0156-idle.txt",
      "codex--v0156-idle-50.txt",
      "codex--v0156-draft-multiline.txt",
      "codex--v0156-headless-idle.txt",
      "codex--v0156-headless-draft.txt",
    ],
    band(texts) {
      let status = texts.length - 1;
      while (status >= 0 && isBlank(texts[status]!)) status--;
      let prompt = status - 1;
      while (prompt >= 0 && !texts[prompt]!.startsWith("› ")) prompt--;
      if (prompt < 0) return null;
      let draftEnd = status;
      while (draftEnd - 1 > prompt && isBlank(texts[draftEnd - 1]!)) draftEnd--;
      const top = prompt > 0 && isBlank(texts[prompt - 1]!) ? prompt - 1 : prompt;
      return { top, prompt, draftEnd, width: displayWidth(texts[prompt]!) - 2 };
    },
    draft: { omit: {}, rows: gutterRows("›") },
  },
  {
    name: "muse",
    adapter: museAdapter,
    frames: ["muse--fresh-idle.txt", "muse--draft-single.txt", "muse--draft-wrapped.txt", "muse--done.txt"],
    band(texts) {
      const found = promptAboveCloser(texts, "❯", isBareRule);
      if (found === null) return null;
      return { top: found.prompt - 1, prompt: found.prompt, draftEnd: found.closer, width: displayWidth(texts[found.closer]!.trimEnd()) - 2 };
    },
    draft: { omit: { indented: "a known gap, see KNOWN_DRAFT_GAPS" }, rows: gutterRows("❯") },
  },
  {
    name: "omp (rule composer)",
    adapter: ompAdapter,
    frames: ["omp--v18-rule-idle.txt", "omp--v18-rule-draft.txt", "omp--v18-rule-wrapped.txt"],
    band(texts) {
      let prompt = texts.length - 1;
      while (prompt > 0 && !(atColumnZero(texts[prompt]!) && texts[prompt]!.startsWith("❯") && isBareRule(texts[prompt - 1]!))) prompt--;
      if (prompt <= 0) return null;
      let draftEnd = prompt + 1;
      while (draftEnd < texts.length && !isBlank(texts[draftEnd]!)) draftEnd++;
      return { top: prompt - 1, prompt, draftEnd, width: displayWidth(texts[prompt - 1]!.trimEnd()) - 2 };
    },
    draft: {
      omit: { blank: "no capture shows how omp paints a blank line inside a draft" },
      rows: gutterRows("❯"),
    },
  },
  {
    name: "grok",
    adapter: grokAdapter,
    frames: ["grok--fresh-idle.txt", "grok--draft-single.txt", "grok--draft-wrapped.txt", "grok--done.txt"],
    band(texts) {
      let prompt = texts.length - 1;
      while (prompt >= 0 && !/^\s*│ ❯/.test(texts[prompt]!)) prompt--;
      if (prompt < 1 || !/^\s*╭/.test(texts[prompt - 1]!)) return null;
      let draftEnd = prompt + 1;
      while (draftEnd < texts.length && !/^\s*╰/.test(texts[draftEnd]!)) draftEnd++;
      if (draftEnd === texts.length) return null;
      // Inner width: from after `│ ❯ ` to before the right `│`, which sits under the top border's `╮`.
      const topRow = texts[prompt - 1]!;
      const right = displayWidth(topRow.slice(0, topRow.indexOf("╮")));
      const lead = displayWidth(texts[prompt]!.slice(0, texts[prompt]!.indexOf("❯") + 2));
      return { top: prompt - 1, prompt, draftEnd, width: right - lead - 1 };
    },
    // grok--draft-wrapped.txt: `  │ ❯ text…  │` then `  │   text…  │`, padded to the right border.
    draft: {
      omit: {},
      rows(wrapped, band, texts) {
        const promptRow = texts[band.prompt]!;
        const indent = promptRow.slice(0, promptRow.indexOf("│"));
        return wrapped.map(({ first, text }) => {
          const pad = " ".repeat(Math.max(0, band.width - displayWidth(text)));
          return plainRow(`${indent}│ ${first ? "❯" : " "} ${text}${pad} │`);
        });
      },
    },
  },
  {
    name: "agy",
    adapter: agyAdapter,
    frames: ["agy--fresh-idle.txt", "agy--done.txt"],
    band(texts) {
      const found = promptAboveCloser(texts, ">", isBareRule);
      if (found === null) return null;
      return { top: found.prompt - 1, prompt: found.prompt, draftEnd: found.closer, width: 0 };
    },
    // No capture shows how Antigravity paints a wrapped or multi-line draft: paint invariance only.
  },
  {
    name: "omp (box composer)",
    adapter: ompAdapter,
    frames: ["omp--fresh-idle.txt", "omp--done.txt"],
    band(texts) {
      let top = texts.length - 1;
      while (top >= 0 && !texts[top]!.startsWith("╭")) top--;
      return top < 0 ? null : { top, prompt: top, draftEnd: top + 1, width: 0 };
    },
    // The box composer paints the last draft row on its bottom border (omp--draft-wrapped.txt), a
    // composer this generator does not model: paint invariance only.
  },
];

function bandOf(composer: Composer, lines: StyledLine[]): Band {
  const band = composer.band(lines.map(lineText));
  if (band === null) throw new Error(`${composer.name}: no composer band found`);
  return band;
}

/** `frame` with the draft region replaced by `draft` (lines as typed), re-parsed. */
function withDraft(composer: Composer, frame: StyledLine[], draft: string[]): StyledLine[] {
  const band = bandOf(composer, frame);
  const wrapped = draft.flatMap((line, i) =>
    wrapLine(line, band.width).map((text, j) => ({ first: i === 0 && j === 0, text })),
  );
  const rows = composer.draft!.rows(wrapped, band, frame.map(lineText));
  return reparse([...frame.slice(0, band.prompt), ...rows, ...frame.slice(band.draftEnd)]);
}

// ---------------------------------------------------------------------------------------------
// 1. Draft round-trip.
// ---------------------------------------------------------------------------------------------

const SEEDS_PER_FRAME = 24;

/** The round-trip itself: the composer stays ready and the draft read back is send evidence. */
function expectRoundTrip(composer: Composer, frame: StyledLine[], draft: string[], label: string): void {
  const sent = draft.join("\n");
  const lines = withDraft(composer, frame, draft);
  const context = `${label}: ${JSON.stringify(sent)}`;
  expect(composer.adapter.composerReady!(lines), `composerReady, ${context}`).toBe(true);
  const read = composer.adapter.extractInputDraft(lines);
  expect(draftCarriesSend(sent, read), `draftCarriesSend(sent, ${JSON.stringify(read)}), ${context}`).toBe(true);
}

/**
 * Drafts a reader does not survive yet. Each is left out of its composer's generated drafts (`omit`)
 * and pinned here instead as `it.fails`, so it shows in every run and turns red the day it is fixed.
 */
const KNOWN_DRAFT_GAPS: { composer: string; kind: LineKind; draft: string[]; why: string }[] = [
  {
    // Muse's continuation test is `/^ {2}\S/` (muse/markers.ts), the same test Codex had until an
    // indented draft line refused every send (codex/chrome.ts, CONTINUATION). A typed indent after
    // the two-column gutter reads as a torn frame, and the composer is lost. No Muse capture of an
    // indented line exists yet; the draft below is the Codex one (codex--v0151-draft-indented-line.txt).
    composer: "muse",
    kind: "indented",
    draft: ["please move all the images across to the new blog", "  then take the originals down"],
    why: "an indented draft line reads as a torn frame (no issue filed yet)",
  },
];

describe("draft round-trip: generated drafts stay composer and read back as send evidence", () => {
  for (const composer of COMPOSERS) {
    const painter = composer.draft;
    if (painter === undefined) continue;
    // SAFETY: `omit` is a Partial<Record<LineKind, …>>, so its own keys are LineKinds.
    const omit = Object.keys(painter.omit) as LineKind[];
    describe(composer.name, () => {
      for (const name of composer.frames) {
        it(`${name}: ${SEEDS_PER_FRAME} generated drafts`, () => {
          const frame = loadLines(name);
          expect(composer.adapter.composerReady!(reparse(frame)), "the captured frame itself").toBe(true);
          for (let seed = 1; seed <= SEEDS_PER_FRAME; seed++) {
            expectRoundTrip(composer, frame, generateDraft(seed, omit), `seed ${seed}`);
          }
        });
      }
      for (const gap of KNOWN_DRAFT_GAPS.filter((g) => g.composer === composer.name)) {
        it.fails(`known gap, ${gap.kind} line: ${gap.why}`, () => {
          for (const name of composer.frames) expectRoundTrip(composer, loadLines(name), gap.draft, name);
        });
      }
    });
  }

  it("every known draft gap is left out of its composer's generated drafts", () => {
    for (const gap of KNOWN_DRAFT_GAPS) {
      const composer = COMPOSERS.find((s) => s.name === gap.composer);
      expect(composer?.draft?.omit[gap.kind], gap.composer).toBeDefined();
    }
  });

  it("the generator covers every kind of line, the known failures in most drafts", () => {
    const drafts = Array.from({ length: SEEDS_PER_FRAME }, (_, i) => generateDraft(i + 1, []));
    const all = drafts.flat();
    expect(all.some((l) => l.startsWith("─"))).toBe(true);
    expect(all.some((l) => l.startsWith("❯"))).toBe(true);
    expect(all.some((l) => l.startsWith("│"))).toBe(true);
    expect(all.some((l) => /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Hangul}/u.test(l))).toBe(true);
    expect(all.some((l) => /\p{Extended_Pictographic}/u.test(l))).toBe(true);
    expect(all.some((l) => /^ {2,}\S/.test(l))).toBe(true);
    expect(all.some((l) => l === "")).toBe(true);
    expect(all.some((l) => displayWidth(l) > 200)).toBe(true);
    const withKnownFailure = drafts.filter((d) => d.some((l) => l.startsWith("─") || l.startsWith("❯")));
    expect(withKnownFailure.length).toBeGreaterThan(SEEDS_PER_FRAME / 2);
  });

  it("wrapLine breaks at the last space that fits, mid-run otherwise, never inside a grapheme", () => {
    expect(wrapLine("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
    expect(wrapLine("これはテストです", 6)).toEqual(["これは", "テスト", "です"]);
    expect(wrapLine("ab👩‍👧‍👦cd", 3)).toEqual(["ab", "👩‍👧‍👦c", "d"]);
    expect(wrapLine("", 10)).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Paint invariance.
// ---------------------------------------------------------------------------------------------

/** The muted foreground Codex 0.156.1 paints its separators with, where 0.154.0 used SGR 2. */
const MUTED = "rgb(135,140,164)";

/** One colour to another, as a theme change does: injective, so two colours that differed still do. */
function shiftColour(colour: string): string {
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(colour);
  if (rgb !== null) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return `rgb(${(r + 41) % 256},${(g + 83) % 256},${(b + 29) % 256})`;
  }
  const slot = /^var\(--ansi-(\d+)\)$/.exec(colour);
  if (slot !== null) return `var(--ansi-${(Number(slot[1]) + 1) % 16})`;
  return colour;
}

const hasInk = (s: AnsiSegment) => s.text.trim() !== "";

const REPAINTS = {
  "dim to plain": (s) => ({ ...s, dim: false }),
  // The Codex 0.156.1 change (#294): what was SGR 2 now carries the theme's muted foreground.
  "dim to a muted foreground": (s) => (s.dim === true ? { ...s, dim: false, fg: s.fg ?? MUTED } : s),
  "one colour to another": (s) => ({
    ...s,
    fg: s.fg === undefined ? undefined : shiftColour(s.fg),
    bg: s.bg === undefined ? undefined : shiftColour(s.bg),
  }),
  "bold on": (s) => (hasInk(s) ? { ...s, bold: true } : s),
  "bold off": (s) => ({ ...s, bold: false }),
  // Codex 0.156.1 started with no Herdr client attached (#294, codex--v0156-headless-idle.txt): no
  // colour query is answered, so the composer loses its fill and the separators their muted colour.
  // The fields keep their own colours, and SGR 2 stays where it was.
  "no client attached": (s) => ({ ...s, bg: undefined, fg: s.fg === MUTED ? undefined : s.fg }),
  // Stronger than any capture: the fields lose their colours too.
  "no paint at all": () => ({}),
} satisfies Record<string, (s: AnsiSegment) => Paint>;

type RepaintName = keyof typeof REPAINTS;

function repaint(frame: StyledLine[], top: number, paint: (s: AnsiSegment) => Paint): StyledLine[] {
  return reparse(
    frame.map((line, i) =>
      i < top ? line : { ...line, segments: line.segments.map((s) => ({ ...s, ...clear(), ...paint(s) })) },
    ),
  );
}

/** Every paint field unset, so a repaint that returns a partial paint drops the rest. */
function clear(): Paint {
  return { fg: undefined, bg: undefined, bold: undefined, dim: undefined, italic: undefined, underline: undefined, strike: undefined };
}

// The Codex frames whose status row carries no `Context N% left` text, so the reader can only
// accept that row by its paint (codex/markers.ts, isStyledStatusRow). The older frames that do
// carry the text are accepted on it whatever the paint, and pass every repaint below.
const CODEX_READ_BY_PAINT = [
  "codex--v0150-idle.txt",
  "codex--v0150-nogit-idle.txt",
  "codex--v0150-custom-status.txt",
  "codex--v0151-draft-indented-line.txt",
  "codex--v0156-idle.txt",
  "codex--v0156-idle-50.txt",
  "codex--v0156-draft-multiline.txt",
  "codex--v0156-headless-idle.txt",
  "codex--v0156-headless-draft.txt",
];

/**
 * Repaints a reader does not survive yet, per composer and frame. Each runs as `it.fails`, so it shows
 * in every run and turns red the day the reader learns the paint; then delete the entry.
 */
const KNOWN_PAINT_GAPS: { composer: string; paint: RepaintName; frames: string[]; why: string }[] = [
  {
    // With no paint at all the status row is `  <model> · <cwd>` in plain text, the same bytes as a
    // line of prose, and the styled acceptor refuses that ON PURPOSE (codex.test.ts, "refuses the
    // same text with no styling at all"). #294 fixed the real headless screen, whose fields keep
    // their colours ("no client attached" above passes); this stronger repaint stays refused by
    // design, no issue filed.
    composer: "codex",
    paint: "no paint at all",
    frames: CODEX_READ_BY_PAINT,
    why: "a status row with no paint is prose by design, no issue filed",
  },
  {
    // The right-aligned notice (`⚠ 1 warning · f2 to view`) is accepted only when every one of its
    // segments is painted (codex/markers.ts, isRightNotice), and its glue text carries the same muted
    // colour the separators lose here. No headless capture shows a notice, so how Codex paints one
    // with no client attached is not known yet; the notice rule was left as it is (#294).
    composer: "codex",
    paint: "no client attached",
    frames: ["codex--v0156-draft-multiline.txt"],
    why: "#294, a right-aligned notice with no colour, no capture yet",
  },
  {
    // The status-row acceptor refuses a bold field or a bold separator ON PURPOSE: every Codex
    // dialog footer paints its key names bold, and that is what keeps a footer from passing as a
    // status row (codex/markers.ts). So a theme that bolds the status row would turn the composer
    // dark. Pinned as a gap so the trade-off stays visible; no issue filed.
    composer: "codex",
    paint: "bold on",
    frames: CODEX_READ_BY_PAINT,
    why: "bold status fields are refused by design, no issue filed",
  },
];

function paintGap(composer: Composer, paint: string, frame: string): string | undefined {
  return KNOWN_PAINT_GAPS.find((g) => g.composer === composer.name && g.paint === paint && g.frames.includes(frame))?.why;
}

describe("paint invariance: repainting the rows around the composer never changes composerReady", () => {
  for (const composer of COMPOSERS) {
    describe(composer.name, () => {
      for (const name of composer.frames) {
        for (const [paintName, paint] of Object.entries(REPAINTS)) {
          const gap = paintGap(composer, paintName, name);
          const title = `${name}: ${paintName}${gap === undefined ? "" : ` (known gap: ${gap})`}`;
          const test = () => {
            const frame = loadLines(name);
            expect(composer.adapter.composerReady!(reparse(frame)), "the captured frame itself").toBe(true);
            expect(composer.adapter.composerReady!(repaint(frame, bandOf(composer, frame).top, paint))).toBe(true);
          };
          if (gap === undefined) it(title, test);
          else it.fails(title, test);
        }
      }
    });
  }

  it("the serializer round-trips every captured frame unchanged in text and paint", () => {
    for (const composer of COMPOSERS) {
      for (const name of composer.frames) {
        const frame = loadLines(name);
        const again = reparse(frame);
        expect(again.map(lineText), name).toEqual(frame.map(lineText));
        const paintOf = (lines: StyledLine[]) =>
          lines.flatMap((l) => l.segments.map((s) => [s.text, s.fg, s.bg, s.bold === true, s.dim === true]));
        expect(paintOf(again), name).toEqual(paintOf(frame));
      }
    }
  });
});
