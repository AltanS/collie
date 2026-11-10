import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import type { JsonObject, JsonValue } from "@/lib/json";
import { server } from "@/test/setup";

import { __resetMorph, __settleMorph, noteMorphSwitch, syncMorph, useMorphAvailable, useMorphSession } from "./store";

// The snapshot's morphRev says when to read. The same number reads nothing, a higher one reads with
// `since`, a lower one is a restarted bridge and reads the whole list, and no number empties the store.

/** Every GET /api/morph the store made, as its `since` (null for a whole read). */
let reads: (string | null)[] = [];

function serve(answer: (since: string | null) => object | Response) {
  server.use(
    http.get("/api/morph", ({ request }) => {
      const since = new URL(request.url).searchParams.get("since");
      reads.push(since);
      const got = answer(since);
      return got instanceof Response ? got : HttpResponse.json(got);
    }),
  );
}

const ADDRESS = "local/w1:p1#ab12";

function session(on: boolean, view?: JsonValue) {
  const out: JsonObject = { session: ADDRESS, on, hint: "(answer with collie morph show)" };
  if (view !== undefined) out.view = view;
  return out;
}

const VIEW: JsonValue = { rev: 1, at: "2026-11-10T10:00:00.000Z", title: "Plan", view: [{ kind: "para", text: "Two steps." }] };

async function sync(rev: number | undefined) {
  await act(async () => {
    syncMorph(rev);
    await __settleMorph();
  });
}

beforeEach(() => {
  reads = [];
  __resetMorph();
});

describe("the Morph store", () => {
  it("reads the whole list on the first number and serves one session by its address", async () => {
    serve(() => ({ rev: 3, sessions: [session(true, VIEW)] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    expect(reads).toEqual([null]);
    expect(result.current?.on).toBe(true);
    expect(result.current?.view?.title).toBe("Plan");
  });

  it("reads nothing when the number did not move, and reads with since when it went up", async () => {
    serve((since) => (since === null ? { rev: 3, sessions: [session(true)] } : { rev: 5, unchanged: true, sessions: [] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    await sync(3);
    await sync(5);
    expect(reads).toEqual([null, "3"]);
    expect(result.current?.on).toBe(true);
  });

  it("reads the whole list again when the number went down (a restarted bridge)", async () => {
    serve((since) => (since === null ? { rev: reads.length === 1 ? 9 : 2, sessions: [session(true)] } : { rev: 9, unchanged: true, sessions: [] }));
    await sync(9);
    await sync(2);
    expect(reads).toEqual([null, null]);
  });

  it("asks once on a snapshot with no number: a fresh bridge has Morph before it has a number", async () => {
    serve(() => ({ rev: 0, sessions: [] }));
    const { result } = renderHook(() => useMorphAvailable());
    expect(result.current).toBe(false);
    await sync(undefined);
    await sync(undefined);
    expect(reads).toEqual([null]);
    expect(result.current).toBe(true);
  });

  it("offers Morph nowhere on a 404, and asks again once a snapshot carries a number", async () => {
    let known = false;
    serve(() => (known ? { rev: 2, sessions: [session(true)] } : new HttpResponse("not found", { status: 404 })));
    const { result } = renderHook(() => ({ available: useMorphAvailable(), one: useMorphSession(ADDRESS) }));
    await sync(undefined);
    await sync(undefined);
    expect(result.current.available).toBe(false);
    expect(reads).toEqual([null]);
    known = true;
    await sync(2);
    expect(reads).toEqual([null, null]);
    expect(result.current.available).toBe(true);
    expect(result.current.one?.on).toBe(true);
  });

  it("keeps what it holds on a later snapshot with no number", async () => {
    serve(() => ({ rev: 3, sessions: [session(true)] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    await sync(undefined);
    expect(reads).toEqual([null]);
    expect(result.current?.on).toBe(true);
  });

  it("keeps the held list when a read fails, and asks again on the next snapshot", async () => {
    let fail = false;
    serve(() => (fail ? new HttpResponse("down", { status: 500 }) : { rev: 3, sessions: [session(true)] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    fail = true;
    await sync(4);
    expect(result.current?.on).toBe(true);
    expect(reads).toEqual([null, "3"]);
  });

  it("matches a held bare address for the same pane, never a held address of another session", async () => {
    serve(() => ({
      rev: 3,
      sessions: [
        { session: "local/w1:p1", on: true, hint: "h" },
        { session: "local/w1:p2#zz99", on: true, hint: "h" },
      ],
    }));
    const { result } = renderHook(() => ({ bare: useMorphSession(ADDRESS), other: useMorphSession("local/w1:p2#ab12") }));
    await sync(3);
    expect(result.current.bare?.session).toBe("local/w1:p1");
    expect(result.current.other).toBeNull();
  });

  it("takes a switch at once, before the next read", async () => {
    serve(() => ({ rev: 3, sessions: [] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    expect(result.current).toBeNull();
    act(() => noteMorphSwitch(ADDRESS, true, null));
    expect(result.current).toEqual({ session: ADDRESS, on: true, hint: "" });
    act(() => noteMorphSwitch(ADDRESS, false, null));
    expect(result.current?.on).toBe(false);
  });
});
