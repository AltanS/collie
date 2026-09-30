import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { useChatWindow } from "./use-chat-window";
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
