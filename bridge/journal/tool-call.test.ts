import { describe, expect, test } from "bun:test";

import { classifyToolCall } from "./tool-call.ts";

// The classifier is pure and harness-blind: name plus input in, one branch of the union out. It gets
// table coverage here, and the per-harness RESULT folding (diff hunks, exit codes) is tested with the
// adapter that folds it, because result shapes are where harnesses actually differ.
//
// Tool names verified in real logs: Claude Code 2.1.284, Codex 0.156.1, opencode 1 and 2, pi.

describe("classifyToolCall", () => {
  test("the same tool under every harness's spelling lands on one kind", () => {
    // The whole point of a shared table: six adapters, one answer per tool.
    for (const name of ["Bash", "bash", "shell", "exec_command"])
      expect(classifyToolCall(name, { command: "ls" }, "ls").kind).toBe("execute");
    for (const name of ["Edit", "MultiEdit", "Write", "apply_patch"])
      expect(classifyToolCall(name, { file_path: "/a.ts" }, "/a.ts").kind).toBe("edit");
    for (const name of ["Read", "read", "read_file", "view"])
      expect(classifyToolCall(name, { file_path: "/a.ts" }, "/a.ts").kind).toBe("read");
  });

  test("a tool nobody has heard of is `other`, carrying the one-line summary unchanged", () => {
    // The degrade path: an unknown tool must read exactly as it did before this module existed.
    expect(classifyToolCall("mcp__jira__create", { issue: "PROJ-1" }, "PROJ-1")).toEqual({
      kind: "other",
      name: "mcp__jira__create",
      summary: "PROJ-1",
    });
  });

  test("an edit starts at zero lines moved, because the input cannot say", () => {
    // `added`/`removed` come from the RESULT. Classified alone, an edit honestly reports nothing.
    expect(classifyToolCall("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }, "/a.ts")).toEqual({
      kind: "edit",
      path: "/a.ts",
      added: 0,
      removed: 0,
    });
  });

  test("a shell command spelled as an argv array still reads as the command", () => {
    // Codex writes ["bash","-lc","ls -la"]. Skipping the array loses the defining argument of the
    // most common call in any log.
    expect(classifyToolCall("shell", { command: ["bash", "-lc", "ls -la"] }, "")).toEqual({
      kind: "execute",
      command: "bash -lc ls -la",
    });
  });

  test("a read names a range only when the call asked for both ends", () => {
    expect(classifyToolCall("Read", { file_path: "/a.ts" }, "/a.ts")).toEqual({ kind: "read", path: "/a.ts" });
    expect(classifyToolCall("Read", { file_path: "/a.ts", offset: 10, limit: 20 }, "/a.ts")).toEqual({
      kind: "read",
      path: "/a.ts",
      range: [10, 30],
    });
    // `offset` alone means "to the end", which has no last line to name.
    expect(classifyToolCall("Read", { file_path: "/a.ts", offset: 10 }, "/a.ts")).toEqual({
      kind: "read",
      path: "/a.ts",
    });
  });

  test("a grep's pattern outranks its path, as it does in the one-line summary", () => {
    // Pinned in text.ts for `summarizeToolInput`; the same order has to hold here or one call reads
    // two ways depending on which field the view picked.
    expect(classifyToolCall("Grep", { pattern: "TODO", path: "src/" }, "TODO")).toEqual({
      kind: "search",
      query: "TODO",
      where: "src/",
    });
  });

  test("a web search says so in `where`, since it has no path", () => {
    expect(classifyToolCall("WebSearch", { query: "bun terminal" }, "bun terminal")).toEqual({
      kind: "search",
      query: "bun terminal",
      where: "web",
    });
  });

  test("a subagent call prefers its description over the whole prompt", () => {
    expect(
      classifyToolCall("Task", { subagent_type: "Explore", description: "find the parser", prompt: "a".repeat(400) }, "find the parser"),
    ).toEqual({ kind: "task", agent: "Explore", summary: "find the parser" });
  });

  test("an absent optional field is absent, not `undefined`", () => {
    // A key holding `undefined` survives a deep compare and a structured clone, so it would travel to
    // the phone as a present-but-empty field.
    expect(Object.keys(classifyToolCall("Bash", { command: "ls" }, "ls"))).toEqual(["kind", "command"]);
    expect(Object.keys(classifyToolCall("Read", { file_path: "/a" }, "/a"))).toEqual(["kind", "path"]);
  });

  test("a non-object input never throws, whatever the harness wrote", () => {
    // Attacker-shaped by construction: this is a value off somebody else's disk.
    expect(classifyToolCall("Bash", undefined, "").kind).toBe("execute");
    expect(classifyToolCall("Bash", "just a string", "").kind).toBe("execute");
    expect(classifyToolCall("Read", [1, 2, 3], "").kind).toBe("read");
  });
});

