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

  it("posts an answer of each other kind with its own member and no optionId", async () => {
    const bodies: JsonValue[] = [];
    server.use(
      http.post<never, JsonValue>(/\/api\/pane\/c1\/answer$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, outcome: "taken" });
      }),
    );
    const head = { requestId: ID, askId: "a1", revision: 2 };
    await answerAsk("c1", { ...head, optionIds: ["a", "b"] });
    await answerAsk("c1", { ...head, text: "On it." });
    await answerAsk("c1", { ...head, values: { summary: "x", urgent: true } });
    expect(bodies).toEqual([
      { ...head, optionIds: ["a", "b"] },
      { ...head, text: "On it." },
      { ...head, values: { summary: "x", urgent: true } },
    ]);
  });

  it("reads a replayed answer", async () => {
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: true, outcome: "taken", replayed: true })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "taken", replayed: true });
  });

  it("reads who decided a too-late answer first, and a replayed one, and none from an older bridge", async () => {
    const decided = { by: "program", at: "2026-10-15T09:30:00.000Z" };
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: false, outcome: "too-late", decided, replayed: true })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "too-late", decided, replayed: true });
    server.use(http.post(/\/api\/pane\/c1\/answer$/, () => HttpResponse.json({ ok: false, outcome: "too-late" })));
    await expect(answerAsk("c1", ASK)).resolves.toEqual({ outcome: "too-late" });
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

describe("abortPane on a pane with a screen (M68 spec 02)", () => {
  it("posts the request id alone and reads each receipt", async () => {
    const bodies: JsonValue[] = [];
    server.use(
      http.post<never, JsonValue>(/\/api\/pane\/s1\/abort$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ requestId: ID, outcome: "stopped", keys: ["Escape"] });
      }),
      http.post(/\/api\/pane\/s2\/abort$/, () => HttpResponse.json({ requestId: ID, outcome: "pressed", keys: ["ctrl+c"] })),
      http.post(/\/api\/pane\/s3\/abort$/, () => HttpResponse.json({ requestId: ID, outcome: "refused", reason: "draft_present" })),
    );
    await expect(abortPane("s1", { requestId: ID })).resolves.toEqual({ requestId: ID, outcome: "stopped", keys: ["Escape"] });
    expect(bodies).toEqual([{ requestId: ID }]);
    await expect(abortPane("s2", { requestId: ID })).resolves.toEqual({ requestId: ID, outcome: "pressed", keys: ["ctrl+c"] });
    await expect(abortPane("s3", { requestId: ID })).resolves.toEqual({ requestId: ID, outcome: "refused", reason: "draft_present" });
  });

  it("reads a missing pane as pane_gone and refuses a body it cannot read", async () => {
    server.use(
      http.post(/\/api\/pane\/s4\/abort$/, () => HttpResponse.json({ requestId: ID, outcome: "refused", reason: "pane_gone" }, { status: 404 })),
      http.post(/\/api\/pane\/s5\/abort$/, () => HttpResponse.json({ requestId: ID, outcome: "refused", reason: "mystery" })),
      http.post(/\/api\/pane\/s6\/abort$/, () => HttpResponse.json({ requestId: ID, outcome: "refused", reason: "request-id-reused" }, { status: 409 })),
    );
    await expect(abortPane("s4", { requestId: ID })).resolves.toEqual({ requestId: ID, outcome: "refused", reason: "pane_gone" });
    await expect(abortPane("s5", { requestId: ID })).rejects.toThrow(/cannot read/);
    await expect(abortPane("s6", { requestId: ID })).rejects.toThrow(/cannot read/);
  });

  // Crew version skew (counsel on the Edge 5 candidate): a member before M68 has no Stop for a screen
  // pane. Its answer is no receipt, and the phone says to update that machine; nothing was pressed.
  it("a 404 with no receipt, an older member's not-found, and the program-only route's 400 are unsupported_build", async () => {
    server.use(
      http.post(/\/api\/pane\/o1\/abort$/, () => new HttpResponse("no such terminal pane", { status: 404 })),
      http.post(/\/api\/pane\/o2\/abort$/, () => HttpResponse.json({ error: "not found" }, { status: 404 })),
      http.post(/\/api\/pane\/o3\/abort$/, () => new HttpResponse("bad body", { status: 400 })),
    );
    for (const pane of ["o1", "o2", "o3"]) {
      await expect(abortPane(pane, { requestId: ID }, { host: "laptop" })).resolves.toEqual({ requestId: ID, outcome: "refused", reason: "unsupported_build" });
    }
  });

  it("a 404 in the bridge's error shape (an unknown host) is thrown as that refusal, not read as an old build", async () => {
    server.use(http.post(/\/api\/pane\/u1\/abort$/, () => HttpResponse.json({ ok: false, code: "host.unknown", error: "no such host" }, { status: 404 })));
    await expect(abortPane("u1", { requestId: ID }, { host: "gone" })).rejects.toThrow(/no such host/);
  });

  it("the lead's write_outcome_unknown (a member that did not answer in time) is the Stop's unknown, never a press claimed", async () => {
    server.use(
      http.post(/\/api\/pane\/t1\/abort$/, () =>
        HttpResponse.json({ ok: false, code: "write_outcome_unknown", error: "the action was sent to host laptop but its outcome is unknown" }, { status: 504 }),
      ),
    );
    await expect(abortPane("t1", { requestId: ID }, { host: "laptop" })).resolves.toEqual({ requestId: ID, outcome: "unknown" });
  });
});

describe("abortPane on a pane with a screen: the queued sends that came back (ADR 0122)", () => {
  it("reads `returned` as the request ids a read-back saw, drops a word that is no request id, and keeps the rest", async () => {
    server.use(
      http.post(/\/api\/pane\/s1\/abort$/, () =>
        HttpResponse.json({ requestId: "stop-req-0001", outcome: "stopped", keys: ["Escape"], returned: ["req-back-00001", "../x", 7] }),
      ),
    );
    await expect(abortPane("s1", { requestId: "stop-req-0001" })).resolves.toEqual({
      requestId: "stop-req-0001",
      outcome: "stopped",
      keys: ["Escape"],
      returned: ["req-back-00001"],
    });
  });

  it("a bridge one release behind sends no `returned`, and the receipt has none", async () => {
    server.use(http.post(/\/api\/pane\/s1\/abort$/, () => HttpResponse.json({ requestId: "stop-req-0002", outcome: "pressed", keys: ["Escape"], returned: [] })));
    const receipt = await abortPane("s1", { requestId: "stop-req-0002" });
    expect(receipt).toEqual({ requestId: "stop-req-0002", outcome: "pressed", keys: ["Escape"] });
  });
});
