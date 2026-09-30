import { describe, expect, test } from "bun:test";

import { computeEtag } from "../http-cache.ts";
import { decodeCursor, encodeCursor, NO_CURSOR } from "./cursor.ts";
import {
  chatParams,
  DEFAULT_CHAT_LIMIT,
  LiveWindows,
  MAX_CHAT_LIMIT,
  MAX_LIVE_BYTES,
  MAX_LIVE_ENTRIES,
  MIN_LIVE_ENTRIES,
  parseChatAfter,
  parseChatBefore,
  SEQ_BASE,
  TICK_FLOOR_MS,
  WINDOW_IDLE_MS,
  MAX_WINDOWS,
} from "./live.ts";
import { NO_CHANGE, parseWith, type PendingTool, rememberPending, type RowReducer } from "./reduce.ts";
import { TranscriptStore } from "./store.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

// The live window is harness-BLIND: it takes rows off a source, hands them to a reducer, and numbers
// what comes back. So it is tested against a FAKE harness with a two-row grammar, not against any
// real one — if a test here needs to know what Claude writes, the seam has leaked.
//
// The fake grammar is two rows, and they are the two shapes that matter to this file:
//   {"id":"u1","say":"ls"}   → a turn that did not exist before  → `added`
//   {"for":"u1","out":"ok"}  → a result folded into an earlier turn → `changed`
// That second row is the whole reason `upserts` exists, and the reason a position watermark cannot
// answer "what is new" (see live.ts's header).

type FakeRow = { id?: string; say?: string; for?: string; out?: string };

function readRow(line: string): FakeRow | null {
  if (line === "") return null;
  try {
    // SAFETY: the value is only ever read through the typed field checks below, each of which
    // verifies the field is a string before using it. A row of any other shape falls through to
    // "nothing happened", which is exactly what a real reducer does with a row it cannot use.
    return JSON.parse(line) as FakeRow;
  } catch {
    return null;
  }
}

function fakeReducer(): RowReducer {
  const pending = new Map<string, PendingTool>();
  return {
    push(line: string) {
      const row = readRow(line);
      if (row === null) return NO_CHANGE;
      if (typeof row.id === "string") {
        const part: Extract<TranscriptPart, { kind: "tool" }> = {
          kind: "tool",
          name: row.say ?? "",
          summary: row.say ?? "",
        };
        const entry: TranscriptEntry = { uuid: row.id, ts: "", role: "assistant", parts: [part] };
        rememberPending(pending, row.id, { part, uuid: row.id });
        return { added: [entry], changed: NO_CHANGE.changed };
      }
      if (typeof row.for === "string") {
        const target = pending.get(row.for);
        if (target === undefined) return NO_CHANGE;
        target.part.result = { text: row.out ?? "" };
        pending.delete(row.for);
        return { added: [], changed: [target.uuid] };
      }
      return NO_CHANGE;
    },
  };
}

const ref = (value = "s1"): AgentSessionRef => ({ kind: "id", value });

/**
 * One fake harness plus a hand-driven clock, counting every seam call.
 *
 * `readSince` is written against the REAL cursor codec, counting rows where a file counts bytes. That
 * keeps the fake honest about the one thing the window depends on: a cursor is opaque, and the only
 * question the window may ask of an answer is `reset` / `fromStart`.
 */
