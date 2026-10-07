// The journal mask is structural: every string of a tool part, its structured call included, is
// masked by shape unless its key is `kind`, `id` or `mimeType` (UNMASKED_KEYS in text.ts). One case per content field of every call
// kind, so a field that slips out of the walk is a red test, not a key on a phone. Placeholders only.
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "./tool-call.ts";
import { redactEntry } from "./text.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

const key = `sk-test-placeholder-${"0".repeat(40)}`;
const masked = `sk-t${"•".repeat(key.length - 4)}`;
const has = (s: string) => `x ${s} y`;

function toolPart(call: ToolCall): TranscriptPart {
  return { kind: "tool", name: "Tool", id: "call-1", summary: "s", call };
}

function maskedCall(call: ToolCall): ToolCall {
  const entry: TranscriptEntry = { uuid: "u-1", ts: "2026-10-08T00:00:00Z", role: "assistant", parts: [toolPart(call)] };
  const part = redactEntry(entry).parts[0];
  if (part?.kind !== "tool" || part.call === undefined) throw new Error("tool part lost its call");
  return part.call;
}

describe("redactEntry — every content field of every call kind is masked", () => {
  const cases: [string, ToolCall, (c: ToolCall) => string | false | undefined][] = [
    ["edit diff line", { kind: "edit", path: "a.ts", added: 1, removed: 0, diff: [{ header: "@@ -0,0 +1 @@", lines: [has(key)] }] }, (c) => c.kind === "edit" && c.diff?.[0]?.lines[0]],
    ["edit diff header", { kind: "edit", path: "a.ts", added: 1, removed: 0, diff: [{ header: has(key), lines: [] }] }, (c) => c.kind === "edit" && c.diff?.[0]?.header],
    ["execute command", { kind: "execute", command: has(key) }, (c) => c.kind === "execute" && c.command],
    ["execute description", { kind: "execute", command: "ls", description: has(key) }, (c) => c.kind === "execute" && c.description],
    ["search query", { kind: "search", query: has(key) }, (c) => c.kind === "search" && c.query],
    ["fetch url", { kind: "fetch", url: `https://example.test/?token=${key}` }, (c) => c.kind === "fetch" && c.url],
    ["task agent", { kind: "task", agent: has(key), summary: "s" }, (c) => c.kind === "task" && c.agent],
    ["task summary", { kind: "task", agent: "general", summary: has(key) }, (c) => c.kind === "task" && c.summary],
    ["other name", { kind: "other", name: has(key), summary: "s" }, (c) => c.kind === "other" && c.name],
    ["other summary", { kind: "other", name: "t", summary: has(key) }, (c) => c.kind === "other" && c.summary],
  ];
  for (const [field, call, pick] of cases) {
    test(field, () => {
      const out = maskedCall(call);
      expect(JSON.stringify(out)).not.toContain(key);
      expect(String(pick(out))).toContain(masked.slice(0, 8));
    });
  }

  const question: ToolCall = {
    kind: "question",
    name: "AskUserQuestion",
    summary: has(key),
    questions: [
      {
        header: has(key),
        question: has(key),
        multiple: false,
        options: [{ label: has(key), description: has(key) }, { label: "plain" }],
      },
    ],
    answers: [[has(key)]],
  };

  test("question: summary, header, question, option label and description, and the answers", () => {
    const out = maskedCall(question);
    if (out.kind !== "question") throw new Error("kind changed");
    const q = out.questions[0];
    expect(out.summary).toBe(has(masked));
    expect(q?.header).toBe(has(masked));
    expect(q?.question).toBe(has(masked));
    expect(q?.options[0]).toEqual({ label: has(masked), description: has(masked) });
    expect(q?.options[1]).toEqual({ label: "plain" });
    expect(out.answers).toEqual([[has(masked)]]);
    expect(q?.multiple).toBe(false);
    expect(JSON.stringify(out)).not.toContain(key);
  });

  test("the tool part's own name, summary and result text are masked; its id and a blob URL are not", () => {
    const blob = `/api/blobs/${"ab".repeat(32)}`;
    const entry: TranscriptEntry = {
      uuid: "u-1",
      ts: "t",
      role: "assistant",
      parts: [{ kind: "tool", name: has(key), id: "call-1", summary: has(key), result: { text: has(key), isError: true, imageUrl: blob } }],
    };
    expect(redactEntry(entry).parts[0]).toEqual({
      kind: "tool",
      name: has(masked),
      id: "call-1",
      summary: has(masked),
      result: { text: has(masked), isError: true, imageUrl: blob },
    });
  });

  test("a canary in path, to, where and imageUrl is masked; the same fields without one are unchanged", () => {
    const path = `/home/u/${key}.txt`;
    const read = maskedCall({ kind: "read", path, range: [1, 5] });
    expect(read).toEqual({ kind: "read", path: `/home/u/${masked}.txt`, range: [1, 5] });
    const move = maskedCall({ kind: "move", path, to: path });
    expect(move).toEqual({ kind: "move", path: `/home/u/${masked}.txt`, to: `/home/u/${masked}.txt` });
    const search = maskedCall({ kind: "search", query: "q", where: path, hits: 3 });
    expect(search).toEqual({ kind: "search", query: "q", where: `/home/u/${masked}.txt`, hits: 3 });
    const edit = maskedCall({ kind: "edit", path, added: 2, removed: 1, created: true });
    expect(JSON.stringify(edit)).not.toContain(key);
    // An image URL that is neither of the two shapes the bridge makes is masked by shape too.
    const entry: TranscriptEntry = {
      uuid: "u-1",
      ts: "t",
      role: "assistant",
      parts: [{ kind: "tool", name: "Shot", id: "c", summary: "s", result: { text: "", imageUrl: `https://example.test/x.png?k=${key}` } }],
    };
    expect(JSON.stringify(redactEntry(entry))).not.toContain(key);
    // An ordinary path, a move's destination and a glob are unchanged: the mask replaces shapes only.
    expect(maskedCall({ kind: "read", path: "/home/u/src/app.ts" })).toEqual({ kind: "read", path: "/home/u/src/app.ts" });
    expect(maskedCall({ kind: "move", path: "a.ts", to: "b/a.ts" })).toEqual({ kind: "move", path: "a.ts", to: "b/a.ts" });
    expect(maskedCall({ kind: "search", query: "q", where: "src/**/*.ts" })).toEqual({ kind: "search", query: "q", where: "src/**/*.ts" });
    expect(maskedCall({ kind: "delete", path: "old.txt" })).toEqual({ kind: "delete", path: "old.txt" });
    expect(maskedCall({ kind: "execute", command: "ls", exitCode: 1 })).toEqual({ kind: "execute", command: "ls", exitCode: 1 });
  });

  test("kind, id and mimeType are never masked, even holding a key's shape", () => {
    const entry: TranscriptEntry = {
      uuid: "u-1",
      ts: "t",
      role: "assistant",
      parts: [{ kind: "tool", name: "t", id: key, summary: "s" }],
    };
    const part = redactEntry(entry).parts[0];
    expect(part?.kind === "tool" && part.id).toBe(key);
  });

  test("a blob URL and an inline base64 image are left whole, even when base64 happens to spell a key shape", () => {
    // `AIza` and 35 key characters can occur by chance inside megabytes of base64: masking it would
    // break the picture and protect nothing.
    const chance = `iVBORw0KGgo+AIza${"Q".repeat(40)}+AAAA==`;
    const data = `data:image/png;base64,${chance}`;
    const blob = `/api/blobs/${"0f".repeat(32)}`;
    const entry: TranscriptEntry = {
      uuid: "u",
      ts: "t",
      role: "assistant",
      parts: [
        { kind: "image", url: data, mimeType: "image/png" },
        { kind: "image", url: blob },
        { kind: "tool", name: "t", id: "c", summary: "s", result: { text: "", imageUrl: data } },
      ],
    };
    expect(redactEntry(entry).parts).toEqual(entry.parts);
    // The same characters outside an image address are a key shape and are masked.
    expect(JSON.stringify(redactEntry({ ...entry, parts: [{ kind: "text", text: chance }] }))).not.toContain(`AIza${"Q".repeat(40)}`);
  });

  test("every string of every call kind, nested in arrays and objects, loses its canary", () => {
    // One instance of every call kind with the canary in EVERY string field, path fields included.
    const k = has(key);
    const calls: ToolCall[] = [
      { kind: "edit", path: k, added: 1, removed: 1, created: false, diff: [{ header: k, lines: [k, k] }, { header: "@@", lines: [k] }] },
      { kind: "execute", command: k, description: k, exitCode: 0 },
      { kind: "read", path: k, range: [1, 2] },
      { kind: "search", query: k, where: k, hits: 1 },
      { kind: "fetch", url: k },
      { kind: "delete", path: k },
      { kind: "move", path: k, to: k },
      { kind: "task", agent: k, summary: k },
      {
        kind: "question",
        name: k,
        summary: k,
        questions: [
          { header: k, question: k, multiple: true, options: [{ label: k, description: k }, { label: k }] },
          { question: k, multiple: false, options: [{ label: k }] },
        ],
        answers: [[k, k], [k]],
      },
      { kind: "other", name: k, summary: k },
    ];
    // The union must be total: a new kind fails here until it has a row above.
    const kinds = new Set(calls.map((c) => c.kind));
    expect([...kinds].toSorted()).toEqual(["delete", "edit", "execute", "fetch", "move", "other", "question", "read", "search", "task"]);
    for (const call of calls) {
      const entry: TranscriptEntry = {
        uuid: "u",
        ts: "t",
        role: "assistant",
        parts: [{ kind: "tool", name: k, id: "c", summary: k, call, result: { text: k, imageUrl: `/x?${key}` } }],
      };
      const out = JSON.stringify(redactEntry(entry));
      expect({ kind: call.kind, leaked: out.includes(key) }).toEqual({ kind: call.kind, leaked: false });
    }
  });

  test("text, thinking and image parts; the entry's own fields are never walked", () => {
    const entry: TranscriptEntry = {
      uuid: key,
      ts: "t",
      role: "user",
      parts: [
        { kind: "text", text: has(key), truncated: true },
        { kind: "thinking", text: has(key) },
        { kind: "image", url: `/api/blobs/${key}`, mimeType: "image/png" },
      ],
    };
    const out = redactEntry(entry);
    expect(out.uuid).toBe(key);
    // A URL that is not a 64-hex blob address is masked by shape like any other string.
    expect(out.parts).toEqual([
      { kind: "text", text: has(masked), truncated: true },
      { kind: "thinking", text: has(masked) },
      { kind: "image", url: `/api/blobs/${masked}`, mimeType: "image/png" },
    ]);
  });
});
