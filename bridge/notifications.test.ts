import { describe, expect, test } from "bun:test";

import {
  NotificationCoordinator,
  makeNotifySink,
  type HerdSummary,
  type NotifyClock,
  type NotifySink,
} from "./notifications.ts";
import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// The coordinator decides whether/when a blocked/done transition becomes a push, and collapses the
// herd into a single summary. We drive it with a fake clock (fire timers on demand) and a recording
// sink, so every debounce / coalesce / retract path is exercised purely — no Bun.serve, no web-push.

class FakeClock implements NotifyClock<number> {
  private readonly timers = new Map<number, () => void>();
  private next = 1;
  schedule(fn: () => void, _delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, fn);
    return id;
  }
  cancel(handle: number): void {
    this.timers.delete(handle);
  }
  /** Fire every still-armed timer (a cancelled one was already removed). */
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
  get armed(): number {
    return this.timers.size;
  }
}

type Event = { kind: "render"; summary: HerdSummary } | { kind: "clear" };

class RecordingSink implements NotifySink {
  readonly events: Event[] = [];
  render(summary: HerdSummary): void {
    this.events.push({ kind: "render", summary });
  }
  clear(): void {
    this.events.push({ kind: "clear" });
  }
  /** The most recently rendered summary, or undefined if the last event was a clear / none yet. */
  get last(): HerdSummary | undefined {
    const e = this.events.at(-1);
    return e?.kind === "render" ? e.summary : undefined;
  }
  get renders(): HerdSummary[] {
    return this.events.flatMap((e) => (e.kind === "render" ? [e.summary] : []));
  }
  get clears(): number {
    return this.events.filter((e) => e.kind === "clear").length;
  }
}

function agentNamed(paneId: string, name: string, status: AgentStatus): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: name,
    status,
    cwd: "/home/you/demo",
    focused: false,
    kind: "agent",
  };
}
const agent = (paneId: string, status: AgentStatus) => agentNamed(paneId, "claude", status);

// `prefs` is a live, mutable object the injected `isNotifiable` reads on every call — so a test can
// flip a preference and call `coord.applyPrefs()` to exercise the runtime-change path. Defaults to
// both kinds enabled, matching the coordinator's old static {blocked,done} set (keeps the existing
// debounce/coalesce/retract suites unchanged).
function setup(prefs: { blocked: boolean; done: boolean } = { blocked: true, done: true }) {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const live = { ...prefs };
  const isNotifiable = (s: AgentStatus): boolean =>
    s === "blocked" ? live.blocked : s === "done" ? live.done : false;
  const coord = new NotificationCoordinator(clock, sink, 30_000, isNotifiable);
  return { clock, sink, coord, prefs: live };
}

describe("NotificationCoordinator — debounce", () => {
  test("does not render until the debounce window elapses, then renders once", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    expect(sink.events).toEqual([]); // armed, not yet fired
    clock.fireAll();
    expect(sink.last).toEqual({
      title: "claude needs you",
      body: "demo · /home/you/demo",
      paneId: "p1",
      renotify: true,
    });
  });

  test("cancels an alert that resolves before the window elapses (handled at the desk)", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    coord.onTransition(agent("p1", "working"), "blocked", "working"); // resolved quickly
    clock.fireAll();
    expect(sink.events).toEqual([]);
    expect(clock.armed).toBe(0);
  });

  test("'done' uses the 'is done' verb", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(sink.last?.title).toBe("claude is done");
  });
});

describe("NotificationCoordinator — coalescing", () => {
  test("two outstanding agents collapse into one digest that buzzes", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agentNamed("p1", "claude", "blocked"), "working", "blocked");
    coord.onTransition(agentNamed("p2", "codex", "blocked"), "working", "blocked");
    clock.fireAll();
    // p1 renders as a single, then p2 promotes it to a digest.
    expect(sink.renders.at(-1)).toEqual({
      title: "2 agents need you",
      body: "claude, codex",
      paneId: undefined,
      renotify: true,
    });
  });

  test("a mixed blocked+done herd reads as 'need attention'", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agentNamed("p1", "claude", "blocked"), "working", "blocked");
    coord.onTransition(agentNamed("p2", "codex", "done"), "working", "done");
    clock.fireAll();
    expect(sink.last?.title).toBe("2 agents need attention");
  });

  test("resolving one of two falls back to the named single, silently", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agentNamed("p1", "claude", "blocked"), "working", "blocked");
    coord.onTransition(agentNamed("p2", "codex", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onTransition(agentNamed("p2", "codex", "idle"), "blocked", "idle"); // codex handled
    expect(sink.last).toEqual({
      title: "claude needs you",
      body: "demo · /home/you/demo",
      paneId: "p1",
      renotify: false, // a retraction update must not re-buzz
    });
  });
});

