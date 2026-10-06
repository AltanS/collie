import { describe, expect, test } from "bun:test";

import type { ChangeCommitDiffResponse, ChangeCommitResponse, ChangesResponse } from "@web/lib/types";

import { memoOf, nextCommit, nextFile, nextList } from "./state";

const diff = (text: string): Extract<ChangeCommitDiffResponse, { available: true }> => ({
  available: true,
  repo: ".",
  path: "a.ts",
  status: "M",
  binary: false,
  directory: false,
  truncated: false,
  diff: text,
  hash: "h1",
});

const commit = (hash: string): ChangeCommitResponse => ({
  available: true,
  repo: ".",
  name: "repo",
  commit: { hash, shortHash: hash.slice(0, 3), subject: "s", author: "a", time: 1 },
  files: [],
  truncated: false,
});

describe("nextFile", () => {
  test("a first answer is ready", () => {
    expect(nextFile(null, "k", diff("x")).phase).toBe("ready");
  });

  test("an equal re-read keeps the same state object", () => {
    const first = nextFile(null, "k", diff("x"));
    expect(nextFile(first, "k", diff("x"))).toBe(first);
  });

  test("a file that left keeps its diff and is marked gone", () => {
    const first = nextFile(null, "k", diff("x"));
    const left = nextFile(first, "k", { available: false, reason: "unknown-path" });
    expect(left.phase === "ready" && left.gone).toBe(true);
    expect(left.phase === "ready" && left.data.available).toBe(true);
    expect(nextFile(left, "k", { available: false, reason: "unknown-path" })).toBe(left);
  });

  test("a newer commit's first read says moved, and an open diff stays", () => {
    const moved = nextFile(null, "k", diff("x"), "other");
    expect(moved.phase === "ready" && moved.moved).toBe(true);
    const first = nextFile(null, "k", diff("x"), "h1");
    const newer: ChangeCommitDiffResponse = { ...diff("y"), hash: "h2" };
    expect(nextFile(first, "k", newer, "h1")).toBe(first);
  });
});

describe("nextCommit", () => {
  test("a newer HEAD waits for a tap and never swaps the files on screen", () => {
    const shown = nextCommit(null, ".", commit("aaa"));
    const next = nextCommit(shown, ".", commit("bbb"));
    expect(next.phase === "ready" && next.newer !== undefined).toBe(true);
    expect(next.phase === "ready" && next.data === (shown.phase === "ready" ? shown.data : null)).toBe(true);
    // The same newer commit again changes nothing.
    expect(nextCommit(next, ".", commit("bbb"))).toBe(next);
  });

  test("an equal re-read keeps the object, and a repo that cannot be seen keeps the commit", () => {
    const shown = nextCommit(null, ".", commit("aaa"));
    expect(nextCommit(shown, ".", commit("aaa"))).toBe(shown);
    expect(nextCommit(shown, ".", { available: false, reason: "unknown-repo" })).toBe(shown);
  });
});

describe("nextList and memoOf", () => {
  const list = (n: number): ChangesResponse => ({
    available: true,
    root: "/r",
    repos: [{ relPath: ".", name: "r", files: Array.from({ length: n }, (_, i) => ({ path: `f${String(i)}`, status: "M", added: 1, removed: 0, binary: false })) }],
    truncated: false,
  });

  test("an unchanged answer keeps the list state", () => {
    const first = nextList({ phase: "loading" }, list(2));
    expect(nextList(first, list(2))).toBe(first);
    expect(nextList(first, list(3))).not.toBe(first);
  });

  test("memoOf recomputes only when an input changes by identity", () => {
    let runs = 0;
    const double = memoOf((n: number) => {
      runs++;
      return n * 2;
    });
    expect(double(2)).toBe(4);
    expect(double(2)).toBe(4);
    expect(double(3)).toBe(6);
    expect(runs).toBe(2);
  });
});
