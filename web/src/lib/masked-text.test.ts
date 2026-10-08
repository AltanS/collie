import { describe, expect, it } from "vitest";

import { entriesHoldMask, holdsMask } from "./masked-text";
import type { TranscriptEntry } from "./types";

describe("holdsMask", () => {
  it("sees a masked key with its readable prefix", () => {
    expect(holdsMask("sk-o••••••••")).toBe(true);
    expect(holdsMask("export KEY=sk-o••••••••\nnext line")).toBe(true);
  });

  it("needs a run of four", () => {
    expect(holdsMask("••••")).toBe(true);
    expect(holdsMask("•••")).toBe(false);
    // Separated bullets are a list, not a mask.
    expect(holdsMask("• one • two • three • four")).toBe(false);
  });

  it("is false for an ordinary sentence and for nothing", () => {
    expect(holdsMask("Run the tests, then push.")).toBe(false);
    expect(holdsMask("")).toBe(false);
  });

  it("gives the same answer twice, so no regex state leaks between calls", () => {
    expect(holdsMask("a••••b")).toBe(true);
    expect(holdsMask("a••••b")).toBe(true);
  });
});

function turn(parts: TranscriptEntry["parts"], extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { uuid: "u1", ts: "2026-10-08T00:00:00Z", role: "assistant", parts, ...extra };
}

describe("entriesHoldMask", () => {
  it("finds a mask in spoken text and in a tool result", () => {
    expect(entriesHoldMask([turn([{ kind: "text", text: "key is sk-o••••••••" }])])).toBe(true);
    expect(
      entriesHoldMask([
        turn([{ kind: "tool", name: "Bash", summary: "env", result: { text: "TOKEN=ghp_••••••••" } }]),
      ]),
    ).toBe(true);
  });

  it("ignores thinking, tool summaries and abandoned branches", () => {
    expect(entriesHoldMask([turn([{ kind: "thinking", text: "a••••••b" }])])).toBe(false);
    expect(entriesHoldMask([turn([{ kind: "tool", name: "Bash", summary: "a••••••b" }])])).toBe(false);
    expect(entriesHoldMask([turn([{ kind: "text", text: "a••••••b" }], { abandoned: true })])).toBe(false);
  });

  it("is false for no turns", () => {
    expect(entriesHoldMask([])).toBe(false);
  });
});
