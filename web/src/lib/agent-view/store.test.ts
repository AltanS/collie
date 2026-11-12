import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import type { JsonObject, JsonValue } from "@/lib/json";
import { server } from "@/test/setup";

import {
  __resetAgentViews,
  __settleAgentViews,
  holdAgentViewFast,
  noteAgentViewSwitch,
  syncAgentViews,
  useAgentViewLive,
  useAgentViewsAvailable,
  useAgentViewsOf,
  useShowAgentViews,
  useViewTurnText,
  VIEW_FAST_BACKOFF_MAX_MS,
  VIEW_FAST_FAILURES,
  VIEW_FAST_MS,
  VIEW_FAST_QUIET_MS,
} from "./store";

// One read serves every view of the sessions the phone shows (GET /api/trick-views?session=...). The
// snapshot's trickViewsRev says when to read again. The same number reads nothing, a higher one reads with
// `since`, a lower one is a restarted bridge and reads the whole list, and no number reads nothing.

/** Every GET /api/trick-views the store made: its `since` (null for a whole read). */
let reads: (string | null)[] = [];
/** The sessions each of those reads named, in the order the store sent them. */
let asked: string[][] = [];

interface Asked {
  since: string | null;
  sessions: string[];
}

function serve(answer: (query: Asked) => object | Response) {
  server.use(
    http.get("/api/trick-views", ({ request }) => {
      const { searchParams } = new URL(request.url);
      const query = { since: searchParams.get("since"), sessions: searchParams.getAll("session") };
      reads.push(query.since);
      asked.push(query.sessions);
      const got = answer(query);
      return got instanceof Response ? got : HttpResponse.json(got);
    }),
  );
}

const ADDRESS = "lodge/w1:p1#ab12";
const OTHER = "lodge/w1:p2#cd34";
const THIRD = "workshop/w3:p1#ef56";

interface ViewOptions {
  trick?: string;
  session?: string;
  screen?: JsonValue;
  sent?: JsonValue;
  off?: string;
}

/** One view as the bridge serves it. */
function viewOf(on: boolean, { trick = "plan", session = ADDRESS, screen, sent, off }: ViewOptions = {}) {
  const out: JsonObject = { trick, session, on };
  if (screen !== undefined) out.view = screen;
  if (sent !== undefined) out.sent = sent;
  if (off !== undefined) out.off = off;
  return out;
}

const SCREEN: JsonValue = { rev: 1, at: "2026-11-10T10:00:00.000Z", title: "Plan", view: [{ kind: "para", text: "Two steps." }] };

/** The mounted screen of one session: it shows the session and reads its views. */
function watch(address: string) {
  useShowAgentViews(address, true);
  return useAgentViewsOf(address);
}

async function settle() {
  await act(async () => {
    await __settleAgentViews();
  });
}

async function sync(rev: number | undefined) {
  await act(async () => {
    syncAgentViews(rev);
    await __settleAgentViews();
  });
}

beforeEach(() => {
  reads = [];
  asked = [];
  __resetAgentViews();
});

