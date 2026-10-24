import { describe, expect, it } from "bun:test";

import { basename, dirname, join } from "node:path";

import type { JsonObject } from "./json.ts";
import type { AgentView } from "./types.ts";
import {
  parseUsageRecord,
  USAGE_FILE_MAX_BYTES,
  USAGE_MAX_AGE_MS,
  usageAt,
  usageFileName,
  UsageTracker,
  type UsageFiles,
  type UsageLimit,
} from "./usage.ts";

const NOW = 1_800_000_000_000;

function record(extra: JsonObject): string {
  return JSON.stringify({ schemaVersion: 1, harness: "claude", at: NOW, ...extra });
}

describe("parseUsageRecord", () => {
  it("keeps the numbers, clamped, and the two known windows in their order", () => {
    const parsed = parseUsageRecord(
      record({
        context: 142,
        limits: [
          { window: "7d", used: 36, resetsAt: NOW + 1000 },
          { window: "5h", used: -4 },
          { window: "spend", used: 50 },
        ],
      }),
    );
    expect(parsed).toEqual({
      schemaVersion: 1,
      harness: "claude",
      at: NOW,
      context: 100,
      limits: [
        { window: "5h", used: 0 },
        { window: "7d", used: 36, resetsAt: NOW + 1000 },
      ],
    });
  });

  it("refuses junk, a newer schema, a missing time and an oversized file", () => {
    expect(parseUsageRecord("not json")).toBeNull();
    expect(parseUsageRecord("[]")).toBeNull();
    expect(parseUsageRecord(JSON.stringify({ schemaVersion: 2, harness: "claude", at: NOW, context: 4 }))).toBeNull();
    expect(parseUsageRecord(JSON.stringify({ schemaVersion: 1, harness: "claude", context: 4 }))).toBeNull();
    expect(parseUsageRecord(record({ context: 4, pad: "x".repeat(USAGE_FILE_MAX_BYTES) }))).toBeNull();
  });

  it("drops a number that is not a number, and carries no text the phone could draw", () => {
    const parsed = parseUsageRecord(record({ context: "42", limits: [{ window: "5h", used: "9" }], label: "<b>" }));
    expect(parsed).toEqual({ schemaVersion: 1, harness: "claude", at: NOW });
  });
});

describe("the window note", () => {
  it("round-trips as a positive integer, a record without it still parses, and junk is dropped", () => {
    expect(parseUsageRecord(record({ context: 4, window: 1_000_000 }))).toEqual({ schemaVersion: 1, harness: "claude", at: NOW, context: 4, window: 1_000_000 });
    expect(parseUsageRecord(record({ context: 4 }))?.window).toBeUndefined();
    for (const window of [0, -5, 1.5, "200000", null, 1e12]) expect(parseUsageRecord(record({ context: 4, window }))?.window).toBeUndefined();
  });

  it("is never drawn: the phone gets the context and the limits only", () => {
    const parsed = parseUsageRecord(record({ context: 4, window: 200_000 }));
    expect(usageAt(parsed!, NOW)).toEqual({ context: 4 });
    expect(usageAt(parseUsageRecord(record({ window: 200_000 }))!, NOW)).toBeUndefined();
  });
});

describe("usageAt", () => {
  it("drops a window whose reset has passed, as Claude Code does", () => {
    const parsed = parseUsageRecord(
      record({ context: 10, limits: [{ window: "5h", used: 90, resetsAt: NOW - 1 }, { window: "7d", used: 20, resetsAt: NOW + 1 }] }),
    );
    expect(parsed).not.toBeNull();
    expect(usageAt(parsed!, NOW)).toEqual({ context: 10, limits: [{ window: "7d", used: 20, resetsAt: NOW + 1 }] });
  });

  it("is absent when nothing is left", () => {
    const parsed = parseUsageRecord(record({ limits: [{ window: "5h", used: 90, resetsAt: NOW - 1 }] }));
    expect(usageAt(parsed!, NOW)).toBeUndefined();
  });
});

describe("usageFileName", () => {
  it("names a file by a digest, so a strange session id never becomes a path", () => {
    expect(usageFileName("../../etc/passwd")).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(usageFileName("abc")).toBe(usageFileName("abc"));
    expect(usageFileName("abc")).not.toBe(usageFileName("abd"));
  });
});

