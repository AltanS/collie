import {
  BURST_MIN_POLLS,
  BURST_QUIET_POLLS,
  burstApplies,
  burstOnPoll,
  burstOnSend,
  burstPaneId,
  burstState,
  consumeTopologyPoll,
  isFollowing,
  lastPollChanged,
  markPollResult,
  NO_BURST,
  resetPollIntent,
  sendCount,
  setFollowing,
  stampSend,
  stampTopology,
  topologyBursting,
} from "./poll-intent";

// The burst rules are counted in POLLS, so they are testable without a clock at all — which is the
// point of keeping the bookkeeping pure and separate from the store.

beforeEach(() => {
  resetPollIntent();
});

describe("burst bookkeeping", () => {
  it("a send starts a burst on that pane", () => {
    const b = burstOnSend("w1:p1");
    expect(b).toEqual({ paneId: "w1:p1", polls: 0, quiet: 0 });
  });

  it("survives BURST_MIN_POLLS unchanged polls however quiet the pane is", () => {
    let b = burstOnSend("w1:p1");
    for (let i = 0; i < BURST_MIN_POLLS - 1; i += 1) b = burstOnPoll(b, false);
    expect(b.paneId).toBe("w1:p1"); // the minimum is a floor, not a target
  });

  it("ends on the poll where the minimum is met AND the quiet run is complete", () => {
    let b = burstOnSend("w1:p1");
    for (let i = 0; i < BURST_MIN_POLLS; i += 1) b = burstOnPoll(b, false);
    expect(b).toBe(NO_BURST);
  });

  it("needs BURST_QUIET_POLLS consecutive unchanged polls, not just one", () => {
    let b = burstOnSend("w1:p1");
    // Past the minimum, still changing every poll: one quiet poll must not end it.
    for (let i = 0; i < BURST_MIN_POLLS + 3; i += 1) b = burstOnPoll(b, true);
    b = burstOnPoll(b, false);
    expect(b.paneId).toBe("w1:p1");
    expect(b.quiet).toBe(1);
    b = burstOnPoll(b, false);
    expect(b).toBe(NO_BURST);
  });

  it("a changed poll resets the quiet run", () => {
    let b = burstOnSend("w1:p1");
    for (let i = 0; i < BURST_MIN_POLLS; i += 1) b = burstOnPoll(b, true);
    b = burstOnPoll(b, false);
    b = burstOnPoll(b, true); // the screen moved again
    expect(b.quiet).toBe(0);
    expect(b.paneId).toBe("w1:p1");
  });

  it("a new send restarts the counters, so each tap buys its own full minimum", () => {
    let b = burstOnSend("w1:p1");
    for (let i = 0; i < BURST_MIN_POLLS - 1; i += 1) b = burstOnPoll(b, false);
    b = burstOnSend("w1:p1");
    expect(b).toEqual({ paneId: "w1:p1", polls: 0, quiet: 0 });
    for (let i = 0; i < BURST_MIN_POLLS - 1; i += 1) b = burstOnPoll(b, false);
    expect(b.paneId).toBe("w1:p1");
  });

  it("polling an ended burst is a no-op", () => {
    expect(burstOnPoll(NO_BURST, false)).toBe(NO_BURST);
    expect(burstOnPoll(NO_BURST, true)).toBe(NO_BURST);
  });

  it("counts the quiet polls even before the minimum, so the run can already be complete", () => {
    // BURST_QUIET_POLLS is smaller than BURST_MIN_POLLS, so a wholly silent pane ends exactly at
    // the minimum — never later.
    expect(BURST_QUIET_POLLS).toBeLessThan(BURST_MIN_POLLS);
  });

  it("only applies to the pane that was sent to, and only while it is open", () => {
    const b = burstOnSend("w1:p1");
    expect(burstApplies(b, "w1:p1")).toBe(true);
    expect(burstApplies(b, "w1:p2")).toBe(false);
    expect(burstApplies(b, null)).toBe(false); // home screen
    expect(burstApplies(b, undefined)).toBe(false);
    expect(burstApplies(NO_BURST, "w1:p1")).toBe(false);
  });
});

describe("the store", () => {
  it("starts with no burst, following, and nothing known about the last poll", () => {
    expect(burstPaneId()).toBeNull();
    expect(isFollowing()).toBe(true);
    expect(lastPollChanged()).toBe(false);
    expect(sendCount()).toBe(0);
  });

  it("stampSend arms the burst and bumps the reschedule counter", () => {
    stampSend("w1:p1");
    expect(burstPaneId()).toBe("w1:p1");
    expect(sendCount()).toBe(1);
    stampSend("w1:p1");
    expect(sendCount()).toBe(2);
  });

  it("markPollResult drives both the change flag and the burst", () => {
    stampSend("w1:p1");
    markPollResult(true);
    expect(lastPollChanged()).toBe(true);
    expect(burstState().quiet).toBe(0);
    for (let i = 0; i < BURST_MIN_POLLS; i += 1) markPollResult(false);
    expect(lastPollChanged()).toBe(false);
    expect(burstPaneId()).toBeNull(); // the burst spent itself on the quiet polls
  });

  it("carries the pane view's follow intent", () => {
    setFollowing(false);
    expect(isFollowing()).toBe(false);
    setFollowing(true);
    expect(isFollowing()).toBe(true);
  });
});

// A create or a close is not spent on any one pane — whichever view is on screen (a tab strip, the
// dashboard) needs the catch-up, so this buys a fixed run of fast polls outright rather than a
// pane-scoped burst.
describe("stampTopology", () => {
  it("starts owed and bumps the reschedule counter, same as a send", () => {
    stampTopology();
    expect(topologyBursting()).toBe(true);
    expect(sendCount()).toBe(1);
    stampTopology();
    expect(sendCount()).toBe(2);
  });

  it("ends after exactly BURST_MIN_POLLS consumed polls", () => {
    stampTopology();
    for (let i = 0; i < BURST_MIN_POLLS - 1; i += 1) {
      consumeTopologyPoll();
      expect(topologyBursting()).toBe(true);
    }
    consumeTopologyPoll();
    expect(topologyBursting()).toBe(false);
  });

  it("consuming past zero is a no-op", () => {
    consumeTopologyPoll();
    expect(topologyBursting()).toBe(false);
  });

  it("a second stamp mid-burst restarts the full budget", () => {
    stampTopology();
    consumeTopologyPoll();
    consumeTopologyPoll();
    stampTopology();
    for (let i = 0; i < BURST_MIN_POLLS - 1; i += 1) {
      consumeTopologyPoll();
      expect(topologyBursting()).toBe(true);
    }
    consumeTopologyPoll();
    expect(topologyBursting()).toBe(false);
  });
});
