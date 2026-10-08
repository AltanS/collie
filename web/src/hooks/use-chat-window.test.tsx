import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { useChatWindow } from "./use-chat-window";
import { latchLost, markWake, noteNetworkFailure, noteReadStart } from "@/lib/connection-health";
import { loadChatTail, saveChatTail } from "@/lib/chat-tail";
import { paneScopeKey } from "@/lib/scope";
import { __resetStore, getRecord } from "@/lib/store";
import { wipeDevice } from "@/lib/wipe";
import { server } from "@/test/setup";
import type { ChatEntry, PaneChatResponse } from "@/lib/types";

// The half of Chat that cannot be pure: a cursor, a fetch, and the answer handed to `mergeChat`.
//
// The load-bearing behaviours are all about WHEN it asks and WHAT it asks for. It rides the poll's
// own loading→idle edge and starts no timer of its own; it carries the cursor it holds, so a second
// ask is a delta rather than a re-read; and a pane it is not enabled for costs nothing at all.

// useChatWindow reads useRevalidator(); drive its state directly, the way use-polling.test does.
interface RevalidatorState {
  state: "idle" | "loading";
}
const rr = vi.hoisted((): RevalidatorState => ({ state: "idle" }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: rr.state, revalidate: vi.fn() }),
}));

const GEN = 1_759_000_000_000;
const BASE = 1_000_000;

function entry(uuid: string, seq: number, text: string): ChatEntry {
  return { uuid, seq, ts: "", role: "assistant", parts: [{ kind: "text", text }] };
}

/** Every chat request this suite saw, in order, as the query string the hook built. */
function recordChat(answers: PaneChatResponse[]): string[] {
  const seen: string[] = [];
  let turn = 0;
  server.use(
    http.get(/\/api\/pane\/[^/]+\/chat/, ({ request }) => {
      seen.push(new URL(request.url).search);
      const body = answers[Math.min(turn, answers.length - 1)]!;
      turn += 1;
      return HttpResponse.json(body);
    }),
  );
  return seen;
}

const firstPage: PaneChatResponse = {
  paneId: "w1:p1",
  available: true,
  page: "live",
  gen: GEN,
  rev: 4,
  head: BASE,
  oldest: BASE,
  hasOlder: false,
  upserts: [entry("a", BASE, "hello")],
};

beforeEach(() => {
  rr.state = "idle";
});

describe("useChatWindow", () => {
  it("asks nothing at all while it is disabled", async () => {
    const seen = recordChat([firstPage]);
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: false }));
    await waitFor(() => expect(result.current.window.status.kind).toBe("empty"));
    expect(seen).toEqual([]);
  });

  it("asks for a first page with no cursor, then carries the one it holds", async () => {
    const seen = recordChat([
      firstPage,
      { ...firstPage, rev: 5, head: BASE + 1, upserts: [entry("b", BASE + 1, "again")] },
    ]);
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    expect(seen).toEqual([""]);

    // One poll: loading, then idle again. That edge is the whole cadence — there is no timer here.
    rr.state = "loading";
    rerender();
    rr.state = "idle";
    rerender();
    await waitFor(() => expect(result.current.window.entries).toHaveLength(2));
    expect(seen[1]).toBe(`?after=${GEN}%3A4`);
  });

  it("reads a 404 as a machine a release behind, never as an empty session", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => new HttpResponse(null, { status: 404 })));
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.status.kind).toBe("stale"));
  });

  it("reads an ordinary empty answer as a pane with nothing to show", async () => {
    recordChat([{ paneId: "w1:p1", available: false, reason: "no-session" }]);
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() =>
      expect(result.current.window.status).toEqual({ kind: "unavailable", reason: "no-session" }),
    );
  });

  it("keeps what it holds when the bridge stops answering", async () => {
    let fail = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/chat/, () =>
        fail ? HttpResponse.error() : HttpResponse.json(firstPage),
      ),
    );
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));

    fail = true;
    rr.state = "loading";
    rerender();
    rr.state = "idle";
    rerender();
    // Nothing is unsaid by a failed read, and nothing is announced: the connection strip above the
    // header is the app's one answer to "the bridge is not answering".
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    expect(result.current.window.status.kind).toBe("live");
  });

  it("asks for the page before the oldest turn it holds, by BOTH of its names", async () => {
    const seen = recordChat([
      { ...firstPage, oldest: BASE, hasOlder: true },
      {
        paneId: "w1:p1",
        available: true,
        page: "older",
        gen: GEN,
        hasOlder: false,
        upserts: [entry("z", BASE - 1, "earlier")],
      },
    ]);
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.hasOlder).toBe(true));

    result.current.loadOlder();
    await waitFor(() => expect(result.current.window.entries).toHaveLength(2));
    expect(seen[1]).toBe(`?limit=40&before=${BASE}%3Aa`);
    expect(result.current.window.entries[0]!.uuid).toBe("z");
    expect(result.current.window.hasOlder).toBe(false);
  });

  it("has nothing to ask for when the window says there is nothing older", async () => {
    const seen = recordChat([firstPage]);
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    result.current.loadOlder();
    await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    expect(seen).toEqual([""]);
  });

  // A window belongs to the pane it was read from: `w1:p1` is a different terminal on every machine
  // and in every session, and merging one machine's turns into another's is the whole hazard.
  it("drops what it holds the moment the pane changes, before it paints", async () => {
    recordChat([firstPage]);
    const { result, rerender } = renderHook(
      ({ paneId }: { paneId: string }) => useChatWindow({ paneId, enabled: true }),
      { initialProps: { paneId: "w1:p1" } },
    );
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    rerender({ paneId: "w2:p1" });
    expect(result.current.window.entries).toEqual([]);
    expect(result.current.window.status.kind).toBe("empty");
  });
});

