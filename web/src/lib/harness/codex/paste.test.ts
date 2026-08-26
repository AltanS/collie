import { describe, expect, it } from "vitest";

import {
  CODEX_INPUT_CHUNK_BYTES,
  codexDraftCarriesSend,
  codexInputChunks,
} from "./paste";

describe("Codex input chunks", () => {
  it("round-trips text with every chunk below the byte boundary", () => {
    const sent = `${"a".repeat(899)}🙂${"界".repeat(400)}`;
    const chunks = codexInputChunks(sent);
    expect(chunks.join("")).toBe(sent);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= CODEX_INPUT_CHUNK_BYTES)).toBe(
      true,
    );
  });

  it("returns no write for empty text and does not split a short message", () => {
    expect(codexInputChunks("")).toEqual([]);
    expect(codexInputChunks("hello")).toEqual(["hello"]);
  });
});

describe("Codex large-paste evidence", () => {
  it("accepts only the exact Unicode character count", () => {
    const sent = "x".repeat(1001);
    expect(codexDraftCarriesSend(sent, "[Pasted Content 1001 chars]")).toBe(true);
    expect(codexDraftCarriesSend(sent, "[Pasted Content 1000 chars]")).toBe(false);
    expect(codexDraftCarriesSend(`${sent}🙂`, "[Pasted Content 1002 chars]")).toBe(true);
    expect(codexDraftCarriesSend("x".repeat(1000), "[Pasted Content 1000 chars]")).toBe(false);
    expect(codexDraftCarriesSend("", "[Pasted Content 0 chars]")).toBe(false);
  });

  it("accepts Codex's collision suffix but no surrounding or malformed text", () => {
    const sent = "y".repeat(1006);
    expect(codexDraftCarriesSend(sent, "[Pasted Content 1006 chars] #2")).toBe(true);
    expect(codexDraftCarriesSend(sent, "[Pasted Content 1006 chars] #10")).toBe(true);
    expect(codexDraftCarriesSend(sent, "prefix [Pasted Content 1006 chars]")).toBe(false);
    expect(codexDraftCarriesSend(sent, "[Pasted Content 01006 chars]")).toBe(false);
    expect(codexDraftCarriesSend(sent, "[Pasted Content 1006 chars] #1")).toBe(false);
  });
});
