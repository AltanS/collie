import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { sendHillAnswers } from "./api";

// The client half of a Send of marked answers: what goes on the wire, and the three ways it ends.

const REQUEST = { rid: "5d1c0a7e-3b2f-4e8a-9c41-000000000001", answers: [{ id: "ak_aaaaaaaaaaaa", intent: "yes", text: null }] };
const RESULT = { rid: REQUEST.rid, items: [{ id: "ak_aaaaaaaaaaaa", code: "ok", reason: null, state: "answered" }], delivery: "typed", at: 1_762_000_000_000 };

describe("sendHillAnswers", () => {
  it("posts the request to /api/hill/answers and reads the result", async () => {
    let seen: { method: string; body: unknown } | null = null;
    server.use(
      http.post(/\/api\/hill\/answers$/, async ({ request }) => {
        seen = { method: request.method, body: await request.json() };
        return HttpResponse.json(RESULT);
      }),
    );
    expect(await sendHillAnswers(REQUEST)).toEqual({ ok: true, result: RESULT });
    expect(seen).toEqual({ method: "POST", body: REQUEST });
  });

  it("reads an ask that closed meanwhile as a gone item, and the unconfirmed mark", async () => {
    const body = { ...RESULT, unconfirmed: true, items: [{ id: "ak_aaaaaaaaaaaa", code: "gone", reason: "the decision is withdrawn", state: "withdrawn" }] };
    server.use(http.post(/\/api\/hill\/answers$/, () => HttpResponse.json(body)));
    const got = await sendHillAnswers(REQUEST);
    expect(got).toEqual({ ok: true, result: body });
  });

  it("returns a refusal with its code, and keeps nothing sent", async () => {
    server.use(http.post(/\/api\/hill\/answers$/, () => HttpResponse.json({ code: "too_long", error: "too long", over: 12 }, { status: 409 })));
    expect(await sendHillAnswers(REQUEST)).toEqual({ ok: false, status: 409, refusal: { code: "too_long", error: "too long", over: 12 } });
    server.use(http.post(/\/api\/hill\/answers$/, () => HttpResponse.json({ code: "not_answering", error: "away", machine: "workshop" }, { status: 409 })));
    expect(await sendHillAnswers(REQUEST)).toMatchObject({ ok: false, refusal: { code: "not_answering", machine: "workshop" } });
  });

  it("returns a refusal with no code when the body is not the bridge's", async () => {
    server.use(http.post(/\/api\/hill\/answers$/, () => new HttpResponse("nope", { status: 403 })));
    expect(await sendHillAnswers(REQUEST)).toEqual({ ok: false, status: 403, refusal: null });
  });

  it("throws on a server error and on a 200 it cannot read, so the caller retries with the same request id", async () => {
    server.use(http.post(/\/api\/hill\/answers$/, () => new HttpResponse("down", { status: 503 })));
    await expect(sendHillAnswers(REQUEST)).rejects.toThrow();
    server.use(http.post(/\/api\/hill\/answers$/, () => HttpResponse.json({ rid: "x" })));
    await expect(sendHillAnswers(REQUEST)).rejects.toThrow("cannot read");
  });
});
