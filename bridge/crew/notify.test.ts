import { describe, expect, test } from "bun:test";

import { AskPush } from "../durable/ask-push.ts";
import { AskGuardStore } from "../durable/guard.ts";
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

function pane(paneId: string, status: AgentStatus, agent = "claude", extra: Partial<PaneWire> = {}): PaneWire {
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
    ...extra,
  };
}

function body(agents: PaneWire[]): PeerSnapshotBody {
  return { sessions: [], agents, shellPanes: [], workspaces: [], tabs: [] };
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
      titleCode: "agent.blocked",
      titleDetail: { agent: "claude" },
      body: "laptop · collie",
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

    expect(push.tags.toSorted()).toEqual(["collie:herd@desktop", "collie:herd@laptop"]);
    expect(push.sent.map((m) => m.host).toSorted()).toEqual(["desktop", "laptop"]);
  });

  test("simultaneous blocks on ONE host batch into that host's single summary", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working"), pane("p2", "working"), pane("p3", "working")]));
    peer.observe(
      "laptop",
      body([
        pane("p1", "blocked", "claude", { paneLabel: "api" }),
        pane("p2", "blocked", "codex", { paneLabel: "web" }),
        pane("p3", "blocked", "pi", { paneLabel: "worker" }),
      ]),
    );
    clock.fireAll();

    // One slot, and its final state is the digest — the existing "one summary, not three races".
    // Named by the push name rule (notifications.ts § pushName), not by agent kind — three panes, three words.
    expect(new Set(push.tags)).toEqual(new Set(["collie:herd@laptop"]));
    expect(push.sent.at(-1)).toMatchObject({
      title: "3 agents need you",
      body: "laptop · api, web, worker",
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

  test("a peer's working → idle is a finished turn and pushes once, naming the host (#345)", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "idle")]));
    clock.fireAll();
    for (let i = 0; i < 10; i++) peer.observe("laptop", body([pane("p1", "idle")]));
    clock.fireAll();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.title).toBe("claude is done");
    expect(push.sent[0]?.titleCode).toBe("agent.done");
    expect(push.sent[0]?.host).toBe("laptop");
  });

  test("a pane closing on the peer retracts it too", () => {
    const { clock, push, peer } = notifier();
    peer.observe("laptop", body([pane("p1", "working")]));
    peer.observe("laptop", body([pane("p1", "blocked")]));
    clock.fireAll();
    peer.observe("laptop", body([]));
    expect(push.sent.at(-1)).toEqual({ type: "clear", tag: "collie:herd@laptop" });
  });

  test("a host that leaves the crew has its outstanding alerts retracted and its slot dropped", () => {
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

// ── The lead's policy is the crew's policy ───────────────────────────────────

describe("PeerNotifier — the lead's snooze and prefs are crew-wide by construction", () => {
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
    expect(peer.tags().toSorted()).toEqual(["collie:herd@desktop", "collie:herd@laptop"]);
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

// ── Asks as data: the guard decides the push, not the way into blocked (ADR 0100) ──────────
describe("a peer's pane that carries asks", () => {
  function guarded() {
    const clock = new FakeClock();
    const push = new RecordingPush();
    let now = 1_000_000;
    const asks = new AskPush(new AskGuardStore(null), () => now);
    const peer = new PeerNotifier<number>({
      clock,
      push,
      mute: { isMuted: () => false },
      delayMs: 5_000,
      isNotifiable: (s) => s === "blocked" || s === "done",
      asks,
    });
    return { clock, push, peer, tick: (ms: number) => (now += ms) };
  }
  const ask = (id: string, toolCallId: string) => ({
    id,
    kind: "permission",
    toolCallId,
    revision: 1,
    title: "shell wants to run ls",
    itemId: "item-1",
    options: [{ id: "allow", label: "Allow", effect: "allow" as const }],
  });
  const blockedPanes = (push: RecordingPush) => push.sent.filter((m) => m.type !== "clear").length;

  test("a new ask pushes once, through the coordinator, and a later poll of the same ask does not", () => {
    const { clock, push, peer } = guarded();
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [ask("a1", "call-1")] })]));
    clock.fireAll();
    expect(blockedPanes(push)).toBe(1);
    expect(push.sent[0]?.host).toBe("laptop");
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [ask("a1", "call-1")] })]));
    clock.fireAll();
    expect(blockedPanes(push)).toBe(1);
  });

  test("two programs on one member that use the same tool call id each push once (M55: the session is in the key)", () => {
    const { clock, push, peer } = guarded();
    const desk = { session: "desk" };
    const cloud = { session: "cloud" };
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { ...desk, asks: [] }), pane("conv-2", "working", "durable", { ...cloud, asks: [] })]));
    peer.observe(
      "laptop",
      body([
        pane("conv-1", "blocked", "durable", { ...desk, asks: [ask("a1", "call-1")] }),
        pane("conv-2", "blocked", "durable", { ...cloud, asks: [ask("a1", "call-1")] }),
      ]),
    );
    clock.fireAll();
    // The guard let both through: the host's summary counts two blocked panes. Keyed by host and
    // tool call alone, the second would have read as known and been shown quietly.
    const sent = push.sent.filter((m) => m.type !== "clear");
    expect(sent.at(-1)).toMatchObject({ titleCode: "herd.blocked", titleDetail: { count: 2 } });
  });

  test("re-ask: a restarted program's same question under a new ask id is shown, not pushed", () => {
    const { clock, push, peer, tick } = guarded();
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [ask("a1", "call-1")] })]));
    clock.fireAll();
    expect(blockedPanes(push)).toBe(1);
    // The program restarts: the pane leaves, comes back idle, then blocked on the same call.
    tick(10_000);
    peer.observe("laptop", body([]));
    peer.observe("laptop", body([pane("conv-1", "idle", "durable", { asks: [] })]));
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [ask("a2", "call-1")] })]));
    clock.fireAll();
    expect(blockedPanes(push)).toBe(1);
  });

  test("a pane without asks still pushes on its way into blocked, as before", () => {
    const { clock, push, peer } = guarded();
    peer.observe("laptop", body([pane("w1:p1", "working")]));
    peer.observe("laptop", body([pane("w1:p1", "blocked")]));
    clock.fireAll();
    expect(blockedPanes(push)).toBe(1);
  });

  test("a hostile burst on one peer pane buzzes the phone once, not once per ask", () => {
    const { clock, push, peer } = guarded();
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    const burst = Array.from({ length: 50 }, (_, i) => ask(`a${String(i)}`, `call-${String(i)}`));
    // Five sweeps as the asks pile up, ten at a time, each sweep re-arming the debounce and firing it.
    for (let upTo = 10; upTo <= 50; upTo += 10) {
      peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: burst.slice(0, upTo) })]));
      clock.fireAll();
    }
    // The member lists every ask; the guard pushes three of them in the first sweep, which is one
    // alert for the pane, and nothing after.
    expect(blockedPanes(push)).toBe(1);
  });

  test("the lead's push for an ask is generic: the pane's push name, never the ask's title or tool line", () => {
    const { clock, push, peer } = guarded();
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    const secret = { ...ask("a1", "call-1"), title: "shell wants to run curl https://x/?token=hunter2", tool: { name: "shell", summary: "rm -rf /" } };
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [secret] })]));
    clock.fireAll();
    const msg = push.sent.find((m) => m.type !== "clear");
    expect(msg?.titleCode).toBe("ask.permission");
    expect(msg?.title).toBe("Permission needed in durable");
    const text = JSON.stringify(msg);
    for (const leak of ["hunter2", "curl", "rm -rf", "shell wants"]) expect(text).not.toContain(leak);
  });

  test("push words the program chose lead the push after the pane's name, with the line as the body", () => {
    const { clock, push, peer } = guarded();
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    const chosen = { ...ask("a1", "call-1"), push: { title: "Ticket 400 needs a yes", line: "write_note wants to add one line to notes.txt" } };
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [chosen] })]));
    clock.fireAll();
    const msg = push.sent.find((m) => m.type !== "clear");
    expect(msg?.title).toBe("durable: Ticket 400 needs a yes");
    // The program's words are not Collie's to translate, so the title carries no code.
    expect(msg?.titleCode).toBeUndefined();
    expect(msg?.body).toBe("laptop · write_note wants to add one line to notes.txt");
    // The ask's own title and tool line still never cross.
    expect(JSON.stringify(msg)).not.toContain("shell wants");
  });

  test("a push title alone keeps the place as the body, and a push line alone keeps the generic headline", () => {
    const titleOnly = guarded();
    titleOnly.peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    titleOnly.peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [{ ...ask("a1", "call-1"), push: { title: "Needs a yes" } }] })]));
    titleOnly.clock.fireAll();
    const first = titleOnly.push.sent.find((m) => m.type !== "clear");
    expect(first?.title).toBe("durable: Needs a yes");
    expect(first?.body).toBe("laptop · collie");

    const lineOnly = guarded();
    lineOnly.peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    lineOnly.peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [{ ...ask("a1", "call-1"), push: { line: "One line." } }] })]));
    lineOnly.clock.fireAll();
    const second = lineOnly.push.sent.find((m) => m.type !== "clear");
    expect(second?.titleCode).toBe("ask.permission");
    expect(second?.title).toBe("Permission needed in durable");
    expect(second?.body).toBe("laptop · One line.");
  });

  test("the lead cleans and cuts the words a member sent, and ignores a push that is not text", () => {
    const { clock, push, peer } = guarded();
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    const hostile = { ...ask("a1", "call-1"), push: { title: `T\u0007${"t".repeat(100)}\u202e`, line: `${"l".repeat(300)}`, extra: "ignored" } };
    peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [hostile] })]));
    clock.fireAll();
    const msg = push.sent.find((m) => m.type !== "clear");
    // 60 characters of the title (the control and the direction mark are gone), 120 of the line.
    expect(msg?.title).toBe(`durable: T${"t".repeat(59)}`);
    expect(msg?.body).toBe(`laptop · ${"l".repeat(120)}`);

    const odd = guarded();
    odd.peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    const wrong = { ...ask("a1", "call-1"), push: { title: 7, line: null } };
    odd.peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [JSON.parse(JSON.stringify(wrong))] })]));
    odd.clock.fireAll();
    expect(odd.push.sent.find((m) => m.type !== "clear")?.title).toBe("Permission needed in durable");
  });

  test("the words change nothing about the guard: a repeated ask with words pushes once", () => {
    const { clock, push, peer } = guarded();
    const chosen = { ...ask("a1", "call-1"), push: { title: "Needs a yes" } };
    peer.observe("laptop", body([pane("conv-1", "working", "durable", { asks: [] })]));
    for (let i = 0; i < 4; i++) {
      peer.observe("laptop", body([pane("conv-1", "blocked", "durable", { asks: [chosen] })]));
      clock.fireAll();
    }
    expect(blockedPanes(push)).toBe(1);
  });

  test("past 30 pushes in an hour, the lead sends one summary for the host and then nothing", () => {
    const { clock, push, peer, tick } = guarded();
    const panes: ReturnType<typeof pane>[] = [];
    let floods = 0;
    for (let i = 0; i < 40; i++) {
      panes.push(pane(`conv-${String(i)}`, "blocked", "durable", { asks: [ask(`a${String(i)}`, `call-${String(i)}`)] }));
      peer.observe("laptop", body([...panes]));
      clock.fireAll();
      tick(7_000);
    }
    floods = push.sent.filter((m) => m.titleCode === "ask.flood").length;
    expect(floods).toBe(1);
    const summary = push.sent.find((m) => m.titleCode === "ask.flood");
    expect(summary?.title).toBe("A durable agent on laptop is raising many asks");
    expect(summary?.host).toBe("laptop");
  });
});
