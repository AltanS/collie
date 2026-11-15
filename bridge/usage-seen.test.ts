import { describe, expect, it } from "bun:test";

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryAddedIo } from "./launchers-added.ts";
import { formatSeenFile, parseSeenText, SEEN_KEYS_MAX, SEEN_WRITE_EVERY_MS, UsageSeen, USAGE_SEEN_FILE, usageSeenIo } from "./usage-seen.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function setup(initial: string | null = null) {
  const io = memoryAddedIo(initial);
  const clock = { now: NOW };
  const lines: string[] = [];
  const seen = new UsageSeen(io, () => clock.now, (line) => lines.push(line));
  return { io, clock, lines, seen };
}

const FIVE = { window: "5h", used: 40, resetsAt: NOW + 3_600_000 };
const WEEK = { window: "7d", used: 12, resetsAt: NOW + 86_400_000 };
const OPUS = { window: "7d:opus", used: 30, resetsAt: NOW + 86_400_000, label: "Opus" };

describe("UsageSeen.record and reading", () => {
  it("answers null for a key never held", () => {
    const { seen } = setup();
    expect(seen.reading("claude", undefined, NOW)).toBeNull();
  });

  it("answers the live reading with its time, the windows as the page draws them", () => {
    const { seen } = setup();
    seen.record("claude", undefined, [WEEK, FIVE, OPUS], NOW);
    expect(seen.reading("claude", undefined, NOW + 1000)).toEqual({
      at: NOW,
      windows: [
        { window: "5h", usedPct: 40, resetsAt: NOW + 3_600_000 },
        { window: "7d", usedPct: 12, resetsAt: NOW + 86_400_000 },
        { window: "7d:opus", label: "Opus", usedPct: 30, resetsAt: NOW + 86_400_000 },
      ],
    });
  });

  it("keys on the harness and the cleaned config folder; the default folder is its own key", () => {
    const { seen } = setup();
    seen.record("claude", "/home/u/.claude-work/", [FIVE], NOW);
    expect(seen.reading("claude", "/home/u/.claude-work", NOW)?.windows).toHaveLength(1);
    expect(seen.reading("claude", undefined, NOW)).toBeNull();
    expect(seen.reading("codex", "/home/u/.claude-work", NOW)).toBeNull();
  });

  it("returns a window whose reset time has passed as usedPct null, and leaves one without a reset time alone", () => {
    const { seen } = setup();
    seen.record("claude", undefined, [{ window: "5h", used: 90, resetsAt: NOW + 1000 }, { window: "7d", used: 5 }], NOW);
    const later = seen.reading("claude", undefined, NOW + 1001);
    expect(later?.windows).toEqual([
      { window: "5h", usedPct: null, resetsAt: NOW + 1000 },
      { window: "7d", usedPct: 5, resetsAt: null },
    ]);
  });

  it("keeps a window that reset while the session lived, until the vendor names a new one", () => {
    const { seen } = setup();
    seen.record("claude", undefined, [{ window: "5h", used: 90, resetsAt: NOW + 1000 }, WEEK], NOW);
    seen.record("claude", undefined, [WEEK], NOW + 2000);
    expect(seen.reading("claude", undefined, NOW + 2000)?.windows.map((w) => [w.window, w.usedPct])).toEqual([["5h", null], ["7d", 12]]);
    seen.record("claude", undefined, [{ window: "5h", used: 3, resetsAt: NOW + 20_000 }, WEEK], NOW + 3000);
    expect(seen.reading("claude", undefined, NOW + 3000)?.windows.map((w) => [w.window, w.usedPct])).toEqual([["5h", 3], ["7d", 12]]);
  });

  it("ignores an offer with no window, an older offer, and a number that is not one", () => {
    const { seen } = setup();
    seen.record("claude", undefined, [FIVE], NOW);
    seen.record("claude", undefined, [], NOW + 5);
    seen.record("claude", undefined, [WEEK], NOW - 5);
    seen.record("claude", undefined, [{ window: "5h", used: Number.NaN }], NOW + 9);
    expect(seen.reading("claude", undefined, NOW)).toEqual({ at: NOW, windows: [{ window: "5h", usedPct: 40, resetsAt: NOW + 3_600_000 }] });
  });

  it("holds numbers, labels and times only", async () => {
    const { seen, io } = setup();
    // A caller may hand an object with more fields than the type names; none of them reaches the file.
    const sneaky = Object.assign({ window: "5h", used: 10 }, { token: "placeholder-token", account: "someone@example.invalid" });
    seen.record("claude", undefined, [sneaky], NOW);
    await seen.settled();
    expect(io.text).not.toContain("placeholder-token");
    expect(io.text).not.toContain("someone@example.invalid");
  });
});