/** A disk in memory: path to [mtime, text]. */
function memoryFiles(entries: Map<string, [number, string]>): UsageFiles & { reads: number } {
  const disk = {
    reads: 0,
    mtime: async (path: string) => entries.get(path)?.[0] ?? null,
    read: async (path: string) => {
      disk.reads += 1;
      return entries.get(path)?.[1] ?? null;
    },
    list: async (dir: string) =>
      [...entries.keys()].filter((path) => dirname(path) === join(dir)).map((path) => basename(path)),
    remove: async (path: string) => {
      entries.delete(path);
    },
  };
  return disk;
}

function pane(session: string | null): AgentView {
  // SAFETY: the tracker reads `agentSession` and nothing else off a pane; the rest of the shape is
  // irrelevant to it, and building a full AgentView here would test the fixture, not the tracker.
  return (session === null ? {} : { agentSession: { kind: "id", value: session } }) as AgentView;
}

describe("UsageTracker", () => {
  const dir = "/state/usage";
  // The tracker joins with the machine's own separator, so the fake disk's keys do too.
  const file = (session: string): string => join(dir, usageFileName(session));

  it("reads a pane's file by its session, and reads it again only when the mtime moves", async () => {
    const entries = new Map<string, [number, string]>([[file("s1"), [NOW, record({ context: 42 })]]]);
    const files = memoryFiles(entries);
    const tracker = new UsageTracker(dir, files, () => NOW);
    await tracker.refresh([pane("s1"), pane(null)]);
    expect(tracker.get(pane("s1"))).toEqual({ context: 42 });
    expect(tracker.get(pane(null))).toBeUndefined();
    expect(tracker.get(pane("s2"))).toBeUndefined();
    const reads = files.reads;
    await tracker.refresh([pane("s1")]);
    expect(files.reads).toBe(reads);
    entries.set(file("s1"), [NOW + 1, record({ context: 50 })]);
    await tracker.refresh([pane("s1")]);
    expect(tracker.get(pane("s1"))).toEqual({ context: 50 });
  });

  it("forgets a session no pane has, and a file that went away", async () => {
    const path = file("s1");
    const entries = new Map<string, [number, string]>([[path, [NOW, record({ context: 42 })]]]);
    const tracker = new UsageTracker(dir, memoryFiles(entries), () => NOW);
    await tracker.refresh([pane("s1")]);
    entries.delete(path);
    await tracker.refresh([pane("s1")]);
    expect(tracker.get(pane("s1"))).toBeUndefined();
  });

  it("one mux session's poll keeps the readings of another's panes", async () => {
    const entries = new Map<string, [number, string]>([
      [file("a"), [NOW, record({ context: 1 })]],
      [file("b"), [NOW, record({ context: 2 })]],
    ]);
    const tracker = new UsageTracker(dir, memoryFiles(entries), () => NOW);
    await tracker.refresh([pane("a")], "main");
    await tracker.refresh([pane("b")], "work");
    expect(tracker.get(pane("a"))).toEqual({ context: 1 });
    expect(tracker.get(pane("b"))).toEqual({ context: 2 });
    await tracker.refresh([], "main");
    expect(tracker.get(pane("a"))).toBeUndefined();
    expect(tracker.get(pane("b"))).toEqual({ context: 2 });
  });

  it("shows each window as the newest any session of the harness reported; the context stays per session", async () => {
    const entries = new Map<string, [number, string]>([
      [file("old"), [NOW, record({ at: NOW - 3_600_000, context: 70, limits: [{ window: "5h", used: 10 }, { window: "7d", used: 30 }] })]],
      [file("new"), [NOW, record({ at: NOW, context: 5, limits: [{ window: "5h", used: 60 }] })]],
      [file("api"), [NOW, record({ at: NOW, context: 9 })]],
      [file("other"), [NOW, JSON.stringify({ schemaVersion: 1, harness: "codex", at: NOW + 1, limits: [{ window: "5h", used: 99 }] })]],
    ]);
    const tracker = new UsageTracker(dir, memoryFiles(entries), () => NOW);
    await tracker.refresh([pane("old"), pane("new"), pane("api"), pane("other")]);
    // The older session shows the newer 5h figure, keeps the 7d only it has, and its own context.
    expect(tracker.get(pane("old"))).toEqual({ context: 70, limits: [{ window: "5h", used: 60 }, { window: "7d", used: 30 }] });
    expect(tracker.get(pane("new"))).toEqual({ context: 5, limits: [{ window: "5h", used: 60 }, { window: "7d", used: 30 }] });
    // A session that reported no windows (an API key) gets none from its neighbours.
    expect(tracker.get(pane("api"))).toEqual({ context: 9 });
    // Another harness's account is another account.
    expect(tracker.get(pane("other"))).toEqual({ limits: [{ window: "5h", used: 99 }] });
  });

  it("removes readings past their age, and leaves files that are not its own", async () => {
    const old = file("old");
    const fresh = file("fresh");
    const foreign = join(dir, "notes.txt");
    const entries = new Map<string, [number, string]>([
      [old, [NOW - USAGE_MAX_AGE_MS - 1, record({ context: 1 })]],
      [fresh, [NOW, record({ context: 2 })]],
      [foreign, [0, "x"]],
    ]);
    const tracker = new UsageTracker(dir, memoryFiles(entries), () => NOW);
    await tracker.refresh([]);
    expect([...entries.keys()].toSorted()).toEqual([fresh, foreign].toSorted());
  });
});

