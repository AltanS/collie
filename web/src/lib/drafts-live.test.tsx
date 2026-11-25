import { act, renderHook } from "@testing-library/react";

import { useHasDraft } from "@/hooks/use-has-draft";
import {
  clearAllDrafts,
  clearDraft,
  hasDraft,
  pruneDrafts,
  saveDraft,
  subscribeDrafts,
  savePutBack,
  __resetDraftPrune,
} from "./drafts";

// Who holds a draft, live: the cached boolean a row's pencil reads (`hasDraft`), its subscription, and the hook
// on top (`useHasDraft`). The rows' own cases are in components/draft-mark-rows.test.tsx.

const KEY = "collie:draft:v2:default:w1:p1";

beforeEach(() => {
  localStorage.clear();
  __resetDraftPrune();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hasDraft", () => {
  it("is true for words, false for none, and false for blank words", () => {
    expect(hasDraft(undefined, "w1:p1")).toBe(false);
    saveDraft(undefined, "w1:p1", "half a reply");
    expect(hasDraft(undefined, "w1:p1")).toBe(true);
    // A blank draft is no draft: `saveDraft` removes it, and a blank entry planted on disk reads as none too.
    saveDraft(undefined, "w1:p1", "   ");
    expect(hasDraft(undefined, "w1:p1")).toBe(false);
    __resetDraftPrune();
    localStorage.setItem(KEY, JSON.stringify({ text: "  \n ", at: Date.now() }));
    expect(hasDraft(undefined, "w1:p1")).toBe(false);
  });

  it("is true for a draft that holds only a chip", () => {
    saveDraft(undefined, "w1:p1", "", [{ n: 1, path: "/tmp/a.png", name: "a.png", kind: "image" }], 2);
    expect(hasDraft(undefined, "w1:p1")).toBe(true);
  });

  it("does not count the Put back list", () => {
    savePutBack(undefined, "w1:p1", [{ draft: "sent text that did not go", chips: [], line: "line" }]);
    expect(hasDraft(undefined, "w1:p1")).toBe(false);
  });

  it("keeps the panes of two sessions and two machines apart", () => {
    saveDraft({ session: "demo" }, "w1:p1", "demo only");
    saveDraft({ host: "lodge" }, "w1:p2", "lodge only");
    expect(hasDraft(undefined, "w1:p1")).toBe(false);
    expect(hasDraft({ session: "demo" }, "w1:p1")).toBe(true);
    expect(hasDraft({ host: "lodge" }, "w1:p2")).toBe(true);
    expect(hasDraft(undefined, "w1:p2")).toBe(false);
  });

  it("reads storage once per pane, not once per ask", () => {
    saveDraft(undefined, "w1:p1", "words");
    expect(hasDraft(undefined, "w1:p1")).toBe(true);
    const read = vi.spyOn(Storage.prototype, "getItem");
    for (let i = 0; i < 50; i++) hasDraft(undefined, "w1:p1");
    expect(read).not.toHaveBeenCalled();
  });

  it("a list of 60 panes reads storage at first paint only, then nothing", () => {
    for (let i = 0; i < 60; i++) saveDraft(undefined, `w1:p${i}`, `draft ${i}`);
    // A fresh page: the caches are empty and the memory tier is gone, the disk holds the drafts.
    __resetDraftPrune();
    const read = vi.spyOn(Storage.prototype, "getItem");
    for (let i = 0; i < 60; i++) expect(hasDraft(undefined, `w1:p${i}`)).toBe(true);
    const first = read.mock.calls.length;
    for (let round = 0; round < 5; round++) for (let i = 0; i < 60; i++) hasDraft(undefined, `w1:p${i}`);
    expect(read.mock.calls.length).toBe(first);
    // This version's key and the first version's, per pane, and the once-per-load prune's one read of each entry.
    expect(first).toBeLessThanOrEqual(60 * 3 + 5);
  });
});

