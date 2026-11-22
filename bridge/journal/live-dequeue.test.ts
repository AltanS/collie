// The take-back's journal side (ADR 0122, the 2026-11-22 addendum): the live window's `dequeueQueued`
// field rides only where the harness declares a dequeue key, the chat route drops it where the
// multiplexer cannot deliver the key (as it drops `sendQueuedNow`), `LiveWindows.queueNow` reads the log
// again past the tick floor and answers the reducer's queue mark, and Claude Code is the one harness
// that declares the key. Also the Send Protocol's memory forgets a taken text (QueuedSends.takenBack).

import { describe, expect, test } from "bun:test";
import { chatBodyForMux } from "../server.ts";
import { declareCapabilities } from "../mux/capabilities.ts";
import { canonicalMuxKey } from "../mux/keys.ts";
import { QueuedSends } from "../surface/queued.ts";
import { createClaudeReducer } from "./claude.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { LiveWindows, type ChatWindowBody } from "./live.ts";
import { buildJournalRegistry } from "./registry.ts";
import { TranscriptStore } from "./store.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptSource } from "./types.ts";

const ref: AgentSessionRef = { kind: "id", value: "s1" };
const queueOp = (operation: string, content?: string): string => JSON.stringify({ type: "queue-operation", operation, timestamp: "2026-11-22T10:00:00.000Z", sessionId: "s1", content });

/** A Claude Code log in memory: the real reducer, a source whose stat moves with every row, a clock the test holds. */
function claudeLog(lines: string[] = []) {
  const state = { lines: [...lines], reads: 0 };
  const clock = { now: 100_000 };
  const source: TranscriptSource = {
    resolve: async (r) => (r.value === "none" ? null : `/fake/${r.value}.jsonl`),
    stat: async () => ({ size: state.lines.length, mtimeMs: 1000 + state.lines.length }),
    load: async () => ({ text: state.lines.join("\n"), complete: true, size: state.lines.length, mtimeMs: 1000 }),
    readSince: async (key, cursor) => {
      state.reads++;
      const at = decodeCursor(cursor, "bytes", key);
      const reset = at === null || at > state.lines.length;
      return { lines: state.lines.slice(reset ? 0 : at), cursor: encodeCursor("bytes", key, state.lines.length), reset, fromStart: reset };
    },
  };
  const adapter: JournalAdapter = { agent: "claude", source, parse: () => [], reducer: () => createClaudeReducer(), dequeue: { keys: ["Up"], proof: "back" } };
  return { state, clock, adapter, live: new LiveWindows(new TranscriptStore(), () => clock.now) };
}

describe("the chat answer's dequeueQueued", () => {
  test("rides the body only when the harness declares a dequeue key", async () => {
    const log = claudeLog([queueOp("enqueue", "waiting")]);
    const declared = await log.live.window(log.adapter, ref, { limit: 10 });
    expect(declared!.dequeueQueued).toEqual(["Up"]);
    const { dequeue: _none, ...bare } = log.adapter;
    const plain = claudeLog([queueOp("enqueue", "waiting")]);
    const body = await plain.live.window(bare, ref, { limit: 10 });
    expect("dequeueQueued" in body!).toBe(false);
  });

  test("the route drops it where the multiplexer cannot deliver the key, and keeps everything else", () => {
    const body: ChatWindowBody = { page: "live", gen: 1, session: "s1", rev: 3, head: 3, oldest: 1, hasOlder: false, upserts: [], queued: ["sign off"], sendQueuedNow: ["ctrl+Enter"], dequeueQueued: ["Up"] };
    const mux = (supports: ("sendKeys" | "readGrid")[], unsupportedKeys: string[]) => declareCapabilities({ supports, unsupportedKeys, topologyLatency: { kind: "push" } });
    expect(chatBodyForMux(body, mux(["sendKeys"], []))).toBe(body);
    const noUp = chatBodyForMux(body, mux(["sendKeys"], ["Up"]));
    expect("dequeueQueued" in noUp).toBe(false);
    expect(noUp).toMatchObject({ sendQueuedNow: ["ctrl+Enter"] });
    // A multiplexer that sends no keys at all offers neither button.
    const none = chatBodyForMux(body, mux(["readGrid"], []));
    expect(none).not.toHaveProperty("dequeueQueued");
    expect(none).not.toHaveProperty("sendQueuedNow");
  });
});

describe("LiveWindows.queueNow", () => {
  test("reads the log again inside the tick floor, so a row written a moment ago counts", async () => {
    const log = claudeLog([queueOp("enqueue", "first")]);
    await log.live.window(log.adapter, ref, { limit: 10 });
    log.state.lines.push(queueOp("popAll", "first"));
    // No time passed: a poll would answer from the floor; the take-back must not.
    const now = await log.live.queueNow(log.adapter, ref);
    expect(now!.mark.texts).toEqual([]);
    expect(now!.mark.recent.at(-1)).toEqual({ n: 2, kind: "back", words: "first" });
  });

  test("answers the generation, null for a ref that names nothing, and the same window the chat reads", async () => {
    const log = claudeLog([queueOp("enqueue", "first")]);
    const body = await log.live.window(log.adapter, ref, { limit: 10 });
    const now = await log.live.queueNow(log.adapter, ref);
    expect(now!.gen).toBe(body!.gen);
    expect(now!.mark.texts).toEqual(["first"]);
    expect(await log.live.queueNow(log.adapter, { kind: "id", value: "none" })).toBeNull();
  });

  test("a reducer that keeps no queue mark answers null", async () => {
    const log = claudeLog([]);
    const marklessReducer = () => {
      const { queueMark: _none, ...rest } = createClaudeReducer();
      return rest;
    };
    expect(await log.live.queueNow({ ...log.adapter, reducer: marklessReducer }, ref)).toBeNull();
  });
});

describe("the registry", () => {
  test("Claude Code declares Up with the journal's `back` proof, and no other harness declares a dequeue key", () => {
    const registry = buildJournalRegistry({ agy: ["/a"], claude: ["/c"], codex: ["/x"], pi: ["/p"], opencode: ["/o"], grok: ["/g"], hermes: ["/h"], kiro: ["/k"], "dsh-tui": ["/d"], mcode: ["/mc"], muse: ["/m"], openclaw: ["/oc"] });
    expect(registry.claude!.dequeue).toEqual({ keys: ["Up"], proof: "back" });
    for (const key of registry.claude!.dequeue!.keys) expect(canonicalMuxKey(key)).toBe(key);
    for (const [agent, adapter] of Object.entries(registry)) {
      if (agent !== "claude") expect(adapter.dequeue).toBeUndefined();
    }
  });
});

describe("QueuedSends.takenBack", () => {
  const sends = () =>
    new QueuedSends({
      store: { list: () => [], markReturned: () => true },
      generation: () => "claude:s",
      matches: () => false,
      now: () => 1_000,
      busy: () => false,
    });
  const add = (q: QueuedSends, id: string, text: string) => q.add({ id, session: "main", paneId: "%1", generation: "claude:s", text, collapse: null, at: 1_000 });

  test("each taken text drops the oldest open send with the same text, once, on this pane only", () => {
    const q = sends();
    add(q, "a1", "same words");
    add(q, "a2", "same  words");
    add(q, "a3", "other");
    q.takenBack("main", "%1", ["same words"]);
    expect(q.of("main", "%1").map((card) => card.requestId)).toEqual(["a2", "a3"]);
    q.takenBack("main", "%2", ["other"]);
    expect(q.of("main", "%1").map((card) => card.requestId)).toEqual(["a2", "a3"]);
  });
});
