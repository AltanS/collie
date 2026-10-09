import { describe, expect, test } from "bun:test";

import { isValidWorktreeBranch } from "./worktree-branch.ts";

// The table the route's 400 rests on. Every refused row is one Git would refuse or one that would
// read as a flag; every accepted row is a name the phone mints or an operator would type.

describe("isValidWorktreeBranch", () => {
  const accepted = [
    "worktree/brisk-otter-3fa9",
    "feature/login",
    "fix-123",
    "a",
    "release/1.18.0",
    "user/name.with.dots",
    "x-y_z",
  ];
  for (const name of accepted) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(isValidWorktreeBranch(name)).toBe(true);
    });
  }

  const refused: Array<[string, string]> = [
    ["", "empty"],
    ["-rf", "leading dash"],
    ["--force", "leading double dash"],
    ["has space", "inner space"],
    ["tab\there", "tab"],
    ["new\nline", "newline"],
    ["bell\u0007", "control char"],
    ["del\u007f", "DEL"],
    ["nbsp x", "non-breaking space"],
    ["a..b", "double dot"],
    ["a@{b", "at-brace"],
    ["a\\b", "backslash"],
    ["a~b", "tilde"],
    ["a^b", "caret"],
    ["a:b", "colon"],
    ["a?b", "question mark"],
    ["a*b", "star"],
    ["a[b", "open bracket"],
    ["feature/", "trailing slash"],
    ["branch.lock", "trailing .lock"],
    ["a//b", "double slash"],
    // M48: the rest of what `git check-ref-format --branch` refuses, checked against git 2.x by hand.
    ["@", "the lone at sign, which git reads as HEAD"],
    ["/lead", "leading slash"],
    ["trail.", "trailing dot"],
    [".dot", "a leading dot"],
    ["a/.hidden", "a component with a leading dot"],
    ["a.lock/b", "a component ending in .lock"],
  ];
  for (const [name, why] of refused) {
    test(`refuses ${why}: ${JSON.stringify(name)}`, () => {
      expect(isValidWorktreeBranch(name)).toBe(false);
    });
  }
});