describe("subscribeDrafts", () => {
  it("tells the listener after a save, a clear, a wipe and a prune, and stops after the unsubscribe", async () => {
    const listener = vi.fn();
    const stop = subscribeDrafts(listener);
    saveDraft(undefined, "w1:p1", "a");
    expect(listener).toHaveBeenCalledTimes(1);
    clearDraft(undefined, "w1:p1");
    expect(listener).toHaveBeenCalledTimes(2);
    // Saving words that are blank is a clear.
    saveDraft(undefined, "w1:p1", "  ");
    expect(listener).toHaveBeenCalledTimes(3);
    clearAllDrafts();
    expect(listener).toHaveBeenCalledTimes(4);

    localStorage.setItem(KEY, JSON.stringify({ text: "old", at: Date.now() - 49 * 60 * 60 * 1000 }));
    pruneDrafts();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(5);
    expect(localStorage.getItem(KEY)).toBeNull();

    stop();
    saveDraft(undefined, "w1:p1", "b");
    expect(listener).toHaveBeenCalledTimes(5);
  });

  // A RESTING DASHBOARD DRAWS NO FRAME (ADR 0138, e2e/idle-repaint.spec.ts), so the store behind every row's
  // pencil must say nothing while nothing changes: no timer, no expiry tick, no repeat after the first read.
  it("notifies nobody while nothing changes, however long the page rests and however often rows ask", async () => {
    vi.useFakeTimers();
    try {
      saveDraft(undefined, "w1:p1", "a draft that is not yet 48 hours old");
      __resetDraftPrune();
      const listener = vi.fn();
      const stop = subscribeDrafts(listener);
      for (let row = 0; row < 3; row += 1) {
        hasDraft(undefined, "w1:p1");
        hasDraft(undefined, "w1:p2");
      }
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await Promise.resolve();
      expect(listener).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the listeners once for the first prune that removed something, and never again for the same read", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(KEY, JSON.stringify({ text: "old", at: Date.now() - 49 * 60 * 60 * 1000 }));
      const listener = vi.fn();
      const stop = subscribeDrafts(listener);
      // The first read prunes. The notice comes off the render's stack, as one microtask.
      expect(hasDraft(undefined, "w1:p1")).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
      for (let row = 0; row < 3; row += 1) hasDraft(undefined, "w1:p1");
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("listens to the storage event once for any number of listeners, and lets go with the last", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const stopA = subscribeDrafts(() => {});
    const stopB = subscribeDrafts(() => {});
    expect(add.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
    stopA();
    expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(0);
    stopB();
    expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("useHasDraft", () => {
  it("comes when a draft is saved and goes when it is cleared, with no reload", () => {
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    expect(result.current).toBe(false);
    act(() => saveDraft(undefined, "w1:p1", "half a reply"));
    expect(result.current).toBe(true);
    act(() => clearDraft(undefined, "w1:p1"));
    expect(result.current).toBe(false);
  });

  it("goes when the composer saves an emptied box, which is what a send does", () => {
    saveDraft(undefined, "w1:p1", "reply");
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    expect(result.current).toBe(true);
    act(() => saveDraft(undefined, "w1:p1", ""));
    expect(result.current).toBe(false);
  });

  it("follows the pane it was given, and no other", () => {
    const { result, rerender } = renderHook(({ id }) => useHasDraft(undefined, id), { initialProps: { id: "w1:p1" } });
    act(() => saveDraft(undefined, "w1:p2", "other pane"));
    expect(result.current).toBe(false);
    rerender({ id: "w1:p2" });
    expect(result.current).toBe(true);
  });

  it("goes with the device wipe", () => {
    saveDraft(undefined, "w1:p1", "reply");
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    expect(result.current).toBe(true);
    act(() => clearAllDrafts());
    expect(result.current).toBe(false);
  });

  it("is false for a draft that is past its 48 hours, whether or not the prune has run", () => {
    localStorage.setItem(KEY, JSON.stringify({ text: "old", at: Date.now() - 49 * 60 * 60 * 1000 }));
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    expect(result.current).toBe(false);
  });

  it("follows another tab: a storage event for its key brings the draft and takes it away", () => {
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    expect(result.current).toBe(false);
    act(() => {
      localStorage.setItem(KEY, JSON.stringify({ text: "typed in the other tab", at: Date.now() }));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(result.current).toBe(true);
    act(() => {
      localStorage.removeItem(KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(result.current).toBe(false);
  });

  it("follows another tab that cleared the whole store (a storage event with no key)", () => {
    // The draft is on disk only, as another tab's write leaves it here.
    localStorage.setItem(KEY, JSON.stringify({ text: "reply", at: Date.now() }));
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    expect(result.current).toBe(true);
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current).toBe(false);
  });

  it("ignores a storage event for a key that is no draft's", () => {
    const { result } = renderHook(() => useHasDraft(undefined, "w1:p1"));
    const read = vi.spyOn(Storage.prototype, "getItem");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "collie:theme" }));
    });
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });
});
