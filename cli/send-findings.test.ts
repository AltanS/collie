import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLD_COMMAND_MS, HOLD_MS, HoldStore, parseHeldEntry, type HeldEntry } from "../bridge/surface/holds.ts";
import { RequestStore, type RequestPhase } from "../bridge/surface/requests.ts";
import { troubleStep } from "../web/src/lib/report/trouble.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { HELD_CAUSES, STALE_SCREEN, type HeldCause, type HeldState, type SendMode, type SendOutcome, type SendReason, type SendReceipt } from "../web/src/lib/surface/send.ts";
import {
  HELD_CAUSE_WORDS,
  HOLD_WARN_MS,
  holdFindings,
  PROBE_RUN_WARN,
  screenFindings,
  sendFindings,
  sendsSection,
  SENDS_ERROR_MIN,
  SENDS_LOST_WARN_MIN,
  SENDS_LOST_WARN_RATE,
  SENDS_NONE_WARN_MIN,
  SENDS_WINDOW_COUNT,
  SENDS_WINDOW_MS,
  type SendsFinding,
} from "./send-findings.ts";
import { posixKey } from "./fakes.ts";
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
  /** The receipt's detail line. */
  readonly detail?: string;
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
  const withReason = send.reason === undefined ? receipt : { ...receipt, reason: send.reason };
  return send.detail === undefined ? withReason : { ...withReason, detail: send.detail };
}

/** One request file as the store writes it, settled unless the send says otherwise. */
function recordFile(id: string, send: Send): string {
  const phase = send.phase ?? (send.outcome === "held" ? "held" : "settled");
  const acceptedAt = NOW - (send.ago ?? 1) * MINUTE;
  const base = { id, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 1, mode: "send", textHash: "0".repeat(64), textLength: 5, acceptedAt, phase };
  return JSON.stringify(phase === "accepted" || phase === "submit-sent" ? base : { ...base, receipt: receiptOf(id, send) });
}

/**
 * A fake `Files` over a map of paths, which records any write the module would attempt (it has none to call).
 * The module joins with the machine's separator, so both sides fold to the POSIX spelling like `fakes.ts` does.
 */
