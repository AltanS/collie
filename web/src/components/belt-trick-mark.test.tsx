import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Keyboard } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Mark, TrickTapReply, TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore, type TapHandlers } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { ActionsRow } from "./actions-row";
import { beltMarksOf } from "./belt-trick-mark";

// THE BELT'S END-BLOCK MARKS (M94 slice 03): between the pins mark and Changes, in manifest order, each
// in its own frame; a tap with an intent goes to the provider and shows busy; a mark with no intent
// opens the trick's session, or is no control at all.

const AS_OF = new Date().toISOString();
function belt(trick: string, mark: Mark, rev = 1): WireTrickPart {
  return { host: "bluefin", trick, part: "belt", rev, asOf: AS_OF, value: { at: "belt", id: "belt", mark } };
}
const LEGS = belt("legs", { icon: "flask", face: "23/34", tone: "working", intent: "rerun" });
const TRACKER = belt("tracker", { icon: "list", face: "M94", tone: "plain" });
const QUIET = belt("quiet", { icon: "bell", count: 2 });

const TRICK_SESSION: AgentView = {
  paneId: "trick:bluefin:tracker:due",
  workspaceId: "trick:bluefin",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:bluefin:tracker",
  agent: "tracker",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "trick",
};

function storeWith(parts: WireTrickPart[], tap: () => Promise<TrickTapReply>): TricksStore {
  const tricks = ["legs", "tracker", "quiet"].map((id): WireTrickInfo => ({ host: "bluefin", id, name: id, icon: "flask", on: true, state: "ok", places: ["belt"] }));
  const reply: TricksReply = { rev: 1, tricks, parts, present: parts.map((p) => `${p.host}/${p.trick}/${p.part}`) };
  return createTricksStore({ fetchTricks: async () => reply, tapTrick: tap, mintRequestId: () => "00000000-0000-4000-8000-000000000001" });
}

afterEach(() => cleanup());

function mount(store: TricksStore, onOpenSession = vi.fn(), handlers: TapHandlers = {}) {
  const marks = beltMarksOf({ parts: [LEGS, TRACKER, QUIET], handlersFor: () => handlers, sessions: [TRICK_SESSION], onOpenSession, store });
  render(
    <ActionsRow
      general={[{ id: "keys", icon: Keyboard, label: "Keys", onSelect: vi.fn() }]}
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
  it("stand between the pins mark and Files, in manifest order, each in its own frame", async () => {
    const store = storeWith([LEGS, TRACKER, QUIET], async () => ({ requestId: "r", outcome: "applied" }));
    await store.syncTricks(1);
    mount(store);
    const slots = [...document.querySelectorAll<HTMLElement>('[data-slot="belt-pins"], [data-slot="belt-trick-mark"], button[aria-label="Files"]')];
    expect(slots.map((el) => el.dataset.trick ?? el.getAttribute("aria-label") ?? el.dataset.slot)).toEqual(["2 pinned", "legs", "tracker", "quiet", "Files"]);
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
    expect(tap).toHaveBeenCalledWith("bluefin", "legs", expect.objectContaining({ intent: "rerun" }));
    expect(legs.getAttribute("aria-busy")).toBe("true");
    expect(legs.querySelector('[data-slot="trick-mark-busy"]')).not.toBeNull();
    await act(async () => finish({ requestId: "00000000-0000-4000-8000-000000000001", outcome: "applied" }));
    expect(legs.getAttribute("aria-busy")).toBe("false");
  });

  it("opens the trick's session from a mark with no intent, and leaves a mark with neither as no control", async () => {
    const store = storeWith([LEGS, TRACKER, QUIET], async () => ({ requestId: "r", outcome: "applied" }));
    await store.syncTricks(1);
    const { onOpenSession } = mount(store);
    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(onOpenSession).toHaveBeenCalledWith(TRICK_SESSION);
    const quiet = document.querySelector('[data-slot="belt-trick-mark"][data-trick="quiet"]');
    expect(quiet?.querySelector("button")).toBeNull();
  });

  it("leaves no gap when no trick has a belt part", () => {
    render(<ActionsRow general={[]} agent="claude" onRun={vi.fn()} changes={{ onClick: vi.fn(), label: "Files" }} />);
    expect(document.querySelector('[data-slot="belt-trick-mark"]')).toBeNull();
  });
});
