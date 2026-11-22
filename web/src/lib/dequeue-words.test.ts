import { dequeueMove, mergedDraft } from "./dequeue-words";
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

describe("a clear that started and was not proved", () => {
  it("taken with leftover takes the words and says the draft sentence beside them", () => {
    const move = dequeueMove({ requestId: "r1", outcome: "taken", texts: ["first"], leftover: true });
    expect(move).toEqual({ kind: "take", text: "first", note: "composer.surface.draft" });
  });
  it("too_late with leftover still says it already went out", () => {
    const move = dequeueMove({ requestId: "r1", outcome: "too_late", leftover: true });
    expect(move.kind === "say" && t(move.key)).toBe("It already went out.");
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
