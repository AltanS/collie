import { describe, expect, it } from "vitest";

import { MAX_RUN_CHARS, reusableShell, runnableLine } from "./run-line";
import type { AgentView } from "./types";

describe("runnableLine", () => {
  it("offers a one-line shell block, tagged or bare", () => {
    expect(runnableLine("bash", "sudo systemctl restart docker\n")).toBe("sudo systemctl restart docker");
    expect(runnableLine("", "git status")).toBe("git status");
    expect(runnableLine("Shell", "ls -la")).toBe("ls -la");
  });

  it("drops the prompt in front of a console line, and Claude Code's shell-mode lead", () => {
    expect(runnableLine("console", "$ npm test")).toBe("npm test");
    expect(runnableLine("bash", "! sudo journalctl -u docker -n 20")).toBe("sudo journalctl -u docker -n 20");
    expect(runnableLine("bash", "!")).toBeNull();
  });

  it("offers nothing for another language, several lines, or a line over the limit", () => {
    expect(runnableLine("ts", "const a = 1")).toBeNull();
    expect(runnableLine("bash", "cd app\nnpm test")).toBeNull();
    expect(runnableLine("bash", "x".repeat(MAX_RUN_CHARS + 1))).toBeNull();
    expect(runnableLine("bash", "   ")).toBeNull();
    expect(runnableLine("console", "$ ")).toBeNull();
  });
});

describe("reusableShell", () => {
  const pane = (paneId: string, extra: Partial<AgentView> = {}): AgentView => ({
    paneId,
    workspaceId: "w7",
    workspaceLabel: "app",
    workspaceNumber: 1,
    tabId: `t-${paneId}`,
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/app",
    focused: false,
    kind: "shell",
    ...extra,
  });
  const claude = pane("w7:p1", { agent: "claude", kind: "agent", status: "idle" });

  it("picks the most recently used shell in the same space and folder", () => {
    const older = pane("w7:p2", { lastActiveAt: 1, lastSeenAt: 2 });
    const newer = pane("w7:p3", { lastActiveAt: 5 });
    expect(reusableShell(claude, [older, newer])?.paneId).toBe("w7:p3");
  });

  it("leaves a shell in another folder, space or machine alone", () => {
    expect(reusableShell(claude, [pane("w7:p2", { cwd: "/home/you" })])).toBeUndefined();
    expect(reusableShell(claude, [pane("w8:p2", { workspaceId: "w8" })])).toBeUndefined();
    expect(reusableShell(claude, [pane("w7:p2", { host: "laptop" })])).toBeUndefined();
  });
});
