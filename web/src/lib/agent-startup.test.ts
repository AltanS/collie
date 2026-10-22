import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstLaunchScreen, readAgentLaunch, startupHarness } from "./agent-startup";
import { paneScopeKey } from "./scope";
import { UNREAD_SURFACE } from "./send-slot";
import type { Surface } from "./surface/surface";

const capture = (name: string) => readFileSync(join(process.cwd(), "src/fixtures/panes", `${name}.txt`), "utf8");
const TRUST = capture("kiro--v3-workspace-trust-continue-w120");
const READY = capture("kiro--v3-idle-w120");
const input = { harness: "kiro", text: "", surface: UNREAD_SURFACE, live: true, stale: false };
const ASK: Surface = { revision: 0, turn: "unknown", composer: "unknown", modal: { ask: { id: "trust", kind: "permission", channel: "keys", hash: "abc", options: [{ id: "1", label: "Continue" }] } } };

describe("first launch screen", () => {
  it("does not mistake shell output, nonzero revision, or an unreadable panel for readiness", () => {
    for (const text of ["", "$ kiro", "Starting Kiro…", capture("kiro--v3-slash-help-w120")]) {
      expect(firstLaunchScreen({ ...input, text, surface: { ...UNREAD_SURFACE, revision: 18 } })).toBeNull();
    }
  });
  it("recognizes captured trust and the real composer even at revision zero", () => {
    expect(firstLaunchScreen({ ...input, text: TRUST })).toBe("dialog");
    expect(firstLaunchScreen({ ...input, text: READY })).toBe("composer");
  });
  it("accepts a concrete bridge ask independently of pane text or revision", () => {
    expect(firstLaunchScreen({ ...input, surface: ASK })).toBe("dialog");
  });
  it("does not use saved, failed, torn or contested evidence", () => {
    expect(firstLaunchScreen({ ...input, text: READY, live: false })).toBeNull();
    expect(firstLaunchScreen({ ...input, surface: ASK, stale: true })).toBeNull();
    for (const reason of ["stale", "torn", "contested"] as const) {
      expect(firstLaunchScreen({ ...input, text: READY, surface: { ...ASK, reason } })).toBeNull();
    }
  });
  it("keeps real unreachable refusals and requires positive adapter evidence", () => {
    expect(firstLaunchScreen({ ...input, text: READY, surface: { ...UNREAD_SURFACE, composer: "unreachable" } })).toBeNull();
    expect(firstLaunchScreen({ ...input, harness: "not-a-harness", text: READY })).toBeNull();
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
