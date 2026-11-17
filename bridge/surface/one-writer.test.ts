// M102 spec 16 outside the Send Protocol's own run: the key gate's press and hold take the machine-wide
// pane lock (the raw keys route, Stop, Clear, the old reply steps), and the request store's write-ahead
// mark tells `interrupted` from `crash` after a restart.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { muxAck, type MuxAck } from "../mux/types.ts";
import { sendReplySteps } from "../server.ts";
import { gateFor, isPaneBusy, KeyGate } from "./key-gate.ts";
import { PANE_BUSY, PaneLockFiles } from "./pane-lock.ts";
import { SendProtocol, SessionLocks } from "./protocol.ts";
import { parseSendRecord, RequestStore } from "./requests.ts";

let dir: string;
const living = new Set<number>();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "one-writer-"));
  living.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lockOf(pid: number): PaneLockFiles {
  living.add(pid);
  return new PaneLockFiles({ dir, scope: "tmux\u0000", pid, alive: (p) => living.has(p), startOf: (p) => `s${String(p)}` });
}

/** A key writer that logs every key it was handed. */
interface KeyLog {
  readonly keys: string[];
  readonly writer: { writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> };
}

function keyLog(): KeyLog {
  const keys: string[] = [];
  return { keys, writer: { writeKeys: (_pane, pressed) => (keys.push(...pressed), Promise.resolve(muxAck())) } };
}

describe("the key gate shares the pane lock", () => {
  test("a person's press is refused before any key while another bridge writes into the pane", async () => {
    const other = lockOf(202);
    expect(other.take("%1", "their-send", Date.now() + 30_000)).toBe(true);
    const { keys, writer } = keyLog();
    const gate = new KeyGate(writer, Date.now, () => Promise.resolve());
    gate.share(lockOf(101));
    const ack = await gate.press("%1", ["Enter"], "person_tap");
    expect(isPaneBusy(ack)).toBe(true);
    expect(!ack.ok && ack.detail).toBe(PANE_BUSY);
    expect(keys).toEqual([]);
    // Another pane is free, and so is this one once the other bridge lets go.
    expect((await gate.press("%2", ["Enter"], "person_tap")).ok).toBe(true);
    other.release("%1", "their-send");
    expect((await gate.press("%1", ["Enter"], "person_tap")).ok).toBe(true);
    expect(keys).toEqual(["Enter", "Enter"]);
  });

  test("a send of this bridge past its until, the file taken over by another: a press is refused busy, Stop waits then goes bypassed (2026-11-17)", async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    const shared = (pid: number): PaneLockFiles => {
      living.add(pid);
      return new PaneLockFiles({ dir, scope: "tmux\u0000", pid, now, alive: (p) => living.has(p), startOf: (p) => `s${String(p)}` });
    };
    const mine = shared(101);
    const locks = new SessionLocks(mine);
    expect(locks.acquire("main\u0000%1", "req-a", clock + 1_000, clock)).toBe(true);
    clock += 1_000 + 5_001;
    const other = shared(202);
    expect(other.take("%1", "their-send", clock + 30_000)).toBe(true);
    const { keys, writer } = keyLog();
    const gate = new KeyGate(writer, now, () => Promise.resolve());
    gate.share(mine);
    expect(isPaneBusy(await gate.press("%1", ["Enter"], "person_tap"))).toBe(true);
    expect(keys).toEqual([]);
    // A new send of this bridge on the pane is refused too.
    expect(locks.acquire("main\u0000%1", "req-b", clock + 10_000, clock)).toBe(false);
    const stop = await gate.pressAlways("%1", ["Escape"]);
    expect(stop.bypassed).toBe(true);
    expect(keys).toEqual(["Escape"]);
  });

  test("a press inside this bridge's own send goes, as a person's key always could; the send keeps its lock", async () => {
    const mine = lockOf(101);
    const locks = new SessionLocks(mine);
    expect(locks.acquire("main\u0000%1", "req-1", Date.now() + 30_000, Date.now())).toBe(true);
    const { keys, writer } = keyLog();
    const gate = new KeyGate(writer);
    gate.share(mine);
    expect((await gate.press("%1", ["Escape"], "person_tap")).ok).toBe(true);
    expect(keys).toEqual(["Escape"]);
    expect(lockOf(202).take("%1", "x", Date.now() + 1_000)).toBe(false);
    locks.release("main\u0000%1", "req-1");
    expect(lockOf(202).take("%1", "x", Date.now() + 1_000)).toBe(true);
  });

  test("a press holds the lock for its own write: another bridge's send cannot start in the middle of it", async () => {
    let release: () => void = () => undefined;
    const writer = { writeKeys: () => new Promise<MuxAck>((resolve) => (release = () => resolve(muxAck()))) };
    const gate = new KeyGate(writer);
    gate.share(lockOf(101));
    const pressing = gate.press("%1", ["Enter"], "person_tap");
    expect(new SessionLocks(lockOf(202)).acquire("other\u0000%1", "req", Date.now() + 30_000, Date.now())).toBe(false);
    release();
    await pressing;
    expect(new SessionLocks(lockOf(202)).acquire("other\u0000%1", "req", Date.now() + 30_000, Date.now())).toBe(true);
  });

  test("a gate with no shared lock presses as before", async () => {
    const { keys, writer } = keyLog();
    expect((await new KeyGate(writer).press("%1", ["Enter"], "person_tap")).ok).toBe(true);
    expect(keys).toEqual(["Enter"]);
  });

  test("the old reply steps (a launcher line, a dialog field) type nothing while another bridge holds the pane", async () => {
    const typed: string[] = [];
    const client = { typeText: (_pane: string, text: string) => (typed.push(text), Promise.resolve(muxAck())), writeKeys: () => Promise.resolve(muxAck()) };
    gateFor(client).share(lockOf(101));
    const other = lockOf(202);
    other.take("%1", "their-send", Date.now() + 30_000);
    const refused = await sendReplySteps(client, "%1", "make test", true, ["Enter"]);
    expect(refused.ok).toBe(false);
    expect(refused.textDelivered).toBe(false);
    expect(typed).toEqual([]);
    other.release("%1", "their-send");
    expect((await sendReplySteps(client, "%1", "make test", true, ["Enter"])).ok).toBe(true);
    expect(typed).toEqual(["make test"]);
  });
});

