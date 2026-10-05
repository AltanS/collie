import { act, renderHook } from "@testing-library/react";

import { LAST_RESORT_NO_JOURNAL_MS } from "@/lib/chat-gate";
import type { AgentStatus } from "@/lib/types";
import { NO_RECORD, activityOf, nextRecord, nextSeen, usePaneStart } from "./use-pane-start";

// What the Chat gate needs about how an agent began, and the one rule that keeps it honest: it
// belongs to ONE agent in ONE pane, so anything that starts another one starts over. Every reading
// moves on an EVENT read off a snapshot; the only clock is the last resort, tested last.
describe("nextSeen", () => {
  it("first sight of an idle agent is fresh, of a busy or unknown one is not", () => {
    expect(nextSeen(null, "p", "codex", false, "idle")?.history).toBe("fresh");
    for (const s of ["working", "blocked", "done", "unknown"] as const) {
      expect(nextSeen(null, "p", "claude", false, s)?.history).toBe("unknown");
    }
  });

  it("a shell this view watched turn into an agent is fresh, whatever its status", () => {
    const shell = nextSeen(null, "p", "shell", true, "unknown");
    expect(nextSeen(shell, "p", "claude", false, "working")?.history).toBe("fresh");
  });

  it("keeps the record while nothing that starts a new one moved, and while the pane is missing", () => {
    const rec = nextSeen(null, "p", "pi", false, "idle");
    expect(nextSeen(rec, "p", "pi", false, "working")).toBe(rec);
    expect(nextSeen(rec, "p", undefined, false, undefined)).toBe(rec);
  });

  it("a pane switch to a pane not in the snapshot drops the record", () => {
    const rec = nextSeen(null, "p", "pi", false, "idle");
    expect(nextSeen(rec, "q", undefined, false, undefined)).toBeNull();
  });
});

describe("nextRecord: the events, as latches", () => {
  const step = (prev: typeof NO_RECORD, status: AgentStatus, asked = 0) =>
    nextRecord(prev, "p", "pi", false, status, asked);

  it("idle is not an end: a fresh agent is idle before its first prompt", () => {
    const r = step(NO_RECORD, "idle");
    expect(activityOf(r)).toBe("none");
    expect(step(r, "idle")).toBe(r); // nothing moved, so the same object
  });

  it("working, then done, ends the first turn and takes the read count of that render as the mark", () => {
    let r = step(NO_RECORD, "idle");
    r = step(r, "working", 3);
    expect(activityOf(r)).toBe("working");
    r = step(r, "done", 4);
    expect(activityOf(r)).toBe("ended");
    expect(r.endMark).toBe(4);
    // The mark is taken once. Later renders with more reads do not move it.
    expect(step(r, "idle", 9).endMark).toBe(4);
  });

  it("working, then idle, is an end too, and `done` alone is one even if working was never seen", () => {
    expect(activityOf(step(step(step(NO_RECORD, "idle"), "working"), "idle"))).toBe("ended");
    expect(activityOf(step(step(NO_RECORD, "idle"), "done"))).toBe("ended");
  });

  it("a question is a latch that outranks the turn's end", () => {
    let r = step(step(NO_RECORD, "idle"), "blocked");
    expect(activityOf(r)).toBe("blocked");
    r = step(r, "working");
    expect(activityOf(r)).toBe("blocked");
    r = step(r, "done");
    expect(activityOf(r)).toBe("blocked");
  });

  it("a shell's statuses never count for the agent that replaces it", () => {
    let r = nextRecord(NO_RECORD, "p", "shell", true, "working", 0);
    r = nextRecord(r, "p", "shell", true, "done", 0);
    expect(r.endMark).toBeNull();
    r = nextRecord(r, "p", "codex", false, "idle", 0);
    expect(activityOf(r)).toBe("none");
  });
});

