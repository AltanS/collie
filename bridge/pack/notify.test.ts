import { describe, expect, test } from "bun:test";

import type { NotifyClock } from "../notifications.ts";
import type { PushMessage } from "../push.ts";
import type { AgentStatus, PaneWire } from "../types.ts";
import type { PeerSnapshotBody } from "./merge.ts";
import { diffPeerAgents, herdPushGate, PeerNotifier } from "./notify.ts";

// Peer notifications, derived on the LEAD from swept bodies through the local coordinator machinery.
// Everything here is pure: a fake clock fires debounces on demand and a recording push captures what
// would have gone to the phone — no Bun.serve, no web-push, no network.

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
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
  get armed(): number {
    return this.timers.size;
  }
}

class RecordingPush {
  readonly sent: PushMessage[] = [];
  send(msg: PushMessage): void {
    this.sent.push(msg);
  }
  get tags(): (string | undefined)[] {
    return this.sent.map((m) => m.tag);
  }
}

function pane(paneId: string, status: AgentStatus, agent = "claude"): PaneWire {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status,
    cwd: "/home/you/collie",
    focused: false,
    kind: "agent",
  };
}

function body(agents: PaneWire[]): PeerSnapshotBody {
  return { sessions: [], agents, shellPanes: [] };
}

function notifier(opts: { notifiable?: (s: AgentStatus) => boolean; muted?: () => boolean } = {}) {
  const clock = new FakeClock();
  const push = new RecordingPush();
  const peer = new PeerNotifier<number>({
    clock,
    push,
    mute: { isMuted: opts.muted ?? (() => false) },
    delayMs: 5_000,
    isNotifiable: opts.notifiable ?? ((s) => s === "blocked" || s === "done"),
  });
  return { clock, push, peer };
}

// ── The diff ─────────────────────────────────────────────────────────────────

describe("diffPeerAgents", () => {
  test("a first sighting never fires a transition — state-engine's rule, verbatim", () => {
    const d = diffPeerAgents(new Map(), [pane("p1", "blocked"), pane("p2", "working")]);
    expect(d.transitions).toEqual([]);
    expect(d.removed).toEqual([]);
    expect([...d.statuses]).toEqual([
      ["p1", "blocked"],
      ["p2", "working"],
    ]);
  });

  test("a moved status is one transition carrying both ends", () => {
    const prev = new Map<string, AgentStatus>([["p1", "working"]]);
    const d = diffPeerAgents(prev, [pane("p1", "blocked")]);
    expect(d.transitions.map((t) => [t.pane.paneId, t.from, t.to])).toEqual([["p1", "working", "blocked"]]);
  });

  test("an unchanged body produces nothing — this is the cross-sweep dedupe", () => {
    const prev = new Map<string, AgentStatus>([["p1", "blocked"]]);
    for (let i = 0; i < 5; i++) {
      const d = diffPeerAgents(prev, [pane("p1", "blocked")]);
      expect(d.transitions).toEqual([]);
      expect(d.removed).toEqual([]);
    }
  });

  test("a vanished pane is removed, and is not also a transition", () => {
    const prev = new Map<string, AgentStatus>([
      ["p1", "blocked"],
      ["p2", "working"],
    ]);
    const d = diffPeerAgents(prev, [pane("p2", "working")]);
    expect(d.removed).toEqual(["p1"]);
    expect(d.transitions).toEqual([]);
  });
});

// ── The notifier ─────────────────────────────────────────────────────────────

