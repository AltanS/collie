import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECEIPT_DETAIL_MAX, type SendReceipt } from "../../web/src/lib/surface/send.ts";
import { AskAnswerer } from "./ask.ts";
import { HOST } from "../host.ts";
import { isOwnerOnly } from "../owner-only.ts";
import { SendProtocol } from "./protocol.ts";
import { parseSendRecord, RequestStore, type AcceptInput, type SendRecord } from "./requests.ts";

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
  test("writes the request file before anything is sent, with no text in it when the text looks like a secret", () => {
    const store = new RequestStore(join(dir, "sends"), () => 5000);
    const result = store.accept(input({ text: "my password is hunter2" }));
    expect(result.kind).toBe("new");
    const raw = readFileSync(join(dir, "sends", `${ID}.json`), "utf8");
    expect(raw).not.toContain("hunter2");
    const stored = JSON.parse(raw);
    expect(stored).toMatchObject({ id: ID, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 4, acceptedAt: 5000, phase: "accepted", textLength: 22 });
    expect(stored.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.line).toBeUndefined();
    expect(result.record.line).toBeUndefined();
  });

  test("a written record carries the Collie version the store was built with, and one built without it carries none", () => {
    const store = new RequestStore(join(dir, "sends"), () => 5000, "1.25.2");
    store.accept(input());
    expect(JSON.parse(readFileSync(join(dir, "sends", `${ID}.json`), "utf8")).collie).toBe("1.25.2");
    expect(store.get(ID)?.collie).toBe("1.25.2");
    // The field survives a later write of the same record.
    store.markSubmitSent(ID);
    expect(store.get(ID)?.collie).toBe("1.25.2");
    const bare = new RequestStore(join(dir, "other"), () => 5000);
    bare.accept(input());
    expect(JSON.parse(readFileSync(join(dir, "other", `${ID}.json`), "utf8")).collie).toBeUndefined();
  });

  test("keeps the text as the line Sent would keep, and nothing of a text that rule refuses (2026-10-21)", () => {
    const store = new RequestStore(join(dir, "sends"), () => 5000);
    const kept = store.accept(input({ text: "ok check please it's past 2pm  " }));
    expect(kept.record.line).toBe("ok check please it's past 2pm");
    expect(JSON.parse(readFileSync(join(dir, "sends", `${ID}.json`), "utf8")).line).toBe("ok check please it's past 2pm");
    // The same four refusals Sent makes: a leading space, several lines, a vendor key, a line too long.
    const refused = [" quiet one", "first line\nsecond line", "use ghp_abcdefghijklmnopqrstuvwxyz0123456789", `x${"y".repeat(5000)}`];
    refused.forEach((text, n) => {
      const id = `req-000${String(n + 2)}-abcdef`;
      const result = store.accept(input({ id, text }));
      expect(result.record.line).toBeUndefined();
      expect(readFileSync(join(dir, "sends", `${id}.json`), "utf8")).not.toContain(text.trim().slice(0, 8));
    });
  });

  test("the line survives a restart, and a line that is not what it should be is dropped while the record stays", () => {
    const first = new RequestStore(join(dir, "sends"), () => 5000);
    first.accept(input({ text: "git status" }));
    expect(new RequestStore(join(dir, "sends")).get(ID)?.line).toBe("git status");
    const path = join(dir, "sends", `${ID}.json`);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, `${JSON.stringify({ ...stored, line: 7 })}\n`);
    const again = new RequestStore(join(dir, "sends")).get(ID);
    expect(again?.id).toBe(ID);
    expect(again?.line).toBeUndefined();
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

  test("a discarded receipt and a cap's numbers survive a restart; a cap that is not whole makes the file unreadable", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const cap = { count: 5, limit: 5, harness: "codex", version: "-" };
    const receipt: SendReceipt = { ...receiptFor(record, "refused"), reason: "unconfirmed", cap };
    first.settle(ID, receipt);
    expect(new RequestStore(dir).get(ID)?.receipt).toEqual(receipt);
    const other = first.accept(input({ id: "req-0004-abcdef", text: "gone" }));
    first.settle("req-0004-abcdef", receiptFor(other.record, "discarded"));
    expect(new RequestStore(dir).get("req-0004-abcdef")?.receipt).toMatchObject({ outcome: "discarded" });
    const broken = join(dir, `${ID}.json`);
    writeFileSync(broken, readFileSync(broken, "utf8").replace('"count":5', '"count":"five"'));
    expect(new RequestStore(dir).get(ID)).toBeNull();
  });

  test("a queued receipt survives a restart; a queued field that is not true makes the file unreadable", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const receipt: SendReceipt = { ...receiptFor(record), queued: true };
    first.settle(ID, receipt);
    expect(new RequestStore(dir).get(ID)?.receipt).toEqual(receipt);
    const broken = join(dir, `${ID}.json`);
    writeFileSync(broken, readFileSync(broken, "utf8").replace('"queued":true', '"queued":"yes"'));
    expect(new RequestStore(dir).get(ID)).toBeNull();
  });

  test("a receipt's proof gap survives a restart (2026-10-25)", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const receipt: SendReceipt = { ...receiptFor(record), gapsMs: { s0: 120, proof: 640 } };
    first.settle(ID, receipt);
    expect(new RequestStore(dir).get(ID)?.receipt).toEqual(receipt);
  });

  test("a detail and saw survive a restart; a future saw word drops only saw, a long detail is cut, a detail of the wrong type is dropped, and the receipt stays", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const saw = { turn: "idle", modal: "none", composer: "draft" } as const;
    const receipt: SendReceipt = { ...receiptFor(record, "refused"), reason: "not_free", detail: "The input box is not free.", saw };
    first.settle(ID, receipt);
    expect(new RequestStore(dir).get(ID)?.receipt).toEqual(receipt);
    const file = join(dir, `${ID}.json`);
    const original = readFileSync(file, "utf8");
    // A word a later Collie wrote: only `saw` goes, the sentence and the rest of the receipt stay.
    writeFileSync(file, original.replace('"turn":"idle"', '"turn":"paused"'));
    const future = new RequestStore(dir).get(ID);
    expect(future?.phase).toBe("settled");
    expect(future?.receipt).toEqual({ ...receipt, saw: undefined });
    expect(future?.receipt?.saw).toBeUndefined();
    expect(future?.receipt?.detail).toBe("The input box is not free.");
    expect(new RequestStore(dir).accept(input()).kind).toBe("replay");
    // A detail past the cap is cut to it.
    writeFileSync(file, original.replace('"The input box is not free."', JSON.stringify("x".repeat(RECEIPT_DETAIL_MAX + 50))));
    const cut = new RequestStore(dir).get(ID)?.receipt;
    expect(cut?.detail).toBe("x".repeat(RECEIPT_DETAIL_MAX));
    expect(cut?.saw).toEqual(saw);
    // A detail that is not a string is dropped.
    writeFileSync(file, original.replace('"The input box is not free."', "42"));
    const wrong = new RequestStore(dir).get(ID)?.receipt;
    expect(wrong?.detail).toBeUndefined();
    expect(wrong?.saw).toEqual(saw);
    expect(wrong?.outcome).toBe("refused");
  });

  test("a receipt with neither detail nor saw reads as before", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const receipt = receiptFor(record);
    first.settle(ID, receipt);
    const read = new RequestStore(dir).get(ID)?.receipt;
    expect(read).toEqual(receipt);
    expect(read && "detail" in read).toBe(false);
    expect(read && "saw" in read).toBe(false);
  });

  test("a program's acknowledged request id survives a restart; one that is not a request id makes the file unreadable (M56 spec 14)", () => {
    const first = new RequestStore(dir);
    const { record } = first.accept(input());
    const receipt: SendReceipt = { ...receiptFor(record), keys: [], acknowledged: ID };
    first.settle(ID, receipt);
    expect(new RequestStore(dir).get(ID)?.receipt).toEqual(receipt);
    const broken = join(dir, `${ID}.json`);
    writeFileSync(broken, readFileSync(broken, "utf8").replace(`"acknowledged":"${ID}"`, '"acknowledged":"../x"'));
    expect(new RequestStore(dir).get(ID)).toBeNull();
  });

  test("a held request (M56 spec 15) survives a restart unsettled, recover leaves it, and rearm runs it again bounded from now", () => {
    let now = 1_000;
    const store = new RequestStore(dir, () => now);
    const { record } = store.accept(input());
    const held: SendReceipt = { ...receiptFor(record, "held"), keys: [] };
    expect(store.hold(ID, held)).toMatchObject({ phase: "held", receipt: held });
    // The hold keeps the line the accept kept, like every other phase.
    expect(JSON.parse(readFileSync(join(dir, `${ID}.json`), "utf8")).line).toBe("hello world");
    const restarted = new RequestStore(dir, () => now);
    expect(restarted.recover(SendProtocol.crashReceipt)).toEqual([]);
    expect(restarted.get(ID)).toMatchObject({ phase: "held", receipt: { outcome: "held" } });
    expect(restarted.prune(0, 0)).toBe(0);
    now = 9_000;
    const armed = restarted.rearm(ID);
    expect(armed).toMatchObject({ phase: "accepted", runAt: 9_000, acceptedAt: 1_000 });
    expect(armed?.receipt).toBeUndefined();
    expect(restarted.rearm(ID)).toBeNull();
    restarted.settle(ID, receiptFor(record));
    expect(restarted.hold(ID, held)).toBeNull();
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

// Ask answers live in the same store (M56 spec 08), under their own file names.
describe("a queued receipt whose text came back (ADR 0122)", () => {
  test("a settled `sent` + `queued` takes `late: returned` once; outcome and queued stay; it survives a restart", () => {
    const store = new RequestStore(dir);
    const { record } = store.accept(input());
    store.settle(ID, { ...receiptFor(record), queued: true });
    expect(store.markReturned(ID)).toBe(true);
    expect(store.markReturned(ID)).toBe(false);
    expect(store.get(ID)?.receipt).toMatchObject({ outcome: "sent", queued: true, late: "returned" });
    expect(new RequestStore(dir).get(ID)?.receipt?.late).toBe("returned");
  });

  test("a settled `steered` receipt takes it too, once, and keeps its outcome", () => {
    const store = new RequestStore(dir);
    const { record } = store.accept(input({ id: "req-steer-00001" }));
    store.settle("req-steer-00001", receiptFor(record, "steered"));
    expect(store.markReturned("req-steer-00001")).toBe(true);
    expect(store.markReturned("req-steer-00001")).toBe(false);
    expect(store.get("req-steer-00001")?.receipt).toMatchObject({ outcome: "steered", late: "returned" });
  });

  test("only a settled queued `sent` takes it: not a plain send, not an effective one, not an unsettled one", () => {
    const store = new RequestStore(dir);
    const plain = store.accept(input({ id: "req-plain-0001" })).record;
    store.settle("req-plain-0001", receiptFor(plain));
    expect(store.markReturned("req-plain-0001")).toBe(false);
    const landed = store.accept(input({ id: "req-landed-001" })).record;
    store.settle("req-landed-001", { ...receiptFor(landed, "effective"), queued: true });
    expect(store.markReturned("req-landed-001")).toBe(false);
    store.accept(input({ id: "req-open-00001" }));
    expect(store.markReturned("req-open-00001")).toBe(false);
    expect(store.markReturned("req-none-00001")).toBe(false);
  });

  test("a late word this build did not write is dropped, and the receipt stays", () => {
    const store = new RequestStore(dir);
    const { record } = store.accept(input());
    store.settle(ID, { ...receiptFor(record), queued: true });
    const path = join(dir, `${ID}.json`);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...raw, receipt: { ...raw.receipt, late: "teleported" } }));
    const read = store.get(ID)?.receipt;
    expect(read).toMatchObject({ outcome: "sent", queued: true });
    expect(read && "late" in read).toBe(false);
  });
});

