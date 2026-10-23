// The structured driver (M56 spec 14): a program session answers the same three contracts as a screen
// pane. Surface from the structured state, Send through accept, persist, lock and receipt with one
// structured write, Ask with `channel: "program"`, the hash compare and the program's own channel.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import { muxOk, muxRefused, type MuxAnswerResult, type MuxControlOutcome, type MuxOutcome } from "../mux/types.ts";
import { askRoute, sendReceiptsRoute, sendRoute, type AskRouteRuntime } from "../server.ts";
import type { AgentStatus, AnswerRequest, Ask as ProgramAsk, ControlRequest } from "../types.ts";
import type { AskOutcome, AskReason } from "../../web/src/lib/surface/ask.ts";
import type { SendOutcome, SendReason } from "../../web/src/lib/surface/send.ts";
import { askOf, isFree, type Ask } from "../../web/src/lib/surface/surface.ts";
import type { CounterKey } from "./counters.ts";
import { contractAsk, PROGRAM_COUNTER_KEY, PROGRAM_LOCK_MS, programRevision, ProgramDriver, type ProgramPort } from "./durable-driver.ts";
import { SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANE = "conv-1";
const TARGET = { session: "desk", paneId: PANE, harness: "durable" } as const;

function permission(revision = 1, extra: Partial<ProgramAsk> = {}): ProgramAsk {
  return {
    id: "pa-1",
    kind: "permission",
    toolCallId: "tc-1",
    revision,
    title: "Run a shell command",
    itemId: "item-1",
    options: [
      { id: "allow", label: "Allow", effect: "allow" },
      { id: "always", label: "Always allow", effect: "allow-always" },
      { id: "deny", label: "Deny", effect: "deny" },
    ],
    tool: { name: "bash", summary: "ls -la" },
    ...extra,
  };
}

/** What a test sets on the fake program. */
interface ProgramState {
  phase: "starting" | "ready" | "unreachable";
  status: AgentStatus | undefined;
  turnId: string | undefined;
  asks: ProgramAsk[];
  control: () => Promise<MuxControlOutcome>;
  answer: () => Promise<MuxOutcome<MuxAnswerResult>>;
}

/** A program pane whose state a test sets, and that records every write. */
function fakeProgram() {
  const state: ProgramState = {
    phase: "ready",
    status: "idle",
    turnId: "turn-1",
    asks: [],
    control: () => Promise.resolve({ kind: "ok", replayed: false }),
    answer: () => Promise.resolve(muxOk({ kind: "taken", replayed: false })),
  };
  const controls: ControlRequest[] = [];
  const answers: AnswerRequest[] = [];
  const listeners = new Set<(paneId: string, requestId: string) => void>();
  /** The program writes a `user` item that names a request id, as the pane log hands it on. */
  const item = (requestId: string, paneId: string = PANE): void => {
    for (const listener of listeners) listener(paneId, requestId);
  };
  const port: ProgramPort = {
    phase: () => state.phase,
    paneStatus: (paneId) => (paneId === PANE ? state.status : undefined),
    paneTurn: (paneId) => (paneId === PANE ? state.turnId : undefined),
    openAsks: (paneId) => (paneId === PANE ? state.asks : undefined),
    controlTurn: (_paneId, request) => {
      controls.push(request);
      return state.control();
    },
    answerAsk: (_paneId, answer) => {
      answers.push(answer);
      return state.answer();
    },
    onUserItem: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { state, port, controls, answers, item };
}

function fakeLedger() {
  const reads: { key: CounterKey; free: boolean }[] = [];
  const sends: { key: CounterKey; outcome: string; reason?: string | undefined }[] = [];
  const confirmed: { key: CounterKey; from: "sent" | "unknown" }[] = [];
  return {
    reads,
    sends,
    confirmed,
    ledger: {
      confirmEffective: (key: CounterKey, from: "sent" | "unknown") => void confirmed.push({ key, from }),
      read: (key: CounterKey, surface: Parameters<typeof isFree>[0]) => void reads.push({ key, free: isFree(surface) }),
      send: (key: CounterKey, end: { outcome: string; reason?: string | undefined }) => void sends.push({ key, outcome: end.outcome, reason: end.reason }),
    },
  };
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-driver-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function driverOf(port: ProgramPort, extra: { ledger?: ReturnType<typeof fakeLedger>["ledger"]; locks?: SessionLocks; store?: RequestStore; now?: () => number } = {}) {
  const store = extra.store ?? new RequestStore(join(dir, "sends"));
  return { store, driver: new ProgramDriver({ session: TARGET.session, port, store, locks: extra.locks ?? new SessionLocks(), ledger: extra.ledger, now: extra.now, salt: "test-salt" }) };
}

describe("Surface from structured state", () => {
  test("an idle pane with no ask is free, with the revision of its turn and an empty composer", () => {
    const { port } = fakeProgram();
    const { driver } = driverOf(port);
    const surface = driver.surfaceOf(PANE)!;
    expect(surface).toEqual({ revision: programRevision("turn-1"), turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(surface)).toBe(true);
    expect(programRevision("turn-1")).toBeGreaterThan(0);
    expect(Number.isSafeInteger(programRevision("turn-1"))).toBe(true);
    expect(programRevision(undefined)).toBe(0);
  });

  test("a working pane runs; the composer stays empty, because there is no box", () => {
    const { state, port } = fakeProgram();
    state.status = "working";
    const { driver } = driverOf(port);
    expect(driver.surfaceOf(PANE)).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });

  test("an open permission is a modal ask on the program channel, with no allow-always option", () => {
    const { state, port } = fakeProgram();
    state.status = "blocked";
    state.asks = [permission()];
    const { driver } = driverOf(port);
    const surface = driver.surfaceOf(PANE)!;
    expect(surface.turn).toBe("running");
    const ask = askOf(surface.modal)!;
    expect(ask.channel).toBe("program");
    expect(ask.kind).toBe("permission");
    expect(ask.id).toMatch(/^ask-[0-9a-f]{14}$/);
    expect(ask.options).toEqual([
      { id: "1", label: "Allow" },
      { id: "2", label: "Deny" },
    ]);
    expect(ask.hash).toBe(contractAsk(permission())!.hash);
  });

  test("a one-pick choice is a question; a text, a form and a several-pick choice are unreadable", () => {
    const { state, port } = fakeProgram();
    state.status = "blocked";
    const { driver } = driverOf(port);
    state.asks = [permission(1, { kind: "choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })];
    expect(askOf(driver.surfaceOf(PANE)!.modal)?.kind).toBe("question");
    for (const odd of [
      permission(1, { kind: "text", options: [] }),
      permission(1, { kind: "form", options: [] }),
      permission(1, { kind: "choice", multiple: true, options: [{ id: "a", label: "A" }] }),
      permission(1, { kind: "future-kind" }),
      permission(1, { options: [{ id: "always", label: "Always", effect: "allow-always" }] }),
    ]) {
      state.asks = [odd];
      expect(driver.surfaceOf(PANE)!.modal).toBe("unreadable");
    }
  });

  test("the ask id stays while the ask stays, and a new revision or new words mint a new id", () => {
    const { state, port } = fakeProgram();
    state.status = "blocked";
    state.asks = [permission(1)];
    const { driver } = driverOf(port);
    const first = askOf(driver.surfaceOf(PANE)!.modal)!.id;
    expect(askOf(driver.surfaceOf(PANE)!.modal)!.id).toBe(first);
    state.asks = [permission(2)];
    const second = askOf(driver.surfaceOf(PANE)!.modal)!;
    expect(second.id).not.toBe(first);
    expect(second.hash).toBe(contractAsk(permission(1))!.hash);
    state.asks = [permission(2, { title: "Delete a file" })];
    const third = askOf(driver.surfaceOf(PANE)!.modal)!;
    expect(third.id).not.toBe(second.id);
    expect(third.hash).not.toBe(second.hash);
  });

  test("a program that does not answer gives a Surface nobody can send on; a pane not listed has none", () => {
    const { state, port } = fakeProgram();
    const { driver } = driverOf(port);
    state.phase = "unreachable";
    expect(driver.surfaceOf(PANE)).toMatchObject({ turn: "unknown", modal: "unknown", composer: "unreachable", reason: "stale" });
    state.phase = "ready";
    expect(driver.surfaceOf("other")).toBeUndefined();
  });

  test("each poll counts every pane's read under the source program", () => {
    const { port } = fakeProgram();
    const { reads, ledger } = fakeLedger();
    const { driver } = driverOf(port, { ledger });
    driver.observe([PANE, "gone"]);
    expect(reads).toEqual([{ key: PROGRAM_COUNTER_KEY, free: true }]);
    expect(PROGRAM_COUNTER_KEY.harness).toBe("program");
  });
});

describe("Send through accept, persist, lock and receipt", () => {
  test("an idle pane: one structured write for its turn, sent, the request id acknowledged, no key", async () => {
    const { port, controls } = fakeProgram();
    const { sends, ledger } = fakeLedger();
    const { driver, store } = driverOf(port, { ledger });
    const answer = await driver.handle({ id: "drv-send-0001", text: "hello there", mode: "send", revision: programRevision("turn-1") }, TARGET);
    expect(controls).toEqual([{ act: "send", requestId: "drv-send-0001", target: { kind: "turn", id: "turn-1" }, text: "hello there", steer: false }]);
    const receipt = answer.receipt!;
    expect(receipt.outcome).toBe("sent");
    expect(receipt.acknowledged).toBe("drv-send-0001");
    expect(receipt.keys).toEqual([]);
    expect(receipt.queued).toBeUndefined();
    expect(receipt.s0?.revision).toBe(programRevision("turn-1"));
    expect(receipt.s1).toBeNull();
    expect(answer.offers).toEqual([]);
    // Persisted with the receipt, read back from disk, and counted under the program row.
    expect(store.get("drv-send-0001")?.receipt).toEqual(receipt);
    expect(store.get("drv-send-0001")?.receipt?.acknowledged).toBe("drv-send-0001");
    expect(sends).toEqual([{ key: PROGRAM_COUNTER_KEY, outcome: "sent", reason: undefined }]);
  });

  test("during a turn the program takes the text for after it: sent, queued, and says so", async () => {
    const { state, port, controls } = fakeProgram();
    state.status = "working";
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-send-0002", text: "and then this", mode: "send" }, TARGET);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ steer: false, target: { kind: "turn", id: "turn-1" } });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, acknowledged: "drv-send-0002" });
    expect(answer.detail).toContain("when that turn ends");
  });

  test("an open ask refuses the send not_free, and nothing reaches the program", async () => {
    const { state, port, controls } = fakeProgram();
    state.status = "blocked";
    state.asks = [permission()];
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-send-0003", text: "hi", mode: "send" }, TARGET);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(askOf(answer.surface!.modal)?.channel).toBe("program");
    expect(controls).toEqual([]);
  });

  test("a turn that moved since the phone looked refuses stale_surface before the program is asked", async () => {
    const { port, controls } = fakeProgram();
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-send-0004", text: "hi", mode: "send", revision: programRevision("turn-0") }, TARGET);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "stale_surface" });
    expect(controls).toEqual([]);
  });

  test("the program's own answers map onto the same outcome list", async () => {
    const cases: [MuxControlOutcome, SendOutcome, SendReason | undefined][] = [
      [{ kind: "stale", turnId: "turn-2", askIds: [] }, "refused", "stale_surface"],
      [{ kind: "unknown", detail: "timed out" }, "unknown", "no_evidence"],
      [{ kind: "refused", detail: "bad body" }, "refused", "write_failed"],
      [{ kind: "unsupported", detail: "This durable agent takes no text from here." }, "refused", "write_failed"],
      [{ kind: "unreachable", detail: "connect refused" }, "refused", "write_failed"],
      [{ kind: "gone", detail: "The conversation is not in the durable agent's layout." }, "refused", "pane_gone"],
    ];
    let n = 10;
    for (const [said, outcome, reason] of cases) {
      const { state, port } = fakeProgram();
      state.control = () => Promise.resolve(said);
      const { driver } = driverOf(port);
      const answer = await driver.handle({ id: `drv-send-00${String(n++)}`, text: "hi", mode: "send" }, TARGET);
      expect(answer.receipt?.outcome).toBe(outcome);
      expect(answer.receipt?.reason).toBe(reason);
      expect(answer.receipt?.acknowledged).toBeUndefined();
    }
  });

  test("a write that throws ends unknown, never as sent", async () => {
    const { state, port } = fakeProgram();
    state.control = () => Promise.reject(new Error("socket closed"));
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-send-0020", text: "hi", mode: "send" }, TARGET);
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
  });

  test("the same id returns the same receipt and writes once; another text under it is id_reused", async () => {
    const { port, controls } = fakeProgram();
    const { driver } = driverOf(port);
    const first = await driver.handle({ id: "drv-send-0021", text: "once", mode: "send" }, TARGET);
    const again = await driver.handle({ id: "drv-send-0021", text: "once", mode: "send" }, TARGET);
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt!);
    const other = await driver.handle({ id: "drv-send-0021", text: "twice", mode: "send" }, TARGET);
    expect(other.receipt).toMatchObject({ outcome: "refused", reason: "id_reused" });
    expect(controls).toHaveLength(1);
  });

  test("two taps at once with one id write once", async () => {
    const { state, port, controls } = fakeProgram();
    let release = (): void => undefined;
    state.control = () => new Promise((resolve) => (release = () => resolve({ kind: "ok", replayed: false })));
    const { driver } = driverOf(port);
    const one = driver.handle({ id: "drv-send-0022", text: "x1", mode: "send" }, TARGET);
    const two = driver.handle({ id: "drv-send-0022", text: "x1", mode: "send" }, TARGET);
    await Bun.sleep(5);
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(controls).toHaveLength(1);
    expect(b.receipt).toEqual(a.receipt!);
  });

  test("one lock per pane: a second send while one runs is refused busy, and shares the lock with answers", async () => {
    const { state, port, controls } = fakeProgram();
    let release = (): void => undefined;
    state.control = () => new Promise((resolve) => (release = () => resolve({ kind: "ok", replayed: false })));
    const { driver } = driverOf(port);
    const one = driver.handle({ id: "drv-send-0023", text: "first", mode: "send" }, TARGET);
    await Bun.sleep(5);
    const two = await driver.handle({ id: "drv-send-0024", text: "second", mode: "send" }, TARGET);
    expect(two.receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    release();
    expect((await one).receipt?.outcome).toBe("sent");
    expect(controls).toHaveLength(1);
  });

  test("a steer is refused steer_unsupported, even from the phone, and nothing is written (M69)", async () => {
    const { port, controls } = fakeProgram();
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-steer-0001", text: "also say hello", mode: "send", when: "steer", fromPhone: true }, TARGET);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "steer_unsupported" });
    expect(controls).toEqual([]);
  });

  test("a box mode is refused not_free and prepare only reads", async () => {
    const { port, controls } = fakeProgram();
    const { driver } = driverOf(port);
    for (const mode of ["append", "replace", "submit", "discard"] as const) {
      const answer = await driver.handle({ id: `drv-mode-${mode}`, text: "x", mode }, TARGET);
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    }
    const prepared = await driver.handle({ id: "prepare", text: "", mode: "prepare" }, TARGET);
    expect(prepared.receipt).toBeUndefined();
    expect(prepared.surface?.composer).toBe("empty");
    expect(controls).toEqual([]);
  });

  test("a command is text to a program: it goes in as a send", async () => {
    const { port, controls } = fakeProgram();
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-send-0030", text: "/help", mode: "command" }, TARGET);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(controls[0]).toMatchObject({ text: "/help" });
  });

  test("a program that does not answer, or a pane it does not list, refuses with nothing written", async () => {
    const { state, port, controls } = fakeProgram();
    const { driver } = driverOf(port);
    state.phase = "starting";
    expect((await driver.handle({ id: "drv-send-0031", text: "hi", mode: "send" }, TARGET)).receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    state.phase = "ready";
    state.status = undefined;
    expect((await driver.handle({ id: "drv-send-0032", text: "hi", mode: "send" }, TARGET)).receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(controls).toEqual([]);
  });

  test("after a crash with the write on its way, the same id ends unknown(crash) and nothing is written again", async () => {
    const { port, controls } = fakeProgram();
    const store = new RequestStore(join(dir, "sends"));
    store.accept({ id: "drv-send-0040", session: "desk", paneId: PANE, paneGeneration: "program", surfaceRevision: 0, mode: "send", text: "lost" });
    store.markSubmitSent("drv-send-0040");
    const { driver } = driverOf(port, { store });
    const answer = await driver.handle({ id: "drv-send-0040", text: "lost", mode: "send" }, TARGET);
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
    expect(answer.replayed).toBe(true);
    expect(controls).toEqual([]);
  });
});

describe("Effective from the program's own item", () => {
  test("the user item that names the request id closes a sent receipt as effective, counted once", async () => {
    const { port, item } = fakeProgram();
    const { confirmed, ledger } = fakeLedger();
    const { driver, store } = driverOf(port, { ledger });
    const answer = await driver.handle({ id: "drv-eff-0001", text: "hello", mode: "send" }, TARGET);
    expect(answer.receipt?.outcome).toBe("sent");
    item("drv-eff-0001");
    const receipt = store.get("drv-eff-0001")?.receipt;
    expect(receipt?.outcome).toBe("effective");
    expect(receipt?.reason).toBeUndefined();
    expect(receipt?.acknowledged).toBe("drv-eff-0001");
    expect(confirmed).toEqual([{ key: PROGRAM_COUNTER_KEY, from: "sent" }]);
    // The same item again (a replay of the log) changes nothing and counts nothing.
    item("drv-eff-0001");
    expect(driver.itemTook(PANE, "drv-eff-0001")).toBe(false);
    expect(confirmed).toHaveLength(1);
    // The session page lists it as effective.
    expect(driver.recent(PANE)[0]).toMatchObject({ requestId: "drv-eff-0001", outcome: "effective" });
  });

  test("a queued send closes when the item comes after the turn, and keeps its queued mark", async () => {
    const { state, port, item } = fakeProgram();
    state.status = "working";
    const { driver, store } = driverOf(port);
    await driver.handle({ id: "drv-eff-0002", text: "after this turn", mode: "send" }, TARGET);
    expect(store.get("drv-eff-0002")?.receipt).toMatchObject({ outcome: "sent", queued: true });
    state.status = "idle";
    item("drv-eff-0002");
    expect(store.get("drv-eff-0002")?.receipt).toMatchObject({ outcome: "effective", queued: true });
    expect(driver.recent(PANE)[0]).toMatchObject({ outcome: "effective", queued: true });
  });

  test("an item that comes while the write runs closes the receipt at its settle", async () => {
    const { state, port, item } = fakeProgram();
    state.control = () => {
      item("drv-eff-0003");
      return Promise.resolve({ kind: "ok", replayed: false });
    };
    const { sends, ledger } = fakeLedger();
    const { driver, store } = driverOf(port, { ledger });
    const answer = await driver.handle({ id: "drv-eff-0003", text: "fast program", mode: "send" }, TARGET);
    expect(answer.receipt?.outcome).toBe("effective");
    expect(store.get("drv-eff-0003")?.receipt?.outcome).toBe("effective");
    expect(sends).toEqual([{ key: PROGRAM_COUNTER_KEY, outcome: "effective", reason: undefined }]);
  });

  test("an unknown end the item confirms is effective, and its doubting sentence goes", async () => {
    const { state, port, item } = fakeProgram();
    state.control = () => {
      item("drv-eff-0004");
      return Promise.resolve({ kind: "unknown", detail: "no answer within 3000ms" });
    };
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-eff-0004", text: "slow answer", mode: "send" }, TARGET);
    expect(answer.receipt?.outcome).toBe("effective");
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.detail).toBeUndefined();

    state.control = () => Promise.resolve({ kind: "unknown", detail: "no answer within 3000ms" });
    const { confirmed, ledger } = fakeLedger();
    const later = driverOf(port, { ledger, store: new RequestStore(join(dir, "later")) });
    const late = await later.driver.handle({ id: "drv-eff-0005", text: "slow answer", mode: "send" }, TARGET);
    expect(late.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(later.driver.itemTook(PANE, "drv-eff-0005")).toBe(true);
    expect(later.store.get("drv-eff-0005")?.receipt?.outcome).toBe("effective");
    expect(confirmed).toEqual([{ key: PROGRAM_COUNTER_KEY, from: "unknown" }]);
  });

  test("an item on another pane, for a refused send, or for a send the driver never ran closes nothing", async () => {
    const { state, port, item } = fakeProgram();
    const { confirmed, ledger } = fakeLedger();
    const { driver, store } = driverOf(port, { ledger });
    await driver.handle({ id: "drv-eff-0006", text: "one", mode: "send" }, TARGET);
    item("drv-eff-0006", "conv-2");
    expect(store.get("drv-eff-0006")?.receipt?.outcome).toBe("sent");
    state.asks = [permission()];
    await driver.handle({ id: "drv-eff-0007", text: "two", mode: "send" }, TARGET);
    item("drv-eff-0007");
    expect(store.get("drv-eff-0007")?.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(driver.itemTook(PANE, "never-sent-0001")).toBe(false);
    // A terminal send in the same store never carries the program generation.
    store.accept({ id: "term-send-0001", session: "desk", paneId: PANE, paneGeneration: "%3", surfaceRevision: 0, mode: "send", text: "x" });
    expect(driver.itemTook(PANE, "term-send-0001")).toBe(false);
    expect(confirmed).toEqual([]);
  });
});

describe("Review round: session, lock, queued, replay", () => {
  test("an item for a pane of the same name in another session closes nothing", async () => {
    const { port, item } = fakeProgram();
    const store = new RequestStore(join(dir, "shared"));
    const { confirmed, ledger } = fakeLedger();
    const other = new ProgramDriver({ session: "other-desk", port: fakeProgram().port, store, locks: new SessionLocks(), ledger, salt: "o" });
    const mine = driverOf(port, { store });
    await mine.driver.handle({ id: "drv-ses-0001", text: "hello", mode: "send" }, TARGET);
    expect(other.itemTook(PANE, "drv-ses-0001")).toBe(false);
    expect(store.get("drv-ses-0001")?.receipt?.outcome).toBe("sent");
    expect(confirmed).toEqual([]);
    item("drv-ses-0001");
    expect(store.get("drv-ses-0001")?.receipt?.outcome).toBe("effective");
  });

  test("the program's own pane routes take the driver's lock: one write per conversation at a time", async () => {
    const { state, port, controls } = fakeProgram();
    const locks = new SessionLocks();
    let release = (): void => undefined;
    state.control = () => new Promise((resolve) => (release = () => resolve({ kind: "ok", replayed: false })));
    const { driver } = driverOf(port, { locks });
    const writes = driver.lockedWrites(port);
    const steer = writes.controlTurn!(PANE, { act: "send", requestId: "steer-0001", target: { kind: "turn", id: "turn-1" }, text: "left", steer: true });
    await Bun.sleep(1);
    const send = await driver.handle({ id: "drv-lock-0001", text: "while steering", mode: "send" }, TARGET);
    expect(send.receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    const answer = await writes.answerAsk!(PANE, { requestId: "ans-0001", askId: "pa-1", revision: 1, optionId: "allow" });
    expect(answer).toEqual({ ok: false, reason: "refused", detail: expect.stringContaining("still running") });
    release();
    expect(await steer).toEqual({ kind: "ok", replayed: false });
    expect(controls).toHaveLength(1);
    // The lock is free again after the pane route's write.
    state.control = () => Promise.resolve({ kind: "ok", replayed: false });
    expect((await driver.handle({ id: "drv-lock-0002", text: "now", mode: "send" }, TARGET)).receipt?.outcome).toBe("sent");
  });

  test("Stop waits for the lock of a send that hangs and goes out at the lock's limit; Steer is refused busy", async () => {
    const { state, port, controls } = fakeProgram();
    state.status = "working";
    let clock = Date.now();
    state.control = () => new Promise(() => undefined); // the send never answers
    const store = new RequestStore(join(dir, "hung"), () => clock);
    const driver = new ProgramDriver({ session: TARGET.session, port, store, locks: new SessionLocks(), now: () => clock, sleep: (ms) => Promise.resolve(void (clock += ms)), salt: "s" });
    void driver.handle({ id: "drv-hang-0001", text: "hangs", mode: "send" }, TARGET);
    await Bun.sleep(5);
    expect(controls).toHaveLength(1);
    const writes = driver.lockedWrites({ ...port, controlTurn: (paneId, request) => (request.act === "abort" ? Promise.resolve({ kind: "ok", replayed: false }) : port.controlTurn(paneId, request)) });
    const steer = await writes.controlTurn!(PANE, { act: "send", requestId: "steer-0002", target: { kind: "turn", id: "turn-1" }, text: "left", steer: true });
    expect(steer).toEqual({ kind: "refused", detail: expect.stringContaining("still running") });
    const started = clock;
    const stop = await writes.controlTurn!(PANE, { act: "abort", requestId: "stop-0001", target: { kind: "turn", id: "turn-1" } });
    expect(stop).toEqual({ kind: "ok", replayed: false });
    // It waited, and no longer than the lock's own limit (plus one retry step).
    expect(clock - started).toBeGreaterThan(0);
    expect(clock - started).toBeLessThanOrEqual(PROGRAM_LOCK_MS + 50);
  });

  test("queued comes from the read after the write: a turn that ended during the write is not queued", async () => {
    const { state, port } = fakeProgram();
    state.status = "working";
    state.control = () => {
      state.status = "idle";
      return Promise.resolve({ kind: "ok", replayed: false });
    };
    const { driver } = driverOf(port);
    const answer = await driver.handle({ id: "drv-q-0001", text: "after", mode: "send" }, TARGET);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.queued).toBeUndefined();
    expect(answer.detail).toBeUndefined();
    // Still the same turn after the write: queued.
    state.status = "working";
    state.control = () => Promise.resolve({ kind: "ok", replayed: false });
    expect((await driver.handle({ id: "drv-q-0002", text: "later", mode: "send" }, TARGET)).receipt?.queued).toBe(true);
  });

  test("a replay from another session or pane is refused id_reused, and an unsettled one claims no restart", async () => {
    const { port, controls } = fakeProgram();
    const { driver, store } = driverOf(port);
    store.accept({ id: "drv-rep-0001", session: "other-desk", paneId: PANE, paneGeneration: "program", surfaceRevision: 0, mode: "send", text: "same" });
    const elsewhere = await driver.handle({ id: "drv-rep-0001", text: "same", mode: "send" }, TARGET);
    expect(elsewhere.receipt).toMatchObject({ outcome: "refused", reason: "id_reused" });
    store.accept({ id: "drv-rep-0002", session: TARGET.session, paneId: "conv-9", paneGeneration: "program", surfaceRevision: 0, mode: "send", text: "same" });
    expect((await driver.handle({ id: "drv-rep-0002", text: "same", mode: "send" }, TARGET)).receipt?.reason).toBe("id_reused");
    store.accept({ id: "drv-rep-0003", session: TARGET.session, paneId: PANE, paneGeneration: "program", surfaceRevision: 0, mode: "send", text: "same" });
    const lost = await driver.handle({ id: "drv-rep-0003", text: "same", mode: "send" }, TARGET);
    expect(lost.receipt).toMatchObject({ outcome: "unknown", reason: "crash" });
    expect(lost.detail).not.toContain("restart");
    expect(controls).toEqual([]);
  });
});

describe("Ask through the program channel", () => {
  function askingPane() {
    const program = fakeProgram();
    program.state.status = "blocked";
    program.state.asks = [permission()];
    return program;
  }

  function liveAsk(driver: ProgramDriver): Ask {
    return askOf(driver.surfaceOf(PANE)!.modal)!;
  }

  test("an answer with the hash goes to the program by its own ask id and revision, with no key", async () => {
    const { port, answers } = askingPane();
    const { driver, store } = driverOf(port);
    const ask = liveAsk(driver);
    const reply = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "2", origin: "person_tap" }, TARGET);
    expect(answers).toEqual([{ requestId: ask.id, askId: "pa-1", revision: 1, optionId: "deny" }]);
    expect(reply.receipt).toMatchObject({ askId: ask.id, hash: ask.hash, optionId: "2", outcome: "sent", channel: "program", keys: [] });
    expect(store.getAsk(ask.id)?.receipt?.channel).toBe("program");
    expect(store.getAsk(ask.id)?.receipt?.hash).toBe(ask.hash);
  });

  test("a wrong hash is refused ask_changed, nothing reaches the program, and the reply names the live ask", async () => {
    const { port, answers } = askingPane();
    const { driver } = driverOf(port);
    const ask = liveAsk(driver);
    const reply = await driver.answer({ askId: ask.id, hash: "00000000000000", optionId: "1", origin: "person_tap" }, TARGET);
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed" });
    expect(reply.ask?.channel).toBe("program");
    expect(reply.ask?.id).not.toBe(ask.id);
    expect(answers).toEqual([]);
  });

  test("an ask the program changed in place since the id was minted is refused ask_changed", async () => {
    const { state, port, answers } = askingPane();
    const { driver } = driverOf(port);
    const ask = liveAsk(driver);
    state.asks = [permission(2)];
    const reply = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "1", origin: "person_tap" }, TARGET);
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed" });
    expect(answers).toEqual([]);
  });

  test("an ask the program closed is refused ask_gone", async () => {
    const { state, port, answers } = askingPane();
    const { driver } = driverOf(port);
    const ask = liveAsk(driver);
    state.asks = [];
    state.status = "working";
    const reply = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "1", origin: "person_tap" }, TARGET);
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_gone" });
    expect(answers).toEqual([]);
  });

  test("single use: the same answer twice replays, another option on the id is refused ask_answered", async () => {
    const { port, answers } = askingPane();
    const { driver } = driverOf(port);
    const ask = liveAsk(driver);
    const first = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "1", origin: "person_tap" }, TARGET);
    const again = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "1", origin: "person_tap" }, TARGET);
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt!);
    const other = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "2", origin: "person_tap" }, TARGET);
    expect(other.receipt).toMatchObject({ outcome: "refused", reason: "ask_answered" });
    expect(answers).toHaveLength(1);
    // The spent id never comes back: the same program ask now carries a new id.
    expect(liveAsk(driver).id).not.toBe(ask.id);
  });

  test("an id the bridge never minted is refused ask_unknown and stores nothing", async () => {
    const { port, answers } = askingPane();
    const { driver, store } = driverOf(port);
    const reply = await driver.answer({ askId: "ask-0123456789abcd", hash: "0123", optionId: "1", origin: "person_tap" }, TARGET);
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_unknown" });
    expect(reply.ask?.channel).toBe("program");
    expect(store.getAsk("ask-0123456789abcd")).toBeNull();
    expect(answers).toEqual([]);
  });

  test("an option the ask does not have is refused no_plan", async () => {
    const { port, answers } = askingPane();
    const { driver } = driverOf(port);
    const ask = liveAsk(driver);
    const reply = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "9", origin: "person_tap" }, TARGET);
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "no_plan" });
    expect(answers).toEqual([]);
  });

  test("the program's answers map onto the ask outcome list", async () => {
    const cases: [MuxOutcome<MuxAnswerResult>, AskOutcome, AskReason | undefined][] = [
      [muxOk({ kind: "too-late", replayed: false, decided: { by: "phone", at: "2026-10-16T10:00:00Z" } }), "refused", "ask_answered"],
      [muxOk({ kind: "too-late", replayed: false, decided: { by: "timeout", at: "2026-10-16T10:00:00Z" } }), "refused", "ask_gone"],
      [muxOk({ kind: "stale", ask: permission(3) }), "refused", "ask_changed"],
      [muxOk({ kind: "unknown", detail: "timed out" }), "unknown", "no_evidence"],
      [muxRefused("bad option"), "refused", "write_failed"],
      [{ ok: false, reason: "gone", detail: "no such pane" }, "refused", "pane_gone"],
    ];
    for (const [index, [said, outcome, reason]] of cases.entries()) {
      const { state, port } = askingPane();
      state.answer = () => Promise.resolve(said);
      // A store of its own per case: the salt is fixed, so each case mints the same ask id.
      const { driver } = driverOf(port, { store: new RequestStore(join(dir, `sends-${String(index)}`)) });
      const ask = liveAsk(driver);
      const reply = await driver.answer({ askId: ask.id, hash: ask.hash, optionId: "1", origin: "person_tap" }, TARGET);
      expect(reply.receipt?.outcome).toBe(outcome);
      expect(reply.receipt?.reason).toBe(reason);
      if (reason === "ask_changed") expect(reply.ask?.channel).toBe("program");
    }
  });
});

