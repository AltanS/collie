import { describe, expect, test } from "bun:test";

import { EventPoker, sameIdSet } from "./event-poker.ts";
import { HerdrMux } from "./mux/herdr/adapter.ts";
import { buildSubscriptions } from "./mux/herdr/events.ts";
import type { HerdrClient } from "./mux/herdr/client.ts";
import type { MuxAdapter } from "./mux/types.ts";

// EventPoker owns the watch lifecycle (ack → healthy, events → debounced poke, down → backoff
// reconnect). The socket itself lives in HerdrClient.subscribeEvents and stays untested; here we
// fake it so tests drive ack/event/down synchronously and assert the decisions.
//
// The poker talks the mux port, so the fake socket is wrapped in the REAL Herdr adapter: the
// subscription list and the event→callback split are then exercised rather than restated.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * HerdrClient carries private socket fields, so no fake can ever *be* one structurally.
 * `Partial<HerdrClient>` keeps `subscribeEvents` checked against the real signature; only the "the
 * rest is never reached" step is asserted.
 */
function asMux(fake: Partial<HerdrClient>): MuxAdapter {
  // SAFETY: a watch calls nothing on its client but `subscribeEvents`, which FakeClient implements;
  // no other member is reachable from the poker's code paths.
  return new HerdrMux(fake as HerdrClient);
}

// Derived from the real client rather than restated, so a change to the subscription contract shows
// up here as a typecheck failure instead of a fake that silently drifts out of shape.
type SubscribeOpts = Parameters<HerdrClient["subscribeEvents"]>[0];
type EventStream = ReturnType<HerdrClient["subscribeEvents"]>;

interface FakeStream extends SubscribeOpts {
  closed: boolean;
}

class FakeClient {
  readonly streams: FakeStream[] = [];
  subscribeEvents(opts: SubscribeOpts): EventStream {
    const stream: FakeStream = { ...opts, closed: false };
    this.streams.push(stream);
    return {
      close: () => {
        if (stream.closed) return;
        stream.closed = true;
        stream.onDown("closed");
      },
    };
  }
  get last(): FakeStream {
    const s = this.streams[this.streams.length - 1];
    if (!s) throw new Error("no stream");
    return s;
  }
}

function makePoker(opts?: { debounceMs?: number; backoffMs?: number[] }) {
  const client = new FakeClient();
  const poker = new EventPoker(asMux(client), {
    debounceMs: opts?.debounceMs ?? 10,
    backoffMs: opts?.backoffMs ?? [10, 20],
  });
  const pokes: number[] = [];
  const health: boolean[] = [];
  poker.onPoke(() => pokes.push(1));
  poker.onHealth((h) => health.push(h));
  return { client, poker, pokes, health };
}