describe("ask answers in the same store", () => {
  const ASK = "ask-0123456789abcd";
  const askInput = { id: ASK, session: "main", paneId: "%1", paneGeneration: "g1", hash: "0abc12", optionId: "2" };

  test("accept, replay, answered, settle, and a send list that never reads an ask file", () => {
    const store = new RequestStore(join(dir, "sends"), () => 7000);
    expect(store.acceptAsk(askInput).kind).toBe("new");
    expect(readdirSync(join(dir, "sends")).filter((name) => name.endsWith(".json"))).toEqual([`ask.${ASK}.json`]);
    expect(store.acceptAsk(askInput).kind).toBe("replay");
    expect(store.acceptAsk({ ...askInput, optionId: "1" }).kind).toBe("answered");
    expect(store.acceptAsk({ ...askInput, hash: "ffffff" }).kind).toBe("answered");
    const receipt = { ...AskAnswerer.crashReceipt(store.getAsk(ASK)!), outcome: "sent" as const, keys: ["Down", "Enter"] };
    const { reason: _crash, ...sent } = receipt;
    expect(store.settleAsk(ASK, sent)?.receipt).toEqual(sent);
    // A settled answer never changes again.
    expect(store.settleAsk(ASK, receipt)?.receipt).toEqual(sent);
    expect(store.list()).toEqual([]);
    expect(store.listAsks().map((record) => record.id)).toEqual([ASK]);
  });

  test("an answer on the program channel keeps its channel across a restart; an unknown channel makes the file unreadable (M56 spec 14)", () => {
    const store = new RequestStore(join(dir, "sends"), () => 7000);
    store.acceptAsk(askInput);
    const { reason: _crash, ...base } = AskAnswerer.crashReceipt(store.getAsk(ASK)!);
    const sent = { ...base, outcome: "sent" as const, channel: "program" as const };
    store.settleAsk(ASK, sent);
    expect(new RequestStore(join(dir, "sends")).getAsk(ASK)?.receipt).toEqual(sent);
    const file = join(dir, "sends", `ask.${ASK}.json`);
    writeFileSync(file, readFileSync(file, "utf8").replace('"channel":"program"', '"channel":"carrier-pigeon"'));
    expect(new RequestStore(join(dir, "sends")).getAsk(ASK)).toBeNull();
  });

  test("a send id can never name an ask file", () => {
    const store = new RequestStore(join(dir, "sends"), () => 7000);
    store.acceptAsk(askInput);
    expect(store.accept(input({ id: ASK })).kind).toBe("new");
    expect(store.getAsk(ASK)?.optionId).toBe("2");
  });

  test("recover settles an unsettled answer as unknown (crash); prune drops old settled answers", () => {
    let now = 7000;
    const store = new RequestStore(join(dir, "sends"), () => now);
    store.acceptAsk(askInput);
    expect(store.recoverAsks(AskAnswerer.crashReceipt).map((record) => record.receipt?.reason)).toEqual(["crash"]);
    now += 8 * 24 * 60 * 60 * 1000;
    expect(store.prune()).toBe(1);
    expect(store.listAsks()).toEqual([]);
  });
});

describe("parseSendRecord", () => {
  // M71 spec 01: `collie doctor` parses the same files without a store, whose constructor writes.
  test("reads back what the store wrote, and refuses what it did not write", () => {
    const store = new RequestStore(join(dir, "sends"), () => 5000);
    const { record } = store.accept(input());
    const settled = store.settle(ID, receiptFor(record, "refused"))!;
    const raw = JSON.parse(readFileSync(join(dir, "sends", `${ID}.json`), "utf8"));
    expect(parseSendRecord(raw)).toEqual(settled);
    expect(parseSendRecord({ ...raw, phase: "lost" })).toBeNull();
    expect(parseSendRecord({ ...raw, receipt: { ...raw.receipt, outcome: "maybe" } })).toBeNull();
    expect(parseSendRecord(undefined)).toBeNull();
  });
});
