import { describe, expect, test } from "bun:test";

import { MAX_TEXT_CHARS } from "../journal/text.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import { findPinnable } from "./lookup.ts";

const entries: TranscriptEntry[] = [
  { uuid: "u1", ts: "2026-11-06T10:00:00Z", role: "user", parts: [{ kind: "text", text: "run the tests" }] },
  {
    uuid: "a1",
    ts: "2026-11-06T10:00:05Z",
    role: "assistant",
    parts: [
      { kind: "thinking", text: "I should run bun test" },
      { kind: "text", text: "   " },
      { kind: "text", text: "Running them now." },
      { kind: "tool", name: "Bash", summary: "bun test", id: "toolu_9", result: { text: "12 pass" } },
      { kind: "tool", name: "Read", summary: "a.ts" },
      { kind: "image", url: "/api/blobs/abc" },
    ],
  },
  { uuid: "n1", ts: "", role: "note", parts: [{ kind: "text", text: "background task finished" }] },
  { uuid: "s1", ts: "", role: "summary", parts: [{ kind: "text", text: "recap" }, { kind: "text", text: "more" }] },
];

describe("findPinnable", () => {
  test("names every block by the id the phone draws, and finds each one", () => {
    // The ids `itemsOf` (web/src/lib/chat-items.ts) gives these entries, written out: a tool part's own id,
    // else `<uuid>:<partIndex>`, a blank text part drawing nothing, one `<uuid>:0` for a compaction.
    // `web/src/lib/chat-items.test.ts` holds the phone's side of the same rule.
    const drawn = ["u1:0", "a1:0", "a1:2", "toolu_9", "a1:4", "a1:5", "n1:0", "s1:0"];
    const unpinnable = new Set(["a1:5", "s1:0"]);
    for (const id of drawn) {
      const found = findPinnable(entries, id);
      expect(found.ok).toBe(!unpinnable.has(id));
      if (!found.ok) expect(found.reason).toBe("not_pinnable");
    }
  });

  test("copies the user message, the reply and the thinking with their kind and time", () => {
    expect(findPinnable(entries, "u1:0")).toEqual({ ok: true, draft: { itemId: "u1:0", kind: "user", text: "run the tests", ts: "2026-11-06T10:00:00Z" } });
    expect(findPinnable(entries, "a1:2")).toEqual({ ok: true, draft: { itemId: "a1:2", kind: "reply", text: "Running them now.", ts: "2026-11-06T10:00:05Z" } });
    expect(findPinnable(entries, "a1:0")).toMatchObject({ ok: true, draft: { kind: "thinking", text: "I should run bun test" } });
    expect(findPinnable(entries, "n1:0")).toEqual({ ok: true, draft: { itemId: "n1:0", kind: "notice", text: "background task finished" } });
  });

  test("copies a tool call by its own id, with name, input summary and result text", () => {
    expect(findPinnable(entries, "toolu_9")).toEqual({
      ok: true,
      draft: { itemId: "toolu_9", kind: "tool", text: "12 pass", tool: { name: "Bash", input: "bun test" }, ts: "2026-11-06T10:00:05Z" },
    });
  });

  test("a tool call with no id is found by uuid and part index, and with no result has an empty text", () => {
    expect(findPinnable(entries, "a1:4")).toMatchObject({ ok: true, draft: { kind: "tool", text: "", tool: { name: "Read", input: "a.ts" } } });
  });

  test("an image and a compaction are not pinnable", () => {
    expect(findPinnable(entries, "a1:5")).toEqual({ ok: false, reason: "not_pinnable" });
    expect(findPinnable(entries, "s1:0")).toEqual({ ok: false, reason: "not_pinnable" });
  });

  test("an id nothing holds, a blank part, a recap part and a tool call's index form are not found", () => {
    expect(findPinnable(entries, "zz:0")).toEqual({ ok: false, reason: "not_found" });
    expect(findPinnable(entries, "a1:1")).toEqual({ ok: false, reason: "not_found" });
    expect(findPinnable(entries, "s1:1")).toEqual({ ok: false, reason: "not_found" });
    expect(findPinnable([], "u1:0")).toEqual({ ok: false, reason: "not_found" });
  });

  test("a text longer than the journal cap is cut at it", () => {
    const long: TranscriptEntry[] = [{ uuid: "l1", ts: "", role: "assistant", parts: [{ kind: "text", text: "y".repeat(MAX_TEXT_CHARS + 10) }] }];
    const found = findPinnable(long, "l1:0");
    expect(found.ok && found.draft.text.length).toBe(MAX_TEXT_CHARS);
  });
});
