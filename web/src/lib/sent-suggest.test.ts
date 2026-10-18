import { describe, expect, it } from "vitest";

import { entry } from "@/test/sent-fixtures";
import { segmentsOf, SUGGEST_LIMIT, suggest, suggestionLines, type SuggestionLine } from "./sent-suggest";

const line = (text: string, over: Partial<SuggestionLine> = {}): SuggestionLine => ({ line: text, inFolder: false, count: 1, at: 1000, ...over });
const lines = (r: ReturnType<typeof suggest>) => r.map((s) => s.line);

describe("suggestionLines", () => {
  it("marks the folder's lines and takes the machine's count for them", () => {
    const folder = [entry({ line: "make test", count: 2, at: 500 })];
    const machine = [entry({ line: "make test", count: 40, at: 900 }), entry({ line: "htop", count: 3, at: 100 })];
    const out = suggestionLines(folder, machine);
    expect(out.find((l) => l.line === "make test")).toEqual({ line: "make test", inFolder: true, count: 40, at: 900 });
    expect(out.find((l) => l.line === "htop")).toEqual({ line: "htop", inFolder: false, count: 3, at: 100 });
  });

  it("keeps a folder line the machine's page did not reach, with the folder's own numbers", () => {
    const out = suggestionLines([entry({ line: "old", count: 2, at: 50 })], []);
    expect(out).toEqual([{ line: "old", inFolder: true, count: 2, at: 50 }]);
  });
});

describe("suggest: an empty box", () => {
  it("offers this folder's newest lines first, newest at the front", () => {
    const all = [line("a", { inFolder: true, at: 10 }), line("b", { inFolder: true, at: 30 }), line("elsewhere", { at: 99 })];
    expect(lines(suggest(all, ""))).toEqual(["b", "a"]);
    expect(suggest(all, "")[0]!.marks).toEqual([]);
  });

  it("falls back to the machine's newest when the folder has none", () => {
    const all = [line("a", { at: 10 }), line("b", { at: 30 })];
    expect(lines(suggest(all, "  "))).toEqual(["b", "a"]);
  });

  it("offers at most the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => line(`cmd ${i}`, { inFolder: true, at: i }));
    expect(suggest(many, "")).toHaveLength(SUGGEST_LIMIT);
  });
});

describe("suggest: typing", () => {
  const all = [
    line("git status", { count: 9 }),
    line("git stash", { count: 2 }),
    line("echo git is fun", { count: 50 }),
    line("make test"),
    line("cargo test --release", { count: 5 }),
  ];

  it("puts lines that start with the text before lines that merely hold it", () => {
    expect(lines(suggest(all, "git"))).toEqual(["git status", "git stash", "echo git is fun"]);
  });

  it("matches without regard to case", () => {
    expect(lines(suggest(all, "GIT STA"))).toEqual(["git status", "git stash"]);
  });

  it("holds every typed word, in any order and place, after the prefix group", () => {
    expect(lines(suggest(all, "test make"))).toEqual(["make test"]);
    expect(lines(suggest(all, "release test"))).toEqual(["cargo test --release"]);
  });

  it("offers nothing for a word no line holds", () => {
    expect(suggest(all, "zzz")).toEqual([]);
  });

  it("ranks within a group by this folder, then how often, then how recently", () => {
    const group = [
      line("ls a", { count: 5, at: 10 }),
      line("ls b", { count: 5, at: 30 }),
      line("ls c", { count: 9, at: 5 }),
      line("ls d", { count: 1, at: 1, inFolder: true }),
    ];
    expect(lines(suggest(group, "ls"))).toEqual(["ls d", "ls c", "ls b", "ls a"]);
  });

  it("does not offer the line that already is the box", () => {
    expect(lines(suggest(all, "git status"))).toEqual([]);
    expect(lines(suggest(all, "git status "))).toEqual([]);
  });

  it("keeps the longer lines that start with the box, when the box is a whole line too", () => {
    const some = [line("ls"), line("ls -la")];
    expect(lines(suggest(some, "ls"))).toEqual(["ls -la"]);
  });

  it("offers nothing while the box starts with a space or a tab, which keeps a line out of Sent", () => {
    expect(suggest(all, " git")).toEqual([]);
    expect(suggest(all, "\tgit")).toEqual([]);
  });

  it("marks the typed prefix, or each typed word where it first stands", () => {
    expect(suggest(all, "git s")[0]!.marks).toEqual([[0, 5]]);
    expect(suggest(all, "test make")[0]!.marks).toEqual([[0, 4], [5, 9]]);
    expect(suggest(all, "release test")[0]!.marks).toEqual([[6, 10], [13, 20]]);
  });

  it("merges words that touch into one mark", () => {
    const out = suggest([line("xx yy")], "yy x");
    expect(out[0]!.marks).toEqual([[0, 1], [3, 5]]);
    expect(suggest([line("abcd")], "bc ab")[0]!.marks).toEqual([[0, 3]]);
  });
});

describe("segmentsOf", () => {
  it("cuts a line into matched and unmatched runs", () => {
    expect(segmentsOf({ line: "git status", marks: [[0, 3]] })).toEqual([
      { text: "git", matched: true },
      { text: " status", matched: false },
    ]);
    expect(segmentsOf({ line: "echo git", marks: [[5, 8]] })).toEqual([
      { text: "echo ", matched: false },
      { text: "git", matched: true },
    ]);
  });

  it("is one unmatched run when nothing matched", () => {
    expect(segmentsOf({ line: "ls", marks: [] })).toEqual([{ text: "ls", matched: false }]);
  });
});
