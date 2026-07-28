import { describe, expect, it } from "vitest";

import { paneSearchText, paneTitle } from "./pane-name";
import type { AgentView } from "./types";

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w0:p1",
    workspaceId: "w0",
    workspaceLabel: "moonward_os",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/kon/dev/moonward",
    focused: false,
    ...over,
  };
}

describe("paneTitle — primary line", () => {
  it("is project · tab when the tab has a label", () => {
    expect(paneTitle(pane({ tabLabel: "fix-auth" })).primary).toBe("moonward_os · fix-auth");
  });

  it("falls back to the project alone when the bridge dropped the tab label", () => {
    // An unlabelled tab in a single-tab space arrives with tabLabel absent (meaningfulTabLabel),
    // so the row must not render a dangling separator.
    expect(paneTitle(pane()).primary).toBe("moonward_os");
  });

  it("never says 'claude'", () => {
    expect(paneTitle(pane({ tabLabel: "fix-auth" })).primary).not.toContain("claude");
    expect(paneTitle(pane()).primary).not.toContain("claude");
  });

  it("falls back to the workspace id if a space somehow has no label", () => {
    expect(paneTitle(pane({ workspaceLabel: "" })).primary).toBe("w0");
  });
});

describe("paneTitle — secondary line", () => {
  it("prefers a user-set pane label", () => {
    const t = paneTitle(pane({ paneLabel: "hand-named", sessionName: "auto-named" }));
    expect(t.secondary).toBe("hand-named");
  });

  it("falls back to Claude's own /rename session name", () => {
    expect(paneTitle(pane({ sessionName: "oauth-refactor" })).secondary).toBe("oauth-refactor");
  });

  it("falls back to a shortened cwd", () => {
    expect(paneTitle(pane()).secondary).toBe("~/dev/moonward");
  });

  it("is null when there is nothing to say", () => {
    expect(paneTitle(pane({ cwd: "" })).secondary).toBeNull();
  });

  it("keeps the pane's own name even when the tab is labelled — nothing is lost", () => {
    const t = paneTitle(pane({ tabLabel: "fix-auth", sessionName: "oauth-refactor" }));
    expect(t.primary).toBe("moonward_os · fix-auth");
    expect(t.secondary).toBe("oauth-refactor");
  });
});

describe("paneTitle — shell panes", () => {
  it("names a shell by its place, not by the word 'shell'", () => {
    const t = paneTitle(pane({ kind: "shell", agent: "shell", tabLabel: "scratch" }));
    expect(t.primary).toBe("moonward_os · scratch");
  });
});

describe("paneSearchText", () => {
  it("lets you find a pane by project, tab, session name or agent", () => {
    const text = paneSearchText(pane({ tabLabel: "fix-auth", sessionName: "oauth-refactor" }));
    expect(text).toContain("moonward_os");
    expect(text).toContain("fix-auth");
    expect(text).toContain("oauth-refactor");
    expect(text).toContain("claude");
  });

  it("skips the missing parts without leaving double spaces", () => {
    expect(paneSearchText(pane({ cwd: "" }))).toBe("moonward_os claude");
  });
});

describe("paneTitle — the cwd fallback only when it says something", () => {
  it("drops the cwd when the directory is just the project again", () => {
    // The space is named after its directory on almost every row, so the fallback was printing
    // line 1 twice.
    expect(paneTitle(pane({ workspaceLabel: "collie", cwd: "/home/kon/dev/ai/collie" })).secondary)
      .toBeNull();
  });

  it("is case-insensitive about that match", () => {
    expect(paneTitle(pane({ workspaceLabel: "Collie", cwd: "/home/kon/dev/ai/collie" })).secondary)
      .toBeNull();
  });

  it("KEEPS the cwd when the pane sits somewhere else — a worktree or a subdir", () => {
    expect(paneTitle(pane({ workspaceLabel: "collie", cwd: "/home/kon/dev/ai/collie/web" })).secondary)
      .toBe("~/dev/ai/collie/web");
  });

  it("still prefers the pane's own name over either", () => {
    const t = paneTitle(pane({ workspaceLabel: "collie", cwd: "/home/kon/dev/ai/collie", sessionName: "oauth" }));
    expect(t.secondary).toBe("oauth");
  });
});