// ── THE SAVED COPY (M46 spec 09, lib/chat-tail.ts) ────────────────────────────
// Each live answer writes the newest turns through; a read that fails for want of a bridge reads them
// back into an empty window, marked with `savedAt`. Store-backed: jsdom has no IndexedDB, so these run
// on the store's memory map, which the test setup resets before every case.
describe("useChatWindow — the saved Chat tail", () => {
  const DISPLAY_PREFS = "collie:display-prefs:v4";
  const failChat = () => server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => HttpResponse.error()));

  /** One poll: the revalidator goes loading, then idle again. */
  function poll(rerender: () => void): void {
    rr.state = "loading";
    rerender();
    rr.state = "idle";
    rerender();
  }

  it("draws the stale saved copy, dated, when the bridge does not answer, and a live answer replaces it", async () => {
    const at = Date.now() - 3_600_000;
    await saveChatTail(undefined, "w1:p1", [entry("s", 5, "saved turn")], "1d", at);
    let fail = true;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/chat/, () => (fail ? HttpResponse.error() : HttpResponse.json(firstPage))),
    );
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.savedAt).toBe(at));
    expect(result.current.window.entries.map((e) => e.uuid)).toEqual(["s"]);
    expect(result.current.window.status.kind).toBe("live");
    expect(result.current.window.hasOlder).toBe(false);
    expect(result.current.tried).toBe(true);

    fail = false;
    poll(rerender);
    await waitFor(() => expect(result.current.window.savedAt).toBeNull());
    expect(result.current.window.entries.map((e) => e.uuid)).toEqual(["a"]);
  });

  it("reads nothing back on a refusal: a 403 is an answer, not an outage (stale)", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("s", 5, "saved turn")], "1d");
    server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => new HttpResponse("nope", { status: 403 })));
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.tried).toBe(true));
    expect(result.current.window.entries).toEqual([]);
    expect(result.current.window.savedAt).toBeNull();
  });

  // M46 pass 3: a failed poll never drops what the window holds. A read that got NO answer (a network
  // failure, the poll deadline) marks it at once; a 5xx needs a second one in a row.
  it("keeps the turns it holds and marks them at once when a read gets no answer", async () => {
    let fail = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/chat/, () => (fail ? HttpResponse.error() : HttpResponse.json(firstPage))),
    );
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    const answeredAt = Date.now();

    fail = true;
    poll(rerender);
    await waitFor(() => expect(result.current.window.savedAt).toBeTypeOf("number"));
    // Dated by the last live answer, and every turn still held: memory, not the store.
    expect(result.current.window.savedAt!).toBeLessThanOrEqual(answeredAt);
    expect(result.current.window.entries.map((e) => e.uuid)).toEqual(["a"]);
  });

  it("the two-failure rule: one 5xx marks nothing, the second in a row marks the window", async () => {
    let status = 200;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/chat/, () =>
        status === 200 ? HttpResponse.json(firstPage) : new HttpResponse("bad gateway", { status }),
      ),
    );
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));

    status = 502;
    poll(rerender);
    await waitFor(() => expect(result.current.asked).toBe(2));
    await waitFor(() => expect(result.current.tried).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A blip: nothing is marked and nothing is dropped.
    expect(result.current.window.savedAt).toBeNull();
    expect(result.current.window.entries).toHaveLength(1);

    poll(rerender);
    await waitFor(() => expect(result.current.window.savedAt).toBeTypeOf("number"));
    expect(result.current.window.entries).toHaveLength(1);

    // The mark stays until a live answer, and the live answer clears it.
    status = 200;
    poll(rerender);
    await waitFor(() => expect(result.current.window.savedAt).toBeNull());
  });

  it("a 5xx between two good reads resets the count", async () => {
    const answers = [200, 502, 200, 502];
    let turn = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/chat/, () => {
        const status = answers[Math.min(turn, answers.length - 1)]!;
        turn += 1;
        return status === 200 ? HttpResponse.json(firstPage) : new HttpResponse("bad gateway", { status });
      }),
    );
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    for (let i = 0; i < 3; i++) {
      poll(rerender);
      await waitFor(() => expect(result.current.asked).toBe(i + 2));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(result.current.window.savedAt).toBeNull();
  });

  // 2026-10-08: right after a wake the herd read's first failure is one strike. The Chat read rides the
  // same poll, after the herd read, and must not mark the window over that strike; the retry decides.
  it("right after a wake, a read with no answer under the herd's strike marks nothing", async () => {
    let fail = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/chat/, () => (fail ? HttpResponse.error() : HttpResponse.json(firstPage))),
    );
    const { result, rerender } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));

    act(() => markWake());
    act(() => {
      noteReadStart();
      noteNetworkFailure();
    });
    fail = true;
    poll(rerender);
    await waitFor(() => expect(result.current.asked).toBe(2));
    await waitFor(() => expect(result.current.tried).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.window.savedAt).toBeNull();
    expect(result.current.window.entries).toHaveLength(1);

    // The retry's herd read gets no answer either: that latches, and the latch marks the window.
    act(() => {
      noteReadStart();
      noteNetworkFailure();
    });
    await waitFor(() => expect(result.current.window.savedAt).toBeTypeOf("number"));
  });

  it("marks what it holds the moment the herd read latches the outage, before its own read fails", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => HttpResponse.json(firstPage)));
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    act(() => latchLost());
    await waitFor(() => expect(result.current.window.savedAt).toBeTypeOf("number"));
    expect(result.current.window.entries).toHaveLength(1);
  });

  it("an empty window reads its saved copy at once when the pane is already the saved copy", async () => {
    const at = Date.now() - 60_000;
    await saveChatTail(undefined, "w1:p1", [entry("s", 5, "saved turn")], "1d", at);
    // The read never answers, the way a request into a VPN with the radio off does not.
    server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true, savedCopy: true }));
    await waitFor(() => expect(result.current.window.savedAt).toBe(at));
    expect(result.current.window.entries.map((e) => e.uuid)).toEqual(["s"]);
    expect(result.current.tried).toBe(false);
  });

  it("a pairing refusal takes back a saved copy the cold open drew", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("s", 5, "saved turn")], "1d");
    let answer: () => void = () => {};
    server.use(
      http.get(
        /\/api\/pane\/[^/]+\/chat/,
        () =>
          new Promise<Response>((resolve) => {
            answer = () => resolve(new HttpResponse("device not paired", { status: 403 }));
          }),
      ),
    );
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true, savedCopy: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    answer();
    await waitFor(() => expect(result.current.window.entries).toEqual([]));
    expect(result.current.window.savedAt).toBeNull();
  });

  it("writes the rendered entries through, never the raw mirror", async () => {
    recordChat([firstPage]);
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    await waitFor(async () => expect(await loadChatTail(undefined, "w1:p1")).not.toBeNull());
    const record = await getRecord("chat-tail", paneScopeKey(undefined, "w1:p1"));
    expect(record?.value).toEqual({ v: 1, entries: [entry("a", BASE, "hello")] });
    // The hook writes no mirror text of its own: the only pane-text writer is the loader.
    expect(await getRecord("pane-text", paneScopeKey(undefined, "w1:p1"))).toBeNull();
  });

  it("honours the setting: off writes nothing", async () => {
    localStorage.setItem(DISPLAY_PREFS, JSON.stringify({ keepChat: "off" }));
    recordChat([firstPage]);
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
  });

  it("honours the setting: 7 days outlives a day, 1 day does not", async () => {
    let clock = Date.now();
    __resetStore({ now: () => clock });
    localStorage.setItem(DISPLAY_PREFS, JSON.stringify({ keepChat: "7d" }));
    recordChat([firstPage]);
    const { result, unmount } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.window.entries).toHaveLength(1));
    await waitFor(async () => expect(await loadChatTail(undefined, "w1:p1")).not.toBeNull());
    unmount();

    localStorage.setItem(DISPLAY_PREFS, JSON.stringify({ keepChat: "1d" }));
    const second = renderHook(() => useChatWindow({ paneId: "w1:p2", enabled: true }));
    await waitFor(() => expect(second.result.current.window.entries).toHaveLength(1));
    await waitFor(async () => expect(await loadChatTail(undefined, "w1:p2")).not.toBeNull());

    clock += 2 * 24 * 3_600_000;
    expect(await loadChatTail(undefined, "w1:p1")).not.toBeNull();
    expect(await loadChatTail(undefined, "w1:p2")).toBeNull();
  });

  it("is gone after a wipe, and a failed read then draws nothing", async () => {
    await saveChatTail(undefined, "w1:p1", [entry("s", 5, "saved turn")], "1d");
    await wipeDevice("unpair");
    failChat();
    const { result } = renderHook(() => useChatWindow({ paneId: "w1:p1", enabled: true }));
    await waitFor(() => expect(result.current.tried).toBe(true));
    expect(result.current.window.entries).toEqual([]);
  });
});