function fakeJournal(lines: string[] = []) {
  const state = { lines: [...lines], mtimeMs: 1000, rewound: false, fromStart: true };
  const calls = { resolve: 0, stat: 0, readSince: 0, load: 0, reducer: 0 };
  let now = 100_000;

  const source: TranscriptSource = {
    async resolve(r) {
      calls.resolve++;
      return r.value === "none" ? null : `/fake/${r.value}.jsonl`;
    },
    async stat() {
      calls.stat++;
      return { size: state.lines.length, mtimeMs: state.mtimeMs };
    },
    async load() {
      calls.load++;
      return {
        text: state.lines.join("\n"),
        complete: state.fromStart,
        size: state.lines.length,
        mtimeMs: state.mtimeMs,
      };
    },
    async readSince(key, cursor) {
      calls.readSince++;
      const at = decodeCursor(cursor, "bytes", key);
      const reset = at === null || state.rewound || at > state.lines.length;
      state.rewound = false;
      return {
        lines: state.lines.slice(reset ? 0 : at),
        cursor: encodeCursor("bytes", key, state.lines.length),
        reset,
        fromStart: reset && state.fromStart,
      };
    },
  };

  const adapter: JournalAdapter = {
    agent: "fake",
    source,
    parse: (text) => parseWith(fakeReducer(), text),
    reducer: () => {
      calls.reducer++;
      return fakeReducer();
    },
  };

  return {
    adapter,
    state,
    calls,
    clock: () => now,
    /** Move the clock past the tick floor, so the next ask really reads. */
    settle: () => {
      now += TICK_FLOOR_MS + 1;
    },
    advance: (ms: number) => {
      now += ms;
    },
    /** The agent wrote rows: new content AND a new mtime, as a real write gives. */
    append: (...rows: string[]) => {
      state.lines.push(...rows);
      state.mtimeMs += 1;
    },
  };
}

const say = (id: string, what = "ls") => JSON.stringify({ id, say: what });
const answer = (id: string, out = "ok") => JSON.stringify({ for: id, out });

function windows(fx: ReturnType<typeof fakeJournal>): LiveWindows {
  return new LiveWindows(new TranscriptStore(), fx.clock);
}

// ── The two tokens ───────────────────────────────────────────────────────────

describe("the position tokens", () => {
  test("`after` is two digit fields and nothing else", () => {
    expect(parseChatAfter("7:3")).toEqual({ gen: 7, rev: 3 });
    expect(parseChatAfter("0:0")).toEqual({ gen: 0, rev: 0 });
    expect(parseChatAfter(null)).toBeNull();
    expect(parseChatAfter("7")).toBeNull();
    expect(parseChatAfter("7:3:1")).toBeNull();
    expect(parseChatAfter("7:")).toBeNull();
    expect(parseChatAfter("-7:3")).toBeNull();
    expect(parseChatAfter("7.5:3")).toBeNull();
    expect(parseChatAfter("1e9:3")).toBeNull();
    expect(parseChatAfter("99999999999999999999:3")).toBeNull();
  });

  test("`before` is a digit seq and a uuid, split on the FIRST colon", () => {
    expect(parseChatBefore("1000005:u5")).toEqual({ seq: 1_000_005, uuid: "u5" });
    // A uuid may hold a colon of its own (codex synthesises one). The seq cannot, so the first colon
    // is the boundary and the rest is the name, whatever it contains.
    expect(parseChatBefore("12:a:b:c")).toEqual({ seq: 12, uuid: "a:b:c" });
    expect(parseChatBefore(null)).toBeNull();
    expect(parseChatBefore("u5")).toBeNull();
    expect(parseChatBefore(":u5")).toBeNull();
    expect(parseChatBefore("12:")).toBeNull();
    expect(parseChatBefore("-1:u5")).toBeNull();
    expect(parseChatBefore(`12:${"x".repeat(101)}`)).toBeNull();
  });

  test("the query clamps the limit and never honours both cursors", () => {
    const at = (q: string) => chatParams(new URL(`http://x/api/pane/p/chat${q}`));
    expect(at("")).toEqual({ limit: DEFAULT_CHAT_LIMIT });
    expect(at("?limit=5")).toEqual({ limit: 5 });
    expect(at("?limit=99999")).toEqual({ limit: MAX_CHAT_LIMIT });
    expect(at("?limit=0")).toEqual({ limit: DEFAULT_CHAT_LIMIT });
    expect(at("?limit=abc")).toEqual({ limit: DEFAULT_CHAT_LIMIT });
    expect(at("?after=9:2")).toEqual({ limit: DEFAULT_CHAT_LIMIT, after: { gen: 9, rev: 2 } });
    // `before` wins, and `after` is not merely ignored — it is absent, which is what the window reads
    // as "this reader holds nothing of the live tail", the only safe reading of a page request.
    expect(at("?before=5:u5&after=9:2")).toEqual({
      limit: DEFAULT_CHAT_LIMIT,
      before: { seq: 5, uuid: "u5" },
    });
    // An unreadable token leaves the key OFF rather than arriving as a zero.
    expect(at("?after=nonsense")).toEqual({ limit: DEFAULT_CHAT_LIMIT });
  });
});

