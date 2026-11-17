import { describe, expect, test } from "bun:test";

import { EventBus } from "../events/bus.ts";
import { attachSessionSource, type TransitionFeed, type TransitionPane } from "../events/sources.ts";
import type { AgentStatus } from "../types.ts";
import { apiListedPane } from "./listed.ts";

// SECURITY READ 2, ITEM 4: the bus source publishes only for the panes `sessions` lists. The source runs
// with the very predicate bridge/index.ts hands it (`listed: apiListedPane`, pinned by
// events/sources.test.ts), and reads.ts lists `sessions` by the same function.

class FakeEngine implements TransitionFeed {
  private readonly transitions = new Set<(agent: TransitionPane, from: AgentStatus, to: AgentStatus) => void>();
  onTransition(fn: (agent: TransitionPane, from: AgentStatus, to: AgentStatus) => void): () => void {
    this.transitions.add(fn);
    return () => this.transitions.delete(fn);
  }
  onRemove(): () => void {
    return () => undefined;
  }
  fire(agent: TransitionPane, from: AgentStatus, to: AgentStatus): void {
    for (const fn of this.transitions) fn(agent, from, to);
  }
}

describe("the panes the local API names", () => {
  test("the predicate: an agent pane or one of no kind; never a shell, a trick session or a kind added later", () => {
    expect(apiListedPane({ kind: "agent" })).toBe(true);
    expect(apiListedPane({})).toBe(true);
    expect(apiListedPane({ kind: "shell" })).toBe(false);
    expect(apiListedPane({ kind: "trick" })).toBe(false);
    expect(apiListedPane({ kind: "later" })).toBe(false);
  });

  test("a shell pane and a trick pane change state: no event; an agent pane does: its events", () => {
    const bus = new EventBus({ machine: () => "m_k3x9q2w7ab", bootId: "boot1", now: () => 0 });
    const engine = new FakeEngine();
    // Every pane holds a token, so only the predicate tells them apart.
    attachSessionSource({ engine, muxSession: "lodge", machine: () => "m_k3x9q2w7ab", listed: apiListedPane, instanceOf: () => "k3f9", publish: (input) => void bus.publish(input) });
    const head = bus.head();
    engine.fire({ paneId: "w1:p9", kind: "shell" }, "working", "idle");
    engine.fire({ paneId: "trick:lodge:t:p", kind: "trick" }, "working", "blocked");
    expect(bus.since(head).events).toEqual([]);
    engine.fire({ paneId: "w1:p1", kind: "agent" }, "working", "done");
    expect(bus.since(head).events.map((event) => event.type)).toEqual(["session.status", "turn.end"]);
    engine.fire({ paneId: "w1:p2" }, "idle", "blocked");
    expect(bus.since(head).events.map((event) => event.type)).toEqual(["session.status", "turn.end", "session.status", "ask.open"]);
  });
});
