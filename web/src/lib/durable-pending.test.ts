import { afterEach, describe, expect, it } from "vitest";

import {
  __resetPending,
  addPending,
  dropNotSent,
  dropPending,
  PENDING_KEEP_MS,
  PENDING_MATCH_MS,
  pendingLines,
  setPendingState,
  unmatched,
  type PendingLine,
} from "./durable-pending";
import type { TranscriptEntry } from "./types";

// The lines a person sent that the program has not written back, and the one rule that retires them.

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

const line = (requestId: string, text: string, over: Partial<PendingLine> = {}): PendingLine => ({
  requestId,
  text,
  at: NOW,
  state: "sent",
  ...over,
});

const said = (uuid: string, text: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid,
  ts: new Date(NOW + 1000).toISOString(),
  role: "user",
  parts: [{ kind: "text", text }],
  ...over,
});

afterEach(() => __resetPending());

describe("unmatched", () => {
  it("a program line with the same request id retires the pending line, whatever its words", () => {
    const out = unmatched([line("r1", "go left")], [said("u1", "go left, please", { requestId: "r1" })], NOW);
    expect(out).toEqual({ open: [], done: ["r1"] });
  });

  it("with no request id, the same text within 30 seconds retires it", () => {
    const near = said("u1", "  go left ", { ts: new Date(NOW + PENDING_MATCH_MS).toISOString() });
    expect(unmatched([line("r1", "go left")], [near], NOW).done).toEqual(["r1"]);
    const far = said("u1", "go left", { ts: new Date(NOW + PENDING_MATCH_MS + 1).toISOString() });
    expect(unmatched([line("r1", "go left")], [far], NOW).open).toHaveLength(1);
  });

  it("another send's request id never matches by text, and other words never match", () => {
    expect(unmatched([line("r1", "go left")], [said("u1", "go left", { requestId: "r2" })], NOW).open).toHaveLength(1);
    expect(unmatched([line("r1", "go left")], [said("u1", "go right")], NOW).open).toHaveLength(1);
  });

  it("only a user turn that the person has not rewound matches", () => {
    expect(unmatched([line("r1", "x")], [said("u1", "x", { role: "assistant" })], NOW).open).toHaveLength(1);
    expect(unmatched([line("r1", "x")], [said("u1", "x", { abandoned: true })], NOW).open).toHaveLength(1);
  });

  it("one program line answers one pending line, the oldest first: two identical sends are not both hidden by one reply", () => {
    const pending = [line("r1", "ok", { at: NOW }), line("r2", "ok", { at: NOW + 500 })];
    const out = unmatched(pending, [said("u1", "ok")], NOW);
    expect(out.done).toEqual(["r1"]);
    expect(out.open.map((l) => l.requestId)).toEqual(["r2"]);
  });

  it("keeps the order of the lines it leaves open", () => {
    const out = unmatched([line("r1", "a"), line("r2", "b"), line("r3", "c")], [said("u1", "b", { requestId: "r2" })], NOW);
    expect(out.open.map((l) => l.requestId)).toEqual(["r1", "r3"]);
  });

  it("a line the program never wrote back stops being drawn after the keep time, and is named so the store forgets it", () => {
    const old = line("r1", "x", { at: NOW - PENDING_KEEP_MS - 1 });
    expect(unmatched([old], [], NOW)).toEqual({ open: [], done: ["r1"] });
    expect(unmatched([line("r1", "x", { at: NOW - PENDING_KEEP_MS })], [], NOW).open).toHaveLength(1);
  });
});

describe("the store", () => {
  it("adds in order, and the same request id again keeps its place and takes the new state", () => {
    addPending("k", line("r1", "a", { state: "sending" }));
    addPending("k", line("r2", "b", { state: "sending" }));
    addPending("k", line("r1", "a", { state: "unconfirmed" }));
    expect(pendingLines("k").map((l) => [l.requestId, l.state])).toEqual([
      ["r1", "unconfirmed"],
      ["r2", "sending"],
    ]);
  });

  it("is per pane, and gives the same array until something changes", () => {
    addPending("k", line("r1", "a"));
    const held = pendingLines("k");
    expect(pendingLines("k")).toBe(held);
    expect(pendingLines("other")).toEqual([]);
    setPendingState("k", "r1", "sent"); // already sent: no change, no new array
    expect(pendingLines("k")).toBe(held);
  });

  it("drops by request id, and drops only the lines that never left", () => {
    addPending("k", line("r1", "a", { state: "notSent" }));
    addPending("k", line("r2", "b", { state: "sent" }));
    dropNotSent("k");
    expect(pendingLines("k").map((l) => l.requestId)).toEqual(["r2"]);
    dropPending("k", ["r2"]);
    expect(pendingLines("k")).toEqual([]);
  });
});
