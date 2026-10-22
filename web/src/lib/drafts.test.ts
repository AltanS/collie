import { clearDraft, fitsDraftStore, loadDraft, loadDraftEntry, pruneDrafts, saveDraft, __resetDraftPrune } from "./drafts";

// The per-pane composer draft store. It is the only reason a reply survives walking over to another
// tab mid-composition, so the cases below pin the three things that would silently lose one: the
// round trip, the empty-means-delete rule, and every storage failure mode staying non-fatal.

const KEY = "collie:draft:v2:default:w1:p1";
/** The same pane's key in the store's first version, the one a Stable 1.23.x build reads. */
const LEGACY = "collie:draft:default:w1:p1";

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

  // The lead's key keeps its shape under the store's version: a host segment is emitted ONLY when
  // there is a host, so the first-version keys an install already stored are still found.
  it("keeps the lead's key shape, with no host segment, under the store's version", () => {
    saveDraft({ host: "  ", session: "  " }, "w1:p1", "still the lead");
    expect(localStorage.getItem("collie:draft:v2:default:w1:p1")).not.toBeNull();
    saveDraft({ session: "demo" }, "w1:p2", "named");
    expect(localStorage.getItem("collie:draft:v2:demo:w1:p2")).not.toBeNull();
    localStorage.setItem("collie:draft:demo:w1:p3", JSON.stringify({ text: "first version", at: Date.now() }));
    expect(loadDraft({ host: "  ", session: "demo" }, "w1:p3")).toBe("first version");
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

  // ADR 0060: a draft carries its chips and the next chip number, and the old shape still loads.
  describe("chips", () => {
    const chip = { n: 1, path: "/a.png", name: "a.png", kind: "image" as const };

    it("round-trips the chips and the next number through the disk tier", () => {
      saveDraft(undefined, "w1:p1", "see [Image #1]", [chip], 3);
      __resetDraftPrune(); // empties the memory tier, so this read is the disk's
      expect(loadDraftEntry(undefined, "w1:p1")).toEqual({ text: "see [Image #1]", attachments: [chip], next: 3 });
    });

    it("stores only the chip fields, never a preview URL or anything else a caller carries", () => {
      const withPreview = { ...chip, previewUrl: "blob:x" };
      saveDraft(undefined, "w1:p1", "x", [withPreview], 2);
      expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").attachments).toEqual([chip]);
    });

    it("keeps a draft that is only chips", () => {
      saveDraft(undefined, "w1:p1", "", [chip], 2);
      expect(loadDraftEntry(undefined, "w1:p1")?.attachments).toEqual([chip]);
    });

    it("stores a text-only draft exactly as it was stored before chips", () => {
      saveDraft(undefined, "w1:p1", "plain");
      expect(Object.keys(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toSorted()).toEqual(["at", "text"]);
    });

    it("loads an old text-only entry as a draft with no chips", () => {
      localStorage.setItem(KEY, JSON.stringify({ text: "from before", at: Date.now() }));
      expect(loadDraft(undefined, "w1:p1")).toBe("from before");
      expect(loadDraftEntry(undefined, "w1:p1")).toEqual({ text: "from before", attachments: [], next: 1 });
    });

    it("drops a malformed chip and keeps the rest of the draft", () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({ text: "t", at: Date.now(), attachments: [chip, { n: 0, path: "/x" }, "junk"], next: 2 }),
      );
      expect(loadDraftEntry(undefined, "w1:p1")).toEqual({ text: "t", attachments: [chip], next: 2 });
    });

    it("never hands out a number a held chip already has", () => {
      localStorage.setItem(KEY, JSON.stringify({ text: "t", at: Date.now(), attachments: [{ ...chip, n: 5 }], next: 2 }));
      expect(loadDraftEntry(undefined, "w1:p1")?.next).toBe(6);
    });

    it("round-trips a paste chip and counts its content toward the disk size cap", () => {
      const pasteChip = { n: 1, path: "a\nb\nc\nd\ne", name: "a", kind: "paste" as const };
      saveDraft(undefined, "w1:p1", "[Pasted #1]", [pasteChip], 2);
      __resetDraftPrune();
      expect(loadDraftEntry(undefined, "w1:p1")).toEqual({
        text: "[Pasted #1]",
        attachments: [pasteChip],
        next: 2,
      });

      const hugePaste = { n: 1, path: "x".repeat(8 * 1024 + 1), name: "xxx", kind: "paste" as const };
      expect(fitsDraftStore("[Pasted #1]", [hugePaste])).toBe(false);
      saveDraft(undefined, "w1:p1", "[Pasted #1]", [hugePaste], 2);
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(loadDraftEntry(undefined, "w1:p1")?.attachments).toEqual([hugePaste]);
    });
  });

  // A paste chip's text lives only in the chip; the draft holds `[Pasted #N]`. A Stable 1.23.x build
  // reads only the first-version key and drops a chip kind it does not know, so it would restore the
  // bare marker and send it literally. The store's second version keeps it from ever meeting one.
  describe("the store's version (PR 560)", () => {
    const pasteChip = { n: 1, path: "a\nb\nc\nd\ne", name: "a", kind: "paste" as const };

    it("writes a paste-chip draft only under the new version, never where an older build reads", () => {
      saveDraft(undefined, "w1:p1", "see [Pasted #1]", [pasteChip], 2);
      expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").attachments).toEqual([pasteChip]);
      expect(localStorage.getItem(LEGACY)).toBeNull();
    });

    it("moves a first-version draft over on read and leaves the first-version entry as it was", () => {
      const raw = JSON.stringify({ text: "typed before the update", at: Date.now() - 1000 });
      localStorage.setItem(LEGACY, raw);
      expect(loadDraft(undefined, "w1:p1")).toBe("typed before the update");
      expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").text).toBe("typed before the update");
      expect(localStorage.getItem(LEGACY)).toBe(raw);
    });

    it("never writes back to the first version: a save supersedes it, a clear removes both", () => {
      localStorage.setItem(LEGACY, JSON.stringify({ text: "old words", at: Date.now() - 1000 }));
      saveDraft(undefined, "w1:p1", "new words");
      expect(localStorage.getItem(LEGACY)).toBeNull();
      expect(loadDraft(undefined, "w1:p1")).toBe("new words");

      saveDraft(undefined, "w1:p1", "kept");
      localStorage.setItem(LEGACY, JSON.stringify({ text: "written by a rolled-back build", at: Date.now() + 1000 }));
      clearDraft(undefined, "w1:p1");
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(localStorage.getItem(LEGACY)).toBeNull();
    });

    it("takes a first-version draft that is newer, as after a rollback and an update again", () => {
      saveDraft(undefined, "w1:p1", "from this build", [pasteChip], 2);
      __resetDraftPrune();
      localStorage.setItem(LEGACY, JSON.stringify({ text: "from the older build", at: Date.now() + 1000 }));
      expect(loadDraftEntry(undefined, "w1:p1")).toEqual({ text: "from the older build", attachments: [], next: 1 });
      expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").text).toBe("from the older build");
    });

    // The Stable-then-Edge round trip. "Newer" is the stored `at`, never which key happens to exist.
    it("takes the older build's text when its entry carries the newer timestamp, whatever is under the new key", () => {
      localStorage.setItem(KEY, JSON.stringify({ text: "written by this build", at: Date.now() - 60_000 }));
      localStorage.setItem(LEGACY, JSON.stringify({ text: "written after the rollback", at: Date.now() - 1000 }));
      expect(loadDraft(undefined, "w1:p1")).toBe("written after the rollback");
      expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").text).toBe("written after the rollback");
    });

    it("keeps the new version's draft when it is newer, and never copies the older entry over it", () => {
      const chips = [{ n: 1, path: "a\nb\nc\nd\ne", name: "a", kind: "paste" as const }];
      const raw = JSON.stringify({ text: "see [Pasted #1]", at: Date.now() - 1000, attachments: chips, next: 2 });
      localStorage.setItem(KEY, raw);
      localStorage.setItem(LEGACY, JSON.stringify({ text: "an older draft", at: Date.now() - 60_000 }));
      expect(loadDraftEntry(undefined, "w1:p1")).toEqual({ text: "see [Pasted #1]", attachments: chips, next: 2 });
      expect(localStorage.getItem(KEY)).toBe(raw);
    });

    // ADR 0017: a recognised password prompt purges the pane's draft. A first-version entry copied
    // forward on read has no save behind it yet, and the purge must still take it and its copy.
    it("purges a draft copied forward from the first version, and the first-version entry too", () => {
      localStorage.setItem(LEGACY, JSON.stringify({ text: "hunter2", at: Date.now() - 1000 }));
      expect(loadDraft(undefined, "w1:p1")).toBe("hunter2");
      expect(localStorage.getItem(KEY)).not.toBeNull();
      clearDraft(undefined, "w1:p1");
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(localStorage.getItem(LEGACY)).toBeNull();
      expect(loadDraft(undefined, "w1:p1")).toBeNull();
    });

    it("never moves an expired first-version draft over", () => {
      const raw = JSON.stringify({ text: "ancient", at: 0 });
      localStorage.setItem(LEGACY, raw);
      expect(loadDraft(undefined, "w1:p1")).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });
});
