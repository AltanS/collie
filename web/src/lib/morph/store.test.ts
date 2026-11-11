import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import type { JsonObject, JsonValue } from "@/lib/json";
import { server } from "@/test/setup";

import {
  __resetMorph,
  __settleMorph,
  holdMorphFast,
  MORPH_FAST_MS,
  MORPH_FAST_QUIET_MS,
  noteMorphSwitch,
  syncMorph,
  useMorphAvailable,
  useMorphLive,
  useMorphSession,
} from "./store";

// The snapshot's trickViewsRev says when to read. The same number reads nothing, a higher one reads with
// `since`, a lower one is a restarted bridge and reads the whole list, and no number empties the store.

/** Every GET /api/trick-views the store made, as its `since` (null for a whole read). */
let reads: (string | null)[] = [];

function serve(answer: (since: string | null) => object | Response) {
  server.use(
    http.get("/api/trick-views", ({ request }) => {
      const since = new URL(request.url).searchParams.get("since");
      reads.push(since);
      const got = answer(since);
      return got instanceof Response ? got : HttpResponse.json(got);
    }),
  );
}

const ADDRESS = "local/w1:p1#ab12";

function session(on: boolean, view?: JsonValue) {
  const out: JsonObject = { trick: "morph", session: ADDRESS, on, hint: "(answer with collie morph show)" };
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
    serve(() => ({ rev: 3, views: [session(true, VIEW)] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    expect(reads).toEqual([null]);
    expect(result.current?.on).toBe(true);
    expect(result.current?.view?.title).toBe("Plan");
  });

  it("reads nothing when the number did not move, and reads with since when it went up", async () => {
    serve((since) => (since === null ? { rev: 3, views: [session(true)] } : { rev: 5, unchanged: true, views: [] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    await sync(3);
    await sync(5);
    expect(reads).toEqual([null, "3"]);
    expect(result.current?.on).toBe(true);
  });

  it("reads the whole list again when the number went down (a restarted bridge)", async () => {
    serve((since) => (since === null ? { rev: reads.length === 1 ? 9 : 2, views: [session(true)] } : { rev: 9, unchanged: true, views: [] }));
    await sync(9);
    await sync(2);
    expect(reads).toEqual([null, null]);
  });

  it("reads the whole list again when a since read answers only the moved views (it carries keys)", async () => {
    serve((since) => (since === null ? { rev: reads.length === 1 ? 3 : 5, views: [session(true)] } : { rev: 5, views: [], keys: [{ trick: "morph", session: ADDRESS }] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    await sync(5);
    expect(reads).toEqual([null, "3", null]);
    expect(result.current?.on).toBe(true);
  });

  it("asks once on a snapshot with no number: a fresh bridge has Morph before it has a number", async () => {
    serve(() => ({ rev: 0, views: [] }));
    const { result } = renderHook(() => useMorphAvailable());
    expect(result.current).toBe(false);
    await sync(undefined);
    await sync(undefined);
    expect(reads).toEqual([null]);
    expect(result.current).toBe(true);
  });

  it("offers Morph nowhere on a 404, and asks again once a snapshot carries a number", async () => {
    let known = false;
    serve(() => (known ? { rev: 2, views: [session(true)] } : new HttpResponse("not found", { status: 404 })));
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
    serve(() => ({ rev: 3, views: [session(true)] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    await sync(undefined);
    expect(reads).toEqual([null]);
    expect(result.current?.on).toBe(true);
  });

  it("keeps the held list when a read fails, and asks again on the next snapshot", async () => {
    let fail = false;
    serve(() => (fail ? new HttpResponse("down", { status: 500 }) : { rev: 3, views: [session(true)] }));
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
      views: [
        { trick: "morph", session: "local/w1:p1", on: true, hint: "h" },
        { trick: "morph", session: "local/w1:p2#zz99", on: true, hint: "h" },
      ],
    }));
    const { result } = renderHook(() => ({ bare: useMorphSession(ADDRESS), other: useMorphSession("local/w1:p2#ab12") }));
    await sync(3);
    expect(result.current.bare?.session).toBe("local/w1:p1");
    expect(result.current.other).toBeNull();
  });

  it("takes a switch at once, before the next read", async () => {
    serve(() => ({ rev: 3, views: [] }));
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    expect(result.current).toBeNull();
    act(() => noteMorphSwitch(ADDRESS, true, null));
    expect(result.current).toEqual({ trick: "morph", session: ADDRESS, on: true, hint: "" });
    act(() => noteMorphSwitch(ADDRESS, false, null));
    expect(result.current?.on).toBe(false);
  });
});

describe("the fast read while a screen is in work", () => {
  let releases: (() => void)[] = [];

  beforeEach(() => {
    releases = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    for (const release of releases) release();
    vi.useRealTimers();
    setHidden(false);
  });

  function hold(busy: boolean) {
    const release = holdMorphFast(busy);
    releases.push(release);
    return release;
  }

  async function tick(ms = MORPH_FAST_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await __settleMorph();
    });
  }

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  /** A bridge whose number never moves: the whole list once, then `unchanged`. */
  function quiet(since: string | null) {
    return since === null ? { rev: 3, views: [] } : { rev: 3, unchanged: true, views: [] };
  }

  /** A bridge whose number moves on each fast read: rev 3 on the whole read, then 4, 5, ... */
  function moving() {
    let rev = 3;
    serve((since) => {
      if (since !== null) rev += 1;
      return { rev, views: [session(true, { at: "2026-11-10T10:00:00.000Z", rev, view: [{ kind: "para", text: "Two steps." }] })] };
    });
  }

  it("reads with since every 800 ms while a busy body holds it, and the new screen lands", async () => {
    moving();
    const { result } = renderHook(() => useMorphSession(ADDRESS));
    await sync(3);
    hold(true);
    await tick();
    expect(reads).toEqual([null, "3"]);
    expect(result.current?.view?.rev).toBe(4);
    await tick();
    expect(reads).toEqual([null, "3", "4"]);
  });

  it("one timer for every holder: two busy bodies read once per beat", async () => {
    moving();
    await sync(3);
    hold(true);
    hold(true);
    await tick();
    expect(reads).toEqual([null, "3"]);
  });

  it("reads nothing before the bridge said it has Morph, and nothing once let go", async () => {
    moving();
    const release = hold(true);
    await tick();
    expect(reads).toEqual([]);
    await sync(3);
    await tick();
    expect(reads).toEqual([null, "3"]);
    release();
    await tick(MORPH_FAST_MS * 3);
    expect(reads).toEqual([null, "3"]);
  });

  it("stops while the page is hidden, and starts again when it shows", async () => {
    moving();
    await sync(3);
    hold(true);
    setHidden(true);
    await tick(MORPH_FAST_MS * 3);
    expect(reads).toEqual([null]);
    setHidden(false);
    await tick();
    expect(reads).toEqual([null, "3"]);
  });

  it("a body that is not busy keeps reading only for the quiet window after the last change", async () => {
    serve(quiet);
    await sync(3);
    vi.advanceTimersByTime(MORPH_FAST_QUIET_MS + 1);
    hold(false);
    await tick(MORPH_FAST_MS * 3);
    expect(reads).toEqual([null]);
  });

  it("a quiet body reads while a change is fresh, then stops", async () => {
    serve(quiet);
    await sync(3);
    hold(false);
    await tick();
    expect(reads).toEqual([null, "3"]);
    await tick(MORPH_FAST_QUIET_MS);
    const count = reads.length;
    await tick(MORPH_FAST_MS * 5);
    expect(reads.length).toBe(count);
  });

  it("slows down after three failed reads in a row", async () => {
    let fail = false;
    serve(() => (fail ? new HttpResponse("down", { status: 500 }) : { rev: 3, views: [] }));
    await sync(3);
    fail = true;
    hold(true);
    await tick();
    await tick();
    await tick();
    expect(reads.length).toBe(4);
    // The fourth read waits 1600 ms, not 800.
    await tick();
    expect(reads.length).toBe(4);
    await tick();
    expect(reads.length).toBe(5);
  });

  it("a snapshot behind the fast read reads nothing; one below the last snapshot is a restart", async () => {
    moving();
    await sync(3);
    hold(true);
    await tick();
    await tick();
    expect(reads).toEqual([null, "3", "4"]);
    releases.splice(0).forEach((release) => release());
    await sync(4);
    expect(reads).toEqual([null, "3", "4"]);
    await sync(1);
    expect(reads).toEqual([null, "3", "4", null]);
  });

  it("useMorphLive holds while mounted and lets go on unmount", async () => {
    moving();
    await sync(3);
    const { unmount } = renderHook(() => useMorphLive(true));
    await tick();
    expect(reads).toEqual([null, "3"]);
    unmount();
    await tick(MORPH_FAST_MS * 3);
    expect(reads).toEqual([null, "3"]);
  });
});
