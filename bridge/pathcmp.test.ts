import { describe, expect, test } from "bun:test";

import { pathEq, pathStartsWithChild } from "./pathcmp.ts";

describe("pathEq", () => {
  test("win32 comparisons ignore case", () => {
    expect(pathEq("C:\\Case\\Root", "c:\\case\\root", "win32")).toBe(true);
  });

  test("POSIX comparisons stay strict", () => {
    expect(pathEq("/tmp/Root", "/tmp/root", "linux")).toBe(false);
  });
});

describe("pathStartsWithChild", () => {
  test("win32 accepts exact and nested children regardless of case", () => {
    expect(pathStartsWithChild("C:\\Case\\Root", "c:\\case\\root", "win32")).toBe(true);
    expect(pathStartsWithChild("C:\\Case\\Root\\child", "c:\\case\\root", "win32")).toBe(true);
  });

  test("win32 still rejects sibling prefixes", () => {
    expect(pathStartsWithChild("C:\\Case\\RootX\\child", "c:\\case\\root", "win32")).toBe(false);
  });

  test("win32 tolerates trailing separators and root paths", () => {
    expect(pathEq("C:\\Case\\Root\\", "c:\\case\\root", "win32")).toBe(true);
    expect(pathStartsWithChild("C:\\Case\\Root\\child\\", "c:\\case\\root\\", "win32")).toBe(true);
    expect(pathStartsWithChild("C:\\Windows", "C:\\", "win32")).toBe(true);
  });

  test("POSIX comparisons stay strict", () => {
    expect(pathStartsWithChild("/tmp/Root/child", "/tmp/root", "linux")).toBe(false);
    expect(pathStartsWithChild("/tmp/root/child", "/tmp/root/", "linux")).toBe(true);
    expect(pathStartsWithChild("/tmp/root", "/", "linux")).toBe(true);
  });
});
