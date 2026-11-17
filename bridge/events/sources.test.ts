import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import type { AgentStatus } from "../types.ts";
import { WalkyInstances } from "../walky/instances.ts";
import { EventBus, type LiveEvent } from "./bus.ts";
import { decodeSessionId } from "./session-id.ts";
import { attachSessionSource, endsTurn, type TransitionFeed, type TransitionPane } from "./sources.ts";

interface Step {
  readonly from: AgentStatus;
  readonly to: AgentStatus;
}

const STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function statusOf(value: string | undefined): AgentStatus {
  const found = STATUSES.find((s) => s === value);
  if (found === undefined) throw new Error(`fixture: not a status: ${String(value)}`);
  return found;
}

function stepsOf(key: string): Step[] {
  const raw = parseJsonObject(readFileSync(join(import.meta.dir, "fixtures", "one-turn.json"), "utf8"));
  const list = raw?.[key];
  if (!Array.isArray(list)) throw new Error(`fixture: no ${key}`);
  return list.map((value) => {
    const row = asJsonObject(value);
    return { from: statusOf(asJsonString(row?.from)), to: statusOf(asJsonString(row?.to)) };
  });
}

/** A hand-driven engine: the same two feeds the real one offers. */
class FakeEngine implements TransitionFeed {
  private readonly transitions = new Set<(agent: TransitionPane, from: AgentStatus, to: AgentStatus) => void>();
  private readonly removes = new Set<(paneId: string) => void>();
  onTransition(fn: (agent: TransitionPane, from: AgentStatus, to: AgentStatus) => void): () => void {
    this.transitions.add(fn);
    return () => this.transitions.delete(fn);
  }
  onRemove(fn: (paneId: string) => void): () => void {
    this.removes.add(fn);
    return () => this.removes.delete(fn);
  }
  fire(paneId: string, from: AgentStatus, to: AgentStatus): void {
    for (const fn of this.transitions) fn({ paneId }, from, to);
  }
  remove(paneId: string): void {
    for (const fn of this.removes) fn(paneId);
  }
  listeners(): number {
    return this.transitions.size + this.removes.size;
  }
}

function rig(instanceOf: (muxSession: string, paneId: string) => string | null = (muxSession) => (muxSession === "default" ? "k3f9" : null)) {
  const bus = new EventBus({ machine: () => "m_k3x9q2w7ab", bootId: "boot1", now: () => 0 });
  const engine = new FakeEngine();
  const errors: string[] = [];
  const detach = attachSessionSource({
    engine,
    muxSession: "default",
    machine: () => "m_k3x9q2w7ab",
    // The predicate's own test is bridge/api/listed.test.ts; here every pane is an agent pane.
    listed: () => true,
    instanceOf,
    publish: (input) => {
      bus.publish(input);
    },
    onError: (message) => errors.push(message),
  });
  const head = bus.head();
  const emitted = (): string[] => bus.since(head).events.map((e) => (e.type === "session.status" ? `status:${e.data.state}` : e.type));
  return { bus, engine, errors, detach, head, emitted };
}

describe("the replay of one recorded turn", () => {
  test("Herdr's turn (done, then idle) emits the status of each step, ONE ask.open and ONE turn.end", () => {
    const { engine, emitted } = rig();
    for (const step of stepsOf("herdr")) engine.fire("w1:p1", step.from, step.to);
    expect(emitted()).toEqual([
      "status:working",
      "status:blocked",
      "ask.open",
      "status:working",
      "status:done",
      "turn.end",
      "status:idle",
    ]);
  });

  test("the same turn on a multiplexer that says idle at the end emits the same events", () => {
    const { engine, emitted } = rig();
    for (const step of stepsOf("idleOnly")) engine.fire("w1:p1", step.from, step.to);
    expect(emitted()).toEqual(["status:working", "status:blocked", "ask.open", "status:working", "status:idle", "turn.end"]);
  });

  test("every event names the pane by its session id and carries no text", () => {
    const { bus, engine, head } = rig();
    for (const step of stepsOf("herdr")) engine.fire("w1:p1", step.from, step.to);
    const events = bus.since(head).events;
    for (const event of events) {
      expect(decodeSessionId(event.session ?? "")).toEqual({ machine: "m_k3x9q2w7ab", paneId: "w1:p1", instance: "k3f9" });
      expect(Object.keys(event.data).every((key) => key === "state")).toBe(true);
    }
  });
});

