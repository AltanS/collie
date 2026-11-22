import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { sendHillTest } from "./api";

// The client half of "Send a test Decision": what goes on the wire, and that an answer of another shape throws.

describe("sendHillTest", () => {
  it("posts an empty body to /api/hill/test and reads { inSeconds, rings }", async () => {
    let seen: { method: string; body: string } | null = null;
    server.use(
      http.post(/\/api\/hill\/test$/, async ({ request }) => {
        seen = { method: request.method, body: await request.text() };
        return HttpResponse.json({ inSeconds: 20, rings: null });
      }),
    );
    expect(await sendHillTest()).toEqual({ inSeconds: 20, rings: null });
    expect(seen).toEqual({ method: "POST", body: "{}" });
  });

  it("reads the reason a notification would not be sent, and a code a newer bridge adds", async () => {
    server.use(http.post(/\/api\/hill\/test$/, () => HttpResponse.json({ inSeconds: 7, rings: "quiet" })));
    expect(await sendHillTest()).toEqual({ inSeconds: 7, rings: "quiet" });
    server.use(http.post(/\/api\/hill\/test$/, () => HttpResponse.json({ inSeconds: 7, rings: "something_new" })));
    expect(await sendHillTest()).toEqual({ inSeconds: 7, rings: "something_new" });
  });

  it("throws on a body that is not { inSeconds, rings }", async () => {
    for (const body of [{}, { inSeconds: "20", rings: null }, { inSeconds: 20 }, { inSeconds: 20, rings: 3 }, { inSeconds: -1, rings: null }, [], "no"]) {
      server.use(http.post(/\/api\/hill\/test$/, () => HttpResponse.json(body)));
      await expect(sendHillTest()).rejects.toThrow("/api/hill/test answered with a body that is not { inSeconds, rings }");
    }
  });

  it("throws on a refusal", async () => {
    server.use(http.post(/\/api\/hill\/test$/, () => HttpResponse.json({ code: "hill_off", error: "the Hill is off" }, { status: 409 })));
    await expect(sendHillTest()).rejects.toThrow();
  });
});
