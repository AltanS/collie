import { describe, expect, test } from "bun:test";

import {
  AuditLog,
  fileAuditAppender,
  formatAuditLine,
  type AppendFn,
  type AuditEntry,
  type AuditFileIo,
} from "./audit.ts";

// formatAuditLine is the pure, load-bearing bit (stable order, truncation, single-line output); the
// AuditLog writer is exercised with a fake append so the fire-and-forget + never-throw contract is
// verified without touching disk.

describe("formatAuditLine", () => {
  test("stamps an ISO ts and keeps a stable field order (ts, action, paneId, device, detail)", () => {
    const line = formatAuditLine(
      { action: "reply", paneId: "w1:p1", device: "phone", detail: { submit: true } },
      0,
    );
    expect(line).toBe(
      '{"ts":"1970-01-01T00:00:00.000Z","action":"reply","paneId":"w1:p1","device":"phone","detail":{"submit":true}}',
    );
  });

  test("omits paneId and device when absent/null (rather than emitting null)", () => {
    const line = formatAuditLine({ action: "workspace.create", device: null, detail: {} }, 0);
    expect(JSON.parse(line)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      action: "workspace.create",
      detail: {},
    });
    expect(line).not.toContain("device");
    expect(line).not.toContain("paneId");
  });

  test("truncates a long string value to 120 chars + ellipsis", () => {
    const long = "x".repeat(500);
    const parsed = JSON.parse(formatAuditLine({ action: "reply", detail: { text: long } }, 0));
    expect(parsed.detail.text).toBe(`${"x".repeat(120)}…`);
  });

  test("folds embedded newlines so the output is a single line", () => {
    const line = formatAuditLine(
      { action: "reply", detail: { text: "line one\nline two\r\nthree" } },
      0,
    );
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).detail.text).toBe("line one line two three");
  });

  test("sanitizes strings nested in arrays (e.g. key names)", () => {
    const parsed = JSON.parse(
      formatAuditLine({ action: "keys", detail: { keys: ["Enter", "a\nb"] } }, 0),
    );
    expect(parsed.detail.keys).toEqual(["Enter", "a b"]);
  });

  test("renders host right after action, before paneId (PACK_PROTOCOL.md §4)", () => {
    const line = formatAuditLine(
      { action: "reply", host: "peer-a", paneId: "w1:p1", detail: { text: "ship it" } },
      0,
    );
    expect(line).toBe(
      '{"ts":"1970-01-01T00:00:00.000Z","action":"reply","host":"peer-a","paneId":"w1:p1","detail":{"text":"ship it"}}',
    );
  });

  test("omits host when absent — byte-identical to a pre-pack line (solo zero-tax, §11)", () => {
    const line = formatAuditLine({ action: "reply", paneId: "w1:p1", detail: { text: "ship it" } }, 0);
    expect(line).toBe(
      '{"ts":"1970-01-01T00:00:00.000Z","action":"reply","paneId":"w1:p1","detail":{"text":"ship it"}}',
    );
    expect(line).not.toContain("host");
  });

  test("two hosts with the same session+paneId produce distinguishable lines", () => {
    const shared = { action: "reply", session: "default", paneId: "w1:p1", detail: {} } as const;
    const lineA = formatAuditLine({ ...shared, host: "peer-a" }, 0);
    const lineB = formatAuditLine({ ...shared, host: "peer-b" }, 0);
    expect(lineA).not.toBe(lineB);
    expect(JSON.parse(lineA).host).toBe("peer-a");
    expect(JSON.parse(lineB).host).toBe("peer-b");
  });
});

describe("AuditLog", () => {
  test("records a formatted, newline-terminated line to the injected append", async () => {
    const lines: string[] = [];
    const append: AppendFn = (l) => void lines.push(l);
    const log = new AuditLog(append, { now: () => 0 });

    log.record({ action: "keys", paneId: "p1", detail: { keys: ["Enter"] } });
    // record() is fire-and-forget; let the swallowed promise settle.
    await Promise.resolve();

    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      action: "keys",
      paneId: "p1",
      detail: { keys: ["Enter"] },
    });
  });

  test("a rejecting append never throws out of record() (audit must not break the action)", async () => {
    const append: AppendFn = () => Promise.reject(new Error("disk full"));
    const log = new AuditLog(append, { now: () => 0 });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => void warnings.push(args.map(String).join(" "))) as typeof console.warn;
    try {
      expect(() => log.record({ action: "reply", detail: {} } satisfies AuditEntry)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes("write failed"))).toBe(true);
  });

  test("a synchronously-throwing append is also swallowed", () => {
    const append: AppendFn = () => {
      throw new Error("boom");
    };
    const log = new AuditLog(append, { now: () => 0 });
    const origWarn = console.warn;
    console.warn = (() => {}) as typeof console.warn;
    try {
      expect(() => log.record({ action: "upload", detail: {} })).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
  });
});

// ── The size cap: an unauthenticated caller can add lines, so it must not add bytes forever ──

/** An in-memory filesystem for the appender: files by path, `rotate` overwriting the destination. */
function fakeIo(seed: Record<string, string> = {}): AuditFileIo & {
  files: Record<string, string>;
  failRotate?: boolean;
} {
  const files: Record<string, string> = { ...seed };
  const io = {
    files,
    failRotate: false,
    size: async (p: string) => Buffer.byteLength(files[p] ?? "", "utf8"),
    rotate: async (from: string, to: string) => {
      if (io.failRotate) throw new Error("EACCES");
      if (files[from] === undefined) throw new Error("ENOENT");
      files[to] = files[from]!;
      delete files[from];
    },
    append: async (p: string, line: string) => {
      files[p] = (files[p] ?? "") + line;
    },
  };
  return io;
}

