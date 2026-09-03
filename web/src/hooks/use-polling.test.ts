import { act, renderHook } from "@testing-library/react";

import {
  BURST_MS,
  HOME_BUSY_MS,
  HOT_MS,
  IDLE_MS,
  SUPERSEDE_MS,
  intervalFor,
  type PollIntent,
  usePolling,
} from "./use-polling";
import { isCatchingUp, resetIdleLock, setLocked } from "@/lib/idle";
import {
  BURST_MIN_POLLS,
  markPollResult,
  resetPollIntent,
  setFollowing,
  stampSend,
  stampTopology,
} from "@/lib/poll-intent";
import type { HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";

// usePolling reads useRevalidator(); drive its state/revalidate directly (hoisted so the vi.mock
// factory can close over the holder). intervalFor is pure and doesn't touch it.
interface RevalidatorState {
  state: "idle" | "loading";
  revalidate: ReturnType<typeof vi.fn>;
}
const rr = vi.hoisted((): RevalidatorState => ({ state: "idle", revalidate: vi.fn() }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: rr.state, revalidate: rr.revalidate }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(paneId: string, status: AgentView["status"]): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/",
    focused: false,
  };
}

function makeShell(paneId: string): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "shell",
    status: "unknown",
    cwd: "/",
    focused: false,
    kind: "shell",
  };
}

function makeData(agents: AgentView[], shellPanes: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes,
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

// The cadence tests read the constants, never a copy of their values: the numbers are a judgement
// call that may be re-tuned (issue #156), and what must not change is the BEHAVIOUR around them.
const HOT = HOT_MS;

/** An intent with nothing happening — each test names only what it changes. */
function on(over: Partial<PollIntent> = {}): PollIntent {
  return { bursting: false, following: true, changed: false, ...over };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The five rules of the cadence, in the order `intervalFor` applies them. The question they answer
// together is "is the operator watching something happen", never "is anything happening anywhere".
describe("intervalFor", () => {
  const idlePane = makeData([makeAgent("w1:p1", "idle")]);
  const workingPane = makeData([makeAgent("w1:p1", "working")]);
  const blockedPane = makeData([makeAgent("w1:p1", "blocked")]);
  const shell = makeData([], [makeShell("w1:s1")]);
  const elsewhere = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p9", "working")]);

  it("rule 0 — a topology burst wins even on the home screen with an idle herd", () => {
    expect(intervalFor(idlePane, null, on({ topologyBursting: true }))).toBe(BURST_MS);
    expect(intervalFor(undefined, undefined, on({ topologyBursting: true }))).toBe(BURST_MS);
  });

  it("rule 1 — a burst on the open pane wins over everything else", () => {
    expect(intervalFor(idlePane, "w1:p1", on({ bursting: true }))).toBe(BURST_MS);
    // Even scrolled up, and even with nothing changing: you just typed, so watch it land.
    expect(intervalFor(idlePane, "w1:p1", on({ bursting: true, following: false }))).toBe(BURST_MS);
  });

  it("rule 2 — the open, followed pane's own agent is working or blocked", () => {
    expect(intervalFor(workingPane, "w1:p1", on())).toBe(HOT);
    expect(intervalFor(blockedPane, "w1:p1", on())).toBe(HOT);
  });

  it("rule 2 does not fire for a BUSY AGENT SOMEWHERE ELSE", () => {
    // Another workspace's working agent is the notification path's business, not a reason to poll
    // the pane you are reading at 1.5s — and with a pane open, rule 4 does not answer either.
    expect(intervalFor(elsewhere, "w1:p1", on())).toBe(IDLE_MS);
  });

  it("rule 3 — a changed poll keeps a followed pane hot, an unchanged one lets it go", () => {
    // Covers a plain shell and any harness that publishes no status at all.
    expect(intervalFor(shell, "w1:s1", on({ changed: true }))).toBe(HOT);
    expect(intervalFor(shell, "w1:s1", on({ changed: false }))).toBe(IDLE_MS);
  });

  it("rule 4 — the home screen over a busy herd polls at HOME_BUSY_MS", () => {
    // Nobody is on a mirror, so nothing needs to be smooth; the dashboard row still has to show a
    // status flip without feeling stuck.
    expect(intervalFor(elsewhere, null, on())).toBe(HOME_BUSY_MS);
    expect(intervalFor(elsewhere, undefined, on())).toBe(HOME_BUSY_MS);
    expect(intervalFor(blockedPane, null, on())).toBe(HOME_BUSY_MS);
    // An absent intent is a legitimate caller (PackProvider asks for the gap alone).
    expect(intervalFor(elsewhere, null)).toBe(HOME_BUSY_MS);
  });

  it("rule 5 — the home screen over an idle herd backs off to IDLE_MS", () => {
    expect(intervalFor(idlePane, null, on())).toBe(IDLE_MS);
    expect(intervalFor(makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "done")]))).toBe(
      IDLE_MS,
    );
    expect(intervalFor(undefined)).toBe(IDLE_MS);
  });

  it("rule 5 — a scrolled-up pane and a quiet idle pane back off too", () => {
    expect(intervalFor(workingPane, "w1:p1", on({ following: false }))).toBe(IDLE_MS);
    expect(intervalFor(shell, "w1:s1", on({ changed: true, following: false }))).toBe(IDLE_MS);
    expect(intervalFor(idlePane, "w1:p1", on())).toBe(IDLE_MS);
  });

  it("a pane the snapshot no longer knows about is not 'open'", () => {
    expect(intervalFor(idlePane, "w99:phantom", on({ changed: true }))).toBe(IDLE_MS);
  });
});