describe("the turn-end rule", () => {
  test("the pairs that end a turn", () => {
    const ends = STATUSES.flatMap((from) => STATUSES.filter((to) => endsTurn(from, to)).map((to) => `${from}->${to}`));
    expect(ends).toEqual(["working->idle", "working->done", "blocked->idle", "blocked->done"]);
  });

  test("an ask lifted on a finished pane is no second turn end", () => {
    const { engine, emitted } = rig();
    engine.fire("p", "idle", "working");
    engine.fire("p", "working", "done");
    engine.fire("p", "done", "blocked");
    engine.fire("p", "blocked", "done");
    expect(emitted().filter((e) => e === "turn.end")).toHaveLength(1);
  });

  test("a new turn ends again, and a pane first seen mid-turn ends once", () => {
    const { engine, emitted } = rig();
    engine.fire("p", "working", "idle");
    engine.fire("p", "idle", "working");
    engine.fire("p", "working", "idle");
    expect(emitted().filter((e) => e === "turn.end")).toHaveLength(2);
  });

  test("a pane that went and came back under the same id starts clean", () => {
    const { engine, emitted } = rig();
    engine.fire("p", "working", "done");
    engine.remove("p");
    engine.fire("p", "blocked", "done");
    expect(emitted().filter((e) => e === "turn.end")).toHaveLength(2);
  });

  test("two panes keep their own turns", () => {
    const { engine, emitted } = rig();
    engine.fire("a", "working", "idle");
    engine.fire("b", "working", "idle");
    expect(emitted().filter((e) => e === "turn.end")).toHaveLength(2);
  });
});

describe("the source's edges", () => {
  test("a pane with no instance token publishes nothing: no invented id", () => {
    const { engine, emitted, errors } = rig(() => null);
    engine.fire("p", "idle", "working");
    expect(emitted()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a failure inside the source never reaches the engine's poll", () => {
    const { engine, emitted, errors } = rig(() => {
      throw new ReferenceError("not yet initialised");
    });
    expect(() => engine.fire("p", "idle", "working")).not.toThrow();
    expect(emitted()).toEqual([]);
    expect(errors).toEqual(["not yet initialised"]);
  });

  test("detach removes both feeds", () => {
    const { engine, detach, emitted } = rig();
    expect(engine.listeners()).toBe(2);
    detach();
    expect(engine.listeners()).toBe(0);
    engine.fire("p", "idle", "working");
    expect(emitted()).toEqual([]);
  });

  test("a push listener sees the turn with the statuses coalesced", () => {
    const { bus, engine } = rig();
    const sub = bus.subscribe();
    for (const step of stepsOf("herdr")) engine.fire("w1:p1", step.from, step.to);
    const types = sub.take().events.map((e: LiveEvent) => (e.type === "session.status" ? `status:${e.data.state}` : e.type));
    expect(types).toEqual(["ask.open", "turn.end", "status:idle"]);
  });
});

describe("the source mints no token (security read 1, item 4)", () => {
  test("driven through a whole turn with a peek that finds no token: nothing published, nothing minted, no file written", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-sources-"));
    try {
      const instances = new WalkyInstances(dir, () => 1_000);
      const minted: string[] = [];
      const tokenOf = instances.tokenOf.bind(instances);
      instances.tokenOf = (session, paneId, at) => {
        minted.push(`${session}/${paneId}`);
        return tokenOf(session, paneId, at);
      };
      const { engine, emitted, errors } = rig((muxSession, paneId) => instances.peek(muxSession, paneId));
      for (const step of stepsOf("herdr")) engine.fire("w1:p1", step.from, step.to);
      engine.fire("w1:p2", "idle", "working");
      engine.fire("w1:p2", "working", "blocked");
      engine.remove("w1:p1");
      expect(emitted()).toEqual([]);
      expect(errors).toEqual([]);
      expect(minted).toEqual([]);
      expect(instances.all()).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
      expect(existsSync(join(dir, "instances.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pane a token was minted for elsewhere (walky's own tick) publishes, and the peek still writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-sources-"));
    try {
      const instances = new WalkyInstances(dir, () => 1_000);
      instances.observe([{ session: "default", paneId: "w1:p1" }]);
      const before = readFileSync(join(dir, "instances.json"), "utf8");
      const { engine, emitted } = rig((muxSession, paneId) => instances.peek(muxSession, paneId));
      engine.fire("w1:p1", "idle", "working");
      engine.fire("w1:p2", "idle", "working");
      expect(emitted()).toEqual(["status:working"]);
      expect(readFileSync(join(dir, "instances.json"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bridge/index.ts wires the source to the peek, never to tokenOf", () => {
    const index = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    const start = index.indexOf("attachSessionSource({");
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, index.indexOf("});", start));
    expect(block).toContain("walkyInstances.peek(");
    expect(block).not.toContain("tokenOf");
    // Security read 2, item 4: the one predicate `sessions` lists by.
    expect(block).toContain("listed: apiListedPane");
  });
});
