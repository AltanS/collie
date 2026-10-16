// The Surface counters (M56 spec 09): a day file per day, fourteen days kept, written at most once a
// minute, with no row of the screen and no text in any of it; the manual-send cap; the inbox and the
// examples folder.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import {
  CAP_WINDOW_MS,
  classifyRead,
  counterDates,
  counterPath,
  dayOf,
  KEEP_DAYS,
  MAX_EXAMPLES,
  MAX_NEGATIVE_EXAMPLES,
  parseDay,
  readDays,
  maskRow,
  summarize,
  SurfaceLedger,
  totalsOf,
  WRITE_EVERY_MS,
  type CounterKey,
} from "./counters.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 16, 12, 0, 0);
const KEY: CounterKey = { harness: "agent", version: "2.1.301", profileId: "agent", status: "provisional" };

const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
const NO_MATCH: Surface = { revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" };
const WEAK: Surface = { revision: 1, turn: "idle", modal: "unknown", composer: "empty" };
const UNREADABLE: Surface = { revision: 1, turn: "idle", modal: "unreadable", composer: "empty" };
const MENU: Surface = {
  revision: 1,
  turn: "idle",
  modal: { ask: { id: "a1", kind: "menu", options: [{ id: "1", label: "Default" }], channel: "keys", hash: "abc" } },
  composer: "unknown",
};
const DRAFT: Surface = { revision: 1, turn: "idle", modal: "none", composer: "draft" };

let state: string;
let clock = { now: START };
let warnings: string[];
let timers: Array<{ run: () => void; ms: number }>;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "collie-counters-"));
  clock = { now: START };
  warnings = [];
  timers = [];
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

function ledger(options: { cap?: number } = {}): SurfaceLedger {
  return new SurfaceLedger(state, { now: () => clock.now, schedule: (run, ms) => timers.push({ run, ms }), warn: (line) => warnings.push(line), ...options });
}
const dir = (): string => join(state, "surface");
const files = (): string[] => (existsSync(dir()) ? readdirSync(dir()).toSorted() : []);

describe("a verdict's class", () => {
  test("free, a modal by kind, unknown by reason, and the rest count as nothing", () => {
    expect(classifyRead(FREE)).toEqual({ free: true });
    expect(classifyRead(MENU)).toEqual({ free: false, modal: "menu" });
    expect(classifyRead(UNREADABLE)).toEqual({ free: false, modal: "unreadable" });
    expect(classifyRead(NO_MATCH)).toEqual({ free: false, unknown: "no-match" });
    expect(classifyRead(WEAK)).toEqual({ free: false, unknown: "weak-cue" });
    expect(classifyRead({ ...NO_MATCH, reason: "stale" })).toEqual({ free: false, unknown: "stale" });
    expect(classifyRead(DRAFT)).toEqual({ free: false });
    expect(classifyRead({ revision: 1, turn: "running", modal: "none", composer: "empty" })).toEqual({ free: false });
  });
});

