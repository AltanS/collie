import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { sentCrew } from "@/test/sent-fixtures";
import { apiErrorStatus, clearSent, getSent, removeSent } from "./api";

// The client half of Sent (M61): what each call puts on the wire, to which machine, and that an old
// bridge's 404 arrives as an ApiError the sheet can read.

interface RemoveBody {
  id?: string;
  requestId?: string;
}

describe("Sent, client", () => {
  it("reads this machine with the scope, folder, words, page size and cursor spelled as the contract has them", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(/\/api\/sent$/, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(sentCrew);
      }),
    );
    const answer = await getSent({ scope: "here", cwd: "/srv/app", q: " git  status ", limit: 20, before: 1234 }, { host: "workshop", session: "s2" });
    expect(answer.entries).toHaveLength(2);
    expect(seen!.searchParams.get("scope")).toBe("here");
    expect(seen!.searchParams.get("cwd")).toBe("/srv/app");
    expect(seen!.searchParams.get("q")).toBe("git  status");
    expect(seen!.searchParams.get("limit")).toBe("20");
    expect(seen!.searchParams.get("before")).toBe("1234");
    // The member is asked through ?host=; the Herdr session is not part of a machine's record.
    expect(seen!.searchParams.get("host")).toBe("workshop");
    expect(seen!.searchParams.has("session")).toBe(false);
  });

  it("leaves out every field the caller did not set, and a blank search", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(/\/api\/sent$/, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(sentCrew);
      }),
    );
    await getSent({ scope: "here", q: "   " });
    expect([...seen!.searchParams.keys()]).toEqual(["scope"]);
  });

  it("asks the lead alone for all machines, so no host rides along", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(/\/api\/sent$/, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(sentCrew);
      }),
    );
    await getSent({ scope: "all" }, { host: "workshop" });
    expect(seen!.searchParams.get("scope")).toBe("all");
    expect(seen!.searchParams.has("host")).toBe(false);
  });

  it("throws the old bridge's 404 as an ApiError the sheet reads by its status", async () => {
    server.use(http.get(/\/api\/sent$/, () => HttpResponse.json({ ok: false, error: "not found" }, { status: 404 })));
    const status = await getSent({ scope: "here" }).then(
      () => undefined,
      (err: Error) => apiErrorStatus(err),
    );
    expect(status).toBe(404);
  });

  it("remove names the line by id with a fresh request id each call, on the machine the scope names", async () => {
    const seen: { url: URL; body: RemoveBody }[] = [];
    server.use(
      http.post<never, RemoveBody>(/\/api\/sent\/remove$/, async ({ request }) => {
        seen.push({ url: new URL(request.url), body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(removeSent("aaaaaaaaaaaaaaaa", { host: "workshop", session: "s2" })).resolves.toEqual({ ok: true });
    await removeSent("aaaaaaaaaaaaaaaa");
    expect(seen[0]!.url.searchParams.get("host")).toBe("workshop");
    expect(seen[0]!.url.searchParams.has("session")).toBe(false);
    expect(seen[1]!.url.searchParams.has("host")).toBe(false);
    expect(seen[0]!.body.id).toBe("aaaaaaaaaaaaaaaa");
    expect(seen[0]!.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.body.requestId).not.toBe(seen[0]!.body.requestId);
  });

  it("clear sends only a request id to the machine the scope names", async () => {
    let seen: { url: URL; body: object } | null = null;
    server.use(
      http.post<never, object>(/\/api\/sent\/clear$/, async ({ request }) => {
        seen = { url: new URL(request.url), body: await request.json() };
        return HttpResponse.json({ ok: true });
      }),
    );
    await clearSent({ host: "workshop" });
    expect(seen!.url.searchParams.get("host")).toBe("workshop");
    expect(Object.keys(seen!.body)).toEqual(["requestId"]);
  });
});
