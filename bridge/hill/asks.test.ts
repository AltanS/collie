import { describe, expect, test } from "bun:test";

import { HILL_ASK_ANSWERED_HERE, HILL_MORE_CONTEXT, HILL_MORE_CONTEXT_LABEL, askTakenBack, type HillAnswerRequest, type HillDecision } from "../../web/src/lib/hill/wire.ts";
import { ASKS_ANSWERS_SUBJECT } from "../../web/src/lib/hill/answers-message.ts";
import { askInput, askRig, ONE, posted, TWO, uuid } from "./ask-rig.ts";
import { ASK_FILES_LEAD_ONLY, type HillPostAnswer } from "./service.ts";

// Asks (2026-11-22): a Decision with the `ask` field, from `collie walky ask`. These cases cover the
// post's rules, the open cap, `--replaces`, the take back, the single answer, and what an ask is spared
// (no end by age, no quiet mark). The one Send of many answers is in asks-send.test.ts.

function refused(answer: HillPostAnswer) {
  if (answer.ok) throw new Error("posted");
  return answer;
}

function answerOf(decision: HillDecision, rid: number, intent: string, text: string | null = null): HillAnswerRequest {
  return { rid: uuid(rid), node: `hill/${decision.id}`, intent, value: { text } };
}

describe("posting an ask", () => {
  test("is a Decision with an ak_ id, no end, priority today, no push, and an optional note", () => {
    const r = askRig();
    const ask = posted(r.hill.post(ONE, askInput(1)));
    expect(ask.id).toMatch(/^ak_[a-z0-9]{12}$/);
    expect(ask).toMatchObject({ state: "open", expiresAt: null, priority: "today", priorityAsked: "today", text: "optional", ask: { words: false, files: [], root: null } });
    expect(ask.pushTag).toBeUndefined();
    expect(r.pushed).toBe(0);
    expect(ask.spokeAfter).toBeUndefined();
  });

  test("a --words ask takes the words, required, and no options", () => {
    const r = askRig();
    const ask = posted(r.hill.post(ONE, askInput(1, { options: [], recommends: null, ask: { words: true, files: [] } })));
    expect(ask).toMatchObject({ text: "required", options: [], ask: { words: true } });
    expect(refused(r.hill.post(ONE, askInput(2, { ask: { words: true, files: [] } }))).error).toContain("--words takes no --option");
  });

  test("the rules of an ask: the question, the options, the labels, the details, the lengths", () => {
    const r = askRig();
    expect(refused(r.hill.post(ONE, askInput(1, { title: "Ship it." }))).error).toContain('end with "?"');
    expect(refused(r.hill.post(ONE, askInput(2, { title: `${"x".repeat(90)}?` }))).error).toContain("90");
    expect(refused(r.hill.post(ONE, askInput(3, { summary: "x".repeat(241) }))).error).toContain("240");
    expect(refused(r.hill.post(ONE, askInput(4, { body: "x".repeat(20_001) }))).error).toContain("20000");
    posted(r.hill.post(ONE, askInput(5, { body: "x".repeat(20_000) })));
    const one = [{ intent: "edge", label: "Ship it on Edge first", detail: "Testers get it." }];
    expect(refused(r.hill.post(ONE, askInput(6, { options: one, recommends: null }))).error).toContain("2 to 5 times. You gave 1");
    const bare = [
      { intent: "yes", label: "Yes", detail: "It ships." },
      { intent: "no", label: "No", detail: "It waits." },
    ];
    expect(refused(r.hill.post(ONE, askInput(7, { options: bare, recommends: null }))).error).toContain('label "Yes" is not allowed');
    const bareDot = [
      { intent: "ok", label: "OK.", detail: "It ships." },
      { intent: "wait", label: "Wait a day", detail: "It waits." },
    ];
    expect(refused(r.hill.post(ONE, askInput(8, { options: bareDot, recommends: null }))).code).toBe("bad_option");
    const noDetail = [
      { intent: "edge", label: "Ship it on Edge first" },
      { intent: "stable", label: "Ship it on Stable now", detail: "Everyone." },
    ];
    expect(refused(r.hill.post(ONE, askInput(9, { options: noDetail }))).error).toContain("--does edge is required");
    const long = [
      { intent: "edge", label: "x".repeat(61), detail: "Testers." },
      { intent: "stable", label: "Ship it on Stable now", detail: "Everyone." },
    ];
    expect(refused(r.hill.post(ONE, askInput(10, { options: long, recommends: null }))).error).toContain("1 to 60");
    const longDoes = [
      { intent: "edge", label: "Ship it on Edge first", detail: "x".repeat(301) },
      { intent: "stable", label: "Ship it on Stable now", detail: "Everyone." },
    ];
    expect(refused(r.hill.post(ONE, askInput(11, { options: longDoes }))).error).toContain("300");
  });

  test("an ask carries no link, names no other session, and a --file needs a bridge that checks it", () => {
    const r = askRig();
    expect(refused(r.hill.post(ONE, askInput(1, { links: [{ label: "x", href: "https://example.com" }] }))).error).toContain("no links");
    expect(refused(r.hill.post(ONE, askInput(2, { replyTo: TWO.address }))).code).toBe("bad_target");
    expect(refused(r.hill.post(ONE, askInput(3, { ask: { words: false, files: [{ path: "/repo/a.md" }] } }))).error).toBe(ASK_FILES_LEAD_ONLY);
  });

  test("a repeat of the request id answers the same ask; another ask under it is refused", () => {
    const r = askRig();
    const first = posted(r.hill.post(ONE, askInput(1)));
    expect(posted(r.hill.post(ONE, askInput(1))).id).toBe(first.id);
    expect(refused(r.hill.post(ONE, askInput(1, { ask: { words: true, files: [] }, options: [], recommends: null }))).code).toBe("request_id_reused");
  });
});