describe("NotificationCoordinator — retraction", () => {
  test("clears the herd once the last outstanding agent resolves", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onTransition(agent("p1", "idle"), "blocked", "idle");
    expect(sink.events.at(-1)).toEqual({ kind: "clear" });
  });

  test("clears the herd when the pane disappears", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onRemove("p1");
    expect(sink.events.at(-1)).toEqual({ kind: "clear" });
  });

  test("removal before delivery cancels without rendering or clearing", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    coord.onRemove("p1");
    clock.fireAll();
    expect(sink.events).toEqual([]);
  });

  test("a second resolution does not emit a second clear", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onTransition(agent("p1", "idle"), "blocked", "idle");
    coord.onTransition(agent("p1", "working"), "idle", "working");
    expect(sink.clears).toBe(1);
  });
});

describe("NotificationCoordinator — type preferences", () => {
  test("with default prefs (done off), a done transition never pushes — even after the window", () => {
    const { clock, sink, coord } = setup({ blocked: true, done: false });
    coord.onTransition(agent("p1", "done"), "working", "done");
    expect(clock.armed).toBe(0); // a disabled kind isn't even debounced
    clock.fireAll();
    expect(sink.events).toEqual([]);
  });

  test("with done enabled, a done transition pushes after the window", () => {
    const { clock, sink, coord } = setup({ blocked: false, done: true });
    coord.onTransition(agent("p1", "done"), "working", "done");
    expect(sink.events).toEqual([]); // still debouncing
    clock.fireAll();
    expect(sink.last?.title).toBe("claude is done");
  });

  test("with blocked disabled, a blocked transition doesn't push", () => {
    const { clock, sink, coord } = setup({ blocked: false, done: true });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    expect(clock.armed).toBe(0);
    clock.fireAll();
    expect(sink.events).toEqual([]);
  });

  test("disabling a kind at runtime retracts an already-outstanding alert of that kind", () => {
    const { clock, sink, coord, prefs } = setup({ blocked: true, done: true });
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(sink.last?.title).toBe("claude is done"); // delivered
    prefs.done = false; // preference changes at runtime…
    coord.applyPrefs(); // …and the API hook re-evaluates the herd
    expect(sink.events.at(-1)).toEqual({ kind: "clear" }); // the done alert is retracted
  });

  test("disabling a kind at runtime cancels a still-pending alert of that kind", () => {
    const { clock, sink, coord, prefs } = setup({ blocked: true, done: true });
    coord.onTransition(agent("p1", "done"), "working", "done"); // debouncing, not yet delivered
    expect(clock.armed).toBe(1);
    prefs.done = false;
    coord.applyPrefs();
    expect(clock.armed).toBe(0); // timer cancelled
    clock.fireAll();
    expect(sink.events).toEqual([]); // nothing was ever shown
  });

  test("a blocked alert is retracted when the agent finishes and done-pushes are off", () => {
    const { clock, sink, coord } = setup({ blocked: true, done: false });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    expect(sink.last?.title).toBe("claude needs you");
    // The agent completes, but done pushes are disabled — so this is a non-notifiable transition
    // that resolves (retracts) the outstanding blocked alert rather than replacing it.
    coord.onTransition(agent("p1", "done"), "blocked", "done");
    expect(sink.events.at(-1)).toEqual({ kind: "clear" });
  });
});

describe("makeNotifySink", () => {
  const summary: HerdSummary = {
    title: "claude needs you",
    body: "demo · /home/you/demo",
    paneId: "p1",
    renotify: true,
  };
  class RecordingPush {
    readonly sent: PushMessage[] = [];
    send(msg: PushMessage): void {
      this.sent.push(msg);
    }
  }

  test("render maps the summary onto a single herd-tagged push", () => {
    const push = new RecordingPush();
    makeNotifySink(push, { isMuted: () => false }, "collie:herd").render(summary);
    expect(push.sent).toEqual([
      { title: "claude needs you", body: "demo · /home/you/demo", tag: "collie:herd", paneId: "p1", renotify: true },
    ]);
  });

  test("clear maps to a clear push on the herd tag", () => {
    const push = new RecordingPush();
    makeNotifySink(push, { isMuted: () => false }, "collie:herd").clear();
    expect(push.sent).toEqual([{ type: "clear", tag: "collie:herd" }]);
  });

  test("an active snooze suppresses both render and clear", () => {
    const push = new RecordingPush();
    const sink = makeNotifySink(push, { isMuted: () => true }, "collie:herd");
    sink.render(summary);
    sink.clear();
    expect(push.sent).toEqual([]);
  });
});
