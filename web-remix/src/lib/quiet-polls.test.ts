/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ServerSummary, SnapshotResponse } from "@web/lib/types";

import { IDLE_MS } from "./polling";
import { CREW_HEALTH_POLL_MS, samePaneRead, sameSnapshot } from "./same";

// QUIET POLLS (REMIX3.md, "A module store is right when"): a poll whose payload did not change wakes
// nobody. The three polled stores are driven here through their real poll functions over a fake
// `fetch` that answers the same payload ten times; each store's subscriber must hear exactly the
// first answer. Freshness (`snapshotAt`) is the one store that moves on every answer.

const PANE_TEXT = "\u001b[1mhello\u001b[0m\n> ";

function herd(ts: number, status: "idle" | "working" = "idle"): SnapshotResponse {
  return {
    bridge: "connected",
    ts,
    agents: [{ paneId: "w1:p1", agent: "claude", status, workspaceId: "w1", workspaceLabel: "w", workspaceNumber: 1, tabId: "w1:t1", cwd: "/", focused: false }],
    shellPanes: [],
    workspaces: [],
    tabs: [],
  };
}

let tick = 0;
let snapshotBody: () => SnapshotResponse = () => herd(++tick);
const realFetch = globalThis.fetch;
const saved = new Map(["document", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

beforeAll(() => {
  Object.assign(globalThis, {
    document: { querySelector: () => null, visibilityState: "visible" },
    window: { setTimeout, clearTimeout },
  });
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://bridge.test");
    const etag = (init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)).get("if-none-match");
    if (url.pathname === "/api/snapshot") return Response.json(snapshotBody()); // no ETag, a new `ts` each read
    if (url.pathname.endsWith("/chat")) {
      if (etag === '"chat-1"') return new Response(null, { status: 304 });
      return Response.json({ available: true, page: "live", gen: 1, rev: 1, head: 0, oldest: 1, hasOlder: false, upserts: [], queued: [] }, { headers: { etag: '"chat-1"' } });
    }
    if (url.pathname.startsWith("/api/pane/")) {
      if (etag === '"pane-1"') return new Response(null, { status: 304, headers: { etag: '"pane-1"' } });
      return Response.json({ paneId: "w1:p1", text: PANE_TEXT, truncated: false, revision: 7 }, { headers: { etag: '"pane-1"' } });
    }
    return new Response("not stubbed", { status: 404 });
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("ten identical polls, zero change events", () => {
  test("snapshot: the body differs only in `ts`; freshness moves on every answer", async () => {
    const { loadSnapshot, snapshot, snapshotAt } = await import("./data");
    let changes = 0;
    let answers = 0;
    snapshot.subscribe(() => changes++);
    snapshotAt.subscribe(() => answers++);
    const signal = new AbortController().signal;
    expect(await loadSnapshot(signal)).toBe(true);
    const first = snapshot.get().data;
    changes = 0;
    for (let i = 0; i < 10; i++) expect(await loadSnapshot(signal)).toBe(false);
    expect(changes).toBe(0);
    expect(snapshot.get().data).toBe(first);
    expect(answers).toBe(11);

    // A real change still publishes, once.
    snapshotBody = () => herd(++tick, "working");
    expect(await loadSnapshot(signal)).toBe(true);
    expect(changes).toBe(1);
  });

  test("pane mirror: a 304 hands back a new object with the same screen", async () => {
    const { paneStore } = await import("./data");
    const { pollPane } = await import("../routes/pane/data");
    const store = paneStore("quiet-test:w1:p1");
    let changes = 0;
    store.subscribe(() => changes++);
    const signal = new AbortController().signal;
    expect(await pollPane("quiet-test:w1:p1", "w1:p1", {}, signal)).toBe(true);
    expect(changes).toBe(1);
    for (let i = 0; i < 10; i++) expect(await pollPane("quiet-test:w1:p1", "w1:p1", {}, signal)).toBe(false);
    expect(changes).toBe(1);
  });

  test("chat window: the counters move, the store does not", async () => {
    const { chatReads, chatStore, pollChat } = await import("../routes/pane/chat-store");
    const store = chatStore("quiet-test:w1:p1");
    const reads = chatReads("quiet-test:w1:p1");
    let changes = 0;
    store.subscribe(() => changes++);
    const signal = new AbortController().signal;
    await pollChat("quiet-test:w1:p1", "w1:p1", {}, signal);
    const afterFirst = changes;
    expect(afterFirst).toBe(1);
    for (let i = 0; i < 10; i++) await pollChat("quiet-test:w1:p1", "w1:p1", {}, signal);
    expect(changes).toBe(afterFirst);
    expect(reads.asked).toBe(11);
    expect(reads.replies.get()).toBe(11);
  });
});

describe("sameSnapshot", () => {
  const member = (lastSeenAt: number): ServerSummary => ({
    id: "peer",
    name: "peer",
    isLead: false,
    reachable: true,
    lastSeenAt,
    protocol: "ok",
  });
  const lead: ServerSummary = { id: "lead", name: "lead", isLead: true, reachable: true, lastSeenAt: 1, protocol: "ok" };

  test("ignores `ts` alone on a solo herd", () => {
    expect(sameSnapshot(herd(1), herd(2))).toBe(true);
    expect(sameSnapshot(herd(1), herd(1, "working"))).toBe(false);
  });

  test("a member going stale by `ts` alone is a change", () => {
    const at = 1_000_000;
    const held = { ...herd(at), servers: [lead, member(at)] };
    expect(sameSnapshot(held, { ...herd(at + 1000), servers: [lead, member(at)] })).toBe(true);
    // Past the tolerance (3 x the idle beat) the member's presented state flips to stale.
    expect(sameSnapshot(held, { ...herd(at + 4 * CREW_HEALTH_POLL_MS), servers: [lead, member(at)] })).toBe(false);
  });

  test("the crew cadence is the idle beat", () => {
    expect(CREW_HEALTH_POLL_MS).toBe(IDLE_MS);
  });
});

describe("samePaneRead", () => {
  const read = { paneId: "p", text: "a", truncated: false, revision: 1 };
  test("the client's notModified flag is not payload; the revision is", () => {
    expect(samePaneRead(read, { ...read, notModified: true })).toBe(true);
    expect(samePaneRead(read, { ...read, revision: 2 })).toBe(false);
    expect(samePaneRead(read, undefined)).toBe(false);
  });
});
