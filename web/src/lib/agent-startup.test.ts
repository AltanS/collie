import { firstScreenRead, readAgentLaunch, startupHarness } from "./agent-startup";
import { paneScopeKey } from "./scope";
import { UNREAD_SURFACE } from "./send-slot";
import type { Surface } from "./surface/surface";

const FREE: Surface = { revision: 3, turn: "idle", modal: "none", composer: "empty" };
const ASK: Surface = { revision: 0, turn: "unknown", composer: "unknown", modal: { ask: { id: "trust", kind: "permission", channel: "keys", hash: "abc", options: [{ id: "1", label: "Continue" }] } } };

describe("the first screen the bridge read", () => {
  it("is a dialog or an input box of the launched harness, at any revision", () => {
    expect(firstScreenRead("kiro", "kiro", ASK)).toBe(true);
    expect(firstScreenRead("kiro", "kiro", FREE)).toBe(true);
    expect(firstScreenRead("kiro", "kiro", { ...FREE, composer: "draft" })).toBe(true);
    expect(firstScreenRead("kiro", "kiro", { revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" })).toBe(true);
  });
  it("is never a shell row, another agent, or a pane with no read", () => {
    expect(firstScreenRead("kiro", "shell", FREE)).toBe(false);
    expect(firstScreenRead("kiro", undefined, FREE)).toBe(false);
    expect(firstScreenRead("kiro", "claude", ASK)).toBe(false);
    expect(firstScreenRead("kiro", "kiro", undefined)).toBe(false);
    expect(firstScreenRead("kiro", "kiro", UNREAD_SURFACE)).toBe(false);
  });
  it("is never a stale, torn or contested read, or a box proven not to take keys", () => {
    for (const reason of ["stale", "torn", "contested", "no-match"] as const) {
      expect(firstScreenRead("kiro", "kiro", { ...ASK, reason })).toBe(false);
    }
    expect(firstScreenRead("kiro", "kiro", { ...FREE, staleFrame: true })).toBe(false);
    expect(firstScreenRead("kiro", "kiro", { ...FREE, composer: "unreachable" })).toBe(false);
  });
});

describe("scoped launch navigation", () => {
  it("marks only by-id agents and harness-metadata rows, not inferred commands or starters", () => {
    expect(startupHarness({ kind: "harness", id: "kiro" })).toBe("kiro");
    expect(startupHarness({ kind: "row", command: "kiro --foo" }, "kiro")).toBe("kiro");
    expect(startupHarness({ kind: "row", command: "kiro" })).toBeUndefined();
    expect(startupHarness({ kind: "run", line: "kiro" }, "kiro")).toBeUndefined();
    expect(startupHarness({ kind: "shell" }, "kiro")).toBeUndefined();
    expect(startupHarness({ kind: "starter", id: "kiro" }, "kiro")).toBeUndefined();
  });
  it("rejects the same pane id in another host or session and malformed history", () => {
    const scope = { host: "peer", session: "other" };
    const agentLaunch = { id: "intent", paneKey: paneScopeKey(scope, "w1:p1"), harness: "kiro" };
    expect(readAgentLaunch({ agentLaunch }, "w1:p1", scope)).toEqual(agentLaunch);
    expect(readAgentLaunch({ agentLaunch }, "w1:p1")).toBeUndefined();
    expect(readAgentLaunch({ agentLaunch }, "w1:p1", { host: "peer" })).toBeUndefined();
    expect(readAgentLaunch({ agentLaunch }, "w1:p2", scope)).toBeUndefined();
    expect(readAgentLaunch({ agentLaunch: { ...agentLaunch, id: null } }, "w1:p1", scope)).toBeUndefined();
    expect(readAgentLaunch(null, "w1:p1", scope)).toBeUndefined();
  });
});