// ── A first read ─────────────────────────────────────────────────────────────

describe("a window's first answer", () => {
  test("numbers the turns from SEQ_BASE and says where it starts", async () => {
    const fx = fakeJournal([say("u1"), say("u2"), say("u3")]);
    const body = await windows(fx).window(fx.adapter, ref(), { limit: 10 });
    expect(body?.page).toBe("live");
    expect(body?.upserts.map((e) => [e.uuid, e.seq])).toEqual([
      ["u1", SEQ_BASE],
      ["u2", SEQ_BASE + 1],
      ["u3", SEQ_BASE + 2],
    ]);
    expect(body?.oldest).toBe(SEQ_BASE);
    expect(body?.head).toBe(SEQ_BASE + 2);
    expect(body?.rev).toBe(1);
    // The source read from its own first row, so there is nothing to load older.
    expect(body?.hasOlder).toBe(false);
  });

  test("a clipped tail says there IS something older, without reading it", async () => {
    const fx = fakeJournal([say("u1")]);
    fx.state.fromStart = false;
    const body = await windows(fx).window(fx.adapter, ref(), { limit: 10 });
    expect(body?.hasOlder).toBe(true);
    expect(fx.calls.load).toBe(0);
  });

  test("an empty log answers a head BELOW its oldest, which is how emptiness reads", async () => {
    const fx = fakeJournal([]);
    const body = await windows(fx).window(fx.adapter, ref(), { limit: 10 });
    expect(body?.upserts).toEqual([]);
    expect(body?.oldest).toBe(SEQ_BASE);
    expect(body?.head).toBe(SEQ_BASE - 1);
    expect(body?.rev).toBe(0);
  });

  test("a reader holding nothing gets a screenful, not the window", async () => {
    const fx = fakeJournal(Array.from({ length: 30 }, (_, i) => say(`u${i}`)));
    const body = await windows(fx).window(fx.adapter, ref(), { limit: 5 });
    expect(body?.upserts.map((e) => e.uuid)).toEqual(["u25", "u26", "u27", "u28", "u29"]);
    // `oldest` is what the WINDOW still holds, not what this answer carried — so a client that got a
    // screenful knows the rest is a request away and not a disk read.
    expect(body?.oldest).toBe(SEQ_BASE);
    expect(body?.head).toBe(SEQ_BASE + 29);
  });

  test("a ref that resolves to nothing is null, indistinguishable from any other refusal", async () => {
    const fx = fakeJournal([say("u1")]);
    expect(await windows(fx).window(fx.adapter, ref("none"), { limit: 10 })).toBeNull();
  });
});

// ── An append, and a change ──────────────────────────────────────────────────

