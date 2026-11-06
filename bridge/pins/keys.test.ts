import { describe, expect, test } from "bun:test";

import { grokJournal } from "../journal/grok.ts";
import type { AgentSessionRef, JournalAdapter } from "../journal/types.ts";
import { resolvePinSession } from "../server.ts";
import type { AgentView } from "../types.ts";
import { pinSessionKey } from "./key.ts";
import { PIN_KEY_TTL_MS, PinKeys } from "./keys.ts";
import { PinStore } from "./store.ts";

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function clock() {
  let at = 1_000;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

describe("PinKeys", () => {
  test("a derived key answers at once and asks nothing", () => {
    const keys = new PinKeys();
    let asked = 0;
    const resolve = async () => (asked += 1, "claude.never");
    expect(keys.keyOf("p", "fp", "claude.s1", resolve)).toBe("claude.s1");
    expect(asked).toBe(0);
  });

  test("a key only the resolver can settle reads null until it lands, then stands", async () => {
    const keys = new PinKeys();
    let asked = 0;
    const resolve = async () => (asked += 1, "grok.s2");
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBeNull();
    // A second snapshot while the question is out asks nothing more.
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBeNull();
    await flush();
    expect(asked).toBe(1);
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBe("grok.s2");
    expect(asked).toBe(1);
  });

  test("a resolved key is asked again after the ttl and keeps its old value until the answer comes", async () => {
    const time = clock();
    const keys = new PinKeys(time.now);
    let answer = "grok.old";
    const resolve = async () => answer;
    keys.keyOf("p", "fp", undefined, resolve);
    await flush();
    answer = "grok.new";
    time.advance(PIN_KEY_TTL_MS - 1);
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBe("grok.old");
    await flush();
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBe("grok.old");
    time.advance(1);
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBe("grok.old");
    await flush();
    expect(keys.keyOf("p", "fp", undefined, resolve)).toBe("grok.new");
  });

  test("a changed pane instance or ref drops the old key: the badge never counts the old session", async () => {
    const keys = new PinKeys();
    keys.remember("p", "instance-1", "muse.old");
    expect(keys.keyOf("p", "instance-1", undefined, async () => "muse.x")).toBe("muse.old");
    // The pane id was reused, or a /clear moved the ref: another fingerprint.
    let release: (key: string) => void = () => {};
    const slow = new Promise<string>((done) => void (release = done));
    expect(keys.keyOf("p", "instance-2", undefined, () => slow)).toBeNull();
    release("muse.new");
    await flush();
    expect(keys.keyOf("p", "instance-2", undefined, async () => "muse.x")).toBe("muse.new");
  });

  test("an answer that arrives after the pane moved on is dropped", async () => {
    const keys = new PinKeys();
    let release: (key: string) => void = () => {};
    const slow = new Promise<string>((done) => void (release = done));
    keys.keyOf("p", "fp-1", undefined, () => slow);
    // The fingerprint moved before the first answer came back.
    expect(keys.keyOf("p", "fp-2", undefined, async () => "fresh")).toBeNull();
    release("stale");
    await flush();
    await flush();
    expect(keys.keyOf("p", "fp-2", undefined, async () => "other")).toBe("fresh");
  });

  test("a resolver that throws keeps the old key, and a route's remember replaces it", async () => {
    const time = clock();
    const keys = new PinKeys(time.now);
    keys.remember("p", "fp", "grok.a");
    time.advance(PIN_KEY_TTL_MS);
    keys.keyOf("p", "fp", undefined, async () => {
      throw new Error("down");
    });
    await flush();
    expect(keys.keyOf("p", "fp", undefined, async () => "grok.zzz")).toBe("grok.a");
    keys.remember("p", "fp", "grok.b");
    expect(keys.keyOf("p", "fp", undefined, async () => "grok.zzz")).toBe("grok.b");
  });
});

describe("the badge and the list name one session, also for a reconciled ref", () => {
  const reported: AgentSessionRef = { kind: "id", value: "00000000-0000-7000-8000-00000000a001" };
  const resumed: AgentSessionRef = { kind: "id", value: "00000000-0000-7000-8000-00000000b002" };
  const pane: AgentView = {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "Main",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "grok",
    status: "idle",
    cwd: "/home/op/proj",
    focused: false,
    agentSession: reported,
  };
  const adapter: JournalAdapter = { ...grokJournal([]), discover: undefined, reconcile: async () => resumed };
  const engine = { current: () => ({ agents: [pane], shellPanes: [] }) };
  const cfg = { transcript: true };
  const journals = { grok: adapter };
  // SAFETY: the resolver reads no multiplexer for a pane that reports its session, so none of its methods run.
  const mux: Parameters<typeof resolvePinSession>[3] = { readGrid: async () => ({ ok: false, reason: "unsupported" }) } as never;
  const resolve = () => resolvePinSession(cfg, journals, engine, mux, "w1:p1");

  test("the badge counts the session the route lists", async () => {
    const store = new PinStore(null);
    const route = await resolve();
    expect(route?.key).toBe(pinSessionKey("grok", resumed));
    store.add(route!.key, { itemId: "a:0", kind: "reply", text: "kept" });
    // What the old badge derived from the reported ref: another session, with no pins.
    expect(store.count(pinSessionKey("grok", reported))).toBe(0);

    const keys = new PinKeys();
    const count = () => {
      // The adapter reconciles, so nothing is derived: only the route's resolver can say.
      const key = keys.keyOf("s\u0000w1:p1", "fp", undefined, async () => (await resolve())?.key ?? null);
      return key === null ? 0 : store.count(key);
    };
    expect(count()).toBe(0);
    await flush();
    await flush();
    expect(count()).toBe(1);
    expect(store.list(route!.key)).toHaveLength(count());
  });
});
