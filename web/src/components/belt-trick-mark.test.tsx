import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Mark, TrickTapReply, TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore, type TapHandlers } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { ActionsRow, type BeltMark } from "./actions-row";
import { beltMarksOf, beltTapHandlers } from "./belt-trick-mark";

// THE BELT'S END-BLOCK MARKS (M94 slice 03): between the pins mark and Changes, in manifest order, each
// in its own frame; a tap with an intent goes to the program and shows busy; a mark with no intent
// opens the trick's session, or is no control at all.

const AS_OF = new Date().toISOString();
function belt(trick: string, mark: Mark, rev = 1): WireTrickPart {
  return { host: "lodge", trick, part: "belt", rev, asOf: AS_OF, value: { at: "belt", id: "belt", mark } };
}
const LEGS = belt("legs", { icon: "flask", label: "23/34", tone: "accent", intent: "rerun" });
const TRACKER = belt("tracker", { icon: "file", label: "M94", tone: "plain" });
const QUIET = belt("quiet", { icon: "bell", badge: "2" });

const TRICK_SESSION: AgentView = {
  paneId: "trick:lodge:tracker:due",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:tracker",
  agent: "tracker",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "trick",
};

function storeWith(parts: WireTrickPart[], tap: () => Promise<TrickTapReply>): TricksStore {
  const tricks = ["legs", "tracker", "quiet"].map((id): WireTrickInfo => ({ host: "lodge", id, name: id, icon: "flask", on: true, state: "ok", places: ["belt"] }));
  const reply: TricksReply = { rev: 1, tricks, parts, present: parts.map((p) => `${p.host}/${p.trick}/${p.part}`) };
  return createTricksStore({ fetchTricks: async () => reply, tapTrick: tap, mintRequestId: () => "00000000-0000-4000-8000-000000000001" });
}

afterEach(() => cleanup());

const row = () => document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
/** The pinned block: the one absolutely placed span over the strip's end, whichever hand. */
const pinnedBlock = () => row().querySelector<HTMLElement>("span.pointer-events-none.absolute")!;
/** The scrolling strip: the parent of the trailing spacer. */
const spacer = () => row().querySelector<HTMLElement>("span[aria-hidden].h-full.shrink-0")!;
const scroller = () => spacer().parentElement!;

function mount(store: TricksStore, onOpenSession = vi.fn(), handlers: TapHandlers = {}) {
  const marks = beltMarksOf({ parts: [LEGS, TRACKER, QUIET], handlersFor: () => handlers, sessions: [TRICK_SESSION], onOpenSession, store });
  render(
    <ActionsRow
      general={[{ id: "keys", icon: "keys-drawer", label: "Keys", onSelect: vi.fn() }]}
      agent="claude"
      onRun={vi.fn()}
      pins={{ count: 2, onClick: vi.fn(), label: "2 pinned", expanded: false }}
      marks={marks}
      changes={{ onClick: vi.fn(), label: "Files" }}
      handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
    />,
  );
  return { onOpenSession };
}

