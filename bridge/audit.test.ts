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