describe("what a poll costs", () => {
  test("an append sends the new turn alone", async () => {
    const fx = fakeJournal([say("u1"), say("u2")]);
    const live = windows(fx);
    const first = await windows(fx).window(fx.adapter, ref(), { limit: 10 });
    expect(first).not.toBeNull();

    const one = await live.window(fx.adapter, ref(), { limit: 10 });
    fx.append(say("u3"));
    fx.settle();
    const two = await live.window(fx.adapter, ref(), {
      limit: 10,
      after: { gen: one!.gen, rev: one!.rev },
    });
    expect(two?.gen).toBe(one!.gen);
    expect(two?.rev).toBe(one!.rev + 1);
    expect(two?.upserts.map((e) => [e.uuid, e.seq])).toEqual([["u3", SEQ_BASE + 2]]);
  });

  test("a result folded into an EARLIER turn comes back at the seq it already had", async () => {
    const fx = fakeJournal([say("u1"), say("u2")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 10 });

    // This is the case a position watermark cannot answer: the turn that changed sits BELOW the
    // newest one, so "everything after seq N" would never mention it.
    fx.append(answer("u1", "done"));
    fx.settle();
    const two = await live.window(fx.adapter, ref(), {
      limit: 10,
      after: { gen: one!.gen, rev: one!.rev },
    });
    expect(two?.upserts).toHaveLength(1);
    expect(two?.upserts[0]?.uuid).toBe("u1");
    expect(two?.upserts[0]?.seq).toBe(SEQ_BASE);
    expect(two?.upserts[0]?.parts[0]).toMatchObject({ kind: "tool", result: { text: "done" } });
    // The head did not move: nothing was added, something was corrected.
    expect(two?.head).toBe(one!.head);
  });

  test("one tick is one revision, however many rows it folded", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 10 });
    fx.append(say("u2"), answer("u1"), say("u3"));
    fx.settle();
    const two = await live.window(fx.adapter, ref(), {
      limit: 10,
      after: { gen: one!.gen, rev: one!.rev },
    });
    expect(two?.rev).toBe(one!.rev + 1);
    expect(two?.upserts.map((e) => e.uuid).toSorted()).toEqual(["u1", "u2", "u3"]);
  });

  test("a reader at an unknown generation is given the tail, not a delta", async () => {
    const fx = fakeJournal([say("u1"), say("u2")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 10 });
    fx.settle();
    const stale = await live.window(fx.adapter, ref(), {
      limit: 10,
      after: { gen: one!.gen + 999, rev: 0 },
    });
    expect(stale?.gen).toBe(one!.gen);
    expect(stale?.upserts.map((e) => e.uuid)).toEqual(["u1", "u2"]);
  });

  test("an unchanged poll re-serialises to the same bytes, which is what makes it a 304", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 10 });
    const at = { gen: one!.gen, rev: one!.rev };

    fx.settle();
    const quiet = await live.window(fx.adapter, ref(), { limit: 10, after: at });
    fx.settle();
    const again = await live.window(fx.adapter, ref(), { limit: 10, after: at });

    expect(quiet?.upserts).toEqual([]);
    expect(quiet?.rev).toBe(one!.rev);
    // The route hashes the serialised body (bridge/server.ts § paneChat), so identical bytes are the
    // whole mechanism behind the 304. Assert the mechanism, not a status code the handler owns.
    expect(computeEtag(JSON.stringify(quiet))).toBe(computeEtag(JSON.stringify(again)));
  });
});

// ── The floor, the pre-check, and the eviction ───────────────────────────────

describe("no reader means no work", () => {
  test("two asks inside the tick floor cost one read", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    await live.window(fx.adapter, ref(), { limit: 10 });
    expect(fx.calls.readSince).toBe(1);
    fx.advance(TICK_FLOOR_MS - 1);
    fx.append(say("u2"));
    await live.window(fx.adapter, ref(), { limit: 10 });
    expect(fx.calls.readSince).toBe(1);
    fx.advance(2);
    await live.window(fx.adapter, ref(), { limit: 10 });
    expect(fx.calls.readSince).toBe(2);
  });

  test("a session whose stat did not move is never read at all", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    await live.window(fx.adapter, ref(), { limit: 10 });
    for (let i = 0; i < 5; i++) {
      fx.settle();
      await live.window(fx.adapter, ref(), { limit: 10 });
    }
    expect(fx.calls.stat).toBe(6);
    expect(fx.calls.readSince).toBe(1);
  });

  test("two readers of one session share one window and one read", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    await live.window(fx.adapter, ref("shared"), { limit: 10 });
    await live.window(fx.adapter, ref("shared"), { limit: 10 });
    expect(live.size()).toBe(1);
    expect(fx.calls.readSince).toBe(1);
    expect(fx.calls.reducer).toBe(1);
  });

  test("a window nobody asked about is dropped whole", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    await live.window(fx.adapter, ref("a"), { limit: 10 });
    expect(live.size()).toBe(1);
    fx.advance(WINDOW_IDLE_MS + 1);
    await live.window(fx.adapter, ref("b"), { limit: 10 });
    expect(live.size()).toBe(1);
  });

  test("past MAX_WINDOWS the least-recently-asked goes first", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    for (let i = 0; i <= MAX_WINDOWS; i++) {
      fx.settle();
      await live.window(fx.adapter, ref(`s${i}`), { limit: 10 });
    }
    expect(live.size()).toBe(MAX_WINDOWS);
    // `s0` was evicted, so asking for it again is a fresh window with a fresh reducer.
    const reducersBefore = fx.calls.reducer;
    fx.settle();
    await live.window(fx.adapter, ref("s0"), { limit: 10 });
    expect(fx.calls.reducer).toBe(reducersBefore + 1);
  });
});

