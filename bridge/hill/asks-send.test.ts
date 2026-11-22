import { describe, expect, test } from "bun:test";

import { ASKS_ANSWERS_SUBJECT, openLine } from "../../web/src/lib/hill/answers-message.ts";
import { HILL_MORE_CONTEXT, type HillAnswersRequest } from "../../web/src/lib/hill/wire.ts";
import { askAnswerRid } from "./answers.ts";
import { askInput, askRig, ONE, posted, TWO, uuid } from "./ask-rig.ts";

// One Send per session (`POST /api/hill/answers`, Asks 2026-11-22): many answers, one message, a receipt
// per ask, and a repeat of the Send's rid that runs nothing.

function send(rid: number, answers: HillAnswersRequest["answers"]): HillAnswersRequest {
  return { rid: uuid(rid), answers };
}

describe("one Send", () => {
  test("closes each ask as answered with its own receipt and types ONE message, the open ones last", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const b = posted(r.hill.post(ONE, askInput(2, { options: [], recommends: null, ask: { words: true, files: [] } })));
    const c = posted(r.hill.post(ONE, askInput(3)));
    const outcome = await r.hill.answerAsks(
      send(90, [
        { id: a.id, intent: "edge", text: null },
        { id: b.id, intent: "answer", text: "Lead with the phone." },
      ]),
      "Pixel 9",
    );
    expect(outcome).toMatchObject({ kind: "done", result: { rid: uuid(90), delivery: "typed", items: [{ id: a.id, code: "ok", state: "answered" }, { id: b.id, code: "ok", state: "answered" }] } });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ to: ONE.address, by: "Pixel 9", subject: ASKS_ANSWERS_SUBJECT });
    expect(r.sent[0]!.body.split("\n")).toEqual([`${a.id} "${a.title}": edge (Ship it on Edge first), as recommended.`, `${b.id} "${b.title}": Lead with the phone.`, openLine(c)]);
    expect(r.store.get(a.id)).toMatchObject({ state: "answered", answer: { intent: "edge", rid: askAnswerRid(uuid(90), a.id), delivery: "typed" } });
    expect(r.store.get(b.id)).toMatchObject({ state: "answered", answer: { intent: "answer", text: "Lead with the phone." } });
    expect(r.store.get(c.id)?.state).toBe("open");
  });

  test("a repeat of the rid answers the stored result and types nothing; other answers under it are refused", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const first = await r.hill.answerAsks(send(90, [{ id: a.id, intent: "edge", text: null }]), "Pixel 9");
    const again = await r.hill.answerAsks(send(90, [{ id: a.id, intent: "edge", text: null }]), "Pixel 9");
    expect(again).toEqual(first);
    expect(r.sent).toHaveLength(1);
    expect(await r.hill.answerAsks(send(90, [{ id: a.id, intent: "stable", text: null }]), "Pixel 9")).toMatchObject({ kind: "refused", refusal: { code: "rid_reused" } });
    // Two at once with one rid: one runs, the other joins it.
    const b = posted(r.hill.post(ONE, askInput(2)));
    const [x, y] = await Promise.all([r.hill.answerAsks(send(91, [{ id: b.id, intent: "edge", text: null }]), "Pixel 9"), r.hill.answerAsks(send(91, [{ id: b.id, intent: "edge", text: null }]), "Pixel 9")]);
    expect(x).toEqual(y);
    expect(r.sent).toHaveLength(2);
  });

  test("an ask closed before the Send is skipped and reported; with none left, nothing is typed", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const b = posted(r.hill.post(ONE, askInput(2)));
    r.hill.withdraw(ONE, a.id);
    const outcome = await r.hill.answerAsks(
      send(90, [
        { id: a.id, intent: "edge", text: null },
        { id: b.id, intent: HILL_MORE_CONTEXT, text: "What is Edge?" },
      ]),
      "Pixel 9",
    );
    expect(outcome).toMatchObject({ kind: "done", result: { items: [{ id: a.id, code: "gone", state: "withdrawn" }, { id: b.id, code: "ok" }] } });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.body).not.toContain(a.id);
    const none = await r.hill.answerAsks(send(91, [{ id: a.id, intent: "edge", text: null }]), "Pixel 9");
    expect(none).toMatchObject({ kind: "done", result: { delivery: "none", items: [{ id: a.id, code: "gone" }] } });
    expect(r.sent).toHaveLength(1);
  });

  test("too long: 409 too_long with how far over, and nothing is closed", async () => {
    const r = askRig();
    const asks = [1, 2].map((n) => posted(r.hill.post(ONE, askInput(n))));
    const note = "x".repeat(2000);
    const outcome = await r.hill.answerAsks(
      send(
        90,
        asks.map((ask) => ({ id: ask.id, intent: "edge", text: note })),
      ),
      "Pixel 9",
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("not refused");
    expect(outcome.refusal.code).toBe("too_long");
    expect(outcome.refusal.over).toBeGreaterThan(0);
    expect(outcome.refusal.error).toContain(`${String(outcome.refusal.over)} characters longer`);
    for (const ask of asks) expect(r.store.get(ask.id)?.state).toBe("open");
    expect(r.sent).toHaveLength(0);
  });

  test("refuses the asks of two sessions, a plain Decision, an unknown id and an answer that does not fit", async () => {
    const r = askRig();
    const mine = posted(r.hill.post(ONE, askInput(1)));
    const theirs = posted(r.hill.post(TWO, askInput(2)));
    const plain = posted(r.hill.post(ONE, { requestId: uuid(3), title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    const two = await r.hill.answerAsks(
      send(90, [
        { id: mine.id, intent: "edge", text: null },
        { id: theirs.id, intent: "edge", text: null },
      ]),
      "Pixel 9",
    );
    expect(two).toMatchObject({ kind: "refused", refusal: { code: "mixed_sessions" } });
    expect(await r.hill.answerAsks(send(91, [{ id: plain.id, intent: "yes", text: null }]), "Pixel 9")).toMatchObject({ kind: "refused", refusal: { code: "not_an_ask", id: plain.id } });
    expect(await r.hill.answerAsks(send(92, [{ id: "ak_000000000000", intent: "edge", text: null }]), "Pixel 9")).toMatchObject({ kind: "refused", refusal: { code: "not_an_ask" } });
    expect(await r.hill.answerAsks(send(93, [{ id: mine.id, intent: "answer", text: "x" }]), "Pixel 9")).toMatchObject({ kind: "refused", refusal: { code: "bad_answer", id: mine.id } });
    expect(r.store.get(mine.id)?.state).toBe("open");
    expect(r.store.get(theirs.id)?.state).toBe("open");
    expect(r.sent).toHaveLength(0);
  });

  test("a refused send opens every ask again and says not typed; a held one answers delivery unknown", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    r.delivery = "refused";
    expect(await r.hill.answerAsks(send(90, [{ id: a.id, intent: "edge", text: null }]), "Pixel 9")).toMatchObject({ kind: "refused", refusal: { code: "not_typed" } });
    expect(r.store.get(a.id)).toMatchObject({ state: "open", answer: null });
    r.delivery = "inbox-only";
    expect(await r.hill.answerAsks(send(91, [{ id: a.id, intent: "edge", text: null }]), "Pixel 9")).toMatchObject({ kind: "done", result: { delivery: "unknown" } });
    expect(r.store.get(a.id)).toMatchObject({ state: "answered", answer: { delivery: "unknown" } });
  });

  test("a session that ended closes its asks undeliverable and types nothing", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    r.live.delete(ONE.address);
    const outcome = await r.hill.answerAsks(send(90, [{ id: a.id, intent: "edge", text: null }]), "Pixel 9");
    expect(outcome).toMatchObject({ kind: "done", result: { delivery: "none", items: [{ id: a.id, code: "gone", state: "undeliverable" }] } });
    expect(r.sent).toHaveLength(0);
  });
});