describe("the agent views store", () => {
  it("reads the whole list for the shown session on mount, and serves its views by its address", async () => {
    serve(() => ({ rev: 3, views: [viewOf(true, { screen: SCREEN })] }));
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    expect(reads).toEqual([null]);
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.trick).toBe("plan");
    expect(result.current[0]?.on).toBe(true);
    expect(result.current[0]?.view?.title).toBe("Plan");
  });

  it("reads nothing while no session is shown, and nothing more once the last one lets go", async () => {
    serve(() => ({ rev: 3, views: [viewOf(true)] }));
    await sync(3);
    expect(reads).toEqual([]);
    const { unmount } = renderHook(() => watch(ADDRESS));
    await settle();
    expect(reads).toEqual([null]);
    unmount();
    await sync(5);
    expect(reads).toEqual([null]);
  });

  it("reads nothing when the number did not move, and reads with since when it went up", async () => {
    serve(({ since }) => (since === null ? { rev: 3, views: [viewOf(true)] } : { rev: 5, unchanged: true, views: [] }));
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    await sync(3);
    await sync(5);
    expect(reads).toEqual([null, "3"]);
    expect(result.current[0]?.on).toBe(true);
  });

  it("reads the whole list again when the number went down (a restarted bridge)", async () => {
    serve(({ since }) => (since === null ? { rev: reads.length === 1 ? 9 : 2, views: [viewOf(true)] } : { rev: 9, unchanged: true, views: [] }));
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(9);
    await sync(2);
    expect(reads).toEqual([null, null]);
  });

  it("merges a since read by its keys: the moved view is replaced, a view the bridge no longer holds goes", async () => {
    serve(({ since }) =>
      since === null
        ? { rev: 3, views: [viewOf(true, { trick: "plan", screen: SCREEN }), viewOf(false, { trick: "notes", off: "switch" })] }
        : // SAFETY: SCREEN is the object literal above.
          { rev: 5, views: [viewOf(true, { trick: "plan", screen: { ...(SCREEN as JsonObject), rev: 2, title: "Plan v2" } })], keys: [{ trick: "plan", session: ADDRESS }] },
    );
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    expect(result.current.map((view) => view.trick)).toEqual(["plan", "notes"]);
    await sync(5);
    expect(reads).toEqual([null, "3"]);
    expect(result.current.map((view) => view.trick)).toEqual(["plan"]);
    expect(result.current[0]?.view?.title).toBe("Plan v2");
  });

  it("keeps the other views of a since read that did not move", async () => {
    serve(({ since }) =>
      since === null
        ? { rev: 3, views: [viewOf(true, { trick: "plan", screen: SCREEN }), viewOf(false, { trick: "notes" })] }
        : { rev: 5, views: [viewOf(true, { trick: "notes" })], keys: [{ trick: "plan", session: ADDRESS }, { trick: "notes", session: ADDRESS }] },
    );
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    await sync(5);
    expect(result.current.map((view) => [view.trick, view.on])).toEqual([
      ["plan", true],
      ["notes", true],
    ]);
    expect(result.current[0]?.view?.title).toBe("Plan");
  });

  it("asks once on a snapshot with no number: a fresh bridge has agent views before it has a number", async () => {
    serve(() => ({ rev: 0, views: [] }));
    const { result } = renderHook(() => ({ available: useAgentViewsAvailable(), views: watch(ADDRESS) }));
    expect(result.current.available).toBe(false);
    await settle();
    await sync(undefined);
    await sync(undefined);
    expect(reads).toEqual([null]);
    expect(result.current.available).toBe(true);
    expect(result.current.views).toEqual([]);
  });

  it("a 404 means no agent views: none offered, no more asking, and one more ask once a snapshot carries a number", async () => {
    let known = false;
    serve(() => (known ? { rev: 2, views: [viewOf(true)] } : new HttpResponse("not found", { status: 404 })));
    const { result } = renderHook(() => ({ available: useAgentViewsAvailable(), views: watch(ADDRESS) }));
    await settle();
    await sync(undefined);
    await sync(undefined);
    expect(result.current.available).toBe(false);
    expect(reads).toEqual([null]);
    known = true;
    await sync(2);
    expect(reads).toEqual([null, null]);
    expect(result.current.available).toBe(true);
    expect(result.current.views[0]?.on).toBe(true);
  });

  it("another failure leaves the question open, and the next snapshot asks again", async () => {
    let fail = true;
    serve(() => (fail ? new HttpResponse("down", { status: 500 }) : { rev: 2, views: [viewOf(true)] }));
    const { result } = renderHook(() => ({ available: useAgentViewsAvailable(), views: watch(ADDRESS) }));
    await settle();
    expect(result.current.available).toBe(false);
    fail = false;
    await sync(undefined);
    expect(reads).toEqual([null, null]);
    expect(result.current.available).toBe(true);
    expect(result.current.views).toHaveLength(1);
  });

  it("keeps what it holds on a later snapshot with no number", async () => {
    serve(() => ({ rev: 3, views: [viewOf(true)] }));
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    await sync(undefined);
    expect(reads).toEqual([null]);
    expect(result.current[0]?.on).toBe(true);
  });

  it("keeps the held list when a read fails, and asks again on the next snapshot", async () => {
    let fail = false;
    serve(() => (fail ? new HttpResponse("down", { status: 500 }) : { rev: reads.length === 1 ? 3 : 4, views: [viewOf(true)] }));
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    fail = true;
    await sync(4);
    expect(result.current[0]?.on).toBe(true);
    expect(reads).toEqual([null, "3"]);
    fail = false;
    await sync(4);
    expect(reads).toEqual([null, "3", "3"]);
  });

  it("matches a held bare address for the same pane, never a held address of another session", async () => {
    serve(() => ({
      rev: 3,
      views: [viewOf(true, { session: "lodge/w1:p1" }), viewOf(true, { session: "lodge/w1:p2#zz99" })],
    }));
    const { result } = renderHook(() => ({ bare: watch(ADDRESS), other: watch("lodge/w1:p2#ab12") }));
    await settle();
    expect(result.current.bare.map((view) => view.session)).toEqual(["lodge/w1:p1"]);
    expect(result.current.other).toEqual([]);
  });

  it("names only the shown sessions in a read, and keeps only their views from an answer", async () => {
    serve(({ since }) => (since === null ? { rev: 3, views: [ADDRESS, OTHER, THIRD].map((session) => viewOf(true, { session })) } : { rev: 5, unchanged: true, views: [] }));
    const first = renderHook(() => watch(ADDRESS));
    await settle();
    expect(asked).toEqual([[ADDRESS]]);
    expect(first.result.current).toHaveLength(1);

    // A second session on screen reads the views of both whole: the held list is for one session only.
    const second = renderHook(() => watch(OTHER));
    await settle();
    expect(reads).toEqual([null, null]);
    expect(asked[1]).toEqual([ADDRESS, OTHER].toSorted());
    expect(second.result.current).toHaveLength(1);
    const elsewhere = renderHook(() => useAgentViewsOf(THIRD));
    expect(elsewhere.result.current).toEqual([]);

    // The same two sessions: a since read.
    await sync(5);
    expect(reads).toEqual([null, null, "3"]);
    expect(asked[2]).toEqual([ADDRESS, OTHER].toSorted());

    // A session that goes is narrowed in place, with no read.
    const shown = renderHook(() => useAgentViewsOf(OTHER));
    expect(shown.result.current).toHaveLength(1);
    second.unmount();
    expect(reads).toEqual([null, null, "3"]);
    expect(shown.result.current).toEqual([]);
    expect(first.result.current).toHaveLength(1);
  });

  it("takes a switch at once, before the next read", async () => {
    serve(() => ({ rev: 3, views: [] }));
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    expect(result.current).toEqual([]);
    act(() => noteAgentViewSwitch({ trick: "plan", session: ADDRESS, on: true }));
    expect(result.current).toEqual([{ trick: "plan", session: ADDRESS, on: true }]);
    act(() => noteAgentViewSwitch({ trick: "plan", session: ADDRESS, on: false }));
    expect(result.current[0]?.on).toBe(false);
  });

  it("switching one view on turns the other views of that session off, and no view of another session", async () => {
    const sent = [{ rid: "r1", at: "2026-11-10T10:00:00.000Z", kind: "text", line: "[view:plan lodge/w1:p1#ab12] from operator: hi" }];
    serve(() => ({
      rev: 3,
      views: [
        viewOf(true, { trick: "plan", screen: SCREEN, sent }),
        viewOf(false, { trick: "notes", off: "switch" }),
        viewOf(true, { trick: "plan", session: OTHER }),
      ],
    }));
    const { result } = renderHook(() => ({ one: watch(ADDRESS), two: watch(OTHER) }));
    await settle();
    expect(result.current.one.map((view) => [view.trick, view.on])).toEqual([
      ["plan", true],
      ["notes", false],
    ]);
    act(() => noteAgentViewSwitch({ trick: "notes", session: ADDRESS, on: true }));
    const [plan, notes] = result.current.one;
    expect(plan).toMatchObject({ trick: "plan", on: false, off: "switch" });
    expect(plan?.view).toBeUndefined();
    expect(plan?.sent).toHaveLength(1);
    expect(notes).toMatchObject({ trick: "notes", on: true });
    expect(result.current.two[0]?.on).toBe(true);
  });

  it("switching a view off turns no other view on", async () => {
    serve(() => ({ rev: 3, views: [viewOf(false, { trick: "notes", off: "switch" }), viewOf(true, { trick: "plan" })] }));
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    act(() => noteAgentViewSwitch({ trick: "plan", session: ADDRESS, on: false }));
    expect(result.current.map((view) => view.on)).toEqual([false, false]);
  });

  it("draws a person turn without the view's head only for a line the bridge listed", async () => {
    const line = "[view:plan lodge/w1:p1#ab12] from operator: Show me the plan [rules: /bin/collie trick view plan help --session lodge/w1:p1#ab12]";
    const lookAlike = "[view:plan lodge/w1:p1#ab12] from operator: Show me more";
    serve(() => ({ rev: 3, views: [viewOf(true, { sent: [{ rid: "r1", at: "2026-11-10T10:00:00.000Z", kind: "text", line }] })] }));
    const { result } = renderHook(() => ({ shown: watch(ADDRESS), sent: useViewTurnText(line), other: useViewTurnText(lookAlike) }));
    expect(result.current.sent).toBe(line);
    await settle();
    expect(result.current.sent).toBe("Show me the plan");
    expect(result.current.other).toBe(lookAlike);
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
    const release = holdAgentViewFast(busy);
    releases.push(release);
    return release;
  }

  async function tick(ms = VIEW_FAST_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await __settleAgentViews();
    });
  }

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  /** A bridge whose number never moves: the whole list once, then `unchanged`. */
  function quiet({ since }: Asked) {
    return since === null ? { rev: 3, views: [] } : { rev: 3, unchanged: true, views: [] };
  }

  /** A bridge whose number moves on each fast read: rev 3 on the whole read, then 4, 5, ... */
  function moving() {
    let rev = 3;
    serve(({ since }) => {
      if (since !== null) rev += 1;
      return { rev, views: [viewOf(true, { screen: { at: "2026-11-10T10:00:00.000Z", rev, view: [{ kind: "para", text: "Two steps." }] } })] };
    });
  }

  it("reads with since every 800 ms while a busy view holds it, and the new screen lands", async () => {
    moving();
    const { result } = renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    hold(true);
    await tick();
    expect(reads).toEqual([null, "3"]);
    expect(result.current[0]?.view?.rev).toBe(4);
    await tick();
    expect(reads).toEqual([null, "3", "4"]);
  });

  it("names only the shown sessions in every fast read", async () => {
    moving();
    renderHook(() => watch(ADDRESS));
    renderHook(() => watch(OTHER));
    await settle();
    await sync(3);
    hold(true);
    await tick();
    await tick();
    expect(asked.length).toBeGreaterThanOrEqual(3);
    for (const sessions of asked) expect(sessions.every((session) => [ADDRESS, OTHER].includes(session))).toBe(true);
    expect(asked.at(-1)).toEqual([ADDRESS, OTHER].toSorted());
  });

  it("one timer for every holder: two busy views read once per beat", async () => {
    moving();
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    hold(true);
    hold(true);
    await tick();
    expect(reads).toEqual([null, "3"]);
  });

  it("reads nothing before a session is shown and the bridge said it has agent views, and nothing once let go", async () => {
    moving();
    const release = hold(true);
    await tick();
    expect(reads).toEqual([]);
    renderHook(() => watch(ADDRESS));
    await settle();
    expect(reads).toEqual([null]);
    await tick();
    expect(reads).toEqual([null, "3"]);
    release();
    await tick(VIEW_FAST_MS * 3);
    expect(reads).toEqual([null, "3"]);
  });

  it("stops while the page is hidden, and starts again when it shows", async () => {
    moving();
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    hold(true);
    setHidden(true);
    await tick(VIEW_FAST_MS * 3);
    expect(reads).toEqual([null]);
    setHidden(false);
    await tick();
    expect(reads).toEqual([null, "3"]);
  });

  it("a view that is not busy keeps reading only for the quiet window after the last change", async () => {
    serve(quiet);
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    vi.advanceTimersByTime(VIEW_FAST_QUIET_MS + 1);
    hold(false);
    await tick(VIEW_FAST_MS * 3);
    expect(reads).toEqual([null]);
  });

  it("a quiet view reads while a change is fresh, then stops", async () => {
    serve(quiet);
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    hold(false);
    await tick();
    expect(reads).toEqual([null, "3"]);
    await tick(VIEW_FAST_QUIET_MS);
    const count = reads.length;
    await tick(VIEW_FAST_MS * 5);
    expect(reads.length).toBe(count);
  });

  it("slows down after three failed reads in a row, up to the cap, and one good read sets the pace back", async () => {
    let fail = false;
    serve(() => (fail ? new HttpResponse("down", { status: 500 }) : { rev: 3, views: [] }));
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    fail = true;
    hold(true);
    for (let i = 0; i < VIEW_FAST_FAILURES; i += 1) await tick();
    expect(reads.length).toBe(1 + VIEW_FAST_FAILURES);
    // Each further failure doubles the wait, to the cap.
    for (const wait of [1600, 3200, 6400, 12_800, VIEW_FAST_BACKOFF_MAX_MS, VIEW_FAST_BACKOFF_MAX_MS]) {
      const before = reads.length;
      await tick(wait - 1);
      expect(reads.length).toBe(before);
      await tick(1);
      expect(reads.length).toBe(before + 1);
    }
    // One good read, then the pace is 800 ms again.
    fail = false;
    await tick(VIEW_FAST_BACKOFF_MAX_MS);
    const good = reads.length;
    await tick();
    expect(reads.length).toBe(good + 1);
  });

  it("a snapshot behind the fast read reads nothing; one below the last snapshot is a restart", async () => {
    moving();
    renderHook(() => watch(ADDRESS));
    await settle();
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

  it("useAgentViewLive holds while mounted and lets go on unmount", async () => {
    moving();
    renderHook(() => watch(ADDRESS));
    await settle();
    await sync(3);
    const { unmount } = renderHook(() => useAgentViewLive(true));
    await tick();
    expect(reads).toEqual([null, "3"]);
    unmount();
    await tick(VIEW_FAST_MS * 3);
    expect(reads).toEqual([null, "3"]);
  });
});
