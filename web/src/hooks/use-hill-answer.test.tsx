import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { HILL_LIST_READ_AFTER_MS } from "@/lib/hill/motion";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { asJsonString, parseJsonObject, type JsonObject } from "@/lib/json";
import { hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { useHillAnswer } from "./use-hill-answer";

// One request id per attempt. A retry of the same attempt after a lost answer reuses it, so the
// bridge answers it once; any answer ends the attempt, and the next tap mints a new id.

let posted: JsonObject[] = [];

function answerWith(reply: (body: JsonObject) => Response) {
  server.use(
    http.post("/api/hill/answer", async ({ request }) => {
      const body = parseJsonObject(await request.text()) ?? {};
      posted.push(body);
      return reply(body);
    }),
  );
}

const ok = (body: JsonObject) => HttpResponse.json({ ...hillReceipt(), rid: asJsonString(body.rid) ?? "" });

beforeEach(() => {
  posted = [];
  __resetHill();
});

describe("useHillAnswer", () => {
  it("posts the node, intent and text with a minted rid, and holds the receipt", async () => {
    answerWith(ok);
    const { result } = renderHook(() => useHillAnswer("dc_k3m9x2p7q4"));
    await act(() => result.current.send("yes", "after the leg"));
    expect(posted[0]).toMatchObject({ node: "hill/dc_k3m9x2p7q4", intent: "yes", value: { text: "after the leg" } });
    expect(asJsonString(posted[0]?.rid)).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.current.state).toMatchObject({ phase: "answered", intent: "yes", receipt: { code: "ok" } });
  });

  it("reuses the rid when the same attempt is retried after a lost answer", async () => {
    answerWith(() => HttpResponse.error());
    const { result } = renderHook(() => useHillAnswer("dc_a"));
    await act(() => result.current.send("yes", null));
    expect(result.current.state).toEqual({ phase: "failed", intent: "yes", text: null });
    answerWith(ok);
    await act(() => result.current.send("yes", null));
    expect(posted).toHaveLength(2);
    expect(posted[0]?.rid).toBe(posted[1]?.rid);
    expect(result.current.state.phase).toBe("answered");
  });

  it("mints a new rid for another intent, and once an answer arrived", async () => {
    answerWith(() => HttpResponse.error());
    const { result } = renderHook(() => useHillAnswer("dc_b"));
    await act(() => result.current.send("yes", null));
    await act(() => result.current.send("no", null));
    expect(posted[0]?.rid).not.toBe(posted[1]?.rid);
    answerWith((body) => HttpResponse.json({ ...hillReceipt({ code: "rejected", state: null, delivery: null, reason: "text is required" }), rid: asJsonString(body.rid) ?? "" }));
    await act(() => result.current.send("no", null));
    await act(() => result.current.send("no", null));
    expect(posted[2]?.rid).toBe(posted[1]?.rid);
    expect(posted[3]?.rid).not.toBe(posted[2]?.rid);
  });

  it("reads a 403 as a denied receipt and a 400 as rejected", async () => {
    server.use(http.post("/api/hill/answer", () => HttpResponse.json({ error: "no" }, { status: 403 })));
    const { result } = renderHook(() => useHillAnswer("dc_c"));
    await act(() => result.current.send("yes", null));
    expect(result.current.state).toMatchObject({ phase: "answered", receipt: { code: "denied" } });
    server.use(http.post("/api/hill/answer", () => HttpResponse.json({ reason: "not an option of this decision" }, { status: 400 })));
    await act(() => result.current.send("maybe", null));
    expect(result.current.state).toMatchObject({ phase: "answered", receipt: { code: "rejected", reason: "not an option of this decision" } });
  });

  it("reads the bridge's plain-text 400 and 409 as rejected with its words, never as sent", async () => {
    server.use(http.post("/api/hill/answer", () => new HttpResponse("bad intent", { status: 400 })));
    const { result } = renderHook(() => useHillAnswer("dc_e"));
    await act(() => result.current.send("yes", null));
    expect(result.current.state).toMatchObject({ phase: "answered", receipt: { code: "rejected", reason: "bad intent", state: null, delivery: null } });
    server.use(http.post("/api/hill/answer", () => new HttpResponse("request-id-reused: this rid already answered with another choice", { status: 409 })));
    await act(() => result.current.send("no", null));
    expect(result.current.state).toMatchObject({ phase: "answered", receipt: { code: "rejected", reason: "request-id-reused: this rid already answered with another choice" } });
    // A refusal is an answer: the next tap is a new attempt with a new request id.
    server.use(http.post("/api/hill/answer", async ({ request }) => {
      posted.push(parseJsonObject(await request.text()) ?? {});
      return new HttpResponse("request-id-reused", { status: 409 });
    }));
    await act(() => result.current.send("no", null));
    await act(() => result.current.send("no", null));
    expect(posted[0]?.rid).not.toBe(posted[1]?.rid);
  });

  it("reads a 503 as not sent: the card offers the same answer again with the same rid", async () => {
    answerWith(() => new HttpResponse("the answer could not be recorded on this machine, so nothing was sent", { status: 503 }));
    const { result } = renderHook(() => useHillAnswer("dc_f"));
    await act(() => result.current.send("yes", null));
    expect(result.current.state).toEqual({ phase: "failed", intent: "yes", text: null });
    answerWith(ok);
    await act(() => result.current.send("yes", null));
    expect(posted[0]?.rid).toBe(posted[1]?.rid);
    expect(result.current.state).toMatchObject({ phase: "answered", receipt: { code: "ok" } });
  });

  it("reads a 200 it cannot read as unknown, never as unsent", async () => {
    server.use(http.post("/api/hill/answer", () => HttpResponse.json({ hello: true })));
    const { result } = renderHook(() => useHillAnswer("dc_d"));
    await act(() => result.current.send("yes", null));
    expect(result.current.state).toMatchObject({ phase: "answered", receipt: { code: "unknown" } });
  });

  it("reads the list once, a short moment after the tap, when the answer closed the decision", async () => {
    // The card leaves when the list says so; the list is read at once instead of on the next poll.
    const reads: (string | null)[] = [];
    server.use(
      http.get("/api/hill", ({ request }) => {
        reads.push(new URL(request.url).searchParams.get("since"));
        return HttpResponse.json({ v: 1, rev: reads.length === 1 ? 1 : 2, open: [], closed: [] });
      }),
    );
    await act(async () => {
      syncHill(1);
      await __settleHill();
    });
    answerWith(ok);
    const { result } = renderHook(() => useHillAnswer("dc_a"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(() => result.current.send("yes", null));
      expect(reads).toEqual([null]);
      await act(async () => {
        vi.advanceTimersByTime(HILL_LIST_READ_AFTER_MS);
        await __settleHill();
      });
    } finally {
      vi.useRealTimers();
    }
    await act(async () => {
      await __settleHill();
    });
    expect(reads).toEqual([null, "1"]);
  });

  it("reads nothing early after a refusal: the decision is still open", async () => {
    const reads: string[] = [];
    server.use(http.get("/api/hill", () => (reads.push("read"), HttpResponse.json({ v: 1, rev: 1, open: [], closed: [] }))));
    await act(async () => {
      syncHill(1);
      await __settleHill();
    });
    answerWith(() => HttpResponse.json({ reason: "not an option of this decision" }, { status: 400 }));
    const { result } = renderHook(() => useHillAnswer("dc_a"));
    await act(() => result.current.send("maybe", null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, HILL_LIST_READ_AFTER_MS + 20));
      await __settleHill();
    });
    expect(reads).toEqual(["read"]);
  });
});
