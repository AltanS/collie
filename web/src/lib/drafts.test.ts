import { clearDraft, fitsDraftStore, loadDraft, pruneDrafts, saveDraft, __resetDraftPrune } from "./drafts";

// The per-pane composer draft store. It is the only reason a reply survives walking over to another
// tab mid-composition, so the cases below pin the three things that would silently lose one: the
// round trip, the empty-means-delete rule, and every storage failure mode staying non-fatal.

const KEY = "collie:draft:default:w1:p1";

beforeEach(() => {
  localStorage.clear();
  __resetDraftPrune();
});

describe("drafts", () => {
  it("round-trips a draft per pane", () => {
    saveDraft(undefined, "w1:p1", "half a reply");
    expect(loadDraft(undefined, "w1:p1")).toBe("half a reply");
    expect(loadDraft(undefined, "w1:p2")).toBeNull();
  });

  it("scopes the key by session so two sessions' panes can't collide", () => {
    saveDraft(undefined, "w1:p1", "primary");
    saveDraft({ session: "demo" }, "w1:p1", "demo session");
    expect(loadDraft(undefined, "w1:p1")).toBe("primary");
    expect(loadDraft({ session: "demo" }, "w1:p1")).toBe("demo session");
  });

  it("scopes the key by host too, so the same pane id on two machines can't collide", () => {
    saveDraft(undefined, "w1:p1", "lead");
    saveDraft({ host: "badger" }, "w1:p1", "badger");
    saveDraft({ host: "badger", session: "demo" }, "w1:p1", "badger demo");
    expect(loadDraft(undefined, "w1:p1")).toBe("lead");
    expect(loadDraft({ host: "badger" }, "w1:p1")).toBe("badger");
    expect(loadDraft({ host: "badger", session: "demo" }, "w1:p1")).toBe("badger demo");
  });

  // Byte-identical keys on the lead: an install that upgrades into the host dimension must still
  // find the drafts it already stored. A host segment is emitted ONLY when there is a host.
  it("keeps the lead's storage keys exactly as they shipped", () => {
    saveDraft({ host: "  ", session: "  " }, "w1:p1", "still the lead");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).not.toBeNull();
    saveDraft({ session: "demo" }, "w1:p2", "named");
    expect(localStorage.getItem("collie:draft:demo:w1:p2")).not.toBeNull();
  });

  it("removes the key when the text is empty or whitespace", () => {
    saveDraft(undefined, "w1:p1", "something");
    saveDraft(undefined, "w1:p1", "   \n ");
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("clearDraft removes the entry", () => {
    saveDraft(undefined, "w1:p1", "gone soon");
    clearDraft(undefined, "w1:p1");
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  it("never truncates an oversize draft — it keeps it whole, out of the disk tier", () => {
    const big = "x".repeat(8 * 1024 + 1);
    saveDraft(undefined, "w1:p1", big);
    // Whole in memory (so a pane switch keeps it), absent from disk (so nothing half-written can be
    // sent later). A truncated draft is the one outcome that must never exist.
    expect(loadDraft(undefined, "w1:p1")).toBe(big);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(fitsDraftStore(big)).toBe(false);

    saveDraft(undefined, "w1:p1", "x".repeat(8 * 1024));
    expect(loadDraft(undefined, "w1:p1")).toHaveLength(8 * 1024);
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  // The bug behind all of this: skipping the write left the PREVIOUS entry on disk, so pasting a
  // long file over a short note and coming back after a remount showed the note — text the user
  // never wrote, presented as their draft.
  it("clears the older, shorter draft an oversize write replaces", () => {
    saveDraft(undefined, "w1:p1", "quick note");
    saveDraft(undefined, "w1:p1", "# heading\n".repeat(1200));

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadDraft(undefined, "w1:p1")).not.toBe("quick note");

    // …and once the process dies, taking the memory tier with it, it is honestly gone — not "quick note".
    __resetDraftPrune();
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  // The ADR 0017 invariant. The password-prompt outcome calls clearDraft and must leave NOTHING
  // behind; a tier it doesn't reach is a secret that outlives its own recognition.
  it("clearDraft empties both tiers, not just the stored one", () => {
    saveDraft(undefined, "w1:p1", "hunter2");
    expect(loadDraft(undefined, "w1:p1")).toBe("hunter2");

    clearDraft(undefined, "w1:p1");

    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("prefers the newer tier when another tab wrote to storage behind this one", () => {
    saveDraft(undefined, "w1:p1", "typed here");
    // A second instance writes only to disk, with a later stamp — this tier has never seen it.
    localStorage.setItem(KEY, JSON.stringify({ text: "from another tab", at: Date.now() + 1000 }));
    expect(loadDraft(undefined, "w1:p1")).toBe("from another tab");
  });

  it("evicts the oldest memory entries when the tier outgrows its ceiling, never the live one", () => {
    const big = "x".repeat(1024 * 1024);
    for (const pane of ["p1", "p2", "p3", "p4", "p5"]) saveDraft(undefined, pane, big);

    // The one just written always survives; the oldest goes first.
    expect(loadDraft(undefined, "p5")).toBe(big);
    expect(loadDraft(undefined, "p1")).toBeNull();
  });

  it("prunes entries older than 48h and keeps recent ones", () => {
    const old = Date.now() - 49 * 60 * 60 * 1000;
    localStorage.setItem(KEY, JSON.stringify({ text: "ancient", at: old }));
    localStorage.setItem(
      "collie:draft:default:w1:p2",
      JSON.stringify({ text: "fresh", at: Date.now() }),
    );
    localStorage.setItem("collie:haptics:v1", "1"); // an unrelated key must survive
    pruneDrafts();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadDraft(undefined, "w1:p2")).toBe("fresh");
    expect(localStorage.getItem("collie:haptics:v1")).toBe("1");
  });

  it("does not resurface an expired draft even before a prune runs", () => {
    localStorage.setItem(KEY, JSON.stringify({ text: "ancient", at: 0 }));
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  it("treats unreadable entries as absent", () => {
    localStorage.setItem(KEY, "not json");
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  it("survives a storage that throws on write (Safari private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveDraft(undefined, "w1:p1", "still typing")).not.toThrow();
    setItem.mockRestore();
    // The memory tier still has it — losing persistence must not also lose the text on screen.
    expect(loadDraft(undefined, "w1:p1")).toBe("still typing");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("survives a storage that throws on read", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    getItem.mockRestore();
  });
});