// ── The bounds ───────────────────────────────────────────────────────────────

describe("the window is bounded", () => {
  test("past MAX_LIVE_ENTRIES it trims the front and says there is more behind", async () => {
    const rows = Array.from({ length: MAX_LIVE_ENTRIES + 10 }, (_, i) => say(`u${i}`));
    const fx = fakeJournal(rows);
    const body = await windows(fx).window(fx.adapter, ref(), { limit: 5 });
    expect(body?.oldest).toBe(SEQ_BASE + 10);
    expect(body?.head).toBe(SEQ_BASE + MAX_LIVE_ENTRIES + 9);
    // `fromStart` was true and it STILL has older turns, because this window threw some away.
    expect(body?.hasOlder).toBe(true);
  });

  test("past MAX_LIVE_BYTES it trims by weight, and a giant turn cannot empty it", async () => {
    // Every turn here is over a tenth of the byte bound, so the bound alone would trim the window
    // down to one. MIN_LIVE_ENTRIES is what stops it.
    const fat = "x".repeat(Math.floor(MAX_LIVE_BYTES / 8));
    const fx = fakeJournal(Array.from({ length: MIN_LIVE_ENTRIES + 6 }, (_, i) => say(`u${i}`, fat)));
    const body = await windows(fx).window(fx.adapter, ref(), { limit: MAX_CHAT_LIMIT });
    expect(body?.upserts).toHaveLength(MIN_LIVE_ENTRIES);
    expect(body?.upserts[0]?.uuid).toBe(`u6`);
    expect(body?.hasOlder).toBe(true);
  });

  test("a result for a turn already trimmed away changes nothing and is not reported", async () => {
    const fx = fakeJournal([say("u1"), ...Array.from({ length: MAX_LIVE_ENTRIES + 4 }, (_, i) => say(`v${i}`))]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 5 });
    expect(one?.oldest).toBeGreaterThan(SEQ_BASE); // u1 is gone

    fx.append(answer("u1"));
    fx.settle();
    const two = await live.window(fx.adapter, ref(), {
      limit: 5,
      after: { gen: one!.gen, rev: one!.rev },
    });
    expect(two?.upserts).toEqual([]);
    expect(two?.rev).toBe(one!.rev);
  });
});

// ── A reset ──────────────────────────────────────────────────────────────────

describe("a reset is a new numbering", () => {
  test("it bumps the generation and numbers from SEQ_BASE again", async () => {
    const fx = fakeJournal([say("u1"), say("u2")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 10 });

    // The log was rewritten under us: a truncation, a rewritten database, or Claude handing the
    // conversation over to a new file. One flag covers all of them (journal/cursor.ts).
    fx.state.lines = [say("w1")];
    fx.state.mtimeMs += 1;
    fx.state.rewound = true;
    fx.settle();
    const two = await live.window(fx.adapter, ref(), {
      limit: 10,
      after: { gen: one!.gen, rev: one!.rev },
    });
    expect(two?.gen).not.toBe(one!.gen);
    expect(two?.upserts.map((e) => [e.uuid, e.seq])).toEqual([["w1", SEQ_BASE]]);
    expect(two?.rev).toBe(1);
  });

  test("the reducer is thrown away with the rows, so no result folds across the gap", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 10 });
    expect(fx.calls.reducer).toBe(1);

    fx.state.lines = [say("w1")];
    fx.state.mtimeMs += 1;
    fx.state.rewound = true;
    fx.settle();
    await live.window(fx.adapter, ref(), { limit: 10, after: { gen: one!.gen, rev: one!.rev } });
    expect(fx.calls.reducer).toBe(2);

    // `u1`'s call was waiting when the reset happened. Its answer must reach nothing.
    fx.append(answer("u1"));
    fx.settle();
    const three = await live.window(fx.adapter, ref(), { limit: 10 });
    expect(three?.upserts.map((e) => e.uuid)).toEqual(["w1"]);
  });
});

// ── Older turns, off disk ────────────────────────────────────────────────────

