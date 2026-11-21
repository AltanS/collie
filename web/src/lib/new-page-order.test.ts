import { describe, expect, it } from "vitest";

import type { LauncherItem } from "@/lib/types";

import { agentChoice, agentsInPickOrder, offerFor } from "./new-page";

// THE ORDER A PERSON PICKS AN AGENT IN: their own agents first, then the built-in agents that are installed, then
// those that are not, each group in the order it came in. The agent New opens on does not move with it.

function builtIn(id: string, label: string, found: boolean): LauncherItem {
  const item: LauncherItem = { key: `harness:${id}`, start: { harness: id }, group: "agents", label, harness: id, source: "builtin", noPrompts: false, branch: true, available: found };
  if (!found) item.reason = "not_found";
  return item;
}

function own(command: string, label: string, source: "added" | "operator", noPrompts = false): LauncherItem {
  return { key: `row:${command}`, start: { command }, group: "agents", label, harness: "claude", command, source, noPrompts, branch: true, available: true };
}

const offerOf = (items: LauncherItem[]) => offerFor({ harnesses: [], items, loaded: true, rows: [], canWorktree: true });
const keys = (items: readonly { key: string }[]) => items.map((i) => i.key);

describe("agentsInPickOrder", () => {
  it("puts own agents first, then installed built-ins, then built-ins not installed, each in its order", () => {
    const offer = offerOf([
      builtIn("claude", "Claude Code", true),
      builtIn("grok", "Grok", false),
      builtIn("codex", "Codex", true),
      own("claude --review", "Review bot", "added", true),
      own("claude --night", "Night shift", "operator"),
    ]);
    expect(keys(agentsInPickOrder(offer.agents))).toEqual(["row:claude --review", "row:claude --night", "harness:claude", "harness:codex", "harness:grok"]);
  });

  it("keeps today's order where there is no own agent", () => {
    const offer = offerOf([builtIn("claude", "Claude Code", true), builtIn("codex", "Codex", false)]);
    expect(keys(agentsInPickOrder(offer.agents))).toEqual(["harness:claude", "harness:codex"]);
  });

  it("lists own agents alone, in their stored order", () => {
    const offer = offerOf([own("b", "Second", "added"), own("a", "First", "added")]);
    expect(keys(agentsInPickOrder(offer.agents))).toEqual(["row:b", "row:a"]);
  });

  it("lists nothing for nothing", () => {
    expect(agentsInPickOrder([])).toEqual([]);
  });

  it("keeps an own agent that runs a built-in's harness apart from it: its key is its line, never the harness", () => {
    const offer = offerOf([builtIn("claude", "Claude Code", true), own("claude", "Plain claude", "added")]);
    expect(keys(agentsInPickOrder(offer.agents))).toEqual(["row:claude", "harness:claude"]);
  });
});

describe("the agent New opens on", () => {
  it("stays the first built-in that starts, with own agents listed first", () => {
    const offer = offerOf([builtIn("claude", "Claude Code", true), own("claude --review", "Review bot", "added", true)]);
    expect(agentChoice(offer, null, null)?.key).toBe("harness:claude");
  });
});
