import { describe, expect, test } from "bun:test";

import { endsInShellPrompt, SHELL_PROMPT } from "./shell-prompt.ts";

describe("endsInShellPrompt", () => {
  test("the last non-blank row decides, blank rows under it do not count", () => {
    expect(endsInShellPrompt("Last login: today\nuser@host:~/work$ \n\n  \n")).toBe(true);
    expect(endsInShellPrompt("$")).toBe(true);
    expect(endsInShellPrompt("~/work ❯ ")).toBe(true);
  });

  test("output, an agent's box and a footer percentage are no prompt", () => {
    expect(endsInShellPrompt("")).toBe(false);
    expect(endsInShellPrompt("building project...")).toBe(false);
    expect(endsInShellPrompt("$ \nbuilding project...")).toBe(false);
    expect(endsInShellPrompt("  context 37%")).toBe(false);
    expect(endsInShellPrompt("  ❯ one option")).toBe(false);
  });

  test("it is the one rule the blind road reads", () => {
    expect(SHELL_PROMPT.test("user@host:~$")).toBe(true);
  });
});
