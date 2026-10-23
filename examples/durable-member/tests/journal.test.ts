// The journal fold (core/journal.ts): a table of record sequences, and what each folds to. The fold is pure, so the
// table is the whole contract: first terminal record per ask id wins, an ask after its terminal is ignored, a receipt
// `done` closes its `pending`.
import { describe, expect, test } from "bun:test";
import { type Ask, foldJournal, type JournalAnswer, type JournalAsk, type JournalExpire, type JournalReceipt, type JournalRecord } from "../../../packages/durable-sdk/src/core/index.ts";

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  kind: "permission",
  toolCallId: `call-${id}`,
  revision: 1,
  title: `${id} wants to run`,
  itemId: `call-${id}`,
  options: [
    { id: "allow", label: "Allow", effect: "allow" },
    { id: "deny", label: "Deny", effect: "deny" },
  ],
  ...over,
});
const opened = (id: string, over: Partial<JournalAsk> = {}): JournalAsk => ({ t: "ask", askId: id, toolCallId: `call-${id}`, argsHash: "h", ask: ask(id), openedAt: "2026-10-21T10:00:00.000Z", ...over });
const answered = (id: string, optionId: string, nonce: string, at = "2026-10-21T10:01:00.000Z"): JournalAnswer => ({ t: "answer", askId: id, revision: 1, answer: { optionId }, requestId: `req-${nonce}`, nonce, at });
const expired = (id: string, at = "2026-10-21T10:05:00.000Z", decidedBy?: "timeout" | "program"): JournalExpire => ({ t: "expire", askId: id, at, ...(decidedBy ? { decidedBy } : {}) });
const receipt = (phase: "pending" | "done", requestId: string, digest = "d1", reply?: object): JournalReceipt => ({
  t: "receipt",
  phase,
  group: "p1",
  requestId,
  digest,
  at: "2026-10-21T10:02:00.000Z",
  ...(reply ? { reply } : {}),
});

/** The ask ids still open, the deciding record of each decided ask, and the receipts as `requestId:phase`. */
const shape = (records: JournalRecord[]) => {
  const f = foldJournal(records);
  return {
    open: f.open.map((a) => a.askId),
    decided: [...f.decided].map(([id, o]) => `${id}:${o.decidedBy}${o.optionId ? `:${o.optionId}` : ""}${o.effect ? `:${o.effect}` : ""}`),
    winners: [...f.winners].map(([id, w]) => `${id}:${w.t === "answer" ? w.nonce : "expire"}`),
    receipts: [...f.receipts].map(([id, r]) => `${id}:${r.phase}`),
  };
};

