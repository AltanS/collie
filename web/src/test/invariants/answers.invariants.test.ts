// M102 spec 15, part 1b: EVERY bridge answer through the phone's request layer, for each request a
// person's tap makes (a send, an answer to an ask, the hook hold card's answer, raw keys, Stop, Clear).
// The answers are generated: each outcome and reason from the product's own closed lists, the HTTP
// statuses 400, 404, 409, 500, 502, 503 and 504 (with a JSON body and with a proxy's HTML page), a
// time-out, an abort, a dropped link, a body that is not JSON, and a body shaped by an older or a
// newer bridge (fields missing, unknown fields).
//
//   I2  each call ends: it resolves to a value or throws an Error (never anything else, never hangs),
//       every request carries an abort signal (so a silent bridge ends in the 20 s budget), and every
//       ending has words a person can read (no HTML page, no JSON, no route path), or is the success
//       that clears the control.
//
// fetch is stubbed per case, so nothing reaches msw or a network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerSentence, clearNotice, readingRefusal, stopNotice } from "@/components/send-notice";
import { abortPane, clearPane, sendKeys } from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { answerAsk } from "@/lib/dialog-ask";
import { markLive, resetLiveness } from "@/lib/liveness";
import { sendText } from "@/lib/reply-action";
import { ASK_OUTCOMES, ASK_REASONS } from "@/lib/surface/ask";
import { CLEAR_OUTCOMES, CLEAR_REASONS } from "@/lib/surface/clear";
import { SEND_OUTCOMES, SEND_REASONS } from "@/lib/surface/send";
import { STOP_OUTCOMES, STOP_REASONS } from "@/lib/surface/stop";
import type { JsonObject } from "@/lib/json";
import type { Ask } from "@/lib/surface/surface";

import { commonAnswers, json, type Answer } from "./bridge-answers";
import { replayHint, rngOf, runSeeds, sample } from "./seed";

const PANE = "inv:p1";
/** An object with the reason added when there is one. */
function reasoned(base: JsonObject, reason: string | undefined): JsonObject {
  const out: JsonObject = { ...base };
  if (reason !== undefined) out.reason = reason;
  return out;
}

function withReasons<O extends string, R extends string>(outcomes: readonly O[], reasons: readonly R[], body: (outcome: O, reason: R | undefined) => JsonObject): Answer[] {
  const out: Answer[] = [];
  for (const outcome of outcomes) {
    for (const reason of [undefined, ...reasons]) {
      out.push({ kind: "status", status: 200, body: json(body(outcome, reason)), label: `200 ${outcome}(${reason ?? "-"})` });
      // The same answer from a newer bridge: one unknown field more.
      out.push({ kind: "status", status: 200, body: json({ ...body(outcome, reason), fromTheFuture: { x: 1 } }), label: `200 ${outcome}(${reason ?? "-"}) + unknown field` });
    }
  }
  return out;
}

const SEND_ANSWERS: readonly Answer[] = [
  ...withReasons(SEND_OUTCOMES, SEND_REASONS, (outcome, reason) => ({ offers: [], receipt: reasoned({ requestId: "x", outcome, keys: [] }, reason) })),
  { kind: "status", status: 200, body: json({ offers: [] }), label: "200 no receipt (older bridge)" },
  { kind: "status", status: 200, body: json({ receipt: { requestId: "x", outcome: "a_new_outcome", keys: [] }, offers: [] }), label: "200 unknown outcome (newer bridge)" },
  ...commonAnswers(),
];
const ASK_ANSWERS: readonly Answer[] = [
  ...withReasons(ASK_OUTCOMES, ASK_REASONS, (outcome, reason) => ({ receipt: reasoned({ outcome }, reason) })),
  { kind: "status", status: 200, body: json({ receipt: { outcome: "a_new_outcome" } }), label: "200 unknown outcome (newer bridge)" },
  ...commonAnswers(),
];
const STOP_ANSWERS: readonly Answer[] = [
  ...withReasons(STOP_OUTCOMES, STOP_REASONS, (outcome, reason) => reasoned({ requestId: "x", outcome, keys: [] }, reason)),
  ...commonAnswers(),
];
const CLEAR_ANSWERS: readonly Answer[] = [
  ...withReasons(CLEAR_OUTCOMES, CLEAR_REASONS, (outcome, reason) => reasoned({ requestId: "x", outcome, keys: [] }, reason)),
  ...commonAnswers(),
];
const KEYS_ANSWERS: readonly Answer[] = [
  { kind: "status", status: 200, body: json({ ok: true }), label: "200 ok" },
  { kind: "status", status: 200, body: json({ ok: false, error: "refused", code: "prompt_changed" }), label: "200 ok:false" },
  { kind: "status", status: 409, body: json({ ok: false, error: "The dialog changed.", code: "prompt_changed" }), label: "409 prompt_changed" },
  ...commonAnswers(),
];

