import { finished, itemsOf, toolOf, toolStatus, withToolOutput } from "./chat-items";
import type { ToolCall, TranscriptEntry, TranscriptPart } from "./types";

// The translation from a journal turn to the blocks Chat draws. The load-bearing rules: a turn that
// is not speech never reads as speech, a denied call never reads as a failed one, a call keeps the
// harness's own id so a host can key a card on it, and an untaught adapter degrades rather than
// disappears.

const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: "u1",
  ts: "2026-09-30T08:00:00.000Z",
  role: "assistant",
  parts: [],
  ...over,
});

const toolPart = (over: Partial<Extract<TranscriptPart, { kind: "tool" }>> = {}): Extract<TranscriptPart, { kind: "tool" }> => ({
  kind: "tool",
  name: "Bash",
  summary: "ls -la",
  ...over,
});

describe("itemsOf", () => {
  it("reads a user turn as speech and an assistant turn as a reply", () => {
    expect(itemsOf(entry({ role: "user", parts: [{ kind: "text", text: "go" }] }))[0]).toMatchObject({
      kind: "user",
      text: "go",
    });
    expect(itemsOf(entry({ role: "assistant", parts: [{ kind: "text", text: "done" }] }))[0]).toMatchObject({
      kind: "reply",
      text: "done",
    });
  });

  it("reads a machine note as a notice, never as speech", () => {
    const [item] = itemsOf(entry({ role: "note", parts: [{ kind: "text", text: "injected" }] }));
    expect(item).toMatchObject({ kind: "notice", note: true });
  });

  it("reads a compaction as ONE marker without its recap, unless the recap is asked for", () => {
    const summary = entry({
      role: "summary",
      parts: [{ kind: "text", text: "the recap" }, { kind: "text", text: "more of it" }],
    });
    const bare = itemsOf(summary);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toEqual({ id: "u1:0", ts: "2026-09-30T08:00:00.000Z", kind: "compacted" });
    expect(itemsOf(summary, true)).toEqual([
      { id: "u1:0", ts: "2026-09-30T08:00:00.000Z", kind: "compacted", text: "the recap\n\nmore of it" },
    ]);
  });

  it("drops a text part that is empty or only whitespace", () => {
    expect(itemsOf(entry({ parts: [{ kind: "text", text: "   \n " }, { kind: "thinking", text: "" }] }))).toEqual([]);
  });

  it("keeps the harness's own id for a tool call and numbers everything else off the turn", () => {
    const items = itemsOf(
      entry({ parts: [{ kind: "text", text: "on it" }, toolPart({ id: "toolu_42" })] }),
    );
    expect(items.map((i) => i.id)).toEqual(["u1:0", "toolu_42"]);
  });

  it("numbers a tool part that carries no id off the turn too", () => {
    expect(itemsOf(entry({ parts: [toolPart()] }))[0]!.id).toBe("u1:0");
  });

  it("names an image in a notice rather than dropping the part", () => {
    const [item] = itemsOf(entry({ parts: [{ kind: "image", url: "/api/image/7" }] }));
    expect(item).toMatchObject({ kind: "notice", text: "Image: /api/image/7" });
  });

  it("carries a turn's timestamp onto every block, and drops an empty one", () => {
    expect(itemsOf(entry({ parts: [{ kind: "text", text: "hi" }] }))[0]!.ts).toBe("2026-09-30T08:00:00.000Z");
    expect(itemsOf(entry({ ts: "", parts: [{ kind: "text", text: "hi" }] }))[0]!.ts).toBeUndefined();
  });

  it("translates an abandoned turn like any other: the flag is the screen's to act on", () => {
    const items = itemsOf(entry({ abandoned: true, parts: [{ kind: "text", text: "rewound" }] }));
    expect(items).toHaveLength(1);
  });
});

describe("toolOf", () => {
  it("degrades an untaught adapter's call to `other`, keeping its name and summary", () => {
    expect(toolOf(toolPart({ name: "Weird", summary: "did a thing" }))).toEqual({
      kind: "other",
      name: "Weird",
      summary: "did a thing",
    });
  });

  it("folds the result text into `output` on a kind that can print one", () => {
    const call: ToolCall = { kind: "execute", command: "ls" };
    expect(toolOf(toolPart({ call, result: { text: "a\nb" } }))).toEqual({
      kind: "execute",
      command: "ls",
      output: "a\nb",
    });
  });

  it("leaves a kind that has nothing to print untouched", () => {
    const call: ToolCall = { kind: "read", path: "/tmp/a.ts" };
    expect(toolOf(toolPart({ call, result: { text: "the whole file" } }))).toEqual(call);
  });

  it("treats an empty result as no result at all", () => {
    const call: ToolCall = { kind: "search", query: "todo" };
    expect(toolOf(toolPart({ call, result: { text: "" } }))).toEqual(call);
  });
});

