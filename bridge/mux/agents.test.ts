import { describe, expect, test } from "bun:test";

import { AGENT_ALIASES, KNOWN_HARNESS_NAMES } from "../journal/registry.ts";
import { registeredAgents } from "../../web/src/lib/harness/registry.ts";
import { isMuxAgentName, MUX_AGENT_NAMES } from "./agents.ts";
import { agentNameProblems } from "./conformance.ts";
import type { MuxPane } from "./types.ts";

// The agent-name rule (agents.ts), and the list it checks against. The web and bridge trees cannot
// import one another in production code, so this file imports across the boundary on purpose, as
// crew-level-contract.test.ts does: the list must be exactly what the two readers answer to.

describe("the contract's agent names are the names Collie's readers answer to", () => {
  test("the list is the screen readers, the journal readers and the journal's aliases", () => {
    const readers = new Set([...registeredAgents(), ...KNOWN_HARNESS_NAMES, ...Object.keys(AGENT_ALIASES)]);
    expect([...MUX_AGENT_NAMES]).toEqual([...readers].toSorted());
  });

  test("shell and every harness name pass; a multiplexer's own id does not", () => {
    expect(isMuxAgentName("shell")).toBe(true);
    for (const name of MUX_AGENT_NAMES) expect(isMuxAgentName(name)).toBe(true);
    for (const name of ["claude-code", "cursor-agent", "gemini-cli", "Claude", ""]) expect(isMuxAgentName(name)).toBe(false);
  });
});

describe("the conformance check applies the rule", () => {
  const pane = (agent: string): MuxPane => ({
    paneId: `p-${agent || "empty"}`,
    spaceId: "s",
    spaceLabel: "s",
    spaceNumber: 1,
    tabId: "t",
    cwd: "",
    focused: false,
    alive: true,
    agent,
    status: agent === "shell" ? "unknown" : "idle",
  });

  test("a harness id from the multiplexer's own vocabulary is a problem", () => {
    expect(agentNameProblems([pane("claude-code")])).toEqual([
      `pane "p-claude-code" reports agent "claude-code", which is not a Collie harness name, so no screen reader or journal reader finds it (agents.ts)`,
    ]);
  });

  test("Collie's own names and a shell are not", () => {
    expect(agentNameProblems([pane("claude"), pane("pi"), pane("shell")])).toEqual([]);
  });

  test("the older two rules still hold: not empty, lower-cased", () => {
    expect(agentNameProblems([pane(""), pane("Claude")])).toHaveLength(2);
  });
});
