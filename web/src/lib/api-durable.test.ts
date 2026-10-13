import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import type { JsonValue } from "./json";
import { abortPane, answerAsk, sendToPane } from "./api";

// The three writes of a pane with no screen, against a stubbed bridge: what each carries, and how
// each answer reads (ADR 0100, ADR 0101). The old-peer 404 is `stale`, as the Chat read has it.

const ID = "11111111-1111-4111-8111-111111111111";
const ASK = { requestId: ID, askId: "a1", revision: 2, optionId: "yes" };

describe("answerAsk", () => {
  it("posts the ask, the revision, the option and the request id", async () => {
    let body: JsonValue | undefined;
    server.use(
      http.post<never, JsonValue>(/\/api\/pane\/c1\/answer$/, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, outcome: "taken" });
      }),
    );
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "taken" });
    expect(body).toEqual(ASK);
  });

  it("reads a replayed answer", async () => {
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: true, outcome: "taken", replayed: true })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "taken", replayed: true });
  });

  it("reads a 404 as stale on an older machine", async () => {
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ error: "not found" }, { status: 404 })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "stale", older: true });
  });

  it("reads a stale body without an ask, and a 504 as unknown", async () => {
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: false, outcome: "stale" }, { status: 409 })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "stale" });
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: false, outcome: "unknown", detail: "x" }, { status: 504 })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "unknown" });
  });

  it("reads maybe-applied at 200, and a reused request id as a refusal with the bridge's words", async () => {
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: false, outcome: "maybe-applied" })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "maybe-applied" });
    server.use(
      http.post(/\/api\/pane\/c1\/answer$/, () =>
        HttpResponse.json({ ok: false, outcome: "refused", reason: "request-id-reused", detail: "That request id was used for another answer." }, { status: 409 }),
      ),
    );
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "refused", detail: "That request id was used for another answer." });
  });

  it("throws on a failure that is not one of its answers", async () => {
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => new HttpResponse("boom", { status: 500 })));
    await expect(answerAsk("c1", ASK)).rejects.toThrow();
  });
});

describe("sendToPane and abortPane", () => {
  it("send names the turn, omits steer when off, and sends it when on", async () => {
    const bodies: JsonValue[] = [];
    server.use(
      http.post<never, JsonValue>(/\/api\/pane\/c1\/send$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, outcome: "ok" });
      }),
    );
    await sendToPane("c1", { requestId: ID, text: "hi", steer: false, target: { turnId: "t1" } });
    await sendToPane("c1", { requestId: ID, text: "hi", steer: true, target: { askId: "a1" } });
    expect(bodies).toEqual([
      { requestId: ID, text: "hi", turnId: "t1" },
      { requestId: ID, text: "hi", steer: true, askId: "a1" },
    ]);
  });

  it("abort names the turn", async () => {
    let body: JsonValue | undefined;
    server.use(
      http.post<never, JsonValue>(/\/api\/pane\/c1\/abort$/, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, outcome: "ok" });
      }),
    );
    await expect(abortPane("c1", { requestId: ID, target: { turnId: "t1" } })).resolves.toEqual({ outcome: "ok" });
    expect(body).toEqual({ requestId: ID, turnId: "t1" });
  });

  it("reads stale with the names that are current", async () => {
    server.use(
      http.post(/\/api\/pane\/c1\/send$/, () =>
        HttpResponse.json({ ok: false, outcome: "stale", turnId: "t2", askIds: ["a9"] }, { status: 409 }),
      ),
    );
    await expect(sendToPane("c1", { requestId: ID, text: "x", steer: false, target: { turnId: "t1" } })).resolves.toEqual({
      outcome: "stale",
      turnId: "t2",
      askIds: ["a9"],
    });
  });

  it("reads a refusal, a 504 and an older machine's 404", async () => {
    server.use(
      http.post(/\/api\/pane\/c1\/send$/, () =>
        HttpResponse.json({ ok: false, outcome: "refused", reason: "refused", detail: "Name a turn." }, { status: 409 }),
      ),
      http.post(/\/api\/pane\/c1\/abort$/, () => HttpResponse.json({ ok: false, outcome: "unknown" }, { status: 504 })),
      http.post(/\/api\/pane\/c2\/abort$/, () => HttpResponse.json({ error: "not found" }, { status: 404 })),
    );
    await expect(sendToPane("c1", { requestId: ID, text: "x", steer: false, target: null })).resolves.toEqual({
      outcome: "refused",
      reason: "refused",
      detail: "Name a turn.",
    });
    await expect(abortPane("c1", { requestId: ID, target: null })).resolves.toEqual({ outcome: "unknown" });
    await expect(abortPane("c2", { requestId: ID, target: null })).resolves.toEqual({ outcome: "stale", askIds: [], older: true });
  });

  it("reads maybe-applied on a send and an abort, and a reused request id as a refusal", async () => {
    server.use(
      http.post(/\/api\/pane\/c1\/send$/, () => HttpResponse.json({ ok: false, outcome: "maybe-applied" })),
      http.post(/\/api\/pane\/c1\/abort$/, () => HttpResponse.json({ ok: false, outcome: "maybe-applied" })),
      http.post(/\/api\/pane\/c2\/send$/, () =>
        HttpResponse.json({ ok: false, outcome: "refused", reason: "request-id-reused", detail: "Used for other text." }, { status: 409 }),
      ),
    );
    await expect(sendToPane("c1", { requestId: ID, text: "x", steer: false, target: null })).resolves.toEqual({ outcome: "maybe-applied" });
    await expect(abortPane("c1", { requestId: ID, target: null })).resolves.toEqual({ outcome: "maybe-applied" });
    await expect(sendToPane("c2", { requestId: ID, text: "x", steer: false, target: null })).resolves.toEqual({
      outcome: "refused",
      reason: "request-id-reused",
      detail: "Used for other text.",
    });
  });

  it("routes to the machine the scope names", async () => {
    let host: string | null = null;
    server.use(
      http.post(/\/api\/pane\/c1\/send$/, ({ request }) => {
        host = new URL(request.url).searchParams.get("host");
        return HttpResponse.json({ ok: true, outcome: "ok" });
      }),
    );
    await sendToPane("c1", { requestId: ID, text: "x", steer: false, target: null }, { host: "workshop" });
    expect(host).toBe("workshop");
  });
});
