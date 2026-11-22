import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { ASK_DRAFT_MAX_AGE_MS, ASK_NOTE_MAX, clearAskDrafts, forgetAskDrafts, pruneAskDrafts, setAskDraft, useAskDraft, useAskDrafts } from "./asks-drafts";

// The marks on the Asks pages live in localStorage under one key and outlive a reload.

const KEY = "collie:ask-drafts:v1";

beforeEach(() => {
  forgetAskDrafts();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

/** A reload: the module forgets what it holds in memory, and reads the storage again. */
async function reload() {
  vi.resetModules();
  return import("./asks-drafts");
}

describe("the ask drafts store", () => {
  it("keeps a mark and a note per ask id under one key", () => {
    setAskDraft("ak_a", { intent: "yes", text: "soon" });
    setAskDraft("ak_b", { intent: null, text: "only a note" });
    // SAFETY: the store wrote this JSON a line before.
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, { intent: string | null; text: string }>;
    expect(Object.keys(stored)).toEqual(["ak_a", "ak_b"]);
    expect(stored.ak_a).toMatchObject({ intent: "yes", text: "soon" });
  });

  it("survives a reload", async () => {
    setAskDraft("ak_a", { intent: "yes", text: "soon" });
    const fresh = await reload();
    const { result } = renderHook(() => fresh.useAskDraft("ak_a"));
    expect(result.current).toMatchObject({ intent: "yes", text: "soon" });
  });

  it("drops an entry with no mark and no note, and the key with the last entry", () => {
    setAskDraft("ak_a", { intent: "yes", text: "" });
    setAskDraft("ak_a", { intent: null, text: "" });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("cuts a note at its ceiling", () => {
    setAskDraft("ak_a", { intent: "yes", text: "x".repeat(ASK_NOTE_MAX + 50) });
    const { result } = renderHook(() => useAskDraft("ak_a"));
    expect(result.current.text).toHaveLength(ASK_NOTE_MAX);
  });

  it("forgets the drafts of asks whose Send succeeded", () => {
    setAskDraft("ak_a", { intent: "yes", text: "" });
    setAskDraft("ak_b", { intent: "no", text: "" });
    clearAskDrafts(["ak_a"]);
    const { result } = renderHook(() => useAskDrafts());
    expect([...result.current.keys()]).toEqual(["ak_b"]);
  });

  it("prunes the drafts of asks that are no longer open", () => {
    setAskDraft("ak_a", { intent: "yes", text: "" });
    setAskDraft("ak_b", { intent: "no", text: "" });
    pruneAskDrafts(new Set(["ak_b"]));
    const { result } = renderHook(() => useAskDrafts());
    expect([...result.current.keys()]).toEqual(["ak_b"]);
  });

  it("drops a draft older than its age limit when it is read", async () => {
    const now = Date.now();
    setAskDraft("ak_old", { intent: "yes", text: "" }, now - ASK_DRAFT_MAX_AGE_MS - 1000);
    setAskDraft("ak_new", { intent: "yes", text: "" }, now);
    const fresh = await reload();
    const { result } = renderHook(() => fresh.useAskDrafts());
    expect([...result.current.keys()]).toEqual(["ak_new"]);
  });

  it("reads a damaged store as empty", async () => {
    localStorage.setItem(KEY, "{not json");
    const fresh = await reload();
    const { result } = renderHook(() => fresh.useAskDrafts());
    expect(result.current.size).toBe(0);
  });

  it("redraws a reader when a draft changes", () => {
    const { result } = renderHook(() => useAskDraft("ak_a"));
    expect(result.current).toEqual({ intent: null, text: "" });
    act(() => setAskDraft("ak_a", { intent: "no", text: "" }));
    expect(result.current.intent).toBe("no");
  });
});
