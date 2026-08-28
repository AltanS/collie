import { describe, expect, it } from "vitest";

import { codexDraftCarriesSend } from "./paste";

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
