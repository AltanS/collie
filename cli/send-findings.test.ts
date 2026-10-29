import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestStore, type RequestPhase } from "../bridge/surface/requests.ts";
import { troubleStep } from "../web/src/lib/report/trouble.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import type { SendOutcome, SendReason, SendReceipt } from "../web/src/lib/surface/send.ts";
import {
  sendFindings,
  SENDS_ERROR_MIN,
  SENDS_LOST_WARN_MIN,
  SENDS_LOST_WARN_RATE,
  SENDS_NONE_WARN_MIN,
  SENDS_WINDOW_COUNT,
  SENDS_WINDOW_MS,
  type SendsFinding,
} from "./send-findings.ts";
import { realFiles, type Files } from "./sys.ts";

const STATE = "/state";
const SENDS = join(STATE, "sends");
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

interface Send {
  readonly outcome: SendOutcome;
  readonly reason?: SendReason;
  readonly harness?: string;
  /** Minutes before NOW. */
  readonly ago?: number;
  readonly phase?: RequestPhase;
}

function receiptOf(id: string, send: Send): SendReceipt {
  const receipt: SendReceipt = {
    requestId: id,
    session: "main",
    paneId: "%1",
    paneGeneration: "g1",
    harness: send.harness ?? "codex",
    version: "0.156.1",
    profileId: send.harness ?? "codex",
    profileStatus: "verified",
    textHash: "0".repeat(64),
    textLength: 5,
    s0: null,
    s1: null,
    s2: null,
    gapsMs: {},
    keys: [],
    outcome: send.outcome,
  };
  return send.reason === undefined ? receipt : { ...receipt, reason: send.reason };
}

/** One request file as the store writes it, settled unless the send says otherwise. */
function recordFile(id: string, send: Send): string {
  const phase = send.phase ?? (send.outcome === "held" ? "held" : "settled");
  const acceptedAt = NOW - (send.ago ?? 1) * MINUTE;
  const base = { id, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 1, mode: "send", textHash: "0".repeat(64), textLength: 5, acceptedAt, phase };
  return JSON.stringify(phase === "accepted" || phase === "submit-sent" ? base : { ...base, receipt: receiptOf(id, send) });
}

/** A fake `Files` over a map of paths, which records any write the module would attempt (it has none to call). */
function fakeFiles(entries: Record<string, string>): Pick<Files, "list" | "read"> {
  return {
    list: (path) => Object.keys(entries).filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1)),
    read: (path) => entries[path] ?? null,
  };
}

/** Sends written as files, ids in order, newest last unless `ago` says otherwise. */
function filesOf(sends: readonly Send[]): Record<string, string> {
  return Object.fromEntries(sends.map((send, n) => {
    const id = `req-${String(n).padStart(4, "0")}-abcdef`;
    return [join(SENDS, `${id}.json`), recordFile(id, send)];
  }));
}

function rows(entries: Record<string, string>): Map<string, SendsFinding> {
  return new Map(sendFindings({ ctx: { stateDir: STATE }, files: fakeFiles(entries), now: () => NOW }).map((f) => [f.harness, f]));
}

const times = (n: number, send: Send): Send[] => Array.from({ length: n }, () => send);