describe("UsageSeen writes", () => {
  it("writes the first reading of a key at once, and the file round trips", async () => {
    const { seen, io } = setup();
    seen.record("claude", undefined, [FIVE, WEEK], NOW);
    await seen.settled();
    expect(io.writes).toBe(1);
    const entries = parseSeenText(io.text);
    expect(entries).toEqual([{ harness: "claude", dir: "", at: NOW, windows: [
      { window: "5h", usedPct: 40, resetsAt: NOW + 3_600_000 },
      { window: "7d", usedPct: 12, resetsAt: NOW + 86_400_000 },
    ] }]);
  });

  it("writes a key at most once a minute, and only when a figure changed", async () => {
    const { seen, io, clock } = setup();
    seen.record("claude", undefined, [FIVE], NOW);
    clock.now = NOW + 10_000;
    seen.record("claude", undefined, [{ ...FIVE, used: 41 }], NOW + 10_000);
    await seen.settled();
    expect(io.writes).toBe(1);
    // A minute on, the same figures at a later time are no change.
    clock.now = NOW + SEEN_WRITE_EVERY_MS + 1;
    seen.record("claude", undefined, [FIVE], clock.now);
    seen.record("claude", undefined, [FIVE], clock.now + 1);
    await seen.settled();
    expect(io.writes).toBe(2);
    clock.now += MIN + 1;
    seen.record("claude", undefined, [FIVE], clock.now);
    await seen.settled();
    expect(io.writes).toBe(2);
    // A changed figure after a minute is written.
    clock.now += MIN + 1;
    seen.record("claude", undefined, [{ ...FIVE, used: 77 }], clock.now);
    await seen.settled();
    expect(io.writes).toBe(3);
    expect(parseSeenText(io.text)?.[0]?.windows[0]?.usedPct).toBe(77);
  });

  it("rate-limits each key on its own", async () => {
    const { seen, io } = setup();
    seen.record("claude", undefined, [FIVE], NOW);
    seen.record("claude", "/home/u/.claude-b", [FIVE], NOW);
    await seen.settled();
    expect(io.writes).toBe(2);
    expect(parseSeenText(io.text)).toHaveLength(2);
  });

  it("reads the last reading back after a restart, and a live one is newer than it", async () => {
    const first = setup();
    first.seen.record("claude", undefined, [FIVE, WEEK], NOW);
    await first.seen.settled();
    const second = setup(first.io.text);
    await second.seen.settled();
    expect(second.seen.reading("claude", undefined, NOW + 1)?.at).toBe(NOW);
    second.seen.record("claude", undefined, [{ ...FIVE, used: 50 }], NOW + 5 * MIN);
    expect(second.seen.reading("claude", undefined, NOW + 5 * MIN)).toMatchObject({ at: NOW + 5 * MIN });
  });

  it("a stored window past its reset comes back as reset since", async () => {
    const first = setup();
    first.seen.record("claude", undefined, [{ window: "5h", used: 90, resetsAt: NOW + 1000 }], NOW);
    await first.seen.settled();
    const second = setup(first.io.text);
    await second.seen.settled();
    expect(second.seen.reading("claude", undefined, NOW + 99_000)?.windows).toEqual([{ window: "5h", usedPct: null, resetsAt: NOW + 1000 }]);
  });

  it("keeps at most 32 keys, and the oldest reading goes", async () => {
    const { seen, io, clock } = setup();
    for (let i = 0; i < SEEN_KEYS_MAX + 3; i++) {
      clock.now = NOW + i;
      seen.record("claude", `/home/u/.claude-${String(i)}`, [FIVE], NOW + i);
    }
    await seen.settled();
    const entries = parseSeenText(io.text) ?? [];
    expect(entries).toHaveLength(SEEN_KEYS_MAX);
    expect(entries.some((e) => e.dir.endsWith("-0"))).toBe(false);
    expect(entries.some((e) => e.dir.endsWith(`-${String(SEEN_KEYS_MAX + 2)}`))).toBe(true);
    expect(seen.reading("claude", "/home/u/.claude-0", NOW + 99)).toBeNull();
  });
});

describe("a file that is not ours", () => {
  it("reads as empty and is not written over, for junk and for another version", async () => {
    for (const text of ["not json", "[]", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1 })]) {
      const { seen, io, lines } = setup(text);
      await seen.settled();
      expect(seen.reading("claude", undefined, NOW)).toBeNull();
      seen.record("claude", undefined, [FIVE], NOW);
      await seen.settled();
      expect(io.writes).toBe(0);
      expect(io.text).toBe(text);
      expect(lines.join("\n")).toContain("is not a version 1 file");
      // The live reading is still answered from memory.
      expect(seen.reading("claude", undefined, NOW)?.windows).toHaveLength(1);
    }
  });

  it("drops an entry that is malformed and keeps the good ones", () => {
    const good = { harness: "claude", dir: "", at: NOW, windows: [{ window: "5h", usedPct: 10, resetsAt: null }] };
    const text = JSON.stringify({ version: 1, entries: [good, { harness: "x" }, "no", { harness: "claude", dir: "/d", at: "now", windows: [] }, { ...good, harness: "codex", windows: [{ window: "", usedPct: 1 }] }] });
    expect(parseSeenText(text)).toEqual([good]);
  });

  it("formats the file with its version", () => {
    expect(JSON.parse(formatSeenFile([]))).toEqual({ version: 1, entries: [] });
  });
});

describe("the file on disk", () => {
  it("is owner-only and atomic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-seen-"));
    try {
      const seen = new UsageSeen(usageSeenIo(dir), () => NOW, () => {});
      seen.record("claude", undefined, [FIVE], NOW);
      await seen.settled();
      const file = join(dir, USAGE_SEEN_FILE);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a bridge that only starts and reads writes no file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-seen-"));
    try {
      const seen = new UsageSeen(usageSeenIo(dir), () => NOW, () => {});
      await seen.settled();
      expect(seen.reading("claude", undefined, NOW)).toBeNull();
      await expect(stat(join(dir, USAGE_SEEN_FILE))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
