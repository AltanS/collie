import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { memoryHillReceipts, type HillReceiptSurface } from "./hill/receipts.ts";
import { readAnswerRequest } from "./hill/parse.ts";
import { HillService, type HillAgentSender, type HillDelivery, type HillPlace } from "./hill/service.ts";
import { HillStore } from "./hill/store.ts";
import { HILL_RID_REUSED, HILL_UNSAVED_TEXT, hillAnswerRoute, hillListRoute } from "./server.ts";
import { parseJsonObject, type JsonObject } from "../web/src/lib/json.ts";
import type { HillDecision, HillPostInput } from "../web/src/lib/hill/wire.ts";
import { apiErrorStatus, fetchHill, postHillAnswer } from "../web/src/lib/api.ts";

// THE HILL'S TWO HALVES, ASKED OF EACH OTHER (M96).
//
// The phone's reader and its answer call were written against fixtures, and the bridge's routes
// against the bridge's own tests. This file serves a REAL `HillService` through the REAL routes
// (`hillListRoute`, `hillAnswerRoute`) to the phone's REAL `fetchHill` and `postHillAnswer`, so a field
// the reader drops, a body the bridge refuses or a status the phone reads wrong fails here. It imports
// across the boundary on purpose, as `machines-web-contract.test.ts` does.

// The phone's transport reads the mount off the page's `<meta>` and the device token out of
// `localStorage`. There is no page here: a root mount and no token is what a bare bridge sees.
Object.defineProperty(globalThis, "document", { value: { querySelector: () => null }, configurable: true });
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "__BUILD_INFO__", { value: { version: "0.0.0", channel: "dev" }, configurable: true });

const POSTER: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "desk" };
const PLACES: HillPlace[] = [{ address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false }];
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Rig {
  readonly hill: HillService;
  readonly typed: string[];
  readonly bodies: (JsonObject | undefined)[];
}

function rig(receipts: HillReceiptSurface = memoryHillReceipts()): Rig {
  let n = 0;
  const typed: string[] = [];
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts,
    place: (address) => PLACES.find((place) => place.address === address) ?? null,
    send: async (_to, body): Promise<HillDelivery> => {
      typed.push(body);
      return "typed";
    },
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: null,
    machine: "desk",
    now: () => 1000,
    mintId: () => `dc_test${String((n += 1)).padStart(8, "0")}`,
  });
  return { hill, typed, bodies: [] };
}

const WITH_OPTIONS: HillPostInput = {
  requestId: uuid(1),
  title: "Ship the zoom fix in 1.28.1?",
  summary: "The pill moves out of Chat. The leg is green.",
  body: "Longer detail the card folds away.",
  options: [
    { intent: "yes", label: "Yes, Edge first", detail: "Edge users find it in a day." },
    { intent: "reset", label: "Reset to main", confirm: "Reset now" },
    { intent: "no", label: "No, wait for 1.29.0" },
  ],
  recommends: { intent: "yes", why: "Edge users find it in a day." },
  links: [{ label: "The PR", href: "https://github.com/AltanS/collie/pull/1" }],
  priority: "today",
};
const TEXT_ONLY: HillPostInput = { requestId: uuid(2), title: "What should the card say?", summary: "Words only.", options: [], text: "required" };

function posted(r: Rig, input: HillPostInput): HillDecision {
  const answer = r.hill.post(POSTER, input);
  if (!answer.ok) throw new Error(`refused: ${answer.code ?? "-"} ${answer.error}`);
  return answer.decision;
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
});

/** The phone asks, the bridge's route handlers answer. Every POST body the phone sent is kept in `r.bodies`. */
function serve(r: Rig): void {
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://bridge.test");
        if (url.pathname === "/api/hill") return hillListRoute(r.hill, url.searchParams.get("since"), null);
        if (url.pathname === "/api/hill/answer") {
          const body = parseJsonObject(await new Request(url, init).text());
          r.bodies.push(body);
          return hillAnswerRoute(r.hill, body, { device: "Pixel 9", acceptEncoding: null });
        }
        return new Response("not found", { status: 404 });
      },
      // Bun's `fetch` type carries `preconnect`; a stand-in has nothing to connect to.
      { preconnect: () => {} },
    ),
  );
}

/** The status and message the phone reads off a call that threw, or `undefined` when it did not throw. */
async function failureOf<T>(call: Promise<T>): Promise<{ status: number | undefined; message: string } | undefined> {
  try {
    await call;
    return undefined;
  } catch (thrown) {
    return { status: apiErrorStatus(thrown), message: thrown instanceof Error ? thrown.message : "" };
  }
}

const ask = (id: string, rid: string, intent: string, text: string | null) => ({ rid, node: `hill/${id}`, intent, value: { text } });

