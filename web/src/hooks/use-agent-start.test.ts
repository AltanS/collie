import { act, renderHook } from "@testing-library/react";

import { useAgentStart } from "./use-agent-start";

// The edge, and only the edge. What this hook gets wrong in the obvious implementation is
// announcing a STATE instead of a CHANGE: opening a pane that has been running Claude for an hour
// reads exactly like a pane where Claude just started, and both say "this pane has an agent".
describe("useAgentStart", () => {
  const render = (paneId: string, harness: string | undefined, isShell: boolean) =>
    renderHook(({ p, h, s }: { p: string; h: string | undefined; s: boolean }) => useAgentStart(p, h, s), {
      initialProps: { p: paneId, h: harness, s: isShell },
    });

  it("says nothing about a pane that already had an agent when you opened it", () => {
    const { result, rerender } = render("w1:p1", "claude", false);
    expect(result.current.started).toBeNull();
    // A second poll reporting the same thing is not a change either.
    act(() => rerender({ p: "w1:p1", h: "claude", s: false }));
    expect(result.current.started).toBeNull();
  });

  it("announces a shell that becomes an agent, naming the harness", () => {
    const { result, rerender } = render("w1:p1", "shell", true);
    expect(result.current.started).toBeNull(); // the baseline
    act(() => rerender({ p: "w1:p1", h: "opencode", s: false }));
    expect(result.current.started).toBe("opencode");
  });

  it("says it once, and stays quiet while the pane keeps reporting the same agent", () => {
    const { result, rerender } = render("w1:p1", "shell", true);
    act(() => rerender({ p: "w1:p1", h: "opencode", s: false }));
    act(() => result.current.clear());
    expect(result.current.started).toBeNull();
    act(() => rerender({ p: "w1:p1", h: "opencode", s: false }));
    expect(result.current.started).toBeNull();
  });

  it("says nothing while the pane is missing from the snapshot, and does not treat that as a baseline", () => {
    // A poll failure or a reconnect drops the pane for a beat. Reading that as "was an agent, now
    // is not" and back would fire on every blip.
    const { result, rerender } = render("w1:p1", "shell", true);
    act(() => rerender({ p: "w1:p1", h: undefined, s: false }));
    expect(result.current.started).toBeNull();
    act(() => rerender({ p: "w1:p1", h: "shell", s: true }));
    expect(result.current.started).toBeNull();
    act(() => rerender({ p: "w1:p1", h: "opencode", s: false }));
    expect(result.current.started).toBe("opencode");
  });

  it("a pane that first appears already running its agent stays quiet", () => {
    const { result, rerender } = render("w1:p1", undefined, false);
    act(() => rerender({ p: "w1:p1", h: "codex", s: false }));
    expect(result.current.started).toBeNull();
  });

  it("never carries one pane's announcement onto another", () => {
    // DetailRoute does not remount on a pane-to-pane move, so the hook has to answer for this.
    const { result, rerender } = render("w1:p1", "shell", true);
    act(() => rerender({ p: "w1:p1", h: "opencode", s: false }));
    expect(result.current.started).toBe("opencode");
    act(() => rerender({ p: "w1:p2", h: "claude", s: false }));
    expect(result.current.started).toBeNull();
  });

  it("a switch to another pane is a fresh baseline, not a transition", () => {
    const { result, rerender } = render("w1:p1", "shell", true);
    // Landing on a second pane that is an agent must not read as shell -> agent.
    act(() => rerender({ p: "w1:p2", h: "claude", s: false }));
    expect(result.current.started).toBeNull();
    act(() => rerender({ p: "w1:p2", h: "claude", s: false }));
    expect(result.current.started).toBeNull();
  });

  it("announces again when an agent exits to a shell and a new one starts", () => {
    const { result, rerender } = render("w1:p1", "claude", false);
    act(() => rerender({ p: "w1:p1", h: "shell", s: true }));
    expect(result.current.started).toBeNull();
    act(() => rerender({ p: "w1:p1", h: "pi", s: false }));
    expect(result.current.started).toBe("pi");
  });
});