describe("the write-ahead mark", () => {
  function store(): RequestStore {
    return new RequestStore(join(dir, "sends"), () => 5_000);
  }
  const input = { id: "req-0000001", session: "main", paneId: "%1", paneGeneration: "g", surfaceRevision: 0, mode: "send", text: "hello" } as const;

  test("a request that reached its first key ends interrupted after a restart; one that did not keeps crash", () => {
    const s = store();
    s.accept(input);
    s.markStarted(input.id);
    s.accept({ ...input, id: "req-0000002" });
    const ended = s.recover(SendProtocol.crashReceipt);
    expect(ended.map((record) => [record.id, record.receipt?.reason])).toEqual([
      ["req-0000001", "interrupted"],
      ["req-0000002", "crash"],
    ]);
  });

  test("a request whose submit mark is on disk keeps crash after a restart: Enter may have gone out (2026-11-17)", () => {
    const s = store();
    s.accept(input);
    s.markStarted(input.id);
    s.markSubmitSent(input.id);
    expect(s.recover(SendProtocol.crashReceipt)[0]?.receipt?.reason).toBe("crash");
  });

  test("the mark is written once, never on a settled record, and a held request's release clears it", () => {
    const s = store();
    s.accept(input);
    s.markStarted(input.id);
    const first = s.get(input.id)?.startedAt;
    s.markStarted(input.id);
    expect(s.get(input.id)?.startedAt).toBe(first);
    const receipt = SendProtocol.crashReceipt(s.get(input.id)!);
    s.hold(input.id, { ...receipt, outcome: "held" });
    expect(s.rearm(input.id)?.startedAt).toBeUndefined();
  });

  test("a record an older Collie wrote (no startedAt) still reads, and recovers as crash", () => {
    const s = store();
    s.accept(input);
    const raw = { id: input.id, session: "main", paneId: "%1", paneGeneration: "g", surfaceRevision: 0, mode: "send", textHash: "h", textLength: 5, acceptedAt: 1, phase: "submit-sent" };
    expect(parseSendRecord(raw)?.startedAt).toBeUndefined();
    writeFileSync(join(dir, "sends", `${input.id}.json`), `${JSON.stringify(raw)}\n`);
    expect(s.recover(SendProtocol.crashReceipt)[0]?.receipt?.reason).toBe("crash");
  });
});