describe("sends rows (M71 spec 01)", () => {
  test("the issue 594 shape, 0 sent and 18 unknown with no_evidence, is an error", () => {
    const codex = rows(filesOf(times(18, { outcome: "unknown", reason: "no_evidence" }))).get("codex")!;
    expect(18).toBeGreaterThanOrEqual(SENDS_ERROR_MIN);
    expect(codex.check).toBe("sends-codex");
    expect(codex.status).toBe("error");
    expect(codex.detail).toBe("18 unknown (no_evidence 18) · last 7 days");
    expect(codex.remedy).toContain("Report a problem");
    expect(codex.remedy).toContain("collie doctor --json");
    expect(codex.counts).toEqual({ unknown: 18 });
    expect(codex.window).toEqual({ count: 18, days: 7 });
    expect(codex.scope).toBeUndefined();
  });

  test("3 received, all refused with probe_failed, warns by rule (a)", () => {
    expect(3).toBe(SENDS_NONE_WARN_MIN);
    const codex = rows(filesOf(times(3, { outcome: "refused", reason: "probe_failed" }))).get("codex")!;
    expect(codex.status).toBe("warn");
    expect(codex.detail).toBe("3 refused (probe_failed 3) · last 7 days");
    expect(codex.remedy).toStartWith("none of the last 3 sends to codex went through; ");
  });

  test("10 received, 7 sent and 3 unknown with crash, warns by rule (b); a reason troubleStep ignores does not", () => {
    expect(SENDS_LOST_WARN_MIN).toBe(5);
    expect(SENDS_LOST_WARN_RATE).toBe(0.3);
    const lost = rows(filesOf([...times(7, { outcome: "sent" }), ...times(3, { outcome: "unknown", reason: "crash" })])).get("codex")!;
    expect(lost.status).toBe("warn");
    expect(lost.detail).toBe("7 sent · 3 unknown (crash 3) · last 7 days");
    expect(lost.remedy).toStartWith("3 of the last 10 sends to codex ended unknown or typed but not submitted; ");
    expect(troubleStep({ outcome: "unknown", reason: "dialog_after_enter" })).toBe("ignore");
    const shown = rows(filesOf([...times(7, { outcome: "sent" }), ...times(3, { outcome: "unknown", reason: "dialog_after_enter" })])).get("codex")!;
    expect(shown.status).toBe("ok");
    expect(shown.remedy).toBeNull();
  });

  test("a lost send with no reason counts, as ADR 0123's table says", () => {
    const codex = rows(filesOf([...times(3, { outcome: "effective" }), ...times(2, { outcome: "typed_not_submitted" })])).get("codex")!;
    expect(codex.status).toBe("warn");
    expect(codex.detail).toBe("3 effective · 2 typed_not_submitted · last 7 days");
  });

  test("2 received with none succeeded is ok: below every minimum", () => {
    const codex = rows(filesOf(times(2, { outcome: "unknown", reason: "no_evidence" }))).get("codex")!;
    expect(codex.status).toBe("ok");
    expect(codex.detail).toBe("2 unknown (no_evidence 2) · last 7 days");
  });

  test("rule (c) comes before (a): 9 is a warning, 10 an error", () => {
    expect(rows(filesOf(times(9, { outcome: "refused", reason: "not_free" }))).get("codex")!.status).toBe("warn");
    expect(rows(filesOf(times(10, { outcome: "refused", reason: "not_free" }))).get("codex")!.status).toBe("error");
  });

  test("an open hold shows in the row and is not received; discarded and cancelled are not received either", () => {
    const sends = [...times(3, { outcome: "held" }), ...times(4, { outcome: "discarded" }), ...times(1, { outcome: "cancelled" }), ...times(2, { outcome: "refused", reason: "busy" })];
    const codex = rows(filesOf(sends)).get("codex")!;
    // Only the 2 refusals are received: below the rule (a) minimum.
    expect(codex.status).toBe("ok");
    expect(codex.detail).toBe("4 discarded · 3 held · 2 refused (busy 2) · 1 cancelled · last 7 days");
    expect(codex.counts).toEqual({ discarded: 4, held: 3, refused: 2, cancelled: 1 });
  });

  test("a request still in flight has no receipt and is left out of the counts", () => {
    const codex = rows(filesOf([{ outcome: "sent", phase: "submit-sent" }, { outcome: "sent", phase: "accepted" }, { outcome: "sent" }])).get("codex")!;
    expect(codex.detail).toBe("1 sent · last 7 days");
    expect(codex.window.count).toBe(1);
  });

  test("every harness with a profile gets a row, one with no receipts says no sends and is ok", () => {
    const all = sendFindings({ ctx: { stateDir: STATE }, files: fakeFiles(filesOf([{ outcome: "sent", harness: "zed" }, { outcome: "sent", harness: "" }])), now: () => NOW });
    expect(all.map((f) => f.harness)).toEqual([...loadProfiles().keys(), "-", "zed"]);
    const claude = all.find((f) => f.harness === "claude")!;
    expect(claude).toEqual({ check: "sends-claude", status: "ok", detail: "no sends in the last 7 days", remedy: null, harness: "claude", window: { count: 0, days: 7 }, counts: {} });
    expect(all.find((f) => f.harness === "-")!.check).toBe("sends--");
  });

  test("the window takes the newest 50 and drops a record older than 7 days", () => {
    expect(SENDS_WINDOW_COUNT).toBe(50);
    expect(SENDS_WINDOW_MS).toBe(7 * 24 * 60 * MINUTE);
    // The 10 oldest went through; the 50 newest did not. Only the newest 50 count.
    const capped = rows(filesOf([...times(10, { outcome: "sent", ago: 600 }), ...times(SENDS_WINDOW_COUNT, { outcome: "unknown", reason: "lost_lock", ago: 5 })])).get("codex")!;
    expect(capped.status).toBe("error");
    expect(capped.detail).toBe("50 unknown (lost_lock 50) · last 50");
    expect(capped.window).toEqual({ count: 50, days: 7 });
    const week = 7 * 24 * 60;
    const aged = rows(filesOf([...times(2, { outcome: "sent" }), { outcome: "unknown", reason: "crash", ago: week + 1 }])).get("codex")!;
    expect(aged.detail).toBe("2 sent · last 7 days");
    expect(aged.counts).toEqual({ sent: 2 });
  });

  test("ask files, temp files, the salt and a file that does not parse are skipped", () => {
    const entries = {
      ...filesOf(times(2, { outcome: "sent" })),
      [join(SENDS, "ask.ask-0123456789abcd.json")]: recordFile("req-9999-abcdef", { outcome: "unknown", reason: "crash" }),
      [join(SENDS, "req-8888-abcdef.json.tmp")]: recordFile("req-8888-abcdef", { outcome: "unknown", reason: "crash" }),
      [join(SENDS, ".salt")]: "abc\n",
      [join(SENDS, "req-7777-abcdef.json")]: "{ torn",
      [join(SENDS, "req-6666-abcdef.json")]: JSON.stringify({ id: "req-6666-abcdef" }),
      [join(SENDS, "not a request id.json")]: recordFile("req-5555-abcdef", { outcome: "unknown", reason: "crash" }),
    };
    expect(rows(entries).get("codex")!.detail).toBe("2 sent · last 7 days");
  });
});