describe("fileAuditAppender rotation", () => {
  test("rotates at the cap: the old content lands in .1 and the line starts a fresh log", async () => {
    const io = fakeIo();
    const append = fileAuditAppender("/s/audit.log", io, 20);
    await append("a".repeat(20) + "\n");
    // Still one file — the cap is checked before a write, so the line that crosses it stays put.
    expect(io.files["/s/audit.log.1"]).toBeUndefined();
    await append("second\n");
    expect(io.files["/s/audit.log.1"]).toBe("a".repeat(20) + "\n");
    expect(io.files["/s/audit.log"]).toBe("second\n");
  });

  test("keeps exactly one generation — a second rotation replaces .1", async () => {
    const io = fakeIo();
    const append = fileAuditAppender("/s/audit.log", io, 8);
    await append("first-1\n");
    await append("second2\n");
    expect(io.files["/s/audit.log.1"]).toBe("first-1\n");
    await append("third\n");
    expect(io.files["/s/audit.log.1"]).toBe("second2\n");
    expect(io.files["/s/audit.log"]).toBe("third\n");
    expect(Object.keys(io.files).sort()).toEqual(["/s/audit.log", "/s/audit.log.1"]);
  });

  test("a failed rename still appends — an oversized trail beats a missing line", async () => {
    const io = fakeIo();
    io.failRotate = true;
    const append = fileAuditAppender("/s/audit.log", io, 8);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => void warnings.push(args.map(String).join(" "))) as typeof console.warn;
    try {
      await append("first-1\n");
      await append("second\n");
    } finally {
      console.warn = origWarn;
    }
    expect(io.files["/s/audit.log"]).toBe("first-1\nsecond\n");
    expect(io.files["/s/audit.log.1"]).toBeUndefined();
    expect(warnings.some((w) => w.includes("could not rotate"))).toBe(true);
  });

  test("lines below the cap never rotate", async () => {
    const io = fakeIo();
    const append = fileAuditAppender("/s/audit.log", io, 1024);
    for (let i = 0; i < 20; i++) await append(`line ${i}\n`);
    expect(io.files["/s/audit.log.1"]).toBeUndefined();
    expect(io.files["/s/audit.log"]!.split("\n")).toHaveLength(21);
  });

  test("seeds its counter from the existing file, so a restart doesn't reset the cap", async () => {
    // The in-memory counter is an optimisation, not the truth: a fresh process inherits a log that
    // is already at the cap and must rotate on its first line, not after another 5 MiB.
    const io = fakeIo({ "/s/audit.log": "x".repeat(64) + "\n" });
    const append = fileAuditAppender("/s/audit.log", io, 32);
    await append("after restart\n");
    expect(io.files["/s/audit.log.1"]).toBe("x".repeat(64) + "\n");
    expect(io.files["/s/audit.log"]).toBe("after restart\n");
  });
});

// ── §12: a pack-originated write is identifiable in the PEER's own log ───────

describe("pack attribution", () => {
  test("via + from ride next to device, and only when present", () => {
    const line = JSON.parse(
      formatAuditLine(
        { action: "reply", paneId: "w1:p1", session: "work", device: "phone-7", via: "pack", from: "desk", detail: { text: "hi" } },
        0,
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(line)).toEqual(["ts", "action", "paneId", "session", "device", "via", "from", "detail"]);
    expect(line.via).toBe("pack");
    expect(line.from).toBe("desk");
  });

  test("a line with no pack attribution is byte-identical to a pre-pack one", () => {
    // The solo zero-tax contract (PACK_PROTOCOL.md §11): optional fields are OMITTED, never nulled.
    const line = formatAuditLine({ action: "reply", paneId: "w1:p1", session: "work", detail: {} }, 0);
    expect(line).not.toContain("via");
    expect(line).not.toContain("from");
    expect(line).toBe(
      JSON.stringify({ ts: new Date(0).toISOString(), action: "reply", paneId: "w1:p1", session: "work", detail: {} }),
    );
  });

  test("`scoped()` stamps every entry, so a handler cannot forget the attribution", async () => {
    // This is how the peer hands the UNMODIFIED browser handlers a log that already knows the action
    // arrived over a pack link — the handlers take no `via` parameter and there is nothing to forget.
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), { now: () => 0 });
    const packLog = log.scoped({ via: "pack", from: "desk" });
    packLog.record({ action: "keys", paneId: "w1:p1", device: "phone-7", detail: { keys: ["Enter"] } });
    // The unscoped log is untouched — one process, two views, no leakage between them.
    log.record({ action: "keys", paneId: "w1:p1", detail: {} });
    await Bun.sleep(5);
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: "keys", via: "pack", from: "desk", device: "phone-7" });
    expect(lines[1]).not.toContain("pack");
  });

  test("an entry's own field beats the scope's — the record is what happened, not what was assumed", () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), { now: () => 0 }).scoped({ via: "pack", from: "desk" });
    log.record({ action: "reply", from: "nas", detail: {} });
    expect(JSON.parse(lines[0]!).from).toBe("nas");
  });

  // `defaults` and `content` share one options object precisely so neither can be transposed into
  // the other's slot — and a scoped view must keep BOTH. A `scoped()` that dropped the content mode
  // would be a redaction quietly turning itself off on exactly the lines a peer writes.
  test("a scoped view keeps the content mode as well as the attribution", () => {
    const lines: string[] = [];
    const log = new AuditLog((l) => void lines.push(l), {
      now: () => 0,
      content: "none",
    }).scoped({ via: "pack", from: "desk" });
    log.record({ action: "reply", paneId: "w1:p1", detail: { text: "the secret" } });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ action: "reply", via: "pack", from: "desk" });
    expect(lines[0]).not.toContain("the secret");
  });
});
