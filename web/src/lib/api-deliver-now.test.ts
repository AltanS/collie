import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { deliverWalky } from "./api";
import { describeThrownError } from "./api-error-message";

// The client half of Deliver now (M99 spec 05): the route it posts to, the three ends it resolves with, and a
// message that still waits arriving as a throw that carries the bridge's words.

describe("Deliver now, client", () => {
  it("posts to the pane's message and resolves on a delivery", async () => {
    let seen: URL | null = null;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/walky\/[^/]+\/deliver$/, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ result: { target: "local/w1:p1", result: "delivered", receipt: {} } });
      }),
    );
    await expect(deliverWalky("w1:p1", "wt_aaaaaaaaaaa1")).resolves.toBeUndefined();
    expect(seen!.pathname).toBe("/api/pane/w1%3Ap1/walky/wt_aaaaaaaaaaa1/deliver");
  });

  it("resolves `unknown` when it may have arrived, so nothing says delivered", async () => {
    server.use(http.post(/\/deliver$/, () => HttpResponse.json({ result: { target: "local/w1:p1", result: "may have arrived", receipt: {} } })));
    await expect(deliverWalky("w1:p1", "wt_aaaaaaaaaaa1")).resolves.toBe("unknown");
  });

  it("throws the bridge's words when the message still waits", async () => {
    server.use(http.post(/\/deliver$/, () => new HttpResponse("The agent is busy. Try again when its turn ends.", { status: 409 })));
    let words = "";
    try {
      await deliverWalky("w1:p1", "wt_aaaaaaaaaaa1");
    } catch (thrown) {
      words = describeThrownError(thrown);
    }
    expect(words).toContain("The agent is busy.");
  });

  it("resolves `gone` on a 410: the message no longer waits, so nothing was refused", async () => {
    server.use(http.post(/\/deliver$/, () => new HttpResponse("It no longer waits for your text.", { status: 410 })));
    await expect(deliverWalky("w1:p1", "wt_aaaaaaaaaaa1")).resolves.toBe("gone");
  });

  it("asks no member: a member's message is delivered on that machine", async () => {
    await expect(deliverWalky("w1:p1", "wt_aaaaaaaaaaa1", { host: "workshop" })).rejects.toThrow();
  });
});
