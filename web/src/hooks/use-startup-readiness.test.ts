import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook } from "@testing-library/react";
import { paneScopeKey } from "@/lib/scope";
import { UNREAD_SURFACE } from "@/lib/send-slot";
import { useStartupReadiness } from "./use-startup-readiness";

type Input = Parameters<typeof useStartupReadiness>[0];
const KEY = paneScopeKey(undefined, "w1:p1");
const READY = readFileSync(join(process.cwd(), "src/fixtures/panes/kiro--v3-idle-w120.txt"), "utf8");
const TRUST = readFileSync(join(process.cwd(), "src/fixtures/panes/kiro--v3-workspace-trust-continue-w120.txt"), "utf8");
const input: Input = { paneKey: KEY, launch: { id: "intent", paneKey: KEY, harness: "kiro" }, text: "$ kiro", surface: UNREAD_SURFACE, agent: "kiro", marked: true, live: true, stale: false };

describe("startup readiness latch", () => {
  it("consumes once, with no send callback, and never re-arms for a later unknown screen", () => {
    const onReady = vi.fn();
    const { result, rerender } = renderHook((props: Input) => useStartupReadiness(props), { initialProps: { ...input, onReady } });
    expect(result.current.starting).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    rerender({ ...input, onReady, text: READY });
    expect(result.current.starting).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    rerender({ ...input, launch: undefined, text: "unknown panel", onReady });
    expect(result.current.starting).toBe(false);
    expect(result.current.initialDialog).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
  });
  it("keeps the initial dialog slot after marker retirement until that screen leaves", () => {
    const onReady = vi.fn();
    const { result, rerender } = renderHook((props: Input) => useStartupReadiness(props), { initialProps: { ...input, text: TRUST, onReady } });
    expect(result.current).toMatchObject({ starting: false, initialDialog: true });
    rerender({ ...input, launch: undefined, text: TRUST, onReady });
    expect(result.current.initialDialog).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    rerender({ ...input, text: "", onReady });
    expect(result.current).toMatchObject({ starting: true, initialDialog: false });
    expect(onReady).not.toHaveBeenCalled();
    rerender({ ...input, text: READY, onReady });
    expect(onReady).toHaveBeenCalledOnce();
    expect(result.current.initialDialog).toBe(false);
    rerender({ ...input, launch: undefined, text: "unknown panel", onReady });
    expect(result.current).toMatchObject({ starting: false, initialDialog: false });
  });
  it("does not authorize a shell or a send-off row from the launch agent's painted composer", () => {
    const initial: Input = { ...input, text: READY, agent: "shell" };
    const { result, rerender } = renderHook((props: Input) => useStartupReadiness(props), { initialProps: initial });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, text: READY, agent: "kiro", marked: false });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, text: READY });
    expect(result.current.starting).toBe(false);
  });
  it("does not release on stale or non-live evidence", () => {
    const { result, rerender } = renderHook((props: Input) => useStartupReadiness(props), { initialProps: { ...input, text: READY, stale: true } });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, text: READY, live: false });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, text: READY });
    expect(result.current.starting).toBe(false);
  });
  it("ends a known launch when its observed agent exits, without treating the initial shell as ready", () => {
    const onReady = vi.fn();
    const initial: Input = { ...input, agent: "shell", onReady };
    const { result, rerender } = renderHook((props: Input) => useStartupReadiness(props), { initialProps: initial });
    expect(result.current.starting).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    rerender({ ...input, text: TRUST, onReady });
    expect(result.current.initialDialog).toBe(true);
    rerender({ ...input, agent: "shell", text: "$", live: false, onReady });
    expect(onReady).not.toHaveBeenCalled();
    rerender({ ...input, agent: "shell", text: "$", onReady });
    expect(result.current).toMatchObject({ starting: false, initialDialog: false });
    expect(onReady).toHaveBeenCalledOnce();
  });
  it("resets at the full address boundary; bare shells and direct opens have no latch", () => {
    const { result, rerender } = renderHook((props: Input) => useStartupReadiness(props), { initialProps: { ...input, text: READY } });
    const peerKey = paneScopeKey({ host: "peer", session: "work" }, "w1:p1");
    rerender({ ...input, paneKey: peerKey });
    expect(result.current.starting).toBe(false);
    rerender({ ...input, paneKey: peerKey, launch: { id: "peer-intent", paneKey: peerKey, harness: "kiro" } });
    expect(result.current.starting).toBe(true);
    rerender({ ...input, paneKey: paneScopeKey(undefined, "w1:p2"), launch: undefined });
    expect(result.current.starting).toBe(false);
  });
});