describe("usePaneStart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type P = {
    pane: string;
    harness: string | undefined;
    shell: boolean;
    status: AgentStatus | undefined;
    asked?: number;
    answered?: number;
    readable?: boolean;
  };
  const setup = (p: P) =>
    renderHook(
      (q: P) =>
        usePaneStart(q.pane, q.harness, q.shell, q.status, { asked: q.asked ?? 0, answered: q.answered ?? 0 }, q.readable ?? false),
      { initialProps: p },
    );
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const pi = { pane: "p", harness: "pi", shell: false } as const;

  it("settles only on an answer to a read started after the turn-end render", () => {
    const { result, rerender } = setup({ ...pi, status: "idle" });
    rerender({ ...pi, status: "working", asked: 2, answered: 2 });
    // The turn-end render: two reads started so far, both answered. Neither began after the end.
    rerender({ ...pi, status: "done", asked: 2, answered: 2 });
    expect(result.current).toMatchObject({ activity: "ended", settled: false });
    // The read the turn-end poll starts is number 3. Started, not answered: still waiting.
    rerender({ ...pi, status: "done", asked: 3, answered: 2 });
    expect(result.current.settled).toBe(false);
    // It answers: now the gate may decide on it.
    rerender({ ...pi, status: "done", asked: 3, answered: 3 });
    expect(result.current.settled).toBe(true);
  });

  it("a read in flight across the turn's end does not settle it; the next one does", () => {
    const { result, rerender } = setup({ ...pi, status: "working", asked: 5, answered: 4 });
    rerender({ ...pi, status: "done", asked: 5, answered: 4 }); // read 5 began BEFORE the end
    rerender({ ...pi, status: "done", asked: 5, answered: 5 }); // ...and its answer says nothing
    expect(result.current.settled).toBe(false);
    rerender({ ...pi, status: "done", asked: 6, answered: 6 });
    expect(result.current.settled).toBe(true);
  });

  it("the last resort fires only after a minute of work with nothing to read and no event", () => {
    const { result, rerender } = setup({ ...pi, status: "idle" });
    advance(LAST_RESORT_NO_JOURNAL_MS * 2); // idle: never armed
    expect(result.current.activity).toBe("none");
    rerender({ ...pi, status: "working" });
    advance(LAST_RESORT_NO_JOURNAL_MS - 1);
    expect(result.current.activity).toBe("working");
    advance(1);
    expect(result.current.activity).toBe("stalled");
  });

  it("the last resort is never armed while the log is readable, and an event disarms it", () => {
    const { result, rerender } = setup({ ...pi, status: "working", readable: true });
    advance(LAST_RESORT_NO_JOURNAL_MS * 2);
    expect(result.current.activity).toBe("working");
    rerender({ ...pi, status: "working", readable: false });
    advance(LAST_RESORT_NO_JOURNAL_MS - 1);
    rerender({ ...pi, status: "done", readable: false }); // the turn's end: an event, so no clock
    advance(LAST_RESORT_NO_JOURNAL_MS * 2);
    expect(result.current.activity).toBe("ended");
  });

  it("a prompt sent from this device arms the last resort on a harness whose status never moves", () => {
    const { result } = setup({ ...pi, status: "idle" });
    act(() => result.current.markSent());
    expect(result.current.activity).toBe("working");
    advance(LAST_RESORT_NO_JOURNAL_MS);
    expect(result.current.activity).toBe("stalled");
  });

  it("a prompt typed into the shell does not count for the agent it starts", () => {
    const { result, rerender } = setup({ pane: "p", harness: "shell", shell: true, status: "unknown" });
    act(() => result.current.markSent()); // `codex`, sent from the phone into the shell
    rerender({ pane: "p", harness: "codex", shell: false, status: "idle" });
    expect(result.current).toMatchObject({ history: "fresh", activity: "none" });
  });

  it("a pane switch starts a new record", () => {
    const { result, rerender } = setup({ ...pi, status: "working" });
    rerender({ ...pi, status: "done" });
    rerender({ pane: "q", harness: "pi", shell: false, status: "idle" });
    expect(result.current).toMatchObject({ history: "fresh", activity: "none", settled: false });
  });
});
