import { describe, expect, test } from "bun:test";

import { cacheWarnings, warnMinutes } from "./warn.ts";
import { watchKeyOf, type CacheWarnPane } from "./watch-key.ts";
import type { PaneCache } from "./engine.ts";

// The decision, driven as data: no timers, no push, no clock. Every gate in the module header gets a
// case, and the two that nobody expects — a TTL shorter than the window, and a muted bridge recording
// nothing — get the longest ones.

const NOW = 1_789_000_000_000;
const WARN = 300;

function reading(over: Partial<PaneCache> = {}): PaneCache {
  return {
    state: "warm",
    // Four minutes left on a ten-minute rule: inside the five-minute window, and the window is well
    // short of the TTL, so this is the ordinary "warn me" shape.
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

/** The ordinary call: one watched pane, nothing sent yet, the bridge's own window. */
function warn(panes: readonly CacheWarnPane[], over: { sent?: ReadonlySet<string>; nowMs?: number } = {}) {
  return cacheWarnings({
    panes,
    watched: () => true,
    nowMs: over.nowMs ?? NOW,
    warnSeconds: WARN,
    sent: over.sent ?? new Set(),
  });
}

describe("warnMinutes", () => {
  test("whole minutes, with one as the floor — 'about 0 min' is unsayable", () => {
    expect(warnMinutes(300)).toBe(5);
    expect(warnMinutes(310)).toBe(5);
    expect(warnMinutes(30)).toBe(1);
  });
});

describe("cacheWarnings", () => {
  test("a warm pane inside the window earns one message, and the pair to record with it", () => {
    const p = pane();
    const out = warn([p]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      title: "Cache goes cold in about 5 min",
      body: "collie · claude. One warning per cycle.",
      paneId: "w1:p1",
      renotify: true,
    });
    expect(out.sentPairs).toEqual([{ key: p.key, expiresAt: p.cache!.expiresAt! }]);
  });

  test("a pane cold from a pending reset never warns, however much clock is left (issue #236)", () => {
    // After `/model` the deadline is still four minutes out, inside the window. "Goes cold in about
    // 5 min" would be wrong twice: it is already cold, and waiting will not save it.
    const reset = reading({
      state: "cold",
      coldReason: "reset",
      reset: { ruleId: "claude.reset.model", label: "The model changed", at: NOW - 1000 },
    });
    expect(warn([pane({ cache: reset })]).messages).toHaveLength(0);
  });

  test("the tag is one per watched pane, and carries no ref and no control byte", () => {
    const tag = warn([pane()]).messages[0]!.tag!;
    expect(tag).toMatch(/^collie:cache:[0-9a-f]{8}$/);
    expect(tag).not.toContain("abc");
    // Two panes must never overwrite each other's notification — this is why the herd slot is not reused.
    const two = warn([pane(), pane({ ref: "id:def", paneId: "w1:p2" })]);
    expect(new Set(two.messages.map((m) => m.tag)).size).toBe(2);
  });

  test("a peer's pane names its machine in the body and carries `host`; a local one carries neither", () => {
    const out = warn([pane({ host: "minibuch" })]);
    expect(out.messages[0]!.body).toBe("minibuch · collie · claude. One warning per cycle.");
    expect(out.messages[0]!.host).toBe("minibuch");
    expect("host" in warn([pane()]).messages[0]!).toBe(false);
    expect("session" in warn([pane()]).messages[0]!).toBe(false);
  });

  test("a named session rides the message so a tap lands on the right one", () => {
    expect(warn([pane({ session: "next" })]).messages[0]!.session).toBe("next");
  });

  test("a pane nobody asked about is never warned", () => {
    const out = cacheWarnings({
      panes: [pane()],
      watched: () => false,
      nowMs: NOW,
      warnSeconds: WARN,
      sent: new Set(),
    });
    expect(out.messages).toEqual([]);
    expect(out.sentPairs).toEqual([]);
  });

  test("`expiring` warns too; `cold` and `unknown` never do", () => {
    expect(warn([pane({ cache: reading({ state: "expiring" }) })]).messages).toHaveLength(1);
    expect(warn([pane({ cache: reading({ state: "cold" }) })]).messages).toEqual([]);
    expect(warn([pane({ cache: reading({ state: "unknown" }) })]).messages).toEqual([]);
  });

  test("a pane with no reading at all is skipped — absent is the ordinary case, not an error", () => {
    const { cache: _cache, ...bare } = pane();
    expect(warn([bare]).messages).toEqual([]);
    expect(warn([pane({ cache: reading({ expiresAt: undefined }) })]).messages).toEqual([]);
  });

  test("a TTL no longer than the window warns at half its own lifetime, not the fixed window", () => {
    // A 300 s cache (Codex, OpenCode, pi, omp) never clears the fixed 300 s window, so the halving is
    // what lets it warn at all: the effective window is 150 s, half the TTL.
    expect(warn([pane({ cache: reading({ ttlSeconds: 300, expiresAt: NOW + 200_000 }) })]).messages).toEqual([]);
    expect(warn([pane({ cache: reading({ ttlSeconds: 300, expiresAt: NOW + 150_000 }) })]).messages).toHaveLength(1);
    expect(warn([pane({ cache: reading({ ttlSeconds: 300, expiresAt: NOW + 100_000 }) })]).messages).toHaveLength(1);
    // A 180 s Google cache halves to a 90 s window.
    expect(warn([pane({ cache: reading({ ttlSeconds: 180, expiresAt: NOW + 120_000 }) })]).messages).toEqual([]);
    expect(warn([pane({ cache: reading({ ttlSeconds: 180, expiresAt: NOW + 90_000 }) })]).messages).toHaveLength(1);
    // A TTL well past twice the window keeps the fixed window unchanged — the ordinary Claude case.
    expect(warn([pane({ cache: reading({ ttlSeconds: 3600, expiresAt: NOW + 5 * 60_000 }) })]).messages).toHaveLength(1);
    expect(warn([pane({ cache: reading({ ttlSeconds: 3600, expiresAt: NOW + 6 * 60_000 }) })]).messages).toEqual([]);
  });

  test("outside the window and past the deadline both say nothing", () => {
    expect(warn([pane({ cache: reading({ expiresAt: NOW + 6 * 60_000 }) })]).messages).toEqual([]);
    expect(warn([pane({ cache: reading({ expiresAt: NOW }) })]).messages).toEqual([]);
    expect(warn([pane({ cache: reading({ expiresAt: NOW - 1000 }) })]).messages).toEqual([]);
  });

  test("once per warm cycle: the same deadline is never pushed twice", () => {
    const p = pane();
    const sent = new Set([`${p.key}@${p.cache!.expiresAt!}`]);
    expect(warn([p], { sent }).messages).toEqual([]);
  });

  test("a new request moves the deadline, and only then may the pane warn again", () => {
    const p = pane();
    const sent = new Set([`${p.key}@${p.cache!.expiresAt!}`]);
    // The agent took another turn: `expiresAt` moved, so the pair is new and the next cycle warns.
    const next = pane({ cache: reading({ expiresAt: NOW + 4 * 60_000 + 30_000 }) });
    expect(warn([next], { sent }).messages).toHaveLength(1);
  });

  test("the title's minutes follow the window it was given", () => {
    const out = cacheWarnings({
      panes: [pane({ cache: reading({ ttlSeconds: 3600, expiresAt: NOW + 9 * 60_000 }) })],
      watched: () => true,
      nowMs: NOW,
      warnSeconds: 600,
      sent: new Set(),
    });
    expect(out.messages[0]!.title).toBe("Cache goes cold in about 10 min");
  });

  test("several panes are judged independently in one call", () => {
    const out = warn([
      pane(),
      pane({ ref: "id:cold", cache: reading({ state: "cold" }) }),
      pane({ ref: "id:other", paneId: "w2:p1", label: "infra · codex" }),
    ]);
    expect(out.messages.map((m) => m.paneId)).toEqual(["w1:p1", "w2:p1"]);
    expect(out.sentPairs).toHaveLength(2);
  });
});