describe("foldJournal", () => {
  const table: { name: string; records: JournalRecord[]; open?: string[]; decided?: string[]; winners?: string[]; receipts?: string[] }[] = [
    { name: "an empty journal folds to nothing", records: [] },
    { name: "an ask with no terminal record is open", records: [opened("a")], open: ["a"] },
    { name: "open asks keep the order of their records", records: [opened("b"), opened("a"), opened("c")], open: ["b", "a", "c"] },
    { name: "an answer closes its ask, with the option and its effect", records: [opened("a"), answered("a", "allow", "n1")], decided: ["a:phone:allow:allow"], winners: ["a:n1"] },
    { name: "a deny answer carries the deny effect", records: [opened("a"), answered("a", "deny", "n1")], decided: ["a:phone:deny:deny"], winners: ["a:n1"] },
    { name: "an expire closes its ask as a timeout", records: [opened("a"), expired("a")], decided: ["a:timeout"], winners: ["a:expire"] },
    { name: "an expire by the program (a stop) says program", records: [opened("a"), expired("a", undefined, "program")], decided: ["a:program"], winners: ["a:expire"] },
    { name: "the first answer wins over a second", records: [opened("a"), answered("a", "allow", "n1"), answered("a", "deny", "n2")], decided: ["a:phone:allow:allow"], winners: ["a:n1"] },
    { name: "the first answer wins over a later expire", records: [opened("a"), answered("a", "deny", "n1"), expired("a")], decided: ["a:phone:deny:deny"], winners: ["a:n1"] },
    { name: "the first expire wins over a later answer", records: [opened("a"), expired("a"), answered("a", "allow", "n1")], decided: ["a:timeout"], winners: ["a:expire"] },
    { name: "two answers at once: the one earlier in the stream wins, not the one with the earlier stamp", records: [opened("a"), answered("a", "deny", "late", "2026-10-21T10:03:00.000Z"), answered("a", "allow", "early", "2026-10-21T10:00:30.000Z")], decided: ["a:phone:deny:deny"], winners: ["a:late"] },
    { name: "an ask after its terminal record is ignored, and stays decided", records: [opened("a"), answered("a", "allow", "n1"), opened("a")], decided: ["a:phone:allow:allow"], winners: ["a:n1"] },
    { name: "a terminal record before any ask decides the id and the ask never opens", records: [expired("a"), opened("a")], decided: ["a:timeout"], winners: ["a:expire"] },
    { name: "an answer with no ask record still decides, without an effect", records: [answered("a", "allow", "n1")], decided: ["a:phone:allow"], winners: ["a:n1"] },
    { name: "a second ask record of an open id is ignored: the first fixes the text and the expiry", records: [opened("a", { expiresAt: "2026-10-21T10:05:00.000Z" }), opened("a", { expiresAt: "2026-10-21T11:00:00.000Z", argsHash: "other" })], open: ["a"] },
    { name: "asks are independent", records: [opened("a"), opened("b"), answered("b", "allow", "n1"), opened("c"), expired("a")], open: ["c"], decided: ["b:phone:allow:allow", "a:timeout"], winners: ["b:n1", "a:expire"] },
    { name: "a text answer has no option and no effect", records: [opened("a", { ask: ask("a", { kind: "text", options: [] }) }), { ...answered("a", "x", "n1"), answer: { text: "hello" } }], decided: ["a:phone"], winners: ["a:n1"] },
    { name: "a pending receipt is pending", records: [receipt("pending", "r1")], receipts: ["r1:pending"] },
    { name: "a done receipt closes its pending", records: [receipt("pending", "r1"), receipt("done", "r1", "d1", { ok: true })], receipts: ["r1:done"] },
    { name: "a done receipt of another digest does not close the pending", records: [receipt("pending", "r1", "d1"), receipt("done", "r1", "d2", { ok: true })], receipts: ["r1:pending"] },
    { name: "a done with no pending stands", records: [receipt("done", "r1", "d1", { ok: true })], receipts: ["r1:done"] },
    { name: "a pending after the done is ignored", records: [receipt("pending", "r1"), receipt("done", "r1", "d1", { ok: true }), receipt("pending", "r1")], receipts: ["r1:done"] },
    { name: "receipts of different ids stay apart", records: [receipt("pending", "r1"), receipt("pending", "r2"), receipt("done", "r2", "d1", { ok: true })], receipts: ["r1:pending", "r2:done"] },
    { name: "records of the three kinds fold side by side", records: [opened("a"), receipt("pending", "r1"), answered("a", "allow", "n1"), receipt("done", "r1", "d1", { result: "taken" })], decided: ["a:phone:allow:allow"], winners: ["a:n1"], receipts: ["r1:done"] },
  ];
  for (const row of table) {
    test(row.name, () => {
      expect(shape(row.records)).toEqual({ open: row.open ?? [], decided: row.decided ?? [], winners: row.winners ?? [], receipts: row.receipts ?? [] });
    });
  }

  test("an open ask comes back without its tag, with every field of its record", () => {
    const record = opened("a", { expiresAt: "2026-10-21T10:05:00.000Z", argsHash: "abc" });
    const [open] = foldJournal([record]).open;
    expect(open).toEqual({ askId: "a", toolCallId: "call-a", argsHash: "abc", ask: ask("a"), openedAt: "2026-10-21T10:00:00.000Z", expiresAt: "2026-10-21T10:05:00.000Z" });
    expect(open).not.toHaveProperty("t");
  });

  test("a done receipt keeps its reply, its group and its digest", () => {
    const f = foldJournal([receipt("pending", "r1"), receipt("done", "r1", "d1", { result: "taken" })]);
    expect(f.receipts.get("r1")).toEqual({ phase: "done", group: "p1", requestId: "r1", digest: "d1", reply: { result: "taken" }, at: "2026-10-21T10:02:00.000Z" });
  });

  test("the fold is pure: the same records fold to the same state, and the input is left alone", () => {
    const records: JournalRecord[] = [opened("a"), answered("a", "allow", "n1"), receipt("pending", "r1")];
    const copy = structuredClone(records);
    expect(shape(records)).toEqual(shape(records));
    expect(records).toEqual(copy);
  });

  test("a prefix of the stream folds to the state the writer saw at that point", () => {
    const records: JournalRecord[] = [opened("a"), opened("b"), answered("a", "allow", "n1"), expired("b")];
    expect(shape(records.slice(0, 2)).open).toEqual(["a", "b"]);
    expect(shape(records.slice(0, 3)).open).toEqual(["b"]);
    expect(shape(records).open).toEqual([]);
  });
});