describe("buildSubscriptions / sameIdSet", () => {
  test("emits the global set (no layout/worktree/scroll/output) plus one scoped status sub per pane", () => {
    const subs = buildSubscriptions(["w1:p1", "w2:p3"]);
    const types = subs.map((s) => s.type);
    expect(types).toContain("pane.created");
    expect(types).toContain("pane.agent_detected");
    expect(types).toContain("workspace.focused");
    expect(types).not.toContain("layout.updated");
    expect(types).not.toContain("pane.scroll_changed");
    expect(types).not.toContain("pane.output_matched");
    const scoped = subs.filter((s) => s.type === "pane.agent_status_changed");
    expect(scoped).toEqual([
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w2:p3" },
    ]);
    // Globals are unscoped.
    expect(subs.find((s) => s.type === "pane.created")?.pane_id).toBeUndefined();
  });

  test("sameIdSet ignores order and duplicates", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet(["a", "a", "b"], ["a", "b"])).toBe(true);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

describe("EventPoker — health", () => {
  test("goes healthy on ack and unhealthy on down, notifying each transition once", () => {
    const { client, poker, health } = makePoker();
    poker.start();
    expect(client.streams.length).toBe(1);
    client.last.onUp();
    client.last.onUp(); // duplicate ack — no second notify
    expect(health).toEqual([true]);
    client.last.onDown("socket error");
    expect(health).toEqual([true, false]);
    poker.stop();
  });
});

describe("EventPoker — reconcile on coming up", () => {
  test("the transition to healthy pokes once — the watch missed everything before it existed", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 10 });
    poker.start();
    expect(pokes.length).toBe(0); // subscribing is not yet knowing
    client.last.onUp();
    await sleep(25);
    // Nothing "happened" — no event was delivered. The poke rides the transition itself, because a
    // stream that was dark cannot have reported what changed while it was dark.
    expect(pokes.length).toBe(1);
    poker.stop();
  });

  test("a resubscribe while already healthy does not poke by itself", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 10 });
    poker.start();
    client.last.onUp();
    await sleep(25);
    expect(pokes.length).toBe(1);
    // The herd changed, so the watch is re-scoped over a LIVE stream. That ack is not a recovery
    // from darkness, and must not be paid for with a second reconcile.
    poker.setAgentPanes(["w1:p1"]);
    client.last.onUp();
    await sleep(25);
    expect(pokes.length).toBe(1);
    poker.stop();
  });
});

describe("EventPoker — debounced poke", () => {
  test("coalesces a burst of events into a single trailing poke", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 10 });
    poker.start();
    client.last.onUp();
    client.last.onEvent("pane_created", {});
    client.last.onEvent("pane_agent_detected", {});
    client.last.onEvent("pane_agent_detected", {});
    expect(pokes.length).toBe(0); // still within the debounce window
    await sleep(25);
    expect(pokes.length).toBe(1); // burst collapsed to one poke
    poker.stop();
  });
});

describe("EventPoker — reconnect backoff", () => {
  test("reconnects after a down per the backoff schedule and resets on the next ack", async () => {
    const { client, poker, health } = makePoker({ backoffMs: [15, 40] });
    poker.start();
    client.last.onUp();
    client.last.onDown("boom");
    expect(client.streams.length).toBe(1); // not yet — waiting out the backoff
    await sleep(30);
    expect(client.streams.length).toBe(2); // reconnected (first backoff step)
    client.last.onUp(); // healthy again → backoff reset
    expect(health).toEqual([true, false, true]);
    poker.stop();
  });
});

describe("EventPoker — resubscribe on pane-set change", () => {
  test("reconnects with the new scoped subscriptions and skips a no-op set", () => {
    const { client, poker } = makePoker();
    poker.start();
    client.last.onUp();
    expect(client.streams.length).toBe(1);

    poker.setAgentPanes(["w1:p1"]);
    expect(client.streams.length).toBe(2); // resubscribed
    expect(client.streams[0]!.closed).toBe(true); // old stream torn down
    expect(
      client.last.subscriptions.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "w1:p1"),
    ).toBe(true);

    poker.setAgentPanes(["w1:p1"]); // same set — no churn
    expect(client.streams.length).toBe(2);
    poker.stop();
  });
});

describe("EventPoker — stop()", () => {
  test("closes the stream, cancels a pending reconnect, and never reconnects afterward", async () => {
    const { client, poker } = makePoker({ backoffMs: [10] });
    poker.start();
    client.last.onUp();
    client.last.onDown("boom"); // schedules a reconnect
    poker.stop();
    await sleep(30);
    expect(client.streams.length).toBe(1); // the scheduled reconnect was cancelled
  });

  test("closing an up stream on stop() does not flip health or schedule work", async () => {
    const { client, poker, health } = makePoker();
    poker.start();
    client.last.onUp();
    poker.stop();
    expect(client.last.closed).toBe(true); // stop() closed it
    expect(health).toEqual([true]); // the deliberate close is stale — no spurious unhealthy
    await sleep(20);
    expect(client.streams.length).toBe(1);
  });
});