describe("the phone's reader reads the bridge's real list", () => {
  test("every decision survives with its ids, states and answer, and the options keep their parts", async () => {
    const r = rig();
    serve(r);
    const withOptions = posted(r, WITH_OPTIONS);
    const textOnly = posted(r, TEXT_ONLY);
    const answered = posted(r, { ...WITH_OPTIONS, requestId: uuid(3), title: "Second?" });
    await postHillAnswer(ask(answered.id, uuid(10), "no", null));

    const wire = r.hill.list();
    // The bytes the route puts on the wire, not the object in memory.
    expect(JSON.parse(JSON.stringify(wire)).open).toHaveLength(2);
    const phone = await fetchHill();

    expect(phone.rev).toBe(wire.rev);
    expect(phone.open.map((d) => [d.id, d.state])).toEqual([[withOptions.id, "open"], [textOnly.id, "open"]]);
    expect(phone.closed.map((d) => [d.id, d.state])).toEqual([[answered.id, "answered"]]);
    expect(phone.open).toEqual(wire.open);
    expect(phone.closed).toEqual(wire.closed);
    expect(phone.closed[0]!.answer).toMatchObject({ rid: uuid(10), intent: "no", label: "No, wait for 1.29.0", text: null, by: "Pixel 9", delivery: "typed" });
    const first = phone.open[0]!;
    expect(first.options.map((o) => [o.intent, o.confirm ?? null])).toEqual([["yes", null], ["reset", "Reset now"], ["no", null]]);
    expect(first.recommends).toEqual({ intent: "yes", why: "Edge users find it in a day." });
    expect(first.links).toEqual([{ label: "The PR", href: "https://github.com/AltanS/collie/pull/1" }]);
    expect(phone.open[1]).toMatchObject({ options: [], text: "required" });
  });

  test("a read with the held revision is the bridge's `unchanged`, and the phone reads it as one", async () => {
    const r = rig();
    serve(r);
    posted(r, TEXT_ONLY);
    const whole = await fetchHill();
    expect(await fetchHill(whole.rev)).toEqual({ rev: whole.rev, unchanged: true, open: [], closed: [] });
  });
});

describe("the bridge reads the bodies the phone builds", () => {
  test("an option tap, a text-only answer and a dismiss all parse, and each is answered", async () => {
    const r = rig();
    serve(r);
    const withOptions = posted(r, WITH_OPTIONS);
    const textOnly = posted(r, TEXT_ONLY);
    const dismissed = posted(r, { ...WITH_OPTIONS, requestId: uuid(3), title: "Third?" });

    const tap = await postHillAnswer(ask(withOptions.id, uuid(11), "yes", "after the leg"));
    const words = await postHillAnswer(ask(textOnly.id, uuid(12), "answer", "Say what it does."));
    const dismiss = await postHillAnswer(ask(dismissed.id, uuid(13), "dismiss", null));

    expect(r.bodies).toHaveLength(3);
    for (const body of r.bodies) expect(readAnswerRequest(body)).toMatchObject({ ok: true });
    expect(tap).toMatchObject({ rid: uuid(11), code: "ok", state: "answered", delivery: "typed" });
    expect(words).toMatchObject({ rid: uuid(12), code: "ok", state: "answered", delivery: "typed" });
    expect(dismiss).toMatchObject({ rid: uuid(13), code: "ok", state: "dismissed" });
    expect(r.bodies[2]).toMatchObject({ intent: "dismiss", value: { text: null } });
  });

  test("a dismiss that carried text would be refused; that is why the card sends null", async () => {
    const r = rig();
    serve(r);
    const decision = posted(r, WITH_OPTIONS);
    expect(await postHillAnswer(ask(decision.id, uuid(14), "dismiss", "never mind"))).toMatchObject({ code: "rejected", reason: "a dismiss carries no text" });
  });
});

describe("the phone reads the bridge's refusals", () => {
  test("a 400 says the bridge's plain words as the reason, and it is not an answer", async () => {
    const r = rig();
    serve(r);
    const decision = posted(r, WITH_OPTIONS);
    const receipt = await postHillAnswer(ask(decision.id, uuid(15), "x".repeat(40), null));
    expect(receipt).toMatchObject({ rid: uuid(15), code: "rejected", reason: "bad intent", state: null, delivery: null });
    expect(r.typed).toEqual([]);
  });

  test("a 409 reads as a rejected receipt with the bridge's words, never as sent", async () => {
    const r = rig();
    serve(r);
    const decision = posted(r, WITH_OPTIONS);
    await postHillAnswer(ask(decision.id, uuid(16), "yes", null));
    const reused = await postHillAnswer(ask(decision.id, uuid(16), "no", null));
    expect(reused).toMatchObject({ rid: uuid(16), code: "rejected", reason: HILL_RID_REUSED, state: null, delivery: null });
    expect(r.typed).toHaveLength(1);
  });

  test("a 503 throws like a lost answer: no receipt, so the card says not sent and retries the same rid", async () => {
    const failing: HillReceiptSurface = { ...memoryHillReceipts(), recordFirst: async () => false };
    const r = rig(failing);
    serve(r);
    const decision = posted(r, WITH_OPTIONS);
    const failure = await failureOf(postHillAnswer(ask(decision.id, uuid(17), "yes", null)));
    expect(failure).toEqual({ status: 503, message: expect.stringContaining(HILL_UNSAVED_TEXT) });
    expect(r.typed).toEqual([]);
    expect(r.hill.list().open.map((d) => d.id)).toEqual([decision.id]);
  });
});