// The self-heal: a revalidation wedged in "loading" (a black-holed fetch) would otherwise no-op
// every future tick, since the fast-path only revalidates while idle. Once it has been loading past
// SUPERSEDE_MS, a tick kicks a fresh revalidate() to supersede the hung one.
describe("usePolling — superseding a wedged revalidation", () => {
  // The hot scenario, stated the way the cadence states it: the operator is on this pane, pinned to
  // its tail (the store's default), and its own agent is working. That is rule 2 → HOT_MS.
  const HOT_PANE = "w1:p1";
  const hotData = () => makeData([makeAgent(HOT_PANE, "working")]);

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockClear();
    resetPollIntent();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT revalidate on a tick before SUPERSEDE_MS has elapsed", () => {
    rr.state = "loading"; // stuck loading from the very first render
    renderHook(() => usePolling(hotData(), HOT_PANE));
    vi.advanceTimersByTime(SUPERSEDE_MS - 1); // several HOT ticks, all still within the grace window
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("DOES revalidate once a load has been stuck past SUPERSEDE_MS", () => {
    rr.state = "loading";
    renderHook(() => usePolling(hotData(), HOT_PANE));
    vi.advanceTimersByTime(SUPERSEDE_MS); // a tick now sees the load has aged past the threshold
    expect(rr.revalidate).toHaveBeenCalled();
  });

  // The gap between ticks is what an operator waits for after a key tap, so it is pinned to the
  // constant exactly: nothing before HOT_MS, one revalidation at HOT_MS, one more each HOT_MS after.
  it("ticks at exactly HOT_MS while the followed pane's agent works", () => {
    rr.state = "idle";
    renderHook(() => usePolling(hotData(), HOT_PANE));

    vi.advanceTimersByTime(HOT_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOT_MS * 3);
    expect(rr.revalidate).toHaveBeenCalledTimes(4);
  });

  // Cooling: the open pane's agent goes idle and its mirror is not moving, so the gap opens to
  // IDLE_MS. The hot gap must buy nothing there — no tick until the full idle interval has passed.
  it("ticks at exactly IDLE_MS once the open pane goes quiet, and re-arms the hot gap when it works again", () => {
    rr.state = "idle";
    const { rerender } = renderHook(({ data }: { data: HomeData }) => usePolling(data, HOT_PANE), {
      initialProps: { data: makeData([makeAgent(HOT_PANE, "idle")]) },
    });

    vi.advanceTimersByTime(HOT_MS);
    expect(rr.revalidate).not.toHaveBeenCalled(); // quiet: the hot gap is not enough
    vi.advanceTimersByTime(IDLE_MS - HOT_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);

    rr.revalidate.mockClear();
    act(() => rerender({ data: hotData() })); // the agent starts working — back to the hot gap
    vi.advanceTimersByTime(HOT_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("still uses the plain idle fast-path when not loading", () => {
    rr.state = "idle";
    renderHook(() => usePolling(hotData(), HOT_PANE));
    vi.advanceTimersByTime(HOT_MS); // one HOT tick
    expect(rr.revalidate).toHaveBeenCalled();
  });

  // The idle lock pauses polling rather than unmounting the route tree, so the tick is the only thing
  // holding the socket off while the cover is up — and releasing it must refetch AT ONCE, since no
  // loader re-runs on its own with the tree still mounted.
  it("does not tick while idle-locked", () => {
    rr.state = "idle";
    setLocked(true);
    try {
      renderHook(() => usePolling(hotData(), HOT_PANE));
      vi.advanceTimersByTime(HOT_MS * 5); // several HOT intervals behind the cover
      expect(rr.revalidate).not.toHaveBeenCalled();
    } finally {
      resetIdleLock();
    }
  });

  it("revalidates immediately when the lock is released", () => {
    rr.state = "idle";
    setLocked(true);
    try {
      const { rerender } = renderHook(() => usePolling(hotData(), HOT_PANE));
      expect(rr.revalidate).not.toHaveBeenCalled();
      act(() => setLocked(false));
      rerender();
      expect(rr.revalidate).toHaveBeenCalled(); // no waiting out an interval
    } finally {
      resetIdleLock();
    }
  });

  // The cover outlives the lock by exactly one refetch: releasing enters the catch-up beat, and only
  // the revalidator coming to rest ends it. Without this the cover would drop straight back onto the
  // frozen screen it just warned about.
  it("holds the catch-up beat from release until the revalidation settles", () => {
    rr.state = "idle";
    setLocked(true);
    try {
      const { rerender } = renderHook(() => usePolling(hotData(), HOT_PANE));
      act(() => setLocked(false));
      rerender();
      expect(isCatchingUp()).toBe(true);

      rr.state = "loading"; // the refetch is in flight — still covered
      rerender();
      expect(isCatchingUp()).toBe(true);

      rr.state = "idle"; // settled — the cover can go
      rerender();
      expect(isCatchingUp()).toBe(false);
    } finally {
      resetIdleLock();
    }
  });

  // Regression: some phones report navigator.onLine === false even when the network is fine (it stuck
  // false after an airplane-mode toggle). The tick must NOT gate on it — otherwise polling wedges
  // forever and the app can never discover the connection came back. A stuck-false flag still polls.
  it("keeps polling even when navigator.onLine reports false (the flag can lie — never wedge)", () => {
    rr.state = "idle";
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      renderHook(() => usePolling(hotData(), HOT_PANE));
      vi.advanceTimersByTime(HOT_MS); // one HOT tick with the flag stuck false
      expect(rr.revalidate).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "onLine"); // restore the prototype getter
    }
  });
});


// The hook half: the intent is read from lib/poll-intent, and a send must not have to wait out a
// gap that was timed for an idle pane.
describe("usePolling — bursts and the follow intent", () => {
  const openPane = () => makeData([makeAgent("w1:p1", "idle")]);

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockClear();
    resetPollIntent();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPollIntent();
  });

  it("backs off to IDLE_MS on a quiet open pane", () => {
    renderHook(() => usePolling(openPane(), "w1:p1"));
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("polls at BURST_MS after a send to the open pane", () => {
    renderHook(() => usePolling(openPane(), "w1:p1"));
    act(() => stampSend("w1:p1"));

    vi.advanceTimersByTime(BURST_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("reschedules from the tap — a send never waits out the old gap", () => {
    renderHook(() => usePolling(openPane(), "w1:p1"));
    // Most of the way through a 6s idle gap…
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(rr.revalidate).not.toHaveBeenCalled();
    // …the operator taps a key. The next poll is BURST_MS from HERE, not 1000ms from here.
    act(() => stampSend("w1:p1"));
    vi.advanceTimersByTime(BURST_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("restarts the burst gap on a second send inside the burst", () => {
    renderHook(() => usePolling(openPane(), "w1:p1"));
    act(() => stampSend("w1:p1"));
    vi.advanceTimersByTime(BURST_MS - 100); // 100ms short of the poll this send bought
    act(() => stampSend("w1:p1")); // a second tap: the gap starts over
    vi.advanceTimersByTime(99);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BURST_MS - 99);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("lets the burst go after its quiet polls and returns to the idle gap", () => {
    const { rerender } = renderHook(() => usePolling(openPane(), "w1:p1"));
    act(() => stampSend("w1:p1"));
    act(() => {
      for (let i = 0; i < 5; i += 1) markPollResult(false); // BURST_MIN_POLLS quiet reads
    });
    rerender();
    rr.revalidate.mockClear();
    vi.advanceTimersByTime(BURST_MS * 4);
    expect(rr.revalidate).not.toHaveBeenCalled(); // back on the slow gap
    vi.advanceTimersByTime(IDLE_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not spend a burst on a pane the operator has left", () => {
    renderHook(() => usePolling(openPane(), null)); // home screen
    act(() => stampSend("w1:p1"));
    vi.advanceTimersByTime(BURST_MS * 4);
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("polls at BURST_MS after a topology write, even on the home screen", () => {
    renderHook(() => usePolling(openPane(), null)); // home screen — no pane open
    act(() => stampTopology());

    vi.advanceTimersByTime(BURST_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("a topology write reschedules from the stamp, like a send does", () => {
    renderHook(() => usePolling(openPane(), null));
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(rr.revalidate).not.toHaveBeenCalled();
    act(() => stampTopology());
    vi.advanceTimersByTime(BURST_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("the topology burst spends itself after BURST_MIN_POLLS polls and backs off", () => {
    renderHook(() => usePolling(openPane(), null));
    act(() => stampTopology());
    // Run through the burst's own budget of fast polls. Each advance is its own `act` so the state
    // update the tick makes (consumeTopologyPoll) is flushed and the interval rescheduled — a tick
    // fires from inside the effect's own setInterval callback, not from test code, so nothing else
    // would flush it between iterations.
    for (let i = 0; i < BURST_MIN_POLLS; i += 1) {
      act(() => {
        vi.advanceTimersByTime(BURST_MS);
      });
    }
    expect(rr.revalidate).toHaveBeenCalledTimes(BURST_MIN_POLLS);
    rr.revalidate.mockClear();
    // Spent — the herd is idle and no pane is open, so the gap is back to IDLE_MS.
    vi.advanceTimersByTime(BURST_MS * 4);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDLE_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("reads the follow intent the pane view publishes", () => {
    const working = makeData([makeAgent("w1:p1", "working")]);
    const { rerender } = renderHook(() => usePolling(working, "w1:p1"));
    vi.advanceTimersByTime(HOT); // following (the default): the working pane is hot
    expect(rr.revalidate).toHaveBeenCalledTimes(1);

    rr.revalidate.mockClear();
    act(() => setFollowing(false)); // scrolled up to read backscroll
    rerender();
    vi.advanceTimersByTime(HOT * 3);
    expect(rr.revalidate).not.toHaveBeenCalled(); // frozen mirror, slow poll
  });

});