function fakeFiles(entries: Record<string, string>): Pick<Files, "list" | "read"> {
  const folded = new Map(Object.entries(entries).map(([p, text]) => [posixKey(p), text]));
  return {
    list: (path) => {
      const dir = posixKey(path);
      return [...folded.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
    },
    read: (path) => folded.get(posixKey(path)) ?? null,
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

  test("the no-harness group is informational: 12 unknown receipts are ok, and the same with claude are an error", () => {
    const shell = rows(filesOf(times(12, { outcome: "unknown", reason: "no_evidence", harness: "" }))).get("-")!;
    expect(shell.check).toBe("sends--");
    expect(shell.status).toBe("ok");
    expect(shell.remedy).toBeNull();
    expect(shell.counts).toEqual({ unknown: 12 });
    expect(shell.detail).toBe("12 unknown (no_evidence 12) · last 7 days");
    const claude = rows(filesOf(times(12, { outcome: "unknown", reason: "no_evidence", harness: "claude" }))).get("claude")!;
    expect(claude.status).toBe("error");
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

const SECRET_TEXT = "the-held-text-fixture-xyzzy";

interface Hold {
  readonly cause?: HeldCause;
  readonly versionUnread?: true;
  readonly state?: HeldState;
  readonly mode?: SendMode;
  readonly harness?: string;
  /** Minutes before NOW. */
  readonly ago?: number;
}

/** One held file as `HoldStore` writes it, carrying the person's text in plain form. */
function heldFile(id: string, hold: Hold): string {
  const heldAt = NOW - (hold.ago ?? 1) * MINUTE;
  const entry: HeldEntry = {
    id, session: "main", paneId: "%1", harness: hold.harness ?? "codex", mode: hold.mode ?? "send", text: SECRET_TEXT, revision: 1,
    heldAt, expiresAt: heldAt + HOLD_MS, seq: 1, state: hold.state ?? "held", tries: 0,
  };
  let full = entry;
  if (hold.cause !== undefined) full = { ...full, cause: hold.cause };
  if (hold.versionUnread === true) full = { ...full, versionUnread: true };
  return JSON.stringify(full);
}

const HELD = join(STATE, "held");
const heldId = (n: number): string => `req-h${String(n).padStart(3, "0")}-abcdef`;

function heldFiles(holds: readonly Hold[]): Record<string, string> {
  return Object.fromEntries(holds.map((hold, n) => [join(HELD, `${heldId(n)}.json`), heldFile(heldId(n), hold)]));
}

const holdRows = (entries: Record<string, string>) => holdFindings({ ctx: { stateDir: STATE }, files: fakeFiles(entries), now: () => NOW });
const screenRows = (entries: Record<string, string>) => new Map(screenFindings({ ctx: { stateDir: STATE }, files: fakeFiles(entries), now: () => NOW }).map((f) => [f.harness, f]));

describe("holds rows (M71 spec 02)", () => {
  test("the cause words are the phone's, for all five causes and for none", () => {
    expect(Object.keys(HELD_CAUSE_WORDS)).toEqual([...HELD_CAUSES]);
    const causes: (HeldCause | undefined)[] = [...HELD_CAUSES, undefined];
    const [row] = holdRows(heldFiles(causes.map((cause, n): Hold => (cause === undefined ? { ago: 6 - n } : { cause, ago: 6 - n }))));
    expect(row!.detail).toBe(
      [
        "held 6 min for a running turn (req-h000-abcdef)",
        "held 5 min for something open at the box (req-h001-abcdef)",
        "held 4 min for something open at the box (req-h002-abcdef)",
        "held 3 min for a draft in the box (req-h003-abcdef)",
        "held 2 min for something open at the box (req-h004-abcdef)",
        "held 1 min for a running turn (req-h005-abcdef)",
      ].join(" · "),
    );
    expect(row!.holds.map((hold) => hold.cause)).toEqual([...HELD_CAUSES, null]);
  });

  test("a hold with no harness is listed but never warns, however old", () => {
    const [row] = holdRows(heldFiles([{ harness: "", ago: 60, cause: "not_free" }]));
    expect(row!.check).toBe("holds--");
    expect(row!.status).toBe("ok");
    expect(row!.remedy).toBeNull();
    expect(row!.holds).toHaveLength(1);
  });

  test("a version that could not be read, and a command, say so; oldest first", () => {
    const [row] = holdRows(heldFiles([{ ago: 2, mode: "command", cause: "draft_present" }, { ago: 9, versionUnread: true }]));
    expect(row!.check).toBe("holds-codex");
    expect(row!.harness).toBe("codex");
    expect(row!.status).toBe("ok");
    expect(row!.detail).toBe("held 9 min for a running turn, version unread (req-h001-abcdef) · held 2 min for a draft in the box, command (req-h000-abcdef)");
    expect(row!.holds).toEqual([
      { requestId: "req-h001-abcdef", cause: null, ageMs: 9 * MINUTE, state: "held" },
      { requestId: "req-h000-abcdef", cause: "draft_present", ageMs: 2 * MINUTE, state: "held" },
    ]);
  });

  test("an open hold warns past 10 minutes, not at 10, and the box cause names Report a problem", () => {
    expect(HOLD_WARN_MS).toBe(10 * MINUTE);
    expect(HOLD_WARN_MS).toBe(HOLD_COMMAND_MS);
    expect(holdRows(heldFiles([{ ago: 10, cause: "not_free" }]))[0]!.status).toBe("ok");
    const turn = holdRows(heldFiles([{ ago: 11 }]))[0]!;
    expect(turn.status).toBe("warn");
    expect(turn.remedy).toBe("open the pane on the phone, read the held row, and send or cancel it");
    const box = holdRows(heldFiles([{ ago: 11, cause: "bound" }, { ago: 1 }]))[0]!;
    expect(box.status).toBe("warn");
    expect(box.remedy).toStartWith("open the pane on the phone, read the held row, and send or cancel it; ");
    expect(box.remedy).toContain("Report a problem");
    const draft = holdRows(heldFiles([{ ago: 30, cause: "draft_present" }]))[0]!;
    expect(draft.remedy).not.toContain("Report a problem");
  });

  test("ended entries are left out; running ones are listed", () => {
    const open = holdRows(heldFiles([{ state: "ended" }, { state: "running", ago: 3 }]));
    expect(open).toHaveLength(1);
    expect(open[0]!.holds).toEqual([{ requestId: "req-h001-abcdef", cause: null, ageMs: 3 * MINUTE, state: "running" }]);
    const none = holdRows(heldFiles([{ state: "ended" }]));
    expect(none).toEqual([{ check: "holds", status: "ok", detail: "no held sends open", remedy: null, holds: [] }]);
    expect(holdRows({})).toEqual(none);
  });

  test("the held text never reaches a detail, a remedy or the json", () => {
    const all = holdRows({ ...heldFiles([{ ago: 20, cause: "not_free" }, { ago: 3, mode: "command" }, { ago: 5, harness: "claude", versionUnread: true }]) });
    expect(all.map((f) => f.check)).toEqual(["holds-claude", "holds-codex"]);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain(SECRET_TEXT);
    expect(dump).not.toContain("xyzzy");
    expect(dump).not.toContain(String(SECRET_TEXT.length));
    expect(dump).not.toContain("textLength");
  });

  test(".tmp leftovers, files that do not parse and a name that is not the id are skipped", () => {
    const entries = {
      ...heldFiles([{ ago: 2 }]),
      [join(HELD, `${heldId(5)}.json.tmp`)]: heldFile(heldId(5), {}),
      [join(HELD, `${heldId(6)}.json`)]: "{ torn",
      [join(HELD, `${heldId(7)}.json`)]: JSON.stringify({ id: heldId(7) }),
      [join(HELD, `${heldId(8)}.json`)]: heldFile(heldId(9), {}),
      [join(HELD, "notes.txt")]: "x",
    };
    expect(holdRows(entries)[0]!.holds.map((hold) => hold.requestId)).toEqual([heldId(0)]);
  });

  test("the pure parser reads what the store writes", () => {
    expect(parseHeldEntry(JSON.parse(heldFile(heldId(0), { cause: "bound" })))?.cause).toBe("bound");
    expect(parseHeldEntry(undefined)).toBeNull();
  });

  test("reads a real HoldStore folder and leaves it as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-holds-findings-"));
    try {
      const store = new HoldStore(join(dir, "held"), () => NOW - 12 * MINUTE);
      store.add({ id: heldId(0), session: "main", paneId: "%1", harness: "codex", mode: "send", text: SECRET_TEXT, revision: 1, command: false, cause: "turn_running" });
      const before = readdirSync(join(dir, "held")).toSorted();
      const found = holdFindings({ ctx: { stateDir: dir }, files: realFiles, now: () => NOW });
      expect(found[0]!.status).toBe("warn");
      expect(found[0]!.detail).toBe(`held 12 min for a running turn (${heldId(0)})`);
      expect(JSON.stringify(found)).not.toContain(SECRET_TEXT);
      expect(readdirSync(join(dir, "held")).toSorted()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing held folder is no holds and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-holds-findings-"));
    try {
      expect(holdFindings({ ctx: { stateDir: dir }, files: realFiles, now: () => NOW }).map((f) => f.detail)).toEqual(["no held sends open"]);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("screen rows (M71 spec 02)", () => {
  const stale: Send = { outcome: "refused", reason: "probe_failed", detail: `${STALE_SCREEN} A probe character may remain.` };
  const plain: Send = { outcome: "refused", reason: "probe_failed", detail: "The pane may still be starting." };

  test("a stale screen is told apart from a plain probe_failed, and counts come out in the detail", () => {
    const codex = screenRows(filesOf([stale, plain, { outcome: "sent" }, stale, { outcome: "sent" }])).get("codex")!;
    expect(codex.check).toBe("screen-codex");
    expect(codex.status).toBe("ok");
    expect(codex.detail).toBe("stale screen 2 · probe failed 1 · longest run 2");
    expect(codex.remedy).toBeNull();
  });

  test("a refusal with another reason that starts alike, or no detail, is not a stale screen", () => {
    const codex = screenRows(filesOf([{ outcome: "refused", reason: "not_free", detail: STALE_SCREEN }, { outcome: "refused", reason: "probe_failed" }, { outcome: "sent" }])).get("codex")!;
    expect(codex.detail).toBe("stale screen 0 · probe failed 1 · longest run 1");
  });

  test("none of either says so; a harness with no receipts has no screen row", () => {
    const all = screenRows(filesOf([{ outcome: "sent" }, { outcome: "sent", harness: "claude" }]));
    expect([...all.keys()]).toEqual(["claude", "codex"]);
    expect(all.get("codex")!.detail).toBe("no stale screen, no probe failure");
    expect(all.get("codex")!.status).toBe("ok");
    expect(screenRows({}).size).toBe(0);
  });

  test("a run of 3 in a row, newest or not, warns and names the longest run", () => {
    expect(PROBE_RUN_WARN).toBe(3);
    // Oldest first by `ago`: sent, three stale, sent.
    const sends: Send[] = [{ outcome: "sent", ago: 50 }, { ...stale, ago: 40 }, { ...plain, ago: 30 }, { ...stale, ago: 20 }, { outcome: "sent", ago: 10 }];
    const codex = screenRows(filesOf(sends)).get("codex")!;
    expect(codex.status).toBe("warn");
    expect(codex.detail).toBe("stale screen 2 · probe failed 1 · longest run 3");
    expect(codex.remedy).toContain("focus the pane on the desktop or resize it");
    expect(codex.remedy).toContain("Report a problem");
    expect(codex.remedy).toStartWith("3 sends to codex in a row ");
  });

  test("a run broken by a sent does not warn, and the order is by acceptedAt, not by file", () => {
    const broken: Send[] = [{ ...stale, ago: 50 }, { ...stale, ago: 40 }, { outcome: "sent", ago: 30 }, { ...stale, ago: 20 }, { ...stale, ago: 10 }];
    const codex = screenRows(filesOf(broken)).get("codex")!;
    expect(codex.status).toBe("ok");
    expect(codex.detail).toBe("stale screen 4 · probe failed 0 · longest run 2");
    // The same sends, listed in reverse file order, give the same answer.
    expect(screenRows(filesOf(broken.toReversed())).get("codex")!.detail).toBe(codex.detail);
    // A held receipt between them breaks a run too; another harness's receipt does not.
    const held = screenRows(filesOf([{ ...stale, ago: 50 }, { outcome: "held", ago: 40 }, { ...stale, ago: 30 }, { ...stale, ago: 20 }])).get("codex")!;
    expect(held.status).toBe("ok");
    const other = screenRows(filesOf([{ ...stale, ago: 50 }, { outcome: "sent", harness: "claude", ago: 40 }, { ...stale, ago: 30 }, { ...stale, ago: 20 }])).get("codex")!;
    expect(other.status).toBe("warn");
  });

  test("the no-harness group never warns, even with a run of probe failures", () => {
    const shell = screenRows(filesOf(times(5, { ...stale, harness: "" }))).get("-")!;
    expect(shell.check).toBe("screen--");
    expect(shell.status).toBe("ok");
    expect(shell.detail).toBe("stale screen 5 · probe failed 0 · longest run 5");
    expect(shell.remedy).toBeNull();
  });

  test("the window is spec 01's: a stale refusal older than 7 days is not counted", () => {
    const codex = screenRows(filesOf([{ ...stale, ago: 7 * 24 * 60 + 1 }, { outcome: "sent" }])).get("codex")!;
    expect(codex.detail).toBe("no stale screen, no probe failure");
  });
});

describe("the sends section (M71 spec 02)", () => {
  test("prints sends rows, then holds rows, then screen rows", () => {
    const entries = { ...filesOf([{ outcome: "sent" }]), ...heldFiles([{}]) };
    const checks = sendsSection({ ctx: { stateDir: STATE }, files: fakeFiles(entries), now: () => NOW }).map((f) => f.check);
    const sends = [...loadProfiles().keys()].map((id) => `sends-${id}`);
    expect(checks).toEqual([...sends, "holds-codex", "screen-codex"]);
  });
});