let seenSignals: (AbortSignal | null | undefined)[] = [];

function stubFetch(answer: Answer): void {
  seenSignals = [];
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    seenSignals.push(init?.signal);
    if (answer.kind === "throw") return Promise.reject(answer.error());
    const headers = { "content-type": answer.body.startsWith("<") ? "text/html" : "application/json" };
    return Promise.resolve(new Response(answer.status === 204 ? null : answer.body, { status: answer.status, headers }));
  });
}

beforeEach(() => {
  resetLiveness();
  markLive(PANE, Date.now() - 200);
});
afterEach(() => vi.unstubAllGlobals());

/** Words a person can read: not empty, no HTML page, no JSON, no route path. */
function unreadable(words: string): string | null {
  const w = words.trim();
  if (w === "") return "no words";
  if (/<\/?[a-z][^>]*>/iu.test(w)) return `an HTML page as words: ${w.slice(0, 80)}`;
  if (w.startsWith("{") || w.startsWith("[")) return `JSON as words: ${w.slice(0, 80)}`;
  if (/\/api\//u.test(w)) return `a route path as words: ${w.slice(0, 80)}`;
  return null;
}

/** How one call ended: a value with its words, or a throw with its words. */
type Ending = { readonly ok: true; readonly words: string | null } | { readonly ok: false; readonly thrown: unknown };

interface Route {
  readonly name: string;
  readonly answers: readonly Answer[];
  /** The call and the words its value gets at the thumb; null words is the success that clears the control. */
  readonly call: () => Promise<string | null>;
  /** The function says "Never throws": its callers do not catch, so a throw is an unhandled tap. */
  readonly neverThrows?: true;
}

const ASK: Ask = { id: "ask-1", kind: "permission", channel: "hook", options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], hash: "h1" };

const ROUTES: readonly Route[] = [
  {
    name: "send (sendText)",
    answers: SEND_ANSWERS,
    neverThrows: true,
    call: async () => {
      const out = await sendText({ paneId: PANE, text: "carry on please", held: null, mint: () => "req-inv-1" });
      if (out.status === "answered") return out.reading.clear ? null : readingRefusal(out.reading).sentence || answerSentence(out.reading);
      return out.error;
    },
  },
  {
    name: "ask answer (answerAsk)",
    answers: ASK_ANSWERS,
    neverThrows: true,
    call: async () => {
      const r = await answerAsk({ paneId: PANE, ask: ASK, tap: { card: "prompt-select", index: 0, label: "Yes" } });
      // settleAskTap (agent-chat.tsx) gives each status a fixed sentence; only `error` carries its own.
      return r.status === "sent" ? null : r.status === "error" ? r.error : r.status;
    },
  },
  {
    name: "hook hold card answer (answerAsk via hold-card)",
    answers: ASK_ANSWERS,
    neverThrows: true,
    call: async () => {
      const r = await answerAsk({ paneId: PANE, ask: ASK, tap: { card: "prompt-select", index: 1, label: "No" }, via: "hold-card" });
      return r.status === "sent" ? null : r.status === "error" ? r.error : r.status;
    },
  },
  {
    name: "raw keys (sendKeys)",
    answers: KEYS_ANSWERS,
    call: async () => {
      const res = await sendKeys(PANE, ["Enter"]);
      return res.ok ? null : describeApiError(res);
    },
  },
  {
    name: "Stop (abortPane)",
    answers: STOP_ANSWERS,
    call: async () => stopNotice(await abortPane(PANE, { requestId: "req-inv-stop" })).sentence,
  },
  {
    name: "Clear (clearPane)",
    answers: CLEAR_ANSWERS,
    call: async () => clearNotice(await clearPane(PANE, { requestId: "req-inv-clear" })).sentence,
  },
];

