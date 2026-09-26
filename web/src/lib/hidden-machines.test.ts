import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  __reloadHiddenMachines,
  currentHiddenMachines,
  machinesHiddenFrom,
  MAX_HIDDEN_MACHINES,
  setMachineHidden,
  useHiddenMachines,
} from "./hidden-machines";
import type { ServerSummary } from "./types";

// The hidden-machines store (issue #288, M40/01): its own module store under
// `collie:hidden-machines:v1`, holding member ids, bounded at 16, written on the operator's own acts
// only, and never read by a solo page.

const KEY = "collie:hidden-machines:v1";

const member = (id: string, isLead = false): ServerSummary => ({
  id,
  name: id,
  isLead,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 1_000,
});
const crew = [member("bluefin", true), member("workshop"), member("attic")];

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

describe("hidden machines — the store", () => {
  it("hides a machine and shows it again, in storage and in memory", () => {
    expect(currentHiddenMachines()).toEqual([]);
    setMachineHidden("workshop", true, crew);
    expect(currentHiddenMachines()).toEqual(["workshop"]);
    expect(stored()).toEqual(["workshop"]);
    setMachineHidden("workshop", false, crew);
    expect(currentHiddenMachines()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it("re-renders a reader on every write, the useSyncExternalStore way", () => {
    const { result } = renderHook(() => useHiddenMachines(true));
    expect(result.current).toEqual([]);
    act(() => setMachineHidden("attic", true, crew));
    expect(result.current).toEqual(["attic"]);
    act(() => setMachineHidden("attic", false, crew));
    expect(result.current).toEqual([]);
  });

  it("keeps an id off the roster until the next write, which drops it", () => {
    setMachineHidden("attic", true, crew);
    // attic left the crew. A poll or a render changes nothing: the id stays stored, and filters
    // nothing, because it names no machine on screen.
    const smaller = crew.filter((s) => s.id !== "attic");
    expect(currentHiddenMachines()).toEqual(["attic"]);
    expect(machinesHiddenFrom(currentHiddenMachines(), smaller, undefined).size).toBe(0);
    // The operator's next act prunes it.
    setMachineHidden("workshop", true, smaller);
    expect(currentHiddenMachines()).toEqual(["workshop"]);
  });

  it(`bounds the set at ${MAX_HIDDEN_MACHINES}, keeping the newest and never the act itself`, () => {
    const big = Array.from({ length: MAX_HIDDEN_MACHINES + 4 }, (_, i) => member(`m${i}`, i === 0));
    for (const s of big) setMachineHidden(s.id, true, big);
    const kept = currentHiddenMachines();
    expect(kept).toHaveLength(MAX_HIDDEN_MACHINES);
    expect(kept).toContain(`m${MAX_HIDDEN_MACHINES + 3}`);
    expect(kept).not.toContain("m0");
    expect(kept).toEqual(big.slice(4).map((s) => s.id));
  });

  it("survives a malformed value: junk and a non-array read as none, bad entries are skipped", () => {
    for (const junk of ["{not json", '"workshop"', '{"id":"workshop"}', "null", "42"]) {
      localStorage.setItem(KEY, junk);
      __reloadHiddenMachines();
      expect(currentHiddenMachines()).toEqual([]);
    }
    localStorage.setItem(KEY, JSON.stringify(["workshop", 7, null, "", "workshop", { id: "attic" }, "attic"]));
    __reloadHiddenMachines();
    expect(currentHiddenMachines()).toEqual(["workshop", "attic"]);
  });

  it("never writes on a read: loading, subscribing and filtering leave storage alone", () => {
    localStorage.setItem(KEY, "{not json");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    __reloadHiddenMachines();
    const { rerender } = renderHook(() => machinesHiddenFrom(useHiddenMachines(true), crew, undefined));
    rerender();
    rerender();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    // The junk is still there: a read repairs nothing.
    expect(localStorage.getItem(KEY)).toBe("{not json");
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it("reads nothing on a solo page: the hook answers none without touching storage", () => {
    localStorage.setItem(KEY, JSON.stringify(["workshop"]));
    __reloadHiddenMachines();
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const { result, rerender } = renderHook(() => useHiddenMachines(false));
    rerender();
    expect(result.current).toEqual([]);
    expect(getItem).not.toHaveBeenCalledWith(KEY);
    getItem.mockRestore();
  });
});

describe("hidden machines — what the dashboard leaves out", () => {
  it("never leaves out the machine the dashboard addresses, the lead when ?h= is absent", () => {
    const hidden = ["bluefin", "workshop"];
    // On the lead: the lead shows whatever is stored.
    expect([...machinesHiddenFrom(hidden, crew, undefined)]).toEqual(["workshop"]);
    // On workshop: workshop shows, and the stored lead comes back into force.
    expect([...machinesHiddenFrom(hidden, crew, "workshop")]).toEqual(["bluefin"]);
  });

  it("is empty on a solo roster, and on a lead with no peer yet", () => {
    expect(machinesHiddenFrom(["workshop"], undefined, undefined).size).toBe(0);
    expect(machinesHiddenFrom(["workshop"], [member("bluefin", true)], undefined).size).toBe(0);
  });

  it("filters nothing with an id the roster does not list", () => {
    expect(machinesHiddenFrom(["cellar"], crew, undefined).size).toBe(0);
  });
});
