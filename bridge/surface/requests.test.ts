import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendReceipt } from "../../web/src/lib/surface/send.ts";
import { HOST } from "../host.ts";
import { isOwnerOnly } from "../owner-only.ts";
import { SendProtocol } from "./protocol.ts";
import { RequestStore, type AcceptInput, type SendRecord } from "./requests.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-sends-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ID = "req-0001-abcdef";

function input(over: Partial<AcceptInput> = {}): AcceptInput {
  return { id: ID, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 4, mode: "send", text: "hello world", ...over };
}

function receiptFor(record: SendRecord, outcome: SendReceipt["outcome"] = "sent"): SendReceipt {
  const { reason: _crash, ...rest } = SendProtocol.crashReceipt(record);
  return { ...rest, outcome, keys: ["Enter"] };
}

describe("accept", () => {
  test("writes the request file before anything is sent, with no text in it", () => {
    const store = new RequestStore(join(dir, "sends"), () => 5000);
    const result = store.accept(input({ text: "my password is hunter2" }));
    expect(result.kind).toBe("new");
    const raw = readFileSync(join(dir, "sends", `${ID}.json`), "utf8");
    expect(raw).not.toContain("hunter2");
    const stored = JSON.parse(raw);
    expect(stored).toMatchObject({ id: ID, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 4, acceptedAt: 5000, phase: "accepted", textLength: 22 });
    expect(stored.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the file and the directory are private", () => {
    const store = new RequestStore(join(dir, "sends"));
    store.accept(input());
    // POSIX: the mode bits. NTFS reports 666, so Windows reads the owner-only access list instead.
    if (HOST.platform === "win32") {
      expect(isOwnerOnly(join(dir, "sends"), HOST)).toEqual({ state: "private" });
      expect(isOwnerOnly(join(dir, "sends", `${ID}.json`), HOST)).toEqual({ state: "private" });
    } else {
      expect(statSync(join(dir, "sends")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "sends", `${ID}.json`)).mode & 0o777).toBe(0o600);
    }
  });

  test("the same id with the same text is a replay of the stored record", () => {
    const store = new RequestStore(dir);
    const first = store.accept(input());
    const again = store.accept(input());
    expect(again).toEqual({ kind: "replay", record: first.record });
  });

  test("the same id with another text is refused id_reused and the stored record stays", () => {
    const store = new RequestStore(dir);
    const first = store.accept(input());
    const other = store.accept(input({ text: "something else" }));
    expect(other.kind).toBe("id_reused");
    expect(store.get(ID)).toEqual(first.record);
  });

  test("an id that is not a plain token never names a file", () => {
    const store = new RequestStore(dir);
    expect(() => store.accept(input({ id: "../../etc/passwd" }))).toThrow(/not a request id/);
    expect(() => store.accept(input({ id: "short" }))).toThrow(/not a request id/);
  });

  test("the text hash is salted per state directory and stable across a restart", () => {
    const a = new RequestStore(join(dir, "a"));
    const b = new RequestStore(join(dir, "b"));
    expect(a.hashText("hi")).not.toBe(b.hashText("hi"));
    expect(new RequestStore(join(dir, "a")).hashText("hi")).toBe(a.hashText("hi"));
  });
});

describe("phases and receipts", () => {
  test("submit-sent is written before the key, and a settled record never changes again", () => {
    let now = 100;
    const store = new RequestStore(dir, () => now);
    const { record } = store.accept(input());
    now = 150;
    store.markSubmitSent(ID);
    expect(store.get(ID)).toMatchObject({ phase: "submit-sent", submitSentAt: 150 });
    const receipt = receiptFor(record);
    store.settle(ID, receipt);
    expect(store.get(ID)?.receipt).toEqual(receipt);
    store.settle(ID, receiptFor(record, "unknown"));
    store.markSubmitSent(ID);
    expect(store.get(ID)).toMatchObject({ phase: "settled", receipt });
  });

  test("requests and receipts survive a restart, and the same id returns the same receipt", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const receipt = receiptFor(record);
    first.settle(ID, receipt);
    const restarted = new RequestStore(dir);
    const replay = restarted.accept(input());
    expect(replay.kind).toBe("replay");
    expect(replay.record.receipt).toEqual(receipt);
  });

  test("after a crash, a request that sent its submit key but never settled ends unknown, and so does one that never got that far", () => {
    const store = new RequestStore(dir);
    store.accept(input());
    store.markSubmitSent(ID);
    store.accept(input({ id: "req-0002-abcdef", text: "other" }));
    const settledId = "req-0003-abcdef";
    const done = store.accept(input({ id: settledId, text: "done" }));
    const doneReceipt = receiptFor(done.record);
    store.settle(settledId, doneReceipt);

    const restarted = new RequestStore(dir);
    const recovered = restarted.recover(SendProtocol.crashReceipt);
    expect(recovered.map((r) => r.id).toSorted()).toEqual([ID, "req-0002-abcdef"]);
    for (const id of [ID, "req-0002-abcdef"]) {
      expect(restarted.get(id)?.receipt).toMatchObject({ outcome: "unknown", reason: "crash", keys: [] });
    }
    expect(restarted.get(settledId)?.receipt).toEqual(doneReceipt);
    // A second start finds nothing left to settle.
    expect(new RequestStore(dir).recover(SendProtocol.crashReceipt)).toEqual([]);
  });

  test("prune drops settled records past the keep window and past the cap, never an unsettled one", () => {
    let now = 0;
    const store = new RequestStore(dir, () => now);
    for (let i = 0; i < 5; i++) {
      now = i * 1000;
      const { record } = store.accept(input({ id: `req-000${String(i)}-prune`, text: `t${String(i)}` }));
      if (i !== 2) store.settle(record.id, receiptFor(record));
    }
    now = 10_000;
    expect(store.prune(9_500, 100)).toBe(1); // req-0000 is 10 s old
    expect(store.prune(100_000, 2)).toBe(2); // two more settled, oldest first; the unsettled one stays
    const left = readdirSync(dir).filter((name) => name.endsWith(".json")).toSorted();
    expect(left).toEqual(["req-0002-prune.json", "req-0004-prune.json"]);
  });
});