async function endingOf(route: Route): Promise<Ending> {
  try {
    return { ok: true, words: await route.call() };
  } catch (thrown) {
    return { ok: false, thrown };
  }
}

/** What breaks I2 in one ending, or null. */
function breakOf(ending: Ending): string | null {
  if (ending.ok) return ending.words === null ? null : unreadable(ending.words);
  // A fetch time-out or abort rejects with a DOMException; the callers catch it and describe it, so only the words count.
  return unreadable(describeThrownError(ending.thrown));
}

const SEEDS = runSeeds();

describe("M102-15 part 1b, every bridge answer through the phone's request layer", () => {
  for (const route of ROUTES) {
    it(`I2: ${route.name} carries an abort signal on its request, so a silent bridge ends`, async () => {
      stubFetch({ kind: "status", status: 200, body: "{}", label: "probe" });
      await endingOf(route);
      expect(seenSignals.length).toBeGreaterThan(0);
      expect(seenSignals.every((s) => s instanceof AbortSignal)).toBe(true);
    });

    it(`I2: ${route.name} ends with readable words or a success on every answer (${String(route.answers.length)} answers)`, async () => {
      const found: string[] = [];
      for (const answer of route.answers) {
        stubFetch(answer);
        const ending = await endingOf(route);
        if (route.neverThrows === true && !ending.ok) found.push(`${answer.label}: threw, though it says it never throws`);
        const why = breakOf(ending);
        if (why !== null) found.push(`${answer.label}: ${why}`);
      }
      expect.soft(found.filter((line) => !line.includes("HTML page") && !line.includes("route path") && !line.includes("JSON as words"))).toEqual([]);
    });
  }

  // A proxy's error page or the route's path in the words: they reach the thumb as the error sentence.
  it(`I2: no ending puts a proxy's HTML page, a route path or raw JSON at the thumb`, async () => {
    const found: string[] = [];
    for (const route of ROUTES) {
      for (const answer of route.answers) {
        stubFetch(answer);
        const why = breakOf(await endingOf(route));
        if (why !== null) found.push(`${route.name} ${answer.label}: ${why}`);
      }
    }
    const perRoute = ROUTES.map((route) => `${route.name}=${String(found.filter((line) => line.startsWith(route.name)).length)}`).join(" ");
    console.info(`[invariants.answers] i2-words-raw: ${String(found.length)} endings (${perRoute}); first: ${found[0] ?? "-"}`);
    expect(found).toEqual([]);
  });

  // The seeded order: the same answers in another order on one route, so no answer depends on the one before it.
  for (const seed of SEEDS) {
    it(`I2: answers in a seeded order end the same (${replayHint(seed, "send order")})`, async () => {
      const route = ROUTES[0];
      if (route === undefined) throw new Error("no route");
      const picked = sample(route.answers, 12, rngOf(seed));
      for (const answer of picked) {
        stubFetch(answer);
        const ending = await endingOf(route);
        // sendText says it never throws: whatever came before, this answer ends in a value.
        expect(ending.ok).toBe(true);
      }
    });
  }
});
