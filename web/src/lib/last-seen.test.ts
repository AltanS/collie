import {
  __clearLastSeen,
  dropLastPaneText,
  loadLastPaneText,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastSnapshot,
} from "./last-seen";
import { paneScopeKey, scopeKey } from "@/lib/scope";
import { fixtureSnapshot } from "@/test/handlers";

beforeEach(() => {
  sessionStorage.clear();
});

describe("the write-through last-seen cache", () => {
  it("reads back a snapshot with the time it was written", () => {
    saveLastSnapshot(undefined, fixtureSnapshot, 1_700_000_000_000);
    const got = loadLastSnapshot(undefined);
    expect(got?.at).toBe(1_700_000_000_000);
    expect(got?.value.agents).toHaveLength(fixtureSnapshot.agents.length);
  });

  it("keeps scopes apart", () => {
    saveLastSnapshot(undefined, fixtureSnapshot);
    expect(loadLastSnapshot({ session: "demo" })).toBeNull();
    expect(loadLastSnapshot({ host: "bruno" })).toBeNull();
  });

  it("reads back a pane mirror verbatim, newlines and all", () => {
    const text = "line one\nline two\n\n❯ ";
    saveLastPaneText(undefined, "w1:p1", text, 42);
    expect(loadLastPaneText(undefined, "w1:p1")).toEqual({ at: 42, value: text });
  });

  it("drops a pane on request", () => {
    saveLastPaneText(undefined, "w1:p1", "hello");
    dropLastPaneText(undefined, "w1:p1");
    expect(loadLastPaneText(undefined, "w1:p1")).toBeNull();
  });

  it("keeps only the newest few panes", () => {
    for (let i = 0; i < 8; i++) saveLastPaneText(undefined, `w1:p${i}`, `pane ${i}`, 1000 + i);
    expect(loadLastPaneText(undefined, "w1:p7")).not.toBeNull();
    expect(loadLastPaneText(undefined, "w1:p0")).toBeNull();
  });

  // Every read is total: a hand-edited or format-drifted entry reads as a miss, never a throw — a
  // cache miss costs a stale render, an exception costs the whole boot this cache exists to save.
  it.each([
    ["not json at all", `collie:last-snapshot:${scopeKey()}`, "{{{"],
    ["a json array", `collie:last-snapshot:${scopeKey()}`, "[]"],
    ["an entry with no stamp", `collie:last-snapshot:${scopeKey()}`, JSON.stringify({ value: {} })],
    ["a pane with no stamp line", `collie:last-pane:${paneScopeKey(undefined, "w1:p1")}`, "just text"],
  ])("treats %s as a miss", (_name, key, raw) => {
    sessionStorage.setItem(key, raw);
    expect(loadLastSnapshot(undefined) ?? loadLastPaneText(undefined, "w1:p1")).toBeNull();
  });

  it("survives a store that refuses to write", () => {
    const boom = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveLastSnapshot(undefined, fixtureSnapshot)).not.toThrow();
    boom.mockRestore();
  });

  it("clears itself without touching anything else in the store", () => {
    sessionStorage.setItem("something:else", "keep me");
    saveLastSnapshot(undefined, fixtureSnapshot);
    saveLastPaneText(undefined, "w1:p1", "hello");
    __clearLastSeen();
    expect(loadLastSnapshot(undefined)).toBeNull();
    expect(loadLastPaneText(undefined, "w1:p1")).toBeNull();
    expect(sessionStorage.getItem("something:else")).toBe("keep me");
  });
});