describe("PeerNotifier — a peer's alerts on the lead's phone", () => {
  test("a block on a peer pushes under that peer's own slot, naming the host", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")])); // first sighting: silent
    expect(push.sent).toEqual([]);

    peer.observe("laptop", body([pane("p1", "blocked")]));
    expect(push.sent).toEqual([]); // still debouncing — an at-desk resolution never reaches the phone
    clock.fireAll();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toEqual({
      title: "claude needs you",
      body: "laptop · collie · /home/you/collie",
      tag: "collie:herd@laptop",
      paneId: "p1",
      renotify: true,
      host: "laptop",
    });
    // `session` does NOT ride it — a peer's merged pane names no session, and the sweep reads that
    // peer's primary (§5's "absent → primary").
    expect(push.sent[0]!.session).toBeUndefined();
  });

  test("the payload carries the host so a tap can deep-link to the right machine", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    expect(push.sent[0]).toMatchObject({ host: "laptop" });
  });

  test("two hosts blocking at once land in two slots, never overwriting each other", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("desktop", body([pane("p1", "working")])); // same pane id, other machine
    peer.observe("laptop", body([pane("p1", "blocked")]));
    peer.observe("desktop", body([pane("p1", "blocked")]));
    clock.fireAll();

    expect(push.tags.sort()).toEqual(["collie:herd@desktop", "collie:herd@laptop"]);
    expect(push.sent.map((m) => m.host).sort()).toEqual(["desktop", "laptop"]);
  });

  test("simultaneous blocks on ONE host batch into that host's single summary", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working"), pane("p2", "working"), pane("p3", "working")]));
    peer.observe(
      "laptop",
      body([pane("p1", "blocked"), pane("p2", "blocked", "codex"), pane("p3", "blocked", "pi")]),
    );
    clock.fireAll();

    // One slot, and its final state is the digest — the existing "one summary, not three races".
    expect(new Set(push.tags)).toEqual(new Set(["collie:herd@laptop"]));
    expect(push.sent.at(-1)).toMatchObject({
      title: "3 agents need you",
      body: "laptop · claude, codex, pi",
    });
  });

  test("a pane that stays blocked across many sweeps is announced exactly once", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    for (let i = 0; i < 10; i++) peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    expect(push.sent).toHaveLength(1);
  });

  test("resolving at the desk retracts the peer's notification", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    peer.observe("laptop", body([pane("p1", "working")]));
    expect(push.sent.at(-1)).toEqual({ type: "clear", tag: "collie:herd@laptop" });
  });

  test("a pane closing on the peer retracts it too", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    peer.observe("laptop", body([]));
    expect(push.sent.at(-1)).toEqual({ type: "clear", tag: "collie:herd@laptop" });
  });

  test("a host that leaves the pack has its outstanding alerts retracted and its slot dropped", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    expect(peer.tags()).toEqual(["collie:herd@laptop"]);

    peer.forget("laptop");
    expect(push.sent.at(-1)).toEqual({ type: "clear", tag: "collie:herd@laptop" });
    expect(peer.tags()).toEqual([]);
    expect(clock.armed).toBe(0);
  });

  test("forgetting a host that never alerted is a no-op", () => {
    const { push, peer } = notifier();
    peer.forget("laptop");
    expect(push.sent).toEqual([]);
  });
});

// ── The lead's policy is the pack's policy ───────────────────────────────────

describe("PeerNotifier — the lead's snooze and prefs are pack-wide by construction", () => {
  test("the lead's snooze suppresses a peer's alert — no fan-out, no peer involvement", () => {
    let muted = false;
    const { clock, push, peer } = notifier({ muted: () => muted });
    peer.observe("laptop", body([pane("p1", "working")]));
    muted = true; // snoozed while the peer was unreachable, mid-sweep, whenever — same answer
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    expect(push.sent).toEqual([]);
  });

  test("the snooze route's clear fan reaches every live peer slot", () => {
    const { clock, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "blocked")]));
    peer.observe("desktop", body([pane("p1", "blocked")]));
    clock.fireAll();
    expect(peer.tags().sort()).toEqual(["collie:herd@desktop", "collie:herd@laptop"]);
  });

  test("disabling a kind in the lead's prefs retracts that kind on every host", () => {
    let notifiable = (s: AgentStatus) => s === "blocked" || s === "done";
    const { clock, push, peer } = notifier({ notifiable: (s) => notifiable(s) });
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("desktop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    peer.observe("desktop", body([pane("p1", "blocked")]));
    clock.fireAll();
    const before = push.sent.length;

    notifiable = (s) => s === "done";
    peer.applyPrefs();

    const after = push.sent.slice(before);
    expect(after).toEqual([
      { type: "clear", tag: "collie:herd@laptop" },
      { type: "clear", tag: "collie:herd@desktop" },
    ]);
  });
});

// ── What a peer does with its own push stack ─────────────────────────────────

describe("herdPushGate", () => {
  test("solo and lead get their gate back by identity — zero tax", () => {
    const snooze = { isMuted: () => false };
    expect(herdPushGate("solo", snooze)).toBe(snooze);
    expect(herdPushGate("lead", snooze)).toBe(snooze);
  });

  test("peer mode mutes the herd path so an alert never arrives twice", () => {
    const gate = herdPushGate("peer", { isMuted: () => false });
    expect(gate.isMuted()).toBe(true);
  });
});
