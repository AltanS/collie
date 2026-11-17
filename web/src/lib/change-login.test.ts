import { describe, expect, it } from "vitest";

import type { AgentView, ServerSummary } from "@/lib/types";
import { defaultRow, HARNESS_CLAUDE, HARNESS_CODEX, workRow } from "@/test/accounts-fixtures";
import { cameFromSession, flowOf, forgetFlow, hasOtherProfiles, loginChanged, offersChangeLogin, reachOf, reachedSessions, rememberFlow, resultOf } from "./change-login";

// Change login's pure rules (M101): who reads signed in, what the sessions that run do, and the result.

const ME = { signedIn: true, email: "me@example.com", plan: "max" };
const OTHER = { signedIn: true, email: "other@example.com", plan: "pro" };

describe("offersChangeLogin", () => {
  it("only an account that reads signed in", () => {
    expect(offersChangeLogin(workRow({ identity: ME }))).toBe(true);
    expect(offersChangeLogin(workRow({ identity: { signedIn: false } }))).toBe(false);
    expect(offersChangeLogin(workRow())).toBe(false);
  });
});

describe("reachOf", () => {
  it("running sessions follow only where the adapter says so; the count is the bridge's", () => {
    const claude = { ...HARNESS_CLAUDE, reachesRunningSessions: true as const };
    expect(reachOf(claude, workRow({ running: 2 }))).toEqual({ kind: "running", count: 2 });
    expect(reachOf(claude, workRow())).toEqual({ kind: "running", count: 0 });
    expect(reachOf(HARNESS_CODEX, workRow({ running: 2 }))).toEqual({ kind: "newOnly" });
    expect(reachOf(undefined, workRow({ running: 2 }))).toEqual({ kind: "newOnly" });
  });
});

describe("hasOtherProfiles", () => {
  it("Default alone or an added profile alone has none; two of one agent have, and another agent's does not count", () => {
    expect(hasOtherProfiles([defaultRow()], defaultRow())).toBe(false);
    expect(hasOtherProfiles([defaultRow(), workRow()], workRow())).toBe(true);
    expect(hasOtherProfiles([defaultRow(), workRow()], defaultRow())).toBe(true);
    const codex = defaultRow({ id: "codex:default", harness: "codex" });
    expect(hasOtherProfiles([defaultRow(), codex], defaultRow())).toBe(false);
  });
});

describe("reachedSessions", () => {
  const pane = (paneId: string, over: Partial<AgentView> = {}): AgentView => ({
    paneId,
    workspaceId: "w1",
    workspaceLabel: "lodge",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "working",
    cwd: "/home/dev/lodge",
    focused: false,
    ...over,
  });

  it("names each pane by the app's one name rule and its space, in the row's order, and skips an unknown id", () => {
    const agents = [pane("w1:p1", { sessionName: "Fix the build" }), pane("w2:p1", { workspaceId: "w2", workspaceLabel: "workshop", agentTitle: "Docs" })];
    const row = workRow({ panes: ["w2:p1", "w9:p9", "w1:p1"] });
    expect(reachedSessions(row, { agents })).toEqual([
      { paneId: "w2:p1", name: "Docs", space: "workshop" },
      { paneId: "w1:p1", name: "Fix the build", space: "lodge" },
    ]);
  });

  it("is empty for a row with no panes, and never reads a pane of another machine", () => {
    expect(reachedSessions(workRow(), { agents: [pane("w1:p1")] })).toEqual([]);
    const servers: ServerSummary[] = [
      { id: "lead", name: "lead", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
      { id: "member", name: "member", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
    ];
    const agents = [pane("w1:p1", { host: "member", sessionName: "Theirs" })];
    expect(reachedSessions(workRow({ panes: ["w1:p1"] }), { agents, servers })).toEqual([]);
  });
});

describe("resultOf", () => {
  it("a new email is a changed login, with its plan", () => {
    expect(resultOf(ME, OTHER)).toEqual({ kind: "changed", email: "other@example.com", plan: "pro" });
    expect(resultOf(undefined, OTHER)).toEqual({ kind: "changed", email: "other@example.com", plan: "pro" });
    expect(resultOf({ signedIn: false }, { signedIn: true, email: "other@example.com" })).toEqual({ kind: "changed", email: "other@example.com" });
  });

  it("the same email, in any case, is 'still signed in'", () => {
    expect(resultOf(ME, ME)).toEqual({ kind: "same", email: "me@example.com", plan: "max" });
    expect(resultOf(ME, { ...ME, email: "ME@example.com" })).toMatchObject({ kind: "same" });
  });

  it("signed out after, and an answer with no email or none at all, say so", () => {
    expect(resultOf(ME, { signedIn: false })).toEqual({ kind: "signedOut" });
    expect(resultOf(ME, { signedIn: true })).toEqual({ kind: "unknown" });
    expect(resultOf(ME, undefined)).toEqual({ kind: "unknown" });
  });
});

describe("loginChanged", () => {
  it("only a known email before and a different one now end the flow on their own", () => {
    expect(loginChanged(ME, OTHER)).toBe(true);
    expect(loginChanged(ME, ME)).toBe(false);
    expect(loginChanged(ME, undefined)).toBe(false);
    expect(loginChanged(undefined, OTHER)).toBe(false);
    expect(loginChanged({ signedIn: false }, OTHER)).toBe(false);
  });
});

describe("the flow in memory", () => {
  it("one per account, replaced by a second, gone when forgotten", () => {
    rememberFlow({ account: "acc-work", paneId: "w1:p1", from: null });
    rememberFlow({ account: "acc-work", paneId: "w1:p2", from: null });
    expect(flowOf("acc-work")?.paneId).toBe("w1:p2");
    forgetFlow("acc-work");
    expect(flowOf("acc-work")).toBeUndefined();
  });

  it("knows a session it came from", () => {
    expect(cameFromSession("/pane/w1%3Ap3")).toBe(true);
    expect(cameFromSession("/pane/w1%3Ap3?h=workshop")).toBe(true);
    expect(cameFromSession("/pane/w1%3Ap3/history")).toBe(false);
    expect(cameFromSession("/settings/accounts/acc-work")).toBe(false);
    expect(cameFromSession(null)).toBe(false);
  });
});
