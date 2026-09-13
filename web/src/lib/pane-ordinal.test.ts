import { paneOrdinals } from "./pane-ordinal";
import type { AgentView } from "@/lib/types";

const pane = (paneId: string, over: Partial<AgentView> = {}): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
  kind: "agent",
  ...over,
});

describe("which pill needs a number", () => {
  it("gives none when every pill already reads differently", () => {
    const out = paneOrdinals([pane("w1:p1"), pane("w1:p3", { agent: "codex" })]);
    expect(out.size).toBe(0);
  });

  it("numbers the twins by their place in the row, and leaves the rest alone", () => {
    const out = paneOrdinals([
      pane("w1:p1"),
      pane("w1:p4", { agent: "codex" }),
      pane("w1:p9"),
    ]);
    // The POSITION in the row, which is what the reader is looking at — not a count of the twins and
    // not the pane id's own suffix.
    expect(out.get("w1:p1")).toBe(1);
    expect(out.get("w1:p9")).toBe(3);
    expect(out.has("w1:p4")).toBe(false);
  });

  it("compares the name the pill actually shows, not the agent behind it", () => {
    // Two claudes, one of them renamed: nothing reads the same, so nothing is numbered. And two
    // panes that happen to carry the SAME hand-set label are twins even though their agents differ.
    expect(paneOrdinals([pane("w1:p1"), pane("w1:p2", { paneLabel: "logs" })]).size).toBe(0);
    const same = paneOrdinals([
      pane("w1:p1", { paneLabel: "logs" }),
      pane("w1:p2", { agent: "codex", paneLabel: "logs" }),
    ]);
    expect([...same.values()]).toEqual([1, 2]);
  });

  it("numbers three of a kind, and a row that is all one name", () => {
    const out = paneOrdinals([pane("w1:p1"), pane("w1:p2"), pane("w1:p3")]);
    expect([...out.values()]).toEqual([1, 2, 3]);
  });
});
