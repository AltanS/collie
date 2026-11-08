import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Keyboard } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Mark, ModTapReply, ModsReply, WireModInfo, WireModPart } from "@/lib/mods/schema";
import { createModsStore, type ModsStore, type TapHandlers } from "@/lib/mods/store";
import type { AgentView } from "@/lib/types";
import { ActionsRow } from "./actions-row";
import { beltMarksOf } from "./belt-mod-mark";

// THE BELT'S END-BLOCK MARKS (M94 slice 03): between the pins mark and Changes, in manifest order, each
// in its own frame; a tap with an intent goes to the provider and shows busy; a mark with no intent
// opens the mod's session, or is no control at all.

const AS_OF = new Date().toISOString();
function belt(mod: string, mark: Mark, rev = 1): WireModPart {
  return { host: "bluefin", mod, part: "belt", rev, asOf: AS_OF, value: { at: "belt", id: "belt", mark } };
}
const LEGS = belt("legs", { icon: "flask", face: "23/34", tone: "working", intent: "rerun" });
const TRACKER = belt("tracker", { icon: "list", face: "M94", tone: "plain" });
const QUIET = belt("quiet", { icon: "bell", count: 2 });

const MOD_SESSION: AgentView = {
  paneId: "mod:bluefin:tracker:due",
  workspaceId: "mod:bluefin",
  workspaceLabel: "Mods",
  workspaceNumber: 2,
  tabId: "mod:bluefin:tracker",
  agent: "tracker",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "mod",
};

function storeWith(parts: WireModPart[], tap: () => Promise<ModTapReply>): ModsStore {
  const mods = ["legs", "tracker", "quiet"].map((id): WireModInfo => ({ host: "bluefin", id, name: id, icon: "flask", on: true, state: "ok", places: ["belt"] }));
  const reply: ModsReply = { rev: 1, mods, parts, present: parts.map((p) => `${p.host}/${p.mod}/${p.part}`) };
  return createModsStore({ fetchMods: async () => reply, tapMod: tap, mintRequestId: () => "00000000-0000-4000-8000-000000000001" });
}

afterEach(() => cleanup());

function mount(store: ModsStore, onOpenSession = vi.fn(), handlers: TapHandlers = {}) {
  const marks = beltMarksOf({ parts: [LEGS, TRACKER, QUIET], handlersFor: () => handlers, sessions: [MOD_SESSION], onOpenSession, store });
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

describe("the mods' marks on the belt", () => {
  it("stand between the pins mark and Files, in manifest order, each in its own frame", async () => {
    const store = storeWith([LEGS, TRACKER, QUIET], async () => ({ requestId: "r", outcome: "applied" }));
    await store.syncMods(1);
    mount(store);
    const slots = [...document.querySelectorAll<HTMLElement>('[data-slot="belt-pins"], [data-slot="belt-mod-mark"], button[aria-label="Files"]')];
    expect(slots.map((el) => el.dataset.mod ?? el.getAttribute("aria-label") ?? el.dataset.slot)).toEqual(["2 pinned", "legs", "tracker", "quiet", "Files"]);
    // Each mark is its own frame, never a belt pill.
    for (const frame of document.querySelectorAll('[data-slot="belt-mod-mark"] [data-slot="mod-mark"]')) {
      expect(frame.className).toContain("border-border");
      expect(frame.className).toContain("rounded-sm");
    }
  });

  it("taps a mark with an intent through the store, and shows busy while the tap is in flight", async () => {
    let finish: (reply: ModTapReply) => void = () => {};
    const tap = vi.fn(() => new Promise<ModTapReply>((resolve) => (finish = resolve)));
    const store = storeWith([LEGS, TRACKER, QUIET], tap);
    await store.syncMods(1);
    mount(store);
    const legs = screen.getByRole("button", { name: "legs: 23/34" });
    fireEvent.click(legs);
    expect(tap).toHaveBeenCalledWith("bluefin", "legs", expect.objectContaining({ intent: "rerun" }));
    expect(legs.getAttribute("aria-busy")).toBe("true");
    expect(legs.querySelector('[data-slot="mod-mark-busy"]')).not.toBeNull();
    await act(async () => finish({ requestId: "00000000-0000-4000-8000-000000000001", outcome: "applied" }));
    expect(legs.getAttribute("aria-busy")).toBe("false");
  });

  it("opens the mod's session from a mark with no intent, and leaves a mark with neither as no control", async () => {
    const store = storeWith([LEGS, TRACKER, QUIET], async () => ({ requestId: "r", outcome: "applied" }));
    await store.syncMods(1);
    const { onOpenSession } = mount(store);
    fireEvent.click(screen.getByRole("button", { name: "Open tracker" }));
    expect(onOpenSession).toHaveBeenCalledWith(MOD_SESSION);
    const quiet = document.querySelector('[data-slot="belt-mod-mark"][data-mod="quiet"]');
    expect(quiet?.querySelector("button")).toBeNull();
  });

  it("leaves no gap when no mod has a belt part", () => {
    render(<ActionsRow general={[]} agent="claude" onRun={vi.fn()} changes={{ onClick: vi.fn(), label: "Files" }} />);
    expect(document.querySelector('[data-slot="belt-mod-mark"]')).toBeNull();
  });
});