describe("sends rows on disk", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("a missing sends folder writes nothing and gives only no-sends rows", () => {
    dir = mkdtempSync(join(tmpdir(), "collie-send-findings-"));
    const all = sendFindings({ ctx: { stateDir: dir }, files: realFiles, now: () => NOW });
    expect(all.map((f) => f.detail)).toEqual([...loadProfiles().keys()].map(() => "no sends in the last 7 days"));
    expect(all.every((f) => f.status === "ok")).toBe(true);
    expect(existsSync(join(dir, "sends"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reads the files the bridge's own store writes, and leaves the folder as it was", () => {
    dir = mkdtempSync(join(tmpdir(), "collie-send-findings-"));
    const store = new RequestStore(join(dir, "sends"), () => NOW - MINUTE);
    for (let n = 0; n < 3; n++) {
      const id = `req-000${String(n)}-abcdef`;
      store.accept({ id, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 1, mode: "send", text: `hello ${String(n)}` });
      store.settle(id, receiptOf(id, { outcome: "refused", reason: "probe_failed" }));
    }
    const before = readdirSync(join(dir, "sends")).toSorted();
    const codex = sendFindings({ ctx: { stateDir: dir }, files: realFiles, now: () => NOW }).find((f) => f.harness === "codex")!;
    expect(codex.status).toBe("warn");
    expect(codex.detail).toBe("3 refused (probe_failed 3) · last 7 days");
    expect(readdirSync(join(dir, "sends")).toSorted()).toEqual(before);
  });
});