describe("the tricks' marks on the belt", () => {
  it("stand in the scrolling strip in manifest order, each in its own frame, and none in the pinned block", async () => {
    const store = storeWith([LEGS, TRACKER, QUIET], async () => ({ rid: "r", code: "ok" as const }));
    await store.syncTricks(1);
    mount(store);
    const slots = [...pinnedBlock().querySelectorAll<HTMLElement>('[data-slot="belt-pins"], [data-slot="belt-trick-mark"], button[aria-label="Files"]')];
    expect(slots.map((el) => el.dataset.trick ?? el.getAttribute("aria-label") ?? el.dataset.slot)).toEqual(["2 pinned", "Files"]);
    expect([...scroller().querySelectorAll<HTMLElement>('[data-slot="belt-trick-mark"]')].map((el) => el.dataset.trick)).toEqual(["legs", "tracker", "quiet"]);
    // Each mark is its own frame, never a belt pill.
    for (const frame of document.querySelectorAll('[data-slot="belt-trick-mark"] [data-slot="trick-mark"]')) {
      expect(frame.className).toContain("border-border");
      expect(frame.className).toContain("rounded-sm");
    }
  });

  it("taps a mark with an intent through the store, and shows busy while the tap is in flight", async () => {
    let finish: (reply: TrickTapReply) => void = () => {};
    const tap = vi.fn(() => new Promise<TrickTapReply>((resolve) => (finish = resolve)));
    const store = storeWith([LEGS, TRACKER, QUIET], tap);
    await store.syncTricks(1);
    mount(store);
    const legs = screen.getByRole("button", { name: "legs: 23/34" });
    fireEvent.click(legs);
    expect(tap).toHaveBeenCalledWith("lodge", "legs", expect.objectContaining({ intent: "rerun" }));
    expect(legs.getAttribute("aria-busy")).toBe("true");
    expect(legs.querySelector('[data-slot="trick-mark-busy"]')).not.toBeNull();
    await act(async () => finish({ rid: "00000000-0000-4000-8000-000000000001", code: "ok" }));
    expect(legs.getAttribute("aria-busy")).toBe("false");
  });

  it("fault A: says a refused tap as a status event in Collie's words, so nothing on the belt moves", async () => {
    const status = await import("@/lib/status");
    const said = vi.spyOn(status, "setStatus");
    const tap = vi.fn(async (): Promise<TrickTapReply> => ({ rid: "00000000-0000-4000-8000-000000000001", code: "rejected", refused: "session", message: "The bridge's English line" }));
    const store = storeWith([LEGS, TRACKER, QUIET], tap);
    await store.syncTricks(1);
    mount(store, vi.fn(), { from: { session: "lodge:w6X:3" } });
    const legs = screen.getByRole("button", { name: "legs: 23/34" });
    const before = row().innerHTML;
    await act(async () => {
      fireEvent.click(legs);
    });
    expect(tap).toHaveBeenCalledWith("lodge", "legs", expect.objectContaining({ intent: "rerun", rev: 1, from: { session: "lodge:w6X:3" } }));
    expect(said).toHaveBeenCalledWith("No open agent session here. Nothing ran.", "warn");
    expect(row().innerHTML).toBe(before);
    said.mockRestore();
  });

  it("fault A: names the agent session open on the phone, and none from a shell pane or no pane", () => {
    expect(beltTapHandlers({ paneId: "w6X:3", kind: "agent" }, "lodge")).toEqual({ from: { session: "lodge:w6X:3" } });
    expect(beltTapHandlers({ paneId: "w6X:3", kind: "agent", host: "workshop" }, "lodge")).toEqual({ from: { session: "workshop:w6X:3" } });
    expect(beltTapHandlers({ paneId: "w6X:4", kind: "shell" }, "lodge")).toEqual({});
    expect(beltTapHandlers({ paneId: "trick:lodge:legs:due", kind: "trick" }, "lodge")).toEqual({});
    expect(beltTapHandlers(undefined, "lodge")).toEqual({});
  });

  it("opens the trick's session from a mark with no intent, and draws a mark with neither as the same control, aria-disabled", async () => {
    const tap = vi.fn(async () => ({ rid: "r", code: "ok" as const }));
    const store = storeWith([LEGS, TRACKER, QUIET], tap);
    await store.syncTricks(1);
    const { onOpenSession } = mount(store);
    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(onOpenSession).toHaveBeenCalledWith(TRICK_SESSION);
    // The step 3 fix: the quiet mark is the same button in the same frame, not a span under the pins.
    const quiet = screen.getByRole("button", { name: "quiet: 2" });
    expect(quiet.dataset.slot).toBe("trick-mark");
    expect(quiet.getAttribute("aria-disabled")).toBe("true");
    expect(quiet.closest('[data-slot="belt-trick-mark"]')?.getAttribute("data-trick")).toBe("quiet");
    expect(quiet.parentElement?.closest("button")).toBeNull();
    fireEvent.click(quiet);
    expect(tap).not.toHaveBeenCalled();
    expect(onOpenSession).toHaveBeenCalledOnce();
  });

  it("never nests one control in another", async () => {
    const store = storeWith([LEGS, TRACKER, QUIET], async () => ({ rid: "r", code: "ok" as const }));
    await store.syncTricks(1);
    mount(store);
    expect(document.querySelectorAll('[data-slot="belt-trick-mark"] button button')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="belt-trick-mark"] button')).toHaveLength(3);
  });

  it("leaves no gap when no trick has a belt part", () => {
    render(<ActionsRow general={[]} agent="claude" onRun={vi.fn()} changes={{ onClick: vi.fn(), label: "Files" }} />);
    expect(document.querySelector('[data-slot="belt-trick-mark"]')).toBeNull();
  });
});

// WHERE THE MARKS STAND (M94): the last section of the strip, never in the pinned block, under both hands.
function placed(count: number, hand: "right" | "left") {
  const marks: BeltMark[] = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    trick: `t${i}`,
    face: <button type="button" data-slot="trick-mark" aria-label={`mark ${i}`} />,
  }));
  render(
    <ActionsRow
      general={[{ id: "keys", icon: "keys-drawer", label: "Keys", onSelect: vi.fn() }]}
      agent="claude"
      onRun={vi.fn()}
      stop={{ onStop: vi.fn(), paneId: "p1", running: false }}
      hand={hand}
      pins={{ count: 2, onClick: vi.fn(), label: "2 pinned", expanded: false }}
      marks={marks}
      changes={{ onClick: vi.fn(), label: "Files" }}
      handle={{ ref: vi.fn(), onClick: vi.fn(), label: "Switch pane" }}
    />,
  );
}

