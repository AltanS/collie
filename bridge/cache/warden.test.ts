import { describe, expect, test } from "bun:test";

import { CacheWarden, type CacheWardenDeps } from "./warden.ts";
import { sentMarkOf, watchKeyOf, type CacheWarnPane } from "./watch-key.ts";
import type { CacheWatchLedger, CacheWatchSent } from "./watch.ts";
import type { PushMessage } from "../push.ts";
import type { PaneCache } from "./engine.ts";

// `bridge/update.test.ts`'s `makeMonitor` pattern, for the same reason: there is no
// `bridge/index.test.ts`, so the wiring site in index.ts is a deps literal with no logic in it and
// every gate is proved here — a movable clock, a recording `send`, and a ledger in memory.

const NOW = 1_789_000_000_000;

function reading(over: Partial<PaneCache> = {}): PaneCache {
  return {
    state: "warm",
    expiresAt: NOW + 4 * 60_000,
    ttlSeconds: 600,
    ruleId: "claude.subscription",
    confidence: "documented",
    ...over,
  };
}

function pane(over: Partial<CacheWarnPane> = {}): CacheWarnPane {
  const ref = over.ref ?? "id:abc";
  return {
    key: watchKeyOf({ ref, host: over.host, session: over.session }),
    ref,
    paneId: "w1:p1",
    label: "collie · claude",
    cache: reading(),
    ...over,
  };
}

/** A ledger in memory: the store's contract without its file, its clock or its prunes. */
function fakeLedger(watched: readonly string[] = []) {
  const keys = new Set(watched);
  const marks = new Set<string>();
  const seenAt = new Map<string, number>();
  const saves: CacheWatchSent[][] = [];
  const ledger: CacheWatchLedger = {
    has: (key) => keys.has(key),
    sentMarks: () => marks,
    seen: (ks, at) => {
      for (const k of ks) seenAt.set(k, at);
    },
    markSent: async (pairs) => {
      saves.push([...pairs]);
      for (const p of pairs) marks.add(sentMarkOf(p.key, p.expiresAt));
    },
  };
  return { ledger, keys, marks, seenAt, saves };
}

function makeWarden(over: Partial<CacheWardenDeps> = {}) {
  const sent: PushMessage[] = [];
  const fake = fakeLedger();
  let clock = NOW;
  const warden = new CacheWarden({
    now: () => clock,
    muted: () => false,
    globalOn: () => false,
    store: fake.ledger,
    warnSeconds: 300,
    send: (msg) => sent.push(msg),
    ...over,
  });
  return { warden, sent, ...fake, tick: (ms: number) => (clock += ms) };
}

describe("CacheWarden", () => {
  test("a watched pane warns exactly once, and records the pair it warned on", () => {
    const fake = fakeLedger([pane().key]);
    const { warden, sent } = makeWarden({ store: fake.ledger });
    warden.tick([pane()]);
    expect(sent).toHaveLength(1);
    expect(fake.saves).toEqual([[{ key: pane().key, expiresAt: reading().expiresAt! }]]);
    // Every poll after it reads the same deadline, and the recorded pair suppresses every one.
    warden.tick([pane()]);
    warden.tick([pane()]);
    expect(sent).toHaveLength(1);
  });

  test("a pane nobody watches says nothing until the global switch goes on", () => {
    let on = false;
    const { warden, sent } = makeWarden({ globalOn: () => on });
    warden.tick([pane()]);
    expect(sent).toEqual([]);
    on = true;
    warden.tick([pane()]);
    expect(sent).toHaveLength(1);
  });

  test("the global switch covers a pane with no entry of its own", () => {
    const { warden, sent, marks } = makeWarden({ globalOn: () => true });
    warden.tick([pane()]);
    expect(sent).toHaveLength(1);
    // The mark is kept even though nothing is on the list, or a restart would re-warn it.
    expect(marks.size).toBe(1);
  });

  test("a muted bridge sends NOTHING and records nothing, so a snooze ending inside the window warns", () => {
    let muted = true;
    const { warden, sent, marks } = makeWarden({ globalOn: () => true, muted: () => muted });
    warden.tick([pane()]);
    expect(sent).toEqual([]);
    expect(marks.size).toBe(0);
    muted = false;
    warden.tick([pane()]);
    expect(sent).toHaveLength(1);
  });

  test("the grace clock is refreshed even while muted — a snooze may not age a list out", () => {
    const fake = fakeLedger([pane().key]);
    const { warden } = makeWarden({ store: fake.ledger, muted: () => true });
    warden.tick([pane()]);
    expect(fake.seenAt.get(pane().key)).toBe(NOW);
  });

  test("the title's minutes follow COLLIE_CACHE_WARN_SECONDS", () => {
    const { warden, sent } = makeWarden({
      globalOn: () => true,
      warnSeconds: 600,
    });
    warden.tick([pane({ cache: reading({ ttlSeconds: 3600, expiresAt: NOW + 9 * 60_000 }) })]);
    expect(sent[0]!.title).toBe("Cache goes cold in about 10 min");
  });

  test("nothing due means no send and no save at all", () => {
    const { warden, sent, saves } = makeWarden({ globalOn: () => true });
    warden.tick([pane({ cache: reading({ expiresAt: NOW + 9 * 60_000 }) })]);
    expect(sent).toEqual([]);
    // The file is written by two events, and "a poll happened" is not one of them.
    expect(saves).toEqual([]);
  });

  test("a clock that moves brings the next pane's deadline into the window", () => {
    const { warden, sent, tick } = makeWarden({ globalOn: () => true });
    const far = pane({ cache: reading({ ttlSeconds: 1800, expiresAt: NOW + 20 * 60_000 }) });
    warden.tick([far]);
    expect(sent).toEqual([]);
    tick(16 * 60_000);
    warden.tick([far]);
    expect(sent).toHaveLength(1);
  });

  test("a peer's pane warns from here, which is where the subscriptions are", () => {
    const { warden, sent } = makeWarden({ globalOn: () => true });
    warden.tick([pane({ host: "minibuch", paneId: "w2:p1" })]);
    expect(sent[0]).toMatchObject({ host: "minibuch", paneId: "w2:p1" });
  });

  test("an empty tick is a no-op, which is every poll on an instance with no agent panes", () => {
    const { warden, sent, saves } = makeWarden({ globalOn: () => true });
    warden.tick([]);
    expect(sent).toEqual([]);
    expect(saves).toEqual([]);
  });
});