describe("older turns are read only when a reader asks", () => {
  test("a page is numbered DOWN from the turn the client named", async () => {
    const fx = fakeJournal(Array.from({ length: 10 }, (_, i) => say(`u${i}`)));
    const live = windows(fx);
    const body = await live.window(fx.adapter, ref(), { limit: 10 });
    expect(fx.calls.load).toBe(0); // the live read never touches the History path

    const older = await live.older(fx.adapter, ref(), { seq: SEQ_BASE + 5, uuid: "u5" }, 3);
    expect(older?.page).toBe("older");
    expect(older?.gen).toBe(body!.gen);
    expect(older?.upserts.map((e) => [e.uuid, e.seq])).toEqual([
      ["u2", SEQ_BASE + 2],
      ["u3", SEQ_BASE + 3],
      ["u4", SEQ_BASE + 4],
    ]);
    expect(older?.hasOlder).toBe(true);
    expect(fx.calls.load).toBe(1);
  });

  test("the log's own start reports nothing older, and a short page still lines up", async () => {
    const fx = fakeJournal(Array.from({ length: 5 }, (_, i) => say(`u${i}`)));
    const live = windows(fx);
    await live.window(fx.adapter, ref(), { limit: 10 });
    const older = await live.older(fx.adapter, ref(), { seq: SEQ_BASE + 2, uuid: "u2" }, 10);
    expect(older?.upserts.map((e) => [e.uuid, e.seq])).toEqual([
      ["u0", SEQ_BASE],
      ["u1", SEQ_BASE + 1],
    ]);
    expect(older?.hasOlder).toBe(false);
  });

  test("a second page off the first page's oldest turn keeps the numbering", async () => {
    const fx = fakeJournal(Array.from({ length: 10 }, (_, i) => say(`u${i}`)));
    const live = windows(fx);
    await live.window(fx.adapter, ref(), { limit: 10 });
    const first = await live.older(fx.adapter, ref(), { seq: SEQ_BASE + 9, uuid: "u9" }, 4);
    const oldest = first!.upserts[0]!;
    expect([oldest.uuid, oldest.seq]).toEqual(["u5", SEQ_BASE + 5]);
    const second = await live.older(fx.adapter, ref(), { seq: oldest.seq, uuid: oldest.uuid }, 4);
    expect(second?.upserts.map((e) => [e.uuid, e.seq])).toEqual([
      ["u1", SEQ_BASE + 1],
      ["u2", SEQ_BASE + 2],
      ["u3", SEQ_BASE + 3],
      ["u4", SEQ_BASE + 4],
    ]);
  });

  test("a ref that resolves to nothing is null here too", async () => {
    const fx = fakeJournal([say("u1")]);
    const live = windows(fx);
    expect(await live.older(fx.adapter, ref("none"), { seq: 1, uuid: "u1" }, 5)).toBeNull();
  });
});

// ── What the window never does ───────────────────────────────────────────────

describe("the window's own boundaries", () => {
  test("it starts from NO_CURSOR and never reads a cursor's meaning", async () => {
    const fx = fakeJournal([say("u1")]);
    const asked: string[] = [];
    const watched: JournalAdapter = {
      ...fx.adapter,
      source: {
        ...fx.adapter.source,
        async readSince(key, cursor) {
          asked.push(cursor);
          return fx.adapter.source.readSince(key, cursor);
        },
      },
    };
    await windows(fx).window(watched, ref(), { limit: 10 });
    expect(asked[0]).toBe(NO_CURSOR);
  });

  test("a seq is never reassigned, even across a hundred polls", async () => {
    const fx = fakeJournal([say("u0")]);
    const live = windows(fx);
    const one = await live.window(fx.adapter, ref(), { limit: 100 });
    const seen = new Map<string, number>([["u0", one!.upserts[0]!.seq]]);
    let at = { gen: one!.gen, rev: one!.rev };
    for (let i = 1; i < 100; i++) {
      fx.append(say(`u${i}`), answer(`u${i - 1}`));
      fx.settle();
      const body = await live.window(fx.adapter, ref(), { limit: 100, after: at });
      at = { gen: body!.gen, rev: body!.rev };
      for (const entry of body!.upserts) {
        const held = seen.get(entry.uuid);
        if (held !== undefined) expect(entry.seq).toBe(held);
        seen.set(entry.uuid, entry.seq);
      }
    }
    expect(seen.size).toBe(100);
    expect([...seen.values()].toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => SEQ_BASE + i),
    );
  });
});
