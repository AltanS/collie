// Over captures. These two files used to put a screen through the phone's own guarded send, which
// fetched, so they live in the `dom` project (see `vitest.config.ts`). That send is gone since M56
// spec 06 (the bridge runs the Send Protocol), and so are the cases that drove it; what remains reads
// the captures through the omp adapter for display and its paste chunking.
//
// The omp adapter's paste chunking is pure, and stays pinned here beside its captures' sibling.

import { describe, expect, it } from "vitest";
import { ompOpaqueDraft, ompReplyChunks } from "../harness/omp/reply-chunks";

const text = Array.from({ length: 30 }, (_, i) => `한글 테스트 ${i} 👨‍💻`).join("\n");

describe("OMP literal paste transport", () => {
  it.each([text, "한글".repeat(900), "a".repeat(511) + "👨‍💻끝", "a\r\nb\n".repeat(80)])("preserves exact text and graphemes within paste limits", (value) => {
    const chunks = ompReplyChunks(value);
    expect(chunks.join("")).toBe(value);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(512);
      expect(chunk.split("\n").length).toBeLessThanOrEqual(5);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
  it("leaves short sends alone and keeps opaque chips out of Take over", () => {
    expect(ompReplyChunks("한글")).toEqual(["한글"]);
    expect(ompOpaqueDraft("📄 #2")).toBe(true);
    expect(ompOpaqueDraft("[Paste #2, +30 lines]")).toBe(true);
    expect(ompOpaqueDraft("normal text")).toBe(false);
  });
  it("does not create a path-prefix paste that OMP would space-separate", () => {
    const value = "a".repeat(512) + "/path/to/file";
    const chunks = ompReplyChunks(value);
    expect(chunks.join("")).toBe(value);
    expect(chunks.slice(1).every((chunk) => !/^[/~.]/.test(chunk))).toBe(true);
  });
});
