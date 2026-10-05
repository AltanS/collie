import { act, renderHook } from "@testing-library/react";

import { CHAT_GRACE_MS } from "@/lib/chat-gate";
import type { AgentStatus } from "@/lib/types";
import { nextSeen, usePaneStart } from "./use-pane-start";

// The two readings the Chat gate needs about how an agent began, and the one rule that keeps them
// honest: they belong to ONE agent in ONE pane, so anything that starts another one starts over.
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

describe("usePaneStart", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type P = { pane: string; harness: string | undefined; shell: boolean; status: AgentStatus | undefined };
  const setup = (p: P) =>
    renderHook((q: P) => usePaneStart(q.pane, q.harness, q.shell, q.status), { initialProps: p });
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("an idle agent has not worked; work starts the grace, and the grace ends once", () => {
    const { result, rerender } = setup({ pane: "p", harness: "codex", shell: false, status: "idle" });
    expect(result.current).toMatchObject({ history: "fresh", activity: "none" });
    rerender({ pane: "p", harness: "codex", shell: false, status: "working" });
    expect(result.current.activity).toBe("recent");
    advance(CHAT_GRACE_MS - 1);
    expect(result.current.activity).toBe("recent");
    advance(1);
    expect(result.current.activity).toBe("long");
    // Going idle again does not give the grace back: the pane has worked.
    rerender({ pane: "p", harness: "codex", shell: false, status: "idle" });
    expect(result.current.activity).toBe("long");
  });

  it("a prompt sent from this device starts the grace even while the status still reads idle", () => {
    const { result } = setup({ pane: "p", harness: "codex", shell: false, status: "idle" });
    act(() => result.current.markSent());
    expect(result.current.activity).toBe("recent");
  });

  it("a prompt typed into the shell does not count for the agent it starts", () => {
    const { result, rerender } = setup({ pane: "p", harness: "shell", shell: true, status: "unknown" });
    act(() => result.current.markSent()); // `codex`, sent from the phone into the shell
    rerender({ pane: "p", harness: "codex", shell: false, status: "idle" });
    expect(result.current).toMatchObject({ history: "fresh", activity: "none" });
  });

  it("a pane switch starts a new record", () => {
    const { result, rerender } = setup({ pane: "p", harness: "pi", shell: false, status: "working" });
    advance(CHAT_GRACE_MS);
    rerender({ pane: "q", harness: "pi", shell: false, status: "idle" });
    expect(result.current).toMatchObject({ history: "fresh", activity: "none" });
  });
});
