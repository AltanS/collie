import { describe, expect, it } from "vitest";

import { fold, matchTerm, queryTerms, type Range } from "./fuzzy";

type Ranges = readonly Range[] | null;

interface Row {
  readonly text: string;
  readonly term: string;
  readonly anchored: Ranges;
  readonly loose: Ranges;
  // The term's letters are not all inside the ranges (a half of a surrogate pair is widened).
  readonly widened?: true;
}

const same = (text: string, term: string, ranges: Ranges): Row => ({ text, term, anchored: ranges, loose: ranges });

const LONG_HOPS = `a${"-b".repeat(150)}`;
const LONG_FLAT = "a".repeat(299) + "z";

const TABLE: readonly Row[] = [
  // substring
  same("collie-workspace", "col", [[0, 3]]),
  same("collie-workspace", "coll", [[0, 4]]),
  same("collie-workspace", "work", [[7, 11]]),
  same("collie-workspace", "space", [[11, 16]]),
  same("collie-workspace", "e-w", [[5, 8]]),
  same("collie-workspace", "-", [[6, 7]]),
  same("banana", "banana", [[0, 6]]),
  same("banana", "ana", [[1, 4]]),
  same("banana", "nan", [[2, 5]]),
  same("x", "x", [[0, 1]]),
  same("pi", "pi", [[0, 2]]),
  same("fooBar", "oba", [[2, 5]]),
  same("src/lib/fuzzy.ts", "ts", [[14, 16]]),
  same("fix-748", "748", [[4, 7]]),
  same("fix-748", "74", [[4, 6]]),
  same("fix748", "748", [[3, 6]]),
  // word start preferred over the first occurrence
  same("scollie-col", "col", [[8, 11]]),
  same("protocol col", "col", [[9, 12]]),
  same("protocol", "col", [[5, 8]]),
  same("fooBar", "bar", [[3, 6]]),
  same("HTTPServer", "server", [[4, 10]]),
  // abbreviation over separators
  same("collie-workspace", "cw", [[0, 1], [7, 8]]),
  same("my_branch", "mb", [[0, 1], [3, 4]]),
  same("my.branch", "mb", [[0, 1], [3, 4]]),
  same("my#branch", "mb", [[0, 1], [3, 4]]),
  same("my branch", "mb", [[0, 1], [3, 4]]),
  same("mini-buch", "mb", [[0, 1], [5, 6]]),
  same("branch:fix", "bf", [[0, 1], [7, 8]]),
  same("Pinned › collie", "pc", [[0, 1], [9, 10]]),
  same("src/lib/fuzzy.ts", "sl", [[0, 1], [4, 5]]),
  same("src/lib/fuzzy.ts", "lf", [[4, 5], [8, 9]]),
  same("alpha-beta", "ab", [[0, 1], [6, 7]]),
  same("Alpha-Beta", "ab", [[0, 1], [6, 7]]),
  same("alpha beta gamma", "bg", [[6, 7], [11, 12]]),
  same("a-b-c", "abc", [[0, 1], [2, 3], [4, 5]]),
  same("claude-opus", "co", [[0, 1], [7, 8]]),
  same("pane-1", "p1", [[0, 1], [5, 6]]),
  // abbreviation with runs
  same("alpha-beta", "alb", [[0, 2], [6, 7]]),
  same("alpha-beta", "alpb", [[0, 3], [6, 7]]),
  // camel humps
  same("fooBar", "fb", [[0, 1], [3, 4]]),
  same("COLLIE-WORKSPACE", "cw", [[0, 1], [7, 8]]),
  // digit boundaries
  same("fix-748", "f7", [[0, 1], [4, 5]]),
  same("fix/748", "f7", [[0, 1], [4, 5]]),
  same("fix748", "f7", [[0, 1], [3, 4]]),
  same("a1b2", "12", [[1, 2], [3, 4]]),
  same("v1.28.1", "128", [[1, 2], [3, 5]]),
  same("fix-748 retry", "f7r", [[0, 1], [4, 5], [8, 9]]),
  // backtracking: the first b cannot be followed by c, the second can
  same("a-bxc-bc", "abc", [[0, 1], [6, 8]]),
  // case
  same("COLLIE", "collie", [[0, 6]]),
  same("collie", "COLLIE", [[0, 6]]),
  // diacritics, ranges on the original
  same("Prüfung", "prufung", [[0, 7]]),
  same("Prüfung", "PRUF", [[0, 4]]),
  same("prüfung-plan", "pp", [[0, 1], [8, 9]]),
  same("Café Münster", "cm", [[0, 1], [5, 6]]),
  same("Café", "cafe", [[0, 4]]),
  same("Café", "é", [[3, 4]]),
  same("crème brûlée", "creme", [[0, 5]]),
  same("Zoë", "zoe", [[0, 3]]),
  same("ÀÉ", "ae", [[0, 2]]),
  same("İstanbul", "istanbul", [[0, 8]]),
  same("Prüfung", "prufung", [[0, 8]]),
  // emoji and CJK: no crash, ranges valid
  same("🚀 launch", "launch", [[3, 9]]),
  same("🚀 launch", "l", [[3, 4]]),
  same("🚀rocket", "r", [[2, 3]]),
  same("go 🚀 now", "🚀", [[3, 5]]),
  { text: "a🚀", term: "\ud83d", anchored: [[1, 3]], loose: [[1, 3]], widened: true },
  same("会议 notes", "notes", [[3, 8]]),
  same("会议室", "议", [[1, 2]]),
  // long texts
  same(LONG_FLAT, "z", [[299, 300]]),
  same("x".repeat(300), "xxx", [[0, 3]]),
  same("x".repeat(300), "y", null),
  { text: LONG_HOPS, term: "ab", anchored: null, loose: [[0, 1], [2, 3]] },
  // no match
  same("collie-workspace", "xyz", null),
  same("collie-workspace", "", null),
  same("", "x", null),
  same("x", "y", null),
  same("claude", "co", null),
  same("Straße", "strasse", null),
  // the term is longer than the text
  same("ab", "abc", null),
  same("ab", "abab", null),
  same("banana", "bananas", null),
  // repeated letters
  { text: "banana", term: "aaa", anchored: null, loose: [[1, 2], [3, 4], [5, 6]] },
  { text: "banana", term: "bnn", anchored: null, loose: [[0, 1], [2, 3], [4, 5]] },
  // anchored against loose
  { text: "collie-workspace", term: "cws", anchored: null, loose: [[0, 1], [7, 8], [11, 12]] },
  { text: "fix-748", term: "x8", anchored: null, loose: [[2, 3], [6, 7]] },
  { text: "HTTPServer", term: "hs", anchored: null, loose: [[0, 1], [4, 5]] },
  { text: "alpha-beta", term: "aa", anchored: null, loose: [[0, 1], [4, 5]] },
  { text: "src/lib/fuzzy.ts", term: "fz", anchored: null, loose: [[8, 9], [10, 11]] },
  { text: "bluefin", term: "fn", anchored: null, loose: [[4, 5], [6, 7]] },
  { text: "minibuch", term: "mb", anchored: null, loose: [[0, 1], [4, 5]] },
  { text: "会议室", term: "会室", anchored: null, loose: [[0, 1], [2, 3]] },
];

