import { describe, expect, test } from "bun:test";

import { classifyToolCall, type ToolCall } from "./tool-call.ts";

// The classifier is pure and harness-blind: name plus input in, one branch of the union out. It gets
// table coverage here, and the per-harness RESULT folding (diff hunks, exit codes) is tested with the
// adapter that folds it, because result shapes are where harnesses actually differ.
//
// Tool names verified in real logs: Claude Code 2.1.284, Codex 0.156.1, opencode 1 and 2, pi.

describe("classifyToolCall", () => {
  test("the same tool under every harness's spelling lands on one kind", () => {
    // The whole point of a shared table: seven adapters, one answer per tool.
    for (const name of ["Bash", "bash", "shell", "exec_command"])
      expect(classifyToolCall(name, { command: "ls" }, "ls").kind).toBe("execute");
    for (const name of ["Edit", "MultiEdit", "Write", "apply_patch", "edit_file", "write_file"])
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

  test("a subagent call names its type, else its model, else nothing, and never the word agent", () => {
    const input = { description: "map the routes" };
    expect(classifyToolCall("Agent", { ...input, subagent_type: "Explore", model: "opus" }, "x")).toEqual({
      kind: "task",
      agent: "Explore",
      summary: "map the routes",
    });
    expect(classifyToolCall("Agent", { ...input, model: "sonnet" }, "x")).toEqual({
      kind: "task",
      agent: "sonnet",
      summary: "map the routes",
    });
    const bare = classifyToolCall("Agent", input, "x");
    expect(bare).toEqual({ kind: "task", summary: "map the routes" });
    expect(Object.keys(bare)).toEqual(["kind", "summary"]);
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

  test("Muse's `selection.mode` means multiple", () => {
    const multi = classifyToolCall(
      "request_user_input",
      {
        questions: [
          {
            id: "fruit",
            question: "Which fruit?",
            options: [{ label: "Apple" }, { label: "Banana" }],
            selection: { mode: "multiple", min_selections: 1, max_selections: 2 },
          },
        ],
      },
      "",
    );
    expect(multi.kind === "question" && multi.questions[0]).toMatchObject({ multiple: true });
    const single = classifyToolCall(
      "request_user_input",
      { questions: [{ id: "fruit", question: "Q?", options: ["a"], selection: { mode: "single" } }] },
      "",
    );
    expect(single.kind === "question" && single.questions[0]?.multiple).toBe(false);
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


// Gentle Shell's tools (gentle-pi 4.2.0), read off real pi logs on 2026-10-16 (issue #461).
describe("classifyToolCall: a task list is a plan", () => {
  test("a `todo` write carries its tasks, a missing status is pending", () => {
    const input = { action: "write", tasks: [{ title: "Write the parser", status: "in_progress", note: "RED" }, { title: "Ship it" }] };
    expect(classifyToolCall("todo", input, "write")).toEqual({
      kind: "plan",
      name: "todo",
      tasks: [
        { title: "Write the parser", status: "in_progress", note: "RED" },
        { title: "Ship it", status: "pending" },
      ],
    });
  });

  test("Claude's TodoWrite and Codex's update_plan map their words onto the five statuses", () => {
    const claude = classifyToolCall("TodoWrite", { todos: [{ content: "A", status: "completed", activeForm: "Doing A" }] }, "");
    expect(claude).toEqual({ kind: "plan", name: "TodoWrite", tasks: [{ title: "A", status: "done" }] });
    const codex = classifyToolCall("update_plan", { plan: [{ step: "B", status: "in_progress" }, { step: "C", status: "cancelled" }] }, "");
    expect(codex).toEqual({
      kind: "plan",
      name: "update_plan",
      tasks: [{ title: "B", status: "in_progress" }, { title: "C", status: "dropped" }],
    });
  });

  test("a `todo update` names one task, so the input holds no list", () => {
    expect(classifyToolCall("todo", { action: "update", id: 3, status: "done" }, "")).toEqual({ kind: "plan", name: "todo", tasks: [] });
  });

  // Hermes's `todo` with `merge: true` carries only the items it changed, so it is not the list.
  test("a merge that carries only the changed items is not a plan", () => {
    expect(classifyToolCall("todo", { todos: [{ content: "A", status: "completed" }], merge: true }, "A").kind).toBe("other");
  });

  test("an unknown status is pending and an entry with no title is dropped", () => {
    const call = classifyToolCall("todo", { action: "write", tasks: [{ title: "A", status: "someday" }, { status: "done" }, "x"] }, "");
    expect(call).toEqual({ kind: "plan", name: "todo", tasks: [{ title: "A", status: "pending" }] });
  });
});

describe("classifyToolCall: Gentle Shell's other tools", () => {
  test("`ask_user_choice` is one question by its shape, options as a list or as a JSON string", () => {
    const options = [{ label: "Yes", description: "Read only", value: "yes" }, { label: "No", value: "no" }];
    const expected: ToolCall = {
      kind: "question",
      name: "ask_user_choice",
      summary: "May I read it?",
      questions: [{ question: "May I read it?", multiple: false, options: [{ label: "Yes", description: "Read only" }, { label: "No" }] }],
    };
    expect(classifyToolCall("ask_user_choice", { question: "May I read it?", options }, "")).toEqual(expected);
    expect(classifyToolCall("ask_user_choice", { question: "May I read it?", options: JSON.stringify(options) }, "")).toEqual(expected);
  });

  test("a lone question with no options is not a question", () => {
    expect(classifyToolCall("ask", { question: "Why?" }, "Why?").kind).toBe("other");
    expect(classifyToolCall("ask", { question: "Why?", options: "not json" }, "Why?").kind).toBe("other");
  });

  test("`subagent_run` and `subagent_continue` are a task named by their label", () => {
    expect(classifyToolCall("subagent_run", { agent: "gentle-ai-explore", label: "Map the footer", task: "Long prompt", mode: "background" }, "")).toEqual({
      kind: "task",
      agent: "gentle-ai-explore",
      summary: "Map the footer",
    });
    expect(classifyToolCall("subagent_continue", { task_id: "t-1", label: "Fix the test", prompt: "Long prompt" }, "")).toEqual({
      kind: "task",
      summary: "Fix the test",
    });
  });

  test("a continue with no label is named by the one-line summary, never the whole prompt", () => {
    expect(classifyToolCall("subagent_continue", { task_id: "t-1", prompt: "Line one\nLine two" }, "t-1")).toEqual({
      kind: "task",
      summary: "t-1",
    });
  });

  test("`bash_background` and `monitor` run a command in the background", () => {
    expect(classifyToolCall("bash_background", { command: "bun test", label: "suite" }, "")).toEqual({
      kind: "execute",
      command: "bun test",
      description: "suite",
      background: true,
    });
    expect(classifyToolCall("monitor", { command: "tail -f log", label: "watch", timeout_seconds: 60 }, "")).toMatchObject({
      kind: "execute",
      background: true,
    });
    expect(classifyToolCall("bash", { command: "ls" }, "ls")).toEqual({ kind: "execute", command: "ls" });
  });

  test("`fetch_content` fetches, `google_search` and `source_check` search the web", () => {
    expect(classifyToolCall("fetch_content", { url: "https://a.dev" }, "")).toEqual({ kind: "fetch", url: "https://a.dev" });
    expect(classifyToolCall("google_search", { query: "bun test" }, "")).toEqual({ kind: "search", query: "bun test", where: "web" });
    expect(classifyToolCall("source_check", { claim: "Bun is fast" }, "")).toEqual({ kind: "search", query: "Bun is fast", where: "web" });
  });

  test("bookkeeping tools are `other` drawn quietly, and `codemode` stays plain `other`", () => {
    for (const name of ["mem_save", "mem_search", "gentle_odd_phase", "job_list"])
      expect(classifyToolCall(name, {}, "s")).toEqual({ kind: "other", name, summary: "s", quiet: true });
    expect(classifyToolCall("codemode", { code: "x" }, "x")).toEqual({ kind: "other", name: "codemode", summary: "x" });
  });
});