describe("UsageTracker with the account windows (ADR 0118)", () => {
  const dir = "/state/usage";
  const file = (session: string): string => join(dir, usageFileName(session));
  const ACCOUNT = [
    { window: "5h" as const, used: 33, resetsAt: NOW + 60_000 },
    { window: "7d" as const, used: 7, resetsAt: NOW + 120_000 },
  ];
  function claudePane(session: string | null, kind: "agent" | "shell" = "agent"): AgentView {
    // SAFETY: the tracker reads `agentSession`, `agent` and `kind` off a pane and nothing else.
    return { ...pane(session), agent: "claude", kind } as AgentView;
  }
  function account(limits: Record<string, UsageLimit[] | undefined>) {
    return { limits: (harness: string) => limits[harness] };
  }

  it("the account windows win over a wrapped statusLine's, and the context stays the session's", async () => {
    const entries = new Map<string, [number, string]>([
      [file("s1"), [NOW, record({ context: 42, limits: [{ window: "5h", used: 90 }, { window: "7d", used: 80 }] })]],
    ]);
    const tracker = new UsageTracker(dir, memoryFiles(entries), () => NOW, account({ claude: ACCOUNT }));
    await tracker.refresh([claudePane("s1")]);
    expect(tracker.get(claudePane("s1"))).toEqual({ context: 42, limits: ACCOUNT });
  });

  it("a pane with no session record still gets the account windows", async () => {
    const tracker = new UsageTracker(dir, memoryFiles(new Map()), () => NOW, account({ claude: ACCOUNT }));
    await tracker.refresh([claudePane(null), claudePane("s9")]);
    expect(tracker.get(claudePane(null))).toEqual({ limits: ACCOUNT });
    expect(tracker.get(claudePane("s9"))).toEqual({ limits: ACCOUNT });
  });

  it("a shell and another harness get none", async () => {
    const tracker = new UsageTracker(dir, memoryFiles(new Map()), () => NOW, account({ claude: ACCOUNT }));
    expect(tracker.get(claudePane(null, "shell"))).toBeUndefined();
    // SAFETY: as in claudePane, the tracker reads only `agentSession`, `agent` and `kind`.
    expect(tracker.get({ ...claudePane(null), agent: "codex" } as AgentView)).toBeUndefined();
  });

  it("without account windows the statusLine road works as before", async () => {
    const limits: UsageLimit[] = [{ window: "5h", used: 90 }, { window: "7d", used: 80 }];
    const written = limits.map((limit) => ({ window: limit.window, used: limit.used }));
    const entries = new Map<string, [number, string]>([[file("s1"), [NOW, record({ context: 42, limits: written })]]]);
    const readings: Array<UsageLimit[] | undefined> = [undefined, []];
    for (const reading of readings) {
      const tracker = new UsageTracker(dir, memoryFiles(entries), () => NOW, account({ claude: reading }));
      await tracker.refresh([claudePane("s1")]);
      expect(tracker.get(claudePane("s1"))).toEqual({ context: 42, limits });
      expect(tracker.get(claudePane(null))).toBeUndefined();
    }
  });

  it("drops an account window whose reset has passed", async () => {
    const tracker = new UsageTracker(dir, memoryFiles(new Map()), () => NOW + 90_000, account({ claude: ACCOUNT }));
    expect(tracker.get(claudePane(null))).toEqual({ limits: ACCOUNT.slice(1) });
  });
});
