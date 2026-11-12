import { describe, expect, test } from "bun:test";

import { markHasConversation, viewPaneMark, type MarkablePane } from "./mark.ts";

// The pane mark an agent view's rules proof and screen are held against: the harness and the conversation the snapshot
// holds for the pane a session names, and null when the pane is not live here.

const ONE = "local/w1:p1#aaaa";

function marker(views: MarkablePane[], placed: string | null = ONE) {
  return viewPaneMark({ place: () => (placed === null ? null : { address: placed }), views: () => views, memberId: "lead" });
}

describe("the pane mark", () => {
  test("is the harness and the conversation it reported; another conversation or harness is another mark", () => {
    const claude = marker([{ paneId: "w1:p1", agent: "claude", agentSession: { kind: "id", value: "conv-1" } }])(ONE);
    expect(claude).not.toBeNull();
    expect(marker([{ paneId: "w1:p1", agent: "claude", agentSession: { kind: "id", value: "conv-2" } }])(ONE)).not.toBe(claude);
    expect(marker([{ paneId: "w1:p1", agent: "codex", agentSession: { kind: "id", value: "conv-1" } }])(ONE)).not.toBe(claude);
  });

  test("a harness that reports no conversation is marked by its harness alone", () => {
    const one = marker([{ paneId: "w1:p1", agent: "agent-x" }])(ONE);
    expect(one).toBe(marker([{ paneId: "w1:p1", agent: "agent-x" }])(ONE));
    expect(one).not.toBe(marker([{ paneId: "w1:p1", agent: "agent-y" }])(ONE));
    expect(marker([{ paneId: "w1:p1", agent: "shell", kind: "shell" }])(ONE)).not.toBe(one);
  });

  test("null for a pane not placed, on another member, held by no view or by two, or a trick session", () => {
    const view: MarkablePane = { paneId: "w1:p1", agent: "claude" };
    expect(marker([view], null)(ONE)).toBeNull();
    expect(marker([view], "other/w1:p1#aaaa")(ONE)).toBeNull();
    expect(marker([view], "lead/w1:p1#aaaa")(ONE)).not.toBeNull();
    expect(marker([])(ONE)).toBeNull();
    expect(marker([view, view])(ONE)).toBeNull();
    expect(marker([{ paneId: "w1:p1", agent: "trick", kind: "trick" }])(ONE)).toBeNull();
  });

  test("a mark names a conversation only when the harness reported one", () => {
    expect(markHasConversation(marker([{ paneId: "w1:p1", agent: "claude", agentSession: { kind: "id", value: "conv-1" } }])(ONE) ?? "")).toBe(true);
    expect(markHasConversation(marker([{ paneId: "w1:p1", agent: "agent-x" }])(ONE) ?? "")).toBe(false);
  });
});