describe.each(["right", "left"] as const)("the trick marks' place, hand %s", (hand) => {
  it.each([0, 1, 3])("with %i marks: none in the pinned block, all in the strip after Collie's own pills and before the spacer", (count) => {
    placed(count, hand);
    expect(pinnedBlock().querySelector('[data-slot="belt-trick-mark"]')).toBeNull();
    const kids = [...scroller().children];
    expect(kids.at(-1)).toBe(spacer());
    const marks = kids.slice(kids.length - 1 - count, -1);
    expect(marks).toHaveLength(count);
    for (const slot of marks) expect(slot.querySelector('[data-slot="belt-trick-mark"]')).not.toBeNull();
    // Every pill Collie itself puts in the strip stands before the first mark.
    const own = kids.slice(0, kids.length - 1 - count);
    expect(own.length).toBeGreaterThan(0);
    for (const el of own) expect(el.querySelector('[data-slot="belt-trick-mark"]')).toBeNull();
    expect(row().querySelectorAll('[data-slot="belt-trick-mark"]')).toHaveLength(count);
  });

  it("leaves the pinned block's pill count and the spacer's inset the same with and without marks", () => {
    placed(0, hand);
    const without = { width: spacer().style.width, pills: pinnedBlock().querySelectorAll("button").length };
    cleanup();
    placed(3, hand);
    expect({ width: spacer().style.width, pills: pinnedBlock().querySelectorAll("button").length }).toEqual(without);
    // Three pinned pills (pins, Files, Switch) at the default scale: 208 + the belt's end air.
    expect(without).toEqual({ width: "224px", pills: 3 });
  });
});

describe("the trick marks' slot", () => {
  it("keeps the strip's gap, no divider and no tint, and sets no touch-action of its own", () => {
    placed(2, "right");
    for (const slot of row().querySelectorAll<HTMLElement>('[data-slot="belt-trick-mark"]')) {
      expect(slot.className).not.toMatch(/border|bg-|touch-/);
      expect(slot.parentElement?.parentElement?.className).not.toMatch(/border|bg-|touch-/);
    }
  });

  it("mirrors the cancelled gap under the left hand and reads left to right", () => {
    placed(1, "left");
    const slot = row().querySelector<HTMLElement>('[data-slot="belt-trick-mark"]')!;
    expect(slot.className).toContain("[direction:ltr]");
    expect(slot.className).toContain("pl-1.5");
    // Collapse's grid is two levels up: its inner clip box, then the box that wears the caller's class.
    expect(slot.parentElement?.parentElement?.className).toContain("-ml-1.5");
  });
});

// A PART THAT FAILS DRAWS ALONE (M94 review): one broken mark never takes the belt's other marks, or the Chat, with it.
describe("a belt part that is broken", () => {
  /** A belt part whose `mark` throws when it is read: the worst a bad reply can do to the renderer. */
  function throwing(trick: string): WireTrickPart {
    const value = {
      at: "belt" as const,
      id: "belt",
      get mark(): Mark {
        throw new Error("a mark that cannot be read");
      },
    };
    return { host: "lodge", trick, part: "belt", rev: 1, asOf: AS_OF, value };
  }

  it("leaves the other marks drawn when one throws", async () => {
    const parts = [LEGS, throwing("tracker"), QUIET];
    const store = storeWith(parts, async () => ({ rid: "r", code: "ok" as const }));
    await store.syncTricks(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const marks = beltMarksOf({ parts, handlersFor: () => ({}), sessions: [], onOpenSession: vi.fn(), store });
    render(<ActionsRow general={[]} agent="claude" onRun={vi.fn()} marks={marks} changes={{ onClick: vi.fn(), label: "Files" }} />);
    expect(screen.getByRole("button", { name: "legs: 23/34" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "quiet: 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="trick-mark"]')).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("draws nothing for a belt part that has no mark, and leaves the others", async () => {
    const bare: WireTrickPart = { host: "lodge", trick: "tracker", part: "belt", rev: 1, asOf: AS_OF, value: JSON.parse('{"at":"belt","id":"belt"}') };
    const parts = [LEGS, bare];
    const store = storeWith(parts, async () => ({ rid: "r", code: "ok" as const }));
    await store.syncTricks(1);
    const marks = beltMarksOf({ parts, handlersFor: () => ({}), sessions: [], onOpenSession: vi.fn(), store });
    render(<ActionsRow general={[]} agent="claude" onRun={vi.fn()} marks={marks} changes={{ onClick: vi.fn(), label: "Files" }} />);
    expect(document.querySelectorAll('[data-slot="trick-mark"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "legs: 23/34" })).toBeTruthy();
  });
});
