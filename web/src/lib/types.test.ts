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
});
