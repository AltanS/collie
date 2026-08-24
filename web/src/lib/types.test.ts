import { paneDisplayName } from "./types";
import type { AgentView } from "./types";

// The one place the pane display-name priority lives, so every surface (pill, card, sidebar, header)
// agrees: explicit user label > Claude's /rename session name > the agent name (or "shell").
function pane(overrides: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    kind: "agent",
    ...overrides,
  };
}

describe("paneDisplayName", () => {
  it("prefers an explicit user label over everything", () => {
    expect(paneDisplayName(pane({ paneLabel: "deploy", sessionName: "auth-refactor" }))).toBe("deploy");
  });

  it("falls back to Claude's /rename session name when there's no label", () => {
    expect(paneDisplayName(pane({ sessionName: "auth-refactor" }))).toBe("auth-refactor");
  });

  it("falls back to the agent name when neither a label nor a session name is set", () => {
    expect(paneDisplayName(pane({ agent: "codex" }))).toBe("codex");
  });

  it("shows \"shell\" for a bare shell pane with no label or session name", () => {
    expect(paneDisplayName(pane({ kind: "shell", agent: "shell" }))).toBe("shell");
  });

  it("still lets a user label win on a shell pane", () => {
    expect(paneDisplayName(pane({ kind: "shell", agent: "shell", paneLabel: "logs" }))).toBe("logs");
  });

  it("uses a live terminal title when there is no hand-set name", () => {
    expect(paneDisplayName(pane({ terminalTitle: "Fixing the parser" }))).toBe("Fixing the parser");
  });

  // A title the multiplexer kept after its program exited names nothing: it is a fact about the past,
  // and a finished agent's task standing in as a live shell's name is the bug this rule exists for.
  it("refuses a STALE terminal title and falls back as if there were no title", () => {
    const stale = { terminalTitle: "✳ waiting for soak time", terminalTitleStale: true };
    expect(paneDisplayName(pane({ kind: "shell", agent: "shell", ...stale }))).toBe("shell");
    expect(paneDisplayName(pane({ ...stale }))).toBe("claude");
    // A name somebody chose is unaffected either way.
    expect(paneDisplayName(pane({ ...stale, paneLabel: "logs" }))).toBe("logs");
  });
});
