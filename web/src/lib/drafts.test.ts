import { clearDraft, loadDraft, pruneDrafts, saveDraft, __resetDraftPrune } from "./drafts";

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
    saveDraft("demo", "w1:p1", "demo session");
    expect(loadDraft(undefined, "w1:p1")).toBe("primary");
    expect(loadDraft("demo", "w1:p1")).toBe("demo session");
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

  it("skips an oversize draft rather than truncating it", () => {
    saveDraft(undefined, "w1:p1", "x".repeat(8 * 1024 + 1));
    // Nothing stored beats a half-message you might then send.
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    saveDraft(undefined, "w1:p1", "x".repeat(8 * 1024));
    expect(loadDraft(undefined, "w1:p1")).toHaveLength(8 * 1024);
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
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
  });

  it("survives a storage that throws on read", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    getItem.mockRestore();
  });
});
