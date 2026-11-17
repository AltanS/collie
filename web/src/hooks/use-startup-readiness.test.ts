import { act, renderHook } from "@testing-library/react";
import { STARTUP_GATE_MS } from "@/lib/agent-startup";
import { paneScopeKey } from "@/lib/scope";
import { UNREAD_SURFACE } from "@/lib/send-slot";
import type { Surface } from "@/lib/surface/surface";
import { useStartupReadiness } from "./use-startup-readiness";

type Input = Parameters<typeof useStartupReadiness>[0];
const KEY = paneScopeKey(undefined, "w1:p1");
const FREE: Surface = { revision: 2, turn: "idle", modal: "none", composer: "empty" };
const ASK: Surface = { revision: 1, turn: "unknown", composer: "unknown", modal: { ask: { id: "trust", kind: "permission", channel: "keys", hash: "abc", options: [{ id: "1", label: "Trust" }] } } };
const LAUNCH = { id: "intent", paneKey: KEY, harness: "kiro" };
const input: Input = { launch: LAUNCH, agent: "shell", surface: undefined, live: true };
const hook = (initial: Input) => renderHook((props: Input) => useStartupReadiness(props), { initialProps: initial });

describe("the startup gate", () => {
  it("holds a shell row and an unread agent, and opens once on the bridge's read of a box", () => {
    const onReady = vi.fn();
    const { result, rerender } = hook({ ...input, onReady });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: "kiro", surface: UNREAD_SURFACE, onReady });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: "kiro", surface: FREE, onReady });
    expect(result.current.starting).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    // Retired, the intent is gone; a later unknown screen does not gate Send again.
    rerender({ ...input, launch: undefined, agent: "kiro", surface: UNREAD_SURFACE, onReady });
    expect(result.current.starting).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("opens on a dialog the bridge lifted, so the composer's answer slot takes over", () => {
    const { result, rerender } = hook(input);
    rerender({ ...input, agent: "kiro", surface: ASK });
    expect(result.current.starting).toBe(false);
    // The dialog leaving does not close it again.
    rerender({ ...input, agent: "kiro", surface: UNREAD_SURFACE });
    expect(result.current.starting).toBe(false);
  });

  it("does not open on a read the phone holds while it is not live", () => {
    const { result, rerender } = hook({ ...input, agent: "kiro", surface: FREE, live: false });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: "kiro", surface: FREE });
    expect(result.current.starting).toBe(false);
  });

  it("opens when the agent it saw leaves the pane, sending nothing", () => {
    const onReady = vi.fn();
    const { result, rerender } = hook({ ...input, onReady });
    rerender({ ...input, agent: "kiro", surface: UNREAD_SURFACE, onReady });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: "shell", surface: UNREAD_SURFACE, onReady });
    expect(result.current.starting).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("opens when the agent falls back to a plain shell that names no agent", () => {
    const onReady = vi.fn();
    const { result, rerender } = hook({ ...input, onReady });
    // Before the agent was ever seen, a pane naming no agent is still the temporary shell.
    rerender({ ...input, agent: undefined, onReady });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: "kiro", surface: UNREAD_SURFACE, onReady });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: undefined, surface: undefined, onReady });
    expect(result.current.starting).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("opens at the launch window's bound on a screen it never reads", () => {
    vi.useFakeTimers();
    try {
      const { result } = hook({ ...input, agent: "kiro", surface: UNREAD_SURFACE });
      expect(result.current.starting).toBe(true);
      act(() => vi.advanceTimersByTime(STARTUP_GATE_MS));
      expect(result.current.starting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts again for a new launch, and a pane with no launch is never gated", () => {
    const { result, rerender } = hook({ ...input, agent: "kiro", surface: FREE });
    expect(result.current.starting).toBe(false);
    rerender({ ...input, launch: { ...LAUNCH, id: "next" }, agent: "shell" });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, launch: undefined });
    expect(result.current.starting).toBe(false);
  });

  // WHAT ENDS THE HOLD (the composer holds its box while `starting`). Each way out, one test.
  it("opens on a first screen that is a prompt: a trust question, a sign-in field, an unreadable dialog", () => {
    const SIGN_IN: Surface = { revision: 3, turn: "unknown", modal: "none", composer: "empty", field: "secret" };
    const UNREADABLE: Surface = { revision: 4, turn: "unknown", modal: "unreadable", composer: "unknown" };
    for (const first of [ASK, SIGN_IN, UNREADABLE]) {
      const { result, rerender } = hook(input);
      expect(result.current.starting).toBe(true);
      rerender({ ...input, agent: "kiro", surface: first });
      expect(result.current.starting).toBe(false);
    }
  });

  it("keeps the hold on a screen the bridge cannot name, as the bridge refuses sends there too, until the bound", () => {
    vi.useFakeTimers();
    try {
      const { result } = hook({ ...input, agent: "kiro", surface: UNREAD_SURFACE });
      expect(result.current.starting).toBe(true);
      act(() => vi.advanceTimersByTime(STARTUP_GATE_MS - 1));
      expect(result.current.starting).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.starting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens at the bound when the read never worked: never live, or lost during the start", () => {
    vi.useFakeTimers();
    try {
      const never = hook({ ...input, live: false });
      const lost = hook({ ...input, agent: "kiro", surface: UNREAD_SURFACE });
      lost.rerender({ ...input, agent: "kiro", surface: UNREAD_SURFACE, live: false });
      expect(never.result.current.starting).toBe(true);
      expect(lost.result.current.starting).toBe(true);
      act(() => vi.advanceTimersByTime(STARTUP_GATE_MS));
      expect(never.result.current.starting).toBe(false);
      expect(lost.result.current.starting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reconnect reads the screen that is there: the first live read of a box opens it", () => {
    const { result, rerender } = hook({ ...input, agent: "kiro", surface: UNREAD_SURFACE, live: false });
    rerender({ ...input, agent: "kiro", surface: FREE, live: false });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: "kiro", surface: FREE, live: true });
    expect(result.current.starting).toBe(false);
  });

  it("an agent that left while the read was down opens it on the first live read", () => {
    const { result, rerender } = hook({ ...input, agent: "kiro", surface: UNREAD_SURFACE });
    rerender({ ...input, agent: undefined, surface: undefined, live: false });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, agent: undefined, surface: undefined, live: true });
    expect(result.current.starting).toBe(false);
  });
});