function validRanges(text: string, ranges: readonly Range[]): void {
  let edge = 0;
  for (const [start, end] of ranges) {
    expect(start).toBeGreaterThanOrEqual(edge);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(text.length);
    const before = text.charCodeAt(start - 1);
    const at = text.charCodeAt(start);
    const last = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    expect(start > 0 && before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff).toBe(false);
    expect(end < text.length && last >= 0xd800 && last <= 0xdbff && after >= 0xdc00 && after <= 0xdfff).toBe(false);
    edge = end + 1;
  }
}

const strip = (s: string): string => fold(s).normalize("NFD").replace(/\p{M}/gu, "");

describe("matchTerm table", () => {
  it("has at least 60 rows", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(60);
  });

  for (const row of TABLE) {
    const label = `${JSON.stringify(row.text.length > 40 ? `${row.text.slice(0, 12)}...(${row.text.length})` : row.text)} / ${JSON.stringify(row.term)}`;
    for (const level of ["anchored", "loose"] as const) {
      it(`${level}: ${label}`, () => {
        const got = matchTerm(row.text, row.term, level);
        expect(got === null ? null : got.ranges).toEqual(row[level]);
        if (got === null) return;
        validRanges(row.text, got.ranges);
        if (row.widened) return;
        const letters = got.ranges.map(([start, end]) => row.text.slice(start, end)).join("");
        expect(strip(letters)).toBe(strip(row.term));
      });
    }
  }

  it("loose keeps the ranges and the score of every anchored match", () => {
    for (const row of TABLE) {
      const a = matchTerm(row.text, row.term, "anchored");
      if (a === null) continue;
      expect(matchTerm(row.text, row.term, "loose")).toEqual(a);
    }
  });
});

describe("queryTerms", () => {
  it("splits at whitespace, folds and drops empties", () => {
    expect(queryTerms("  Fix   PRÜF\tcw ")).toEqual(["fix", "pruf", "cw"]);
    expect(queryTerms("   ")).toEqual([]);
    expect(queryTerms("")).toEqual([]);
  });

  it("keeps at most eight terms", () => {
    expect(queryTerms("a b c d e f g h i j")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("score order", () => {
  // Listed from best to worst for `col` at the loose level: substring at a word start (shorter text,
  // then later start), substring inside a word, abbreviation (fewer runs), loose (fewer runs, shorter).
  const ORDERED = [
    "col",
    "colab",
    "collie",
    "collie-workspace",
    "a-col",
    "my-col",
    "my-collie",
    "protocol",
    "comp-lamp",
    "cat-oak-lamp",
    "cooler",
    "cxoxl",
  ];

  it("ranks the twelve labels in the listed order", () => {
    const scored = ORDERED.toReversed().map((label) => {
      const got = matchTerm(label, "col", "loose");
      expect(got).not.toBeNull();
      return { label, score: got?.score ?? 0 };
    });
    scored.sort((a, b) => b.score - a.score);
    expect(scored.map((s) => s.label)).toEqual(ORDERED);
    expect(new Set(scored.map((s) => s.score)).size).toBe(ORDERED.length);
  });
});

describe("budget", () => {
  it("runs 10 000 matches of a 20-letter term over 300 texts of 40 units well inside five times the 50 ms budget", () => {
    const term = "abcdefghijklmnopqrst";
    const texts: string[] = [];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const filler = "abcdefghijklmnopqrstuvwxyz -_/";
    for (let i = 0; i < 300; i++) {
      let text = "";
      if (i % 3 === 0) {
        for (const letter of term) text += letter + filler[next() % filler.length];
      }
      while (text.length < 40) text += filler[next() % filler.length];
      texts.push(text.slice(0, 40));
    }
    const started = performance.now();
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      const got = matchTerm(texts[i % texts.length] ?? "", term, i % 2 === 0 ? "anchored" : "loose");
      if (got !== null) hits += 1;
    }
    const elapsed = performance.now() - started;
    expect(hits).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });
});
