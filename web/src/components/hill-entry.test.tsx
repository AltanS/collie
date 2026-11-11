import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HillAboutSheet, HillEntryRow } from "@/components/hill-entry";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { __resetHill, __settleHill, syncHill, useHillOpen } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { ARM_DWELL_MS } from "@/lib/arm";
import type { TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { clearStatus } from "@/lib/status";
import { groupDecision, hillDecision, trickDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// The Hill as a built-in entry of Settings → Tricks: a row, an About sheet and the Hill's one switch, with
// an armed second tap when questions wait. The entry writes the switch and nothing else.

const NOW = Date.parse("2026-11-08T09:41:00Z");
const LEGS: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"], provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } };

async function storeWith(tricks: WireTrickInfo[], runsOn?: { lead?: string }): Promise<TricksStore> {
  const reply: TricksReply = { rev: 5, tricks, parts: [], present: [] };
  if (runsOn !== undefined) reply.runsOn = runsOn;
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  return store;
}

const sheetProps = { open: true, onClose: () => {}, on: true, canSet: true, waiting: 0, onSet: () => {} };

beforeEach(() => __resetHill());
afterEach(() => {
  clearStatus();
  vi.restoreAllMocks();
});

describe("the Hill's row", () => {
  it("shows the name, the Built in badge, the description and the chevron, and no switch, Remove or version", () => {
    const { container } = render(<HillEntryRow onAbout={() => {}} />);
    const button = screen.getByRole("button", { name: "About Hill" });
    expect(within(button).getByText("Hill")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="hill-badge"]')).toHaveTextContent("Built in");
    expect(container.querySelector('[data-line="description"]')).toHaveTextContent("Questions from your agents and tricks that wait for your tap.");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-slot="hill-entry"] [data-slot="switch"]')).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/remove/i)).toBeNull();
    expect(container.querySelector('[data-line="slot"]')).toBeNull();
  });

  it("a tap asks to open the sheet", () => {
    const onAbout = vi.fn();
    render(<HillEntryRow onAbout={onAbout} />);
    fireEvent.click(screen.getByRole("button", { name: "About Hill" }));
    expect(onAbout).toHaveBeenCalledTimes(1);
  });
});

describe("the Hill's About sheet", () => {
  it("is a dialog named Hill with the four sentences, the built-in line and the one switch", () => {
    render(<HillAboutSheet {...sheetProps} />);
    const dialog = screen.getByRole("dialog", { name: "Hill" });
    expect(dialog.querySelector('[data-section="about"]')).toHaveTextContent(
      "The Hill is where Collie keeps the questions that wait for your tap. Agents and tricks post a question there, with options and a recommendation. Nothing is chosen for you, and your tap goes back to the one that asked. Collie itself asks there before a trick's code changes or a proposed trick is switched on.",
    );
    expect(dialog.querySelector('[data-line="built-in"]')).toHaveTextContent("Built in. It comes with Collie and cannot be removed.");
    expect(within(dialog).getAllByRole("switch")).toHaveLength(1);
    expect(within(dialog).getByRole("switch", { name: "The Hill" })).toBeChecked();
    expect(within(dialog).queryByRole("button", { name: /remove|undo/i })).toBeNull();
  });

  it("shows the switch off when the Hill is off, and a switch that cannot write is disabled", () => {
    const { rerender } = render(<HillAboutSheet {...sheetProps} on={false} />);
    expect(screen.getByRole("switch", { name: "The Hill" })).not.toBeChecked();
    rerender(<HillAboutSheet {...sheetProps} canSet={false} />);
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeDisabled();
  });

  it("with no Decision waiting, one tap switches off at once", () => {
    const onSet = vi.fn();
    render(<HillAboutSheet {...sheetProps} onSet={onSet} />);
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(onSet).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
  });

  it("with only an agent's or a trick's questions waiting, the first tap arms too and the second switches off", () => {
    const onSet = vi.fn();
    render(<HillAboutSheet {...sheetProps} waiting={2} onSet={onSet} />);
    const sw = screen.getByRole("switch", { name: "The Hill" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("2 questions wait on the Hill. You cannot answer them while it is off.");
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    fireEvent.click(sw);
    expect(onSet).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("with questions waiting, the first tap arms with the count of all of them, the second switches off", () => {
    const onSet = vi.fn();
    render(<HillAboutSheet {...sheetProps} waiting={3} onSet={onSet} />);
    const sw = screen.getByRole("switch", { name: "The Hill" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(onSet).not.toHaveBeenCalled();
    expect(sw).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait on the Hill. You cannot answer them while it is off.");
    // The same touch landing twice is not the second tap.
    clock.mockReturnValue(t0 + 100);
    fireEvent.click(sw);
    expect(onSet).not.toHaveBeenCalled();
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    fireEvent.click(sw);
    expect(onSet).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("reserves the note's slot before the tap, so arming moves nothing", () => {
    const { rerender } = render(<HillAboutSheet {...sheetProps} waiting={3} />);
    const slot = document.querySelector('[data-slot="armed-slot"]');
    expect(slot).not.toBeNull();
    // Before the tap the slot holds only the invisible copy that sets its height.
    expect(slot!.querySelector('[data-line="armed"]')).toBeNull();
    expect(slot!.querySelector("[aria-hidden]")).toHaveClass("invisible");
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(document.querySelector('[data-slot="armed-slot"]')).toBe(slot);
    rerender(<HillAboutSheet {...sheetProps} waiting={0} />);
    // The list empties when the Hill goes off; the sheet keeps the slot until it closes.
    expect(document.querySelector('[data-slot="armed-slot"]')).toBe(slot);
  });

  it("draws no slot when no question waits", () => {
    render(<HillAboutSheet {...sheetProps} waiting={0} />);
    expect(document.querySelector('[data-slot="armed-slot"]')).toBeNull();
  });

  it("says one question in the singular", () => {
    render(<HillAboutSheet {...sheetProps} waiting={1} />);
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 question waits on the Hill. You cannot answer it while it is off.");
  });

  it("the arm lapses by itself, and the next tap arms again instead of switching off", () => {
    vi.useFakeTimers();
    try {
      const onSet = vi.fn();
      render(<HillAboutSheet {...sheetProps} waiting={2} onSet={onSet} />);
      const sw = screen.getByRole("switch", { name: "The Hill" });
      fireEvent.click(sw);
      expect(document.querySelector('[data-line="armed"]')).not.toBeNull();
      act(() => vi.advanceTimersByTime(5000));
      expect(document.querySelector('[data-line="armed"]')).toBeNull();
      fireEvent.click(sw);
      expect(onSet).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turning on never asks", () => {
    const onSet = vi.fn();
    render(<HillAboutSheet {...sheetProps} on={false} waiting={3} onSet={onSet} />);
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(onSet).toHaveBeenCalledExactlyOnceWith(true);
  });
});

/** The card under a root route whose loader answers `data`, and what it asked the bridge. */
function renderCard(store: TricksStore, data: Partial<HomeData>, onSwitch = vi.fn()) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <TricksSettingsCard store={store} now={NOW} onSwitch={onSwitch} /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return onSwitch;
}

describe("the Hill's entry on the Tricks card", () => {
  it("is the first row, above the person's tricks", async () => {
    renderCard(await storeWith([LEGS]), {});
    const group = (await screen.findByText("Browser leg")).closest('[data-slot="list-group"]')!;
    expect(group.firstElementChild).toHaveAttribute("data-slot", "hill-entry");
    expect(group.children[1]).toHaveAttribute("data-trick", "legs");
  });

  it("draws no Hill row on a crew member, as the card says the lead runs the tricks", async () => {
    renderCard(await storeWith([], { lead: "lodge" }), {});
    await screen.findByText(/Tricks run on the lead of this crew/);
    expect(screen.queryByRole("button", { name: "About Hill" })).toBeNull();
  });

  it("turning the switch off changes only the switch: no Decision, proposal or trick moves", async () => {
    const open = [hillDecision(), trickDecision(), groupDecision(2)];
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => requests.push(`${request.method} ${new URL(request.url).pathname}`));
    server.use(
      http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 7, open, closed: [] })),
      http.post("/api/hill/switch", () => HttpResponse.json({ on: false })),
    );
    let seen: readonly { id: string; state: string }[] = [];
    function Probe() {
      seen = useHillOpen();
      return null;
    }
    const onSwitch = vi.fn();
    const store = await storeWith([LEGS]);
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => ({}),
          element: (
            <>
              <Probe />
              <TricksSettingsCard store={store} now={NOW} onSwitch={onSwitch} />
            </>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
    await act(async () => {
      syncHill(7);
      await __settleHill();
    });
    render(<RouterProvider router={router} />);
    const before = seen.map((d) => `${d.id}:${d.state}`);
    expect(before).toHaveLength(3);
    requests.length = 0;

    fireEvent.click(await screen.findByRole("button", { name: "About Hill" }));
    const sw = within(await screen.findByRole("dialog", { name: "Hill" })).getByRole("switch", { name: "The Hill" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait on the Hill. You cannot answer them while it is off.");
    expect(requests).toEqual([]);
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    await act(async () => fireEvent.click(sw));
    await waitFor(() => expect(requests).toContain("POST /api/hill/switch"));

    // The one write is the switch. Nothing was answered, withdrawn, dismissed or switched, and the list the
    // phone holds is the same list: the Decisions stay open, the trick stays on.
    expect(requests.filter((r) => r.startsWith("POST") || r.startsWith("PUT") || r.startsWith("DELETE"))).toEqual(["POST /api/hill/switch"]);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(seen.map((d) => `${d.id}:${d.state}`)).toEqual(before);
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    clock.mockRestore();
    server.events.removeAllListeners();
  });

  it("the sheet's switch and the Alerts switch are one value: the snapshot's hillOff", async () => {
    renderCard(await storeWith([LEGS]), { hillOff: true });
    fireEvent.click(await screen.findByRole("button", { name: "About Hill" }));
    expect(within(await screen.findByRole("dialog", { name: "Hill" })).getByRole("switch", { name: "The Hill" })).not.toBeChecked();
  });
});
