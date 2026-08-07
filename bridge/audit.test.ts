import { describe, expect, test } from "bun:test";

import { AuditLog, formatAuditLine, type AppendFn, type AuditEntry } from "./audit.ts";

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
    const log = new AuditLog(append, () => 0);

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
    const log = new AuditLog(append, () => 0);
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
    const log = new AuditLog(append, () => 0);
    const origWarn = console.warn;
    console.warn = (() => {}) as typeof console.warn;
    try {
      expect(() => log.record({ action: "upload", detail: {} })).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
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
    const log = new AuditLog((l) => void lines.push(l), () => 0);
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
    const log = new AuditLog((l) => void lines.push(l), () => 0).scoped({ via: "pack", from: "desk" });
    log.record({ action: "reply", from: "nas", detail: {} });
    expect(JSON.parse(lines[0]!).from).toBe("nas");
  });
});