describe("the routes on a program session", () => {
  function routeRuntime(port: ProgramPort, store: RequestStore) {
    const driver = new ProgramDriver({ session: "desk", port, store, locks: new SessionLocks(), salt: "route" });
    let pokes = 0;
    const rt: AskRouteRuntime = {
      name: "desk",
      driver,
      // A program pane carries `controlTurn`: without the driver, the raw refusal would answer.
      herdr: { controlTurn: () => Promise.reject(new Error("never called by the driver route")) },
      engine: {
        current: () => ({ agents: [{ paneId: PANE, agent: "durable" }] }),
        noteInput: () => undefined,
        pokeNow: () => {
          pokes++;
        },
      },
    };
    return { rt, driver, pokes: () => pokes };
  }

  test("POST /api/send runs the driver, audits without the text, and lists the receipt", async () => {
    const { port } = fakeProgram();
    const store = new RequestStore(join(dir, "sends"));
    const { rt, pokes } = routeRuntime(port, store);
    const lines: string[] = [];
    const audit = new AuditLog((line) => void lines.push(line));
    const context = { audit, device: null, redact: false, acceptEncoding: null };
    const res = await sendRoute(rt, { id: "route-drv-0001", pane: PANE, text: "secret words" }, context);
    expect(res.status).toBe(200);
    // SAFETY: the route answers a SendAnswer as JSON; the test reads two fields of its receipt.
    const body = (await res.json()) as { receipt: { outcome: string; acknowledged: string } };
    expect(body.receipt).toMatchObject({ outcome: "sent", acknowledged: "route-drv-0001" });
    expect(lines.join("\n")).not.toContain("secret words");
    expect(pokes()).toBe(1);
    expect((await sendRoute(rt, { id: "route-drv-0002", pane: "nope", text: "x" }, context)).status).toBe(404);
    // SAFETY: the route answers a SendReceiptsAnswer as JSON.
    const listed = (await sendReceiptsRoute(rt, PANE, null).json()) as { receipts: { requestId: string }[] };
    expect(listed.receipts.map((row) => row.requestId)).toEqual(["route-drv-0001"]);
  });

  test("POST /api/ask/<id> answers through the program channel", async () => {
    const { state, port, answers } = fakeProgram();
    state.status = "blocked";
    state.asks = [permission()];
    const store = new RequestStore(join(dir, "sends"));
    const { rt, driver } = routeRuntime(port, store);
    const ask = askOf(driver.surfaceOf(PANE)!.modal)!;
    const context = { audit: new AuditLog(() => undefined), device: null, redact: false, acceptEncoding: null };
    const res = await askRoute(rt, ask.id, { pane: PANE, hash: ask.hash, optionId: "1", origin: "person_tap" }, context);
    // SAFETY: the route answers an AskReply as JSON; the test reads three fields of its receipt.
    const body = (await res.json()) as { receipt: { outcome: string; channel: string; hash: string } };
    expect(body.receipt).toMatchObject({ outcome: "sent", channel: "program", hash: ask.hash });
    expect(answers).toHaveLength(1);
  });
});