describe("the open asks of a session", () => {
  test("at most five; the refusal lists them and says take one back or replace one", () => {
    const r = askRig();
    const five = [1, 2, 3, 4, 5].map((n) => posted(r.hill.post(ONE, askInput(n))));
    const sixth = refused(r.hill.post(ONE, askInput(6)));
    expect(sixth.code).toBe("too_many_open");
    for (const ask of five) expect(sixth.error).toContain(`${ask.id} "${ask.title}"`);
    expect(sixth.error).toContain("Take one back or replace one");
    // Another session has its own five; a plain Decision does not count against asks.
    posted(r.hill.post(TWO, askInput(7)));
    posted(r.hill.post(ONE, { requestId: uuid(8), title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    r.hill.withdraw(ONE, five[0]!.id);
    posted(r.hill.post(ONE, askInput(9)));
  });

  test("stay open when the person writes in the session, and keep no end across a restart", () => {
    const r = askRig();
    const ask = posted(r.hill.post(ONE, askInput(1)));
    const plain = posted(r.hill.post(ONE, { requestId: uuid(2), title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    r.clock = 5000;
    expect(r.hill.noteSpoke(ONE.address)).toBe(1);
    const open = r.hill.list().open;
    expect(open.find((d) => d.id === ask.id)?.spokeAfter).toBeUndefined();
    expect(open.find((d) => d.id === plain.id)?.spokeAfter).toBe(5000);
    expect(r.hill.clearSpoken().ok).toBe(true);
    expect(r.store.get(ask.id)?.state).toBe("open");
    // Far past any Decision's end, the sweep still leaves the ask.
    r.clock = 1000 + 400 * 24 * 3_600_000;
    r.hill.sweep();
    expect(r.store.get(ask.id)).toMatchObject({ state: "open", expiresAt: null });
  });

  test("the sweep closes an ask whose session is gone", () => {
    const r = askRig();
    const ask = posted(r.hill.post(ONE, askInput(1)));
    r.live.delete(ONE.address);
    r.hill.sweep();
    r.hill.sweep();
    expect(r.store.get(ask.id)?.state).toBe("undeliverable");
  });
});

describe("--replaces", () => {
  test("takes an open ask of the session, and closes it as superseded", () => {
    const r = askRig();
    const old = posted(r.hill.post(ONE, askInput(1)));
    const next = posted(r.hill.post(ONE, askInput(2, { supersedes: old.id })));
    expect(next.supersedes).toBe(old.id);
    expect(r.store.get(old.id)).toMatchObject({ state: "superseded", supersededBy: next.id });
  });

  test("takes an ask answered with more context: records it and closes nothing", async () => {
    const r = askRig();
    const old = posted(r.hill.post(ONE, askInput(1)));
    const outcome = await r.hill.answer(answerOf(old, 50, HILL_MORE_CONTEXT, "What is Edge?"), old.id, "Pixel 9");
    expect(outcome.kind).toBe("receipt");
    expect(r.store.get(old.id)).toMatchObject({ state: "answered", answer: { intent: HILL_MORE_CONTEXT, label: HILL_MORE_CONTEXT_LABEL, text: "What is Edge?" } });
    const next = posted(r.hill.post(ONE, askInput(2, { supersedes: old.id })));
    expect(next.supersedes).toBe(old.id);
    expect(r.store.get(old.id)).toMatchObject({ state: "answered", supersededBy: null });
  });

  test("refuses an ask of another session, a plain Decision, and an ask closed another way", async () => {
    const r = askRig();
    const theirs = posted(r.hill.post(TWO, askInput(1)));
    expect(refused(r.hill.post(ONE, askInput(2, { supersedes: theirs.id }))).error).toContain("no ask of this session");
    const plain = posted(r.hill.post(ONE, { requestId: uuid(3), title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    expect(refused(r.hill.post(ONE, askInput(4, { supersedes: plain.id }))).error).toContain("not an ask");
    const answered = posted(r.hill.post(ONE, askInput(5)));
    await r.hill.answer(answerOf(answered, 51, "edge"), answered.id, "Pixel 9");
    expect(refused(r.hill.post(ONE, askInput(6, { supersedes: answered.id }))).error).toContain('that ask is answered; it takes an open ask, or one answered with "I need more context"');
  });
});

describe("taking an ask back", () => {
  test("--answered closes it answered in the session; --because keeps the reason; a plain cancel is by the poster", () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const b = posted(r.hill.post(ONE, askInput(2)));
    const c = posted(r.hill.post(ONE, askInput(3)));
    expect(r.hill.cancelAsk(ONE, a.id, { answered: true, because: null })).toMatchObject({ ok: true, decision: { state: "withdrawn", closedReason: HILL_ASK_ANSWERED_HERE } });
    expect(r.hill.cancelAsk(ONE, b.id, { answered: false, because: "The test answers it." })).toMatchObject({ ok: true, decision: { closedReason: askTakenBack("The test answers it.") } });
    expect(r.hill.cancelAsk(ONE, c.id, { answered: false, because: null })).toMatchObject({ ok: true, decision: { closedReason: "by the poster" } });
    expect(r.sent).toHaveLength(0);
  });

  test("refuses both flags at once, a long reason, the flags on a plain Decision, and another session's ask", () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    expect(r.hill.cancelAsk(ONE, a.id, { answered: true, because: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("do not go together") });
    expect(r.hill.cancelAsk(ONE, a.id, { answered: false, because: "x".repeat(201) })).toMatchObject({ ok: false, error: expect.stringContaining("200") });
    const plain = posted(r.hill.post(ONE, { requestId: uuid(3), title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    expect(r.hill.cancelAsk(ONE, plain.id, { answered: true, because: null })).toMatchObject({ ok: false, error: expect.stringContaining("is not an ask") });
    expect(r.hill.cancelAsk(TWO, a.id, { answered: false, because: null })).toMatchObject({ ok: false, missing: true });
  });
});

describe("the single answer to an ask", () => {
  test("types the one-line form with the asks subject", async () => {
    const r = askRig();
    const ask = posted(r.hill.post(ONE, askInput(1)));
    const outcome = await r.hill.answer(answerOf(ask, 50, "stable", "The testers are away."), ask.id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok", state: "answered" } });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.subject).toBe(ASKS_ANSWERS_SUBJECT);
    expect(r.sent[0]!.body).toBe(`${ask.id} "${ask.title}": stable (Ship it on Stable now), not the recommended option. Note: The testers are away.`);
  });

  test("takes more context on a --words ask; refuses bare words on an ask with options", async () => {
    const r = askRig();
    const words = posted(r.hill.post(ONE, askInput(1, { options: [], recommends: null, ask: { words: true, files: [] } })));
    const more = await r.hill.answer(answerOf(words, 50, HILL_MORE_CONTEXT), words.id, "Pixel 9");
    expect(more).toMatchObject({ kind: "receipt", receipt: { code: "ok" } });
    expect(r.sent[0]!.body).toContain(`--replaces ${words.id}`);
    const options = posted(r.hill.post(ONE, askInput(2)));
    const bare = await r.hill.answer(answerOf(options, 51, "answer", "Ship it"), options.id, "Pixel 9");
    expect(bare).toMatchObject({ kind: "receipt", receipt: { code: "rejected", reason: "not an option of this decision" } });
    expect(r.store.get(options.id)?.state).toBe("open");
  });

  test("a plain Decision takes no more-context", async () => {
    const r = askRig();
    const plain = posted(r.hill.post(ONE, { requestId: uuid(3), title: "Plain?", summary: "A plain card.", options: [{ intent: "yes", label: "Yes" }], recommends: null }));
    const outcome = await r.hill.answer(answerOf(plain, 50, HILL_MORE_CONTEXT), plain.id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "rejected" } });
  });
});