describe("toolStatus", () => {
  it("is running while no result has landed", () => {
    expect(toolStatus(toolPart())).toBe("running");
  });

  it("tells a refusal apart from a fault", () => {
    expect(toolStatus(toolPart({ result: { text: "", denied: true } }))).toBe("denied");
    expect(toolStatus(toolPart({ result: { text: "boom", isError: true } }))).toBe("failed");
  });

  it("reads a refusal as denied even when the harness also flagged it an error", () => {
    expect(toolStatus(toolPart({ result: { text: "no", denied: true, isError: true } }))).toBe("denied");
  });

  it("is done for an ordinary result", () => {
    expect(toolStatus(toolPart({ result: { text: "ok" } }))).toBe("done");
  });

  it("is running when the result came back but the call is ongoing (a background job, a subagent)", () => {
    const call: ToolCall = { kind: "execute", command: "sleep 9", background: true, ongoing: true };
    expect(toolStatus(toolPart({ call, result: { text: "started" } }))).toBe("running");
    const agent: ToolCall = { kind: "task", agent: "explore", summary: "look", ongoing: true };
    expect(toolStatus(toolPart({ call: agent, result: { text: "queued" } }))).toBe("running");
  });

  it("lets a refusal or a fault win over ongoing", () => {
    const call: ToolCall = { kind: "execute", command: "x", ongoing: true };
    expect(toolStatus(toolPart({ call, result: { text: "", denied: true } }))).toBe("denied");
    expect(toolStatus(toolPart({ call, result: { text: "boom", isError: true } }))).toBe("failed");
  });

  it("is done once the ongoing flag is gone", () => {
    const call: ToolCall = { kind: "execute", command: "x", background: true };
    expect(toolStatus(toolPart({ call, result: { text: "ok" } }))).toBe("done");
  });
});

describe("withToolOutput", () => {
  it("adds `output` to the five kinds that can show one", () => {
    const calls: ToolCall[] = [
      { kind: "execute", command: "ls" },
      { kind: "search", query: "todo" },
      { kind: "fetch", url: "https://example.test" },
      { kind: "task", agent: "explore", summary: "looked" },
      { kind: "other", name: "Weird", summary: "did a thing" },
    ];
    for (const call of calls) expect(withToolOutput(call, "out")).toMatchObject({ output: "out" });
  });

  it("returns the other four unchanged, a plan among them: its result is the list, which the card already draws", () => {
    const calls: ToolCall[] = [
      { kind: "plan", name: "todo", tasks: [{ title: "a", status: "done" }] },
      { kind: "edit", path: "a.ts", added: 1, removed: 0 },
      { kind: "read", path: "a.ts" },
      { kind: "delete", path: "a.ts" },
    ];
    for (const call of calls) expect(withToolOutput(call, "out")).toEqual(call);
  });
});

describe("a durable turn that is still being written, and a line with a request id (WIRE.md 7.15)", () => {
  it("carries partial onto a reply, a thinking block and a notice, and never onto the person's own line", () => {
    const text: TranscriptPart[] = [{ kind: "text", text: "Hel" }];
    expect(itemsOf(entry({ partial: true, parts: text }))[0]).toMatchObject({ kind: "reply", partial: true });
    expect(itemsOf(entry({ partial: true, parts: [{ kind: "thinking", text: "hm" }] }))[0]).toMatchObject({ kind: "thinking", partial: true });
    expect(itemsOf(entry({ role: "note", partial: true, parts: text }))[0]).toMatchObject({ kind: "notice", partial: true });
    expect(itemsOf(entry({ role: "user", partial: true, parts: text }))[0]).not.toHaveProperty("partial");
    expect(itemsOf(entry({ parts: text }))[0]).not.toHaveProperty("partial");
  });

  it("carries a request id onto the person's line only", () => {
    const text: TranscriptPart[] = [{ kind: "text", text: "go" }];
    expect(itemsOf(entry({ role: "user", requestId: "req-1", parts: text }))[0]).toMatchObject({ kind: "user", requestId: "req-1" });
    expect(itemsOf(entry({ role: "assistant", requestId: "req-1", parts: text }))[0]).not.toHaveProperty("requestId");
    expect(itemsOf(entry({ role: "user", parts: text }))[0]).not.toHaveProperty("requestId");
  });

  it("finished drops partial and nothing else", () => {
    const [grown] = itemsOf(entry({ partial: true, parts: [{ kind: "text", text: "Half" }] }));
    expect(grown).toMatchObject({ partial: true });
    const done = finished(grown!);
    expect(done).toMatchObject({ kind: "reply", text: "Half", id: grown!.id });
    expect(done).not.toHaveProperty("partial");
    const [tool] = itemsOf(entry({ parts: [toolPart({ id: "t1" })] }));
    expect(finished(tool!)).toBe(tool);
  });
});

describe("itemsOf and a walky talky envelope (M62)", () => {
  const envelope = (text: string, role: "user" | "assistant" = "user") => ({
    uuid: "u9",
    ts: "2026-10-17T09:30:00Z",
    role,
    parts: [{ kind: "text" as const, text }],
  });

  it("tags a user turn whose first line is a header, with what the header claims", () => {
    const [item] = itemsOf(envelope("[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, x#y) reply to wt_8ab2c3d4e5f6\nbody"));
    expect(item).toMatchObject({ kind: "user", walky: { id: "wt_k3f9x2m8q1a0", kind: "agent", replyTo: "wt_8ab2c3d4e5f6" } });
  });

  it("leaves an ordinary turn, and a header quoted on a later line, untagged", () => {
    expect(itemsOf(envelope("fix the tests"))[0]).not.toHaveProperty("walky");
    expect(itemsOf(envelope("see:\n[walky-talky wt_k3f9x2m8q1a0] from agent x (y)"))[0]).not.toHaveProperty("walky");
  });

  it("tags only a user turn: an assistant that prints a header is just speaking", () => {
    expect(itemsOf(envelope("[walky-talky wt_k3f9x2m8q1a0] from agent x (y)", "assistant"))[0]).not.toHaveProperty("walky");
  });
});
