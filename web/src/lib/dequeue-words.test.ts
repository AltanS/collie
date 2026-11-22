import { dequeueMove, keepsDequeueId, mergedDraft } from "./dequeue-words";
import { DEQUEUE_REASONS } from "./surface/dequeue";
import { t } from "./i18n";

// What the phone does with each take-back receipt (ADR 0122, the 2026-11-22 addendum): the merge rule, the
// status line of each end, and when a second tap must replay the same request id.

describe("dequeueMove", () => {
  it("taken: the texts join in queue order with one newline", () => {
    expect(dequeueMove({ requestId: "r1", outcome: "taken", texts: ["first", "second"] })).toEqual({ kind: "take", text: "first\nsecond" });
  });

  it("in_box says nothing: the Back in the box card is the answer", () => {
    expect(dequeueMove({ requestId: "r1", outcome: "in_box" })).toEqual({ kind: "quiet" });
  });

  it("too_late says it already went out, unknown says to read the chat", () => {
    const tooLate = dequeueMove({ requestId: "r1", outcome: "too_late" });
    const unknown = dequeueMove({ requestId: "r1", outcome: "unknown" });
    expect(tooLate.kind === "say" && t(tooLate.key)).toBe("It already went out.");
    expect(unknown.kind === "say" && t(unknown.key)).toBe("The text may have reached the agent. Read the chat.");
  });

  it.each(DEQUEUE_REASONS)("a refusal for %s says one existing sentence", (reason) => {
    const move = dequeueMove({ requestId: "r1", outcome: "refused", reason });
    expect(move.kind).toBe("say");
    expect(move.kind === "say" && t(move.key).length).toBeGreaterThan(0);
  });
});

describe("keepsDequeueId", () => {
  it("keeps the id only while no answer could tell", () => {
    expect(keepsDequeueId(null)).toBe(true);
    expect(keepsDequeueId({ requestId: "r1", outcome: "unknown" })).toBe(true);
    for (const outcome of ["taken", "in_box", "too_late", "refused"] as const) expect(keepsDequeueId({ requestId: "r1", outcome })).toBe(false);
  });
});

describe("mergedDraft", () => {
  it("puts the taken text first, then one newline, then the draft", () => {
    expect(mergedDraft("taken", "my draft")).toBe("taken\nmy draft");
  });
  it("takes the text alone into an empty or blank box", () => {
    expect(mergedDraft("taken", "")).toBe("taken");
    expect(mergedDraft("taken", "  \n")).toBe("taken");
  });
});