describe("classifyToolCall: a question is recognised by its input", () => {
  const input = {
    questions: [{ question: "Which fruit?", header: "Fruit", options: [{ label: "Apple", description: "A round fruit" }, { label: "Banana" }] }],
  };

  test("the shape decides, whatever the tool is called", () => {
    for (const name of ["question", "AskUserQuestion", "some_other_tool"])
      expect(classifyToolCall(name, input, "").kind).toBe("question");
  });

  test("the summary is the first question and the call carries every field it was given", () => {
    expect(classifyToolCall("question", input, "ignored")).toEqual({
      kind: "question",
      name: "question",
      summary: "Which fruit?",
      questions: [
        {
          header: "Fruit",
          question: "Which fruit?",
          multiple: false,
          options: [{ label: "Apple", description: "A round fruit" }, { label: "Banana" }],
        },
      ],
    });
  });

  test("Claude's `multiSelect` and opencode's `multiple` both mean multiple", () => {
    const ask = (flag: Record<string, boolean>) => {
      const call = classifyToolCall("q", { questions: [{ question: "Q?", options: ["a"], ...flag }] }, "");
      return call.kind === "question" ? call.questions[0]?.multiple : undefined;
    };
    expect(ask({ multiSelect: true })).toBe(true);
    expect(ask({ multiple: true })).toBe(true);
    expect(ask({})).toBe(false);
  });

  test("an option may be a bare string", () => {
    const call = classifyToolCall("q", { questions: [{ question: "Q?", options: ["a", "b"] }] }, "");
    expect(call.kind === "question" && call.questions[0]?.options).toEqual([{ label: "a" }, { label: "b" }]);
  });

  test("a malformed entry is dropped, and nothing valid left falls through to `other`", () => {
    const mixed = classifyToolCall(
      "q",
      { questions: [null, "x", { question: "no options" }, { question: 3, options: [] }, { question: "Good?", options: [{ label: "y" }, { nolabel: 1 }, 7] }] },
      "s",
    );
    expect(mixed.kind === "question" && mixed.questions).toEqual([{ question: "Good?", multiple: false, options: [{ label: "y" }] }]);
    expect(classifyToolCall("q", { questions: [null, { question: "no options" }] }, "s")).toEqual({ kind: "other", name: "q", summary: "s" });
    expect(classifyToolCall("q", { questions: [] }, "s").kind).toBe("other");
    expect(classifyToolCall("q", { questions: "nope" }, "s").kind).toBe("other");
  });

  test("a runaway input is capped", () => {
    const options = Array.from({ length: 50 }, (_, i) => ({ label: `o${String(i)}` }));
    const questions = Array.from({ length: 30 }, () => ({ question: "q".repeat(2000), options }));
    const call = classifyToolCall("q", { questions }, "");
    if (call.kind !== "question") throw new Error("not a question");
    expect(call.questions).toHaveLength(9);
    expect(call.questions[0]?.options).toHaveLength(20);
    expect(call.questions[0]?.question).toHaveLength(500);
  });
});