describe("the day file", () => {
  test("flush writes a pending count at once, without the minute timer", () => {
    const l = ledger();
    l.read(KEY, FREE, null);
    l.flush();
    expect(files()).toEqual(["counters-2026-10-16.json"]);
  });

  test("counts verdicts and sends per harness, version, profile and status, and rolls per day", () => {
    const l = ledger();
    l.read(KEY, FREE, null);
    l.read(KEY, FREE, null);
    l.read(KEY, NO_MATCH, "aaaa1111");
    l.read(KEY, MENU, null);
    l.send(KEY, { outcome: "refused", reason: "not_free", probed: false });
    l.send(KEY, { outcome: "sent", probed: true });
    l.send(KEY, { outcome: "effective", probed: false });
    l.send(KEY, { outcome: "unknown", reason: "bound", probed: false });
    l.noteManual(KEY);
    l.flush();
    expect(files()).toEqual(["counters-2026-10-16.json"]);

    clock.now = START + DAY;
    l.read(KEY, FREE, null);
    l.flush();
    expect(files()).toEqual(["counters-2026-10-16.json", "counters-2026-10-17.json"]);

    const first = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-16"), "utf8")));
    expect(Object.values(first!.rows)).toEqual([
      { ...KEY, free: 2, unknown: { "no-match": 1 }, modal: { menu: 1 }, refused: { not_free: 1 }, probed: 1, manual: 1, sent: 1, effective: 1, unknown_outcome: 1, typed_not_submitted: 0, discarded: 0, held: 0, held_sent: 0, held_expired: 0, held_cancelled: 0, edges: {}, holds: {} },
    ]);
    const second = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-17"), "utf8")));
    expect(Object.values(second!.rows)).toHaveLength(1);
    expect(Object.values(second!.rows)[0]!.free).toBe(1);
  });

  test("typed_not_submitted is counted per harness and version, like the other outcomes", () => {
    const l = ledger();
    const other = { ...KEY, version: "2.1.302" };
    l.send(KEY, { outcome: "typed_not_submitted", reason: "mismatch", probed: true });
    l.send(KEY, { outcome: "typed_not_submitted", reason: "changed", probed: true });
    l.send(other, { outcome: "typed_not_submitted", reason: "mismatch", probed: false });
    l.flush();
    const day = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-16"), "utf8")));
    const rows = Object.values(day!.rows);
    expect(rows.map((row) => [row.version, row.typed_not_submitted, row.probed, row.sent])).toEqual([
      ["2.1.301", 2, 2, 0],
      ["2.1.302", 1, 0, 0],
    ]);
  });

  test("a discard is counted as discarded per harness and version, never under sent", () => {
    const l = ledger();
    const other = { ...KEY, version: "2.1.302" };
    l.send(KEY, { outcome: "discarded", probed: false });
    l.send(KEY, { outcome: "discarded", probed: false });
    l.send(KEY, { outcome: "sent", probed: false });
    l.send(other, { outcome: "discarded", probed: false });
    l.flush();
    const day = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-16"), "utf8")));
    expect(Object.values(day!.rows).map((row) => [row.version, row.discarded, row.sent])).toEqual([
      ["2.1.301", 2, 1],
      ["2.1.302", 1, 0],
    ]);
    expect(summarize([day!]).map((row) => [row.version, row.discarded])).toEqual([
      ["2.1.301", 2],
      ["2.1.302", 1],
    ]);
  });

  test("the held send's four counts (M56 spec 15): held, held_sent (also sent or effective), held_expired, held_cancelled, added up by the summary", () => {
    const l = ledger();
    l.send(KEY, { outcome: "held", probed: false });
    l.send(KEY, { outcome: "held", probed: false });
    l.send(KEY, { outcome: "held", probed: false });
    l.send(KEY, { outcome: "sent", probed: true, released: true });
    l.send(KEY, { outcome: "expired", probed: false });
    l.send(KEY, { outcome: "cancelled", probed: false });
    l.send(KEY, { outcome: "sent", probed: false });
    l.flush();
    const day = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-16"), "utf8")));
    expect(Object.values(day!.rows)[0]).toMatchObject({ held: 3, held_sent: 1, held_expired: 1, held_cancelled: 1, sent: 2 });
    expect(summarize([day!, day!])[0]).toMatchObject({ held: 6, held_sent: 2, held_expired: 2, held_cancelled: 2 });
  });

  test("another version, profile or status is another row", () => {
    const l = ledger();
    l.read(KEY, FREE, null);
    l.read({ ...KEY, version: "2.1.302" }, FREE, null);
    l.read({ ...KEY, status: "verified" }, FREE, null);
    expect(l.rows()).toHaveLength(3);
  });

  test("a restart in the same day adds to the file it left", () => {
    const first = ledger();
    first.read(KEY, FREE, null);
    first.flush();
    const second = ledger();
    second.read(KEY, FREE, null);
    expect(second.rows()[0]!.free).toBe(2);
  });

  test("keeps fourteen days and drops the rest, by the date in the name", () => {
    mkdirSync(dir(), { recursive: true });
    for (let back = 0; back < 20; back++) writeFileSync(counterPath(dir(), dayOf(START - back * DAY)), JSON.stringify({ date: dayOf(START - back * DAY), rows: {}, unknownFrames: {}, manualAt: {} }));
    writeFileSync(join(dir(), "inbox.jsonl"), "{}\n");
    ledger();
    const left = counterDates(files());
    expect(left).toHaveLength(KEEP_DAYS);
    expect(left[0]).toBe("2026-10-16");
    expect(left.at(-1)).toBe(dayOf(START - (KEEP_DAYS - 1) * DAY));
    // Only counters files are touched.
    expect(files()).toContain("inbox.jsonl");
  });

  test("a new day prunes as it rolls", () => {
    const l = ledger();
    l.read(KEY, FREE, null);
    l.flush();
    clock.now = START + 15 * DAY;
    l.read(KEY, FREE, null);
    l.flush();
    expect(counterDates(files())).toEqual(["2026-10-31"]);
  });

  test("is written at most once a minute: the first change now, the rest on one trailing write", () => {
    const l = ledger();
    l.read(KEY, FREE, null);
    expect(files()).toEqual(["counters-2026-10-16.json"]);
    const bytes = (): string => readFileSync(counterPath(dir(), "2026-10-16"), "utf8");
    const before = bytes();
    clock.now += 10_000;
    for (let i = 0; i < 20; i++) l.read(KEY, FREE, null);
    expect(bytes()).toBe(before);
    // One trailing write is scheduled, for the end of the minute, and not twenty.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(WRITE_EVERY_MS - 10_000);
    clock.now += WRITE_EVERY_MS - 10_000;
    timers[0]!.run();
    expect(parseDay(JSON.parse(bytes()))!.rows[`agent|2.1.301|agent|provisional`]!.free).toBe(21);
    // After the minute the next change writes at once.
    clock.now += WRITE_EVERY_MS;
    l.read(KEY, FREE, null);
    expect(parseDay(JSON.parse(bytes()))!.rows[`agent|2.1.301|agent|provisional`]!.free).toBe(22);
  });

  test("an unknown verdict files the hash of its cluster once, and no row text exists anywhere in the file", () => {
    const l = ledger();
    l.read(KEY, NO_MATCH, "deadbeef0001");
    l.read(KEY, NO_MATCH, "deadbeef0001");
    l.read(KEY, NO_MATCH, "deadbeef0002");
    l.read(KEY, FREE, "deadbeef0003");
    l.flush();
    const day = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-16"), "utf8")));
    expect(Object.values(day!.unknownFrames)).toEqual([["deadbeef0001", "deadbeef0002"]]);
    expect(Object.values(day!.rows)[0]!.unknown).toEqual({ "no-match": 3 });
  });

  test("a failed write is a warning and never throws", () => {
    writeFileSync(dir(), "a file where the folder should be");
    const l = ledger();
    expect(() => l.read(KEY, FREE, null)).not.toThrow();
    l.flush();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a torn or foreign file is read as an empty day, and parseDay checks every field", () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(counterPath(dir(), "2026-10-16"), "{ not json");
    expect(ledger().rows()).toEqual([]);
    expect(parseDay("text")).toBeNull();
    expect(parseDay({ date: "yesterday" })).toBeNull();
    const day = parseDay({ date: "2026-10-16", rows: { x: { harness: "a", version: "1", profileId: "p", status: "verified", free: "many", unknown: { weird: -3, fine: 2 } }, y: 5 }, unknownFrames: { k: ["abc", 7, "XYZ!"] }, manualAt: { k: [1, "x", 2] } });
    expect(Object.values(day!.rows)).toEqual([{ harness: "a", version: "1", profileId: "p", status: "verified", free: 0, unknown: { fine: 2 }, modal: {}, refused: {}, probed: 0, manual: 0, sent: 0, effective: 0, unknown_outcome: 0, typed_not_submitted: 0, discarded: 0, held: 0, held_sent: 0, held_expired: 0, held_cancelled: 0, edges: {}, holds: {} }]);
    expect(day!.unknownFrames).toEqual({ k: ["abc"] });
    expect(day!.manualAt).toEqual({ k: [1, 2] });
  });
});

describe("the summary", () => {
  test("adds up the last seven days by row, today's unwritten counts included", () => {
    const l = ledger();
    for (let back = 9; back >= 0; back--) {
      clock.now = START - back * DAY;
      l.read(KEY, FREE, null);
      l.read(KEY, NO_MATCH, "aa");
      l.noteManual(KEY);
      l.flush();
    }
    clock.now = START;
    l.read(KEY, FREE, null);
    const rows = l.rows();
    expect(rows).toHaveLength(1);
    // Seven days of one free each, and one more read today that is not on disk yet.
    expect(rows[0]).toMatchObject({ free: 8, manual: 7 });
    expect(l.totals()).toEqual({ free: 8, unknown: 7, manual: 7 });
    expect(readDays(dir(), START, 7)).toHaveLength(7);
    expect(readDays(dir(), START, 3)).toHaveLength(3);
  });

  test("totals add the unknown reasons together, and rows sort by harness then version", () => {
    const rows = summarize([
      parseDay({ date: "2026-10-16", rows: {}, unknownFrames: {}, manualAt: {} })!,
    ]);
    expect(rows).toEqual([]);
    const l = ledger();
    l.read({ ...KEY, harness: "zeta", version: "2.10.0" }, NO_MATCH, null);
    l.read({ ...KEY, harness: "alpha", version: "2.9.0" }, WEAK, null);
    l.read({ ...KEY, harness: "alpha", version: "2.10.0" }, FREE, null);
    expect(l.rows().map((row) => `${row.harness} ${row.version}`)).toEqual(["alpha 2.9.0", "alpha 2.10.0", "zeta 2.10.0"]);
    expect(totalsOf(l.rows())).toEqual({ free: 1, unknown: 2, manual: 0 });
  });
});

describe("the cap", () => {
  test("is reached after N manual sends on one harness and version inside 24 hours, and not before", () => {
    const l = ledger({ cap: 5 });
    for (let n = 0; n < 4; n++) l.noteManual(KEY);
    expect(l.capState("agent", "2.1.301")).toEqual({ count: 4, limit: 5, reached: false });
    l.noteManual(KEY);
    expect(l.capState("agent", "2.1.301")).toEqual({ count: 5, limit: 5, reached: true });
    // Another version has its own count.
    expect(l.capState("agent", "2.1.302")).toEqual({ count: 0, limit: 5, reached: false });
    expect(l.capState("other", "2.1.301").reached).toBe(false);
  });

  test("the window is 24 hours, across midnight and across a restart", () => {
    const l = ledger({ cap: 2 });
    clock.now = Date.UTC(2026, 9, 16, 23, 0, 0);
    l.noteManual(KEY);
    l.noteManual(KEY);
    l.flush();
    clock.now = Date.UTC(2026, 9, 17, 1, 0, 0);
    expect(l.capState("agent", "2.1.301").reached).toBe(true);
    const restarted = ledger({ cap: 2 });
    expect(restarted.capState("agent", "2.1.301").reached).toBe(true);
    clock.now = Date.UTC(2026, 9, 16, 23, 0, 0) + CAP_WINDOW_MS + 1000;
    expect(restarted.capState("agent", "2.1.301")).toEqual({ count: 0, limit: 2, reached: false });
  });

  test("defaults to five", () => {
    expect(ledger().capState("agent", "1").limit).toBe(5);
  });

  test("a refusal's line is filed for the lab with the hash and the version, and the file is cut back when it grows", () => {
    const l = ledger();
    l.inbox({ harness: "agent", version: "2.1.301", profileId: "agent", status: "provisional", frame: "abc123", count: 5 });
    const lines = readFileSync(join(dir(), "inbox.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({ at: START, harness: "agent", version: "2.1.301", profileId: "agent", status: "provisional", frame: "abc123", count: 5 });
    for (let n = 0; n < 4000; n++) l.inbox({ harness: "agent", version: "2.1.301", profileId: "agent", status: "provisional", frame: `f${String(n)}`, count: 5 });
    const after = readFileSync(join(dir(), "inbox.jsonl"), "utf8").trim().split("\n");
    expect(after.length).toBeLessThanOrEqual(4000);
    expect(after.at(-1)).toContain("f3999");
  });
});

describe("the examples folder", () => {
  const entry = (n: number) => ({
    requestId: `req-${String(n).padStart(6, "0")}`,
    ...KEY,
    outcome: "sent" as const,
    cluster: ["> my password is hunter2", "────", "❯ Try \"fix it\"", "  sonnet · 12% · $0.34"],
    frame: "abc123",
    textLength: 12,
  });

  test("holds the cluster as a shape: every letter, digit and symbol is a class mark, the layout stays, the text is a length", () => {
    const l = ledger();
    l.example(entry(1));
    const [name] = readdirSync(l.examplesDir);
    const text = readFileSync(join(l.examplesDir, name!), "utf8");
    expect(text).not.toMatch(/hunter2|password|sonnet|fix it/u);
    // SAFETY: the file was written by `SurfaceLedger.example` a line above; only fields of the written body are read back.
    const body = JSON.parse(text) as { cluster: string[]; text: string };
    expect(body.cluster).toEqual(["x aa aaaaaaaa aa aaaaaa0", "────", "x aaa xaaa aax", "  aaaaaa x 00x x x0x00"]);
    expect(body.text).toBe("<typed:12>");
  });

  test("keeps at most fifty files, the oldest dropped", () => {
    const l = ledger();
    for (let n = 0; n < MAX_EXAMPLES + 7; n++) {
      clock.now = START + n;
      l.example(entry(n));
    }
    const names = readdirSync(l.examplesDir).toSorted();
    expect(names).toHaveLength(MAX_EXAMPLES);
    expect(names[0]).toContain("req-000007");
    expect(names.at(-1)).toContain(`req-${String(MAX_EXAMPLES + 6).padStart(6, "0")}`);
  });

  // The review of 2026-10-16: refusals repeat on one screen, so they get their own small cap and
  // one file per frame hash and reason per day, and never push the sent examples out.
  const refusal = (n: number, frame: string, reason = "unconfirmed") => ({
    ...entry(n),
    outcome: "refused" as const,
    reason,
    modal: "unreadable" as const,
    frame,
  });

  test("refused examples keep their own cap of ten, and the sent examples keep their fifty", () => {
    const l = ledger();
    for (let n = 0; n < MAX_EXAMPLES; n++) {
      clock.now = START + n;
      l.example(entry(n));
    }
    for (let n = 0; n < MAX_NEGATIVE_EXAMPLES + 4; n++) {
      clock.now = START + 1000 + n;
      l.example(refusal(n, `f${String(n).padStart(4, "0")}`));
    }
    const names = readdirSync(l.examplesDir).toSorted();
    const negative = names.filter((name) => name.includes("-refused-"));
    expect(negative).toHaveLength(MAX_NEGATIVE_EXAMPLES);
    expect(negative[0]).toContain("f0004");
    expect(names.length - negative.length).toBe(MAX_EXAMPLES);
  });

  test("a refusal files once per frame hash and reason per day", () => {
    const l = ledger();
    for (let n = 0; n < 5; n++) {
      clock.now = START + n;
      l.example(refusal(n, "same0"));
    }
    l.example(refusal(9, "same0", "not_free"));
    l.example(refusal(10, "other"));
    expect(readdirSync(l.examplesDir)).toHaveLength(3);
    // The next day the same screen and reason file again.
    clock.now = START + 24 * 60 * 60 * 1000;
    l.example(refusal(11, "same0"));
    expect(readdirSync(l.examplesDir)).toHaveLength(4);
  });

  test("maskRow keeps whitespace and box drawing, and hides letters, digits and symbols in every script", () => {
    expect(maskRow("sk-or-v1-abc123! \u256d\u2500\u256e")).toBe("aaxaaxa0xaaa000x \u256d\u2500\u256e");
    expect(maskRow("sk-or-v1-secret  \u2502 \u041f\u0440\u0438\u0432\u0435\u0442 \u65e5\u672c \u273b 12:30  ")).toBe("aaxaaxa0xaaaaaa  \u2502 aaaaaa aa x 00x00");
  });
});

describe("hook edges in the counters (M56 spec 11)", () => {
  test("counts each edge word per row, and a confirmed send moves from sent to effective", () => {
    const l = ledger();
    l.edge(KEY, "stop");
    l.edge(KEY, "stop");
    l.edge(KEY, "lost-stop");
    l.send(KEY, { outcome: "sent", probed: false });
    l.confirmEffective(KEY, "sent");
    l.flush();
    const [row] = l.rows();
    expect(row?.edges).toEqual({ stop: 2, "lost-stop": 1 });
    expect(row?.sent).toBe(0);
    expect(row?.effective).toBe(1);
    const day = parseDay(JSON.parse(readFileSync(counterPath(dir(), "2026-10-16"), "utf8")));
    expect(Object.values(day!.rows)[0]?.edges).toEqual({ stop: 2, "lost-stop": 1 });
  });
});
