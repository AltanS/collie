import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startAgainLine, startAgainNames, TricksSwitchCard, TricksSwitchControl } from "@/components/tricks-switch-card";
import { setTricksSwitch } from "@/lib/api";
import { ARM_DWELL_MS } from "@/lib/arm";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus, currentStatus } from "@/lib/status";
import { tricksStore } from "@/lib/tricks/store";
import type { WireTrickInfo } from "@/lib/tricks/schema";
import { hillDecision, trickDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";
import { tapAtFirstPaint } from "@/test/tap-at-first-paint";

// The switch for tricks as a whole (bridge/tricks/feature-switch.ts), a card in Settings, Tricks and the Hill: drawn from the
// snapshot's `tricksOff`, a tap that writes `POST /api/tricks/switch`, the armed second tap while a trick's
// Decision is open, and the Windows line.

const LABEL = "Tricks";

/** The controller under a root route whose loader answers `data`, which a test may change before a revalidation. */
function renderControl(first: Partial<HomeData>) {
  const holder = { data: first };
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => holder.data, element: <TricksSwitchControl /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return holder;
}

beforeEach(() => __resetHill());
afterEach(() => clearStatus());

describe("the tricks switch card", () => {
  it("says what tricks are, the experiment contract, and draws the switch on", () => {
    render(<TricksSwitchCard on disabled={false} onToggle={() => {}} />);
    expect(screen.getByText("Tricks are small programs that add buttons, lines and pages to Collie. A trick's program runs as you on this machine.")).toBeInTheDocument();
    expect(screen.getByText("Tricks are an experiment: they may change, lose settings, or be withdrawn in a patch release.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: LABEL })).toBeChecked();
    expect(document.querySelector('[data-slot="armed-slot"]')).toBeNull();
  });

  it("draws the switch off", () => {
    render(<TricksSwitchCard on={false} disabled={false} onToggle={() => {}} />);
    expect(screen.getByRole("switch", { name: LABEL })).not.toBeChecked();
  });

  it("a Windows bridge: the one line, and the switch cannot move", () => {
    render(<TricksSwitchCard on={false} disabled={false} windows onToggle={() => {}} />);
    expect(document.querySelector('[data-line="windows"]')?.textContent).toBe("Tricks do not run on a Windows machine yet.");
    expect(screen.getByRole("switch", { name: LABEL })).toBeDisabled();
  });

  it("draws no Windows line elsewhere", () => {
    render(<TricksSwitchCard on disabled={false} onToggle={() => {}} />);
    expect(document.querySelector('[data-line="windows"]')).toBeNull();
  });

  it("a disabled card cannot be flipped", () => {
    const onToggle = vi.fn();
    render(<TricksSwitchCard on disabled onToggle={onToggle} />);
    expect(screen.getByRole("switch", { name: LABEL })).toBeDisabled();
  });
});

describe("the first tap on the tricks switch right after the card appears", () => {
  it("still arms it: the mount effect must not drop the arm a tap in the first paint set", async () => {
    const onToggle = vi.fn();
    await tapAtFirstPaint(<TricksSwitchCard on disabled={false} waiting={3} onToggle={onToggle} />, '[role="switch"]', (host) => {
      expect(onToggle).not.toHaveBeenCalled();
      expect(host.querySelector('[data-line="armed"]')).not.toBeNull();
    });
  });
});

describe("the armed second tap on the tricks switch", () => {
  const props = { on: true, disabled: false };

  it("with no trick Decision waiting, one tap switches off at once", () => {
    const onToggle = vi.fn();
    render(<TricksSwitchCard {...props} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: LABEL }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
  });

  it("with questions waiting, the first tap arms with the count, the second switches off", () => {
    const onToggle = vi.fn();
    render(<TricksSwitchCard {...props} waiting={3} onToggle={onToggle} />);
    const sw = screen.getByRole("switch", { name: LABEL });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
    expect(sw).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("3 questions from tricks wait on the Hill. You cannot answer them while tricks are off.");
    // The same touch landing twice is not the second tap.
    clock.mockReturnValue(t0 + 100);
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
    clock.mockRestore();
  });

  it("says one question in the singular", () => {
    render(<TricksSwitchCard {...props} waiting={1} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: LABEL }));
    expect(screen.getByRole("status")).toHaveTextContent("1 question from a trick waits on the Hill. You cannot answer it while tricks are off.");
  });

  it("reserves the note's slot before the tap, so arming moves nothing", () => {
    render(<TricksSwitchCard {...props} waiting={3} onToggle={() => {}} />);
    const slot = document.querySelector('[data-slot="armed-slot"]');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('[data-line="armed"]')).toBeNull();
    expect(slot!.querySelector("[aria-hidden]")).toHaveClass("invisible");
    fireEvent.click(screen.getByRole("switch", { name: LABEL }));
    expect(document.querySelector('[data-slot="armed-slot"]')).toBe(slot);
  });

  it("the arm lapses by itself, and the next tap arms again instead of switching off", () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      render(<TricksSwitchCard {...props} waiting={2} onToggle={onToggle} />);
      const sw = screen.getByRole("switch", { name: LABEL });
      fireEvent.click(sw);
      expect(document.querySelector('[data-line="armed"]')).not.toBeNull();
      act(() => vi.advanceTimersByTime(5000));
      expect(document.querySelector('[data-line="armed"]')).toBeNull();
      fireEvent.click(sw);
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turning on never asks", () => {
    const onToggle = vi.fn();
    render(<TricksSwitchCard on={false} disabled={false} waiting={3} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: LABEL }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("the tricks switch over the snapshot and the Hill's list", () => {
  it("reads on when the snapshot carries no tricksOff, off when it does", async () => {
    renderControl({});
    expect(await screen.findByRole("switch", { name: LABEL })).toBeChecked();
  });

  it("starts off with tricksOff, and a tap on writes { on: true } and reads the snapshot again", async () => {
    let posted = "";
    server.use(
      http.post("/api/tricks/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: true });
      }),
    );
    const holder = renderControl({ tricksOff: true });
    const sw = await screen.findByRole("switch", { name: LABEL });
    expect(sw).not.toBeChecked();
    holder.data = {};
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":true}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: LABEL })).toBeChecked());
  });

  it("a refused write puts the switch back and says so on the status line", async () => {
    server.use(http.post("/api/tricks/switch", () => new HttpResponse("the tricks switch could not be saved on this machine; nothing changed", { status: 503 })));
    renderControl({});
    await userEvent.click(await screen.findByRole("switch", { name: LABEL }));
    await waitFor(() => expect(currentStatus()).toMatchObject({ text: "Could not switch tricks. Try again.", tone: "error" }));
    expect(screen.getByRole("switch", { name: LABEL })).toBeChecked();
  });

  it("a device that may only read sees the switch, disabled", async () => {
    renderControl({ device: { enforced: true, device: "tablet", authorized: false } });
    expect(await screen.findByRole("switch", { name: LABEL })).toBeDisabled();
  });

  it("counts only the Decisions a trick posted: an agent's question does not arm it", async () => {
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => requests.push(`${request.method} ${new URL(request.url).pathname}`));
    server.use(
      http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 7, open: [hillDecision()], closed: [] })),
      http.post("/api/tricks/switch", () => HttpResponse.json({ on: false })),
    );
    await act(async () => {
      syncHill(7);
      await __settleHill();
    });
    renderControl({});
    await userEvent.click(await screen.findByRole("switch", { name: LABEL }));
    await waitFor(() => expect(requests).toContain("POST /api/tricks/switch"));
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
  });

  it("with a trick's Decision open the first tap arms and writes nothing, the second writes only the switch", async () => {
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => requests.push(`${request.method} ${new URL(request.url).pathname}`));
    server.use(
      http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 7, open: [hillDecision(), trickDecision(), trickDecision()], closed: [] })),
      http.post("/api/tricks/switch", () => HttpResponse.json({ on: false })),
    );
    await act(async () => {
      syncHill(7);
      await __settleHill();
    });
    renderControl({});
    const sw = await screen.findByRole("switch", { name: LABEL });
    requests.length = 0;
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(screen.getByRole("status")).toHaveTextContent("2 questions from tricks wait on the Hill. You cannot answer them while tricks are off.");
    expect(requests).toEqual([]);
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    await act(async () => fireEvent.click(sw));
    await waitFor(() => expect(requests).toEqual(["POST /api/tricks/switch"]));
    clock.mockRestore();
  });
});

describe("setTricksSwitch", () => {
  it("posts { on } to /api/tricks/switch and answers the value the bridge holds", async () => {
    let posted = "";
    server.use(
      http.post("/api/tricks/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: false });
      }),
    );
    await expect(setTricksSwitch(false)).resolves.toBe(false);
    expect(posted).toBe('{"on":false}');
  });

  it("throws on a body that is not { on }", async () => {
    server.use(http.post("/api/tricks/switch", () => HttpResponse.json({ nope: 1 })));
    await expect(setTricksSwitch(true)).rejects.toThrow("not { on }");
  });
});

// Last in the file: it seeds the app's own tricks store, which has no reset.
describe("the tricks switch on a Windows bridge", () => {
  it("reads the gate from the tricks store: the line shows and the switch is disabled", async () => {
    server.use(http.get("/api/tricks", () => HttpResponse.json({ rev: 1, tricks: [], parts: [], present: [], gate: "windows" })));
    await act(async () => {
      await tricksStore.syncTricks(1);
    });
    renderControl({ tricksOff: true });
    expect(await screen.findByRole("switch", { name: LABEL })).toBeDisabled();
    expect(document.querySelector('[data-line="windows"]')?.textContent).toBe("Tricks do not run on a Windows machine yet.");
  });
});

// "These start again" (2026-11-17): while the big switch is off, the tricks whose own switch is on are named.
describe("the line that names the tricks a tap on the switch starts again", () => {
  const LINE = '[data-line="starts"]';
  const names = (count: number): string[] => Array.from({ length: count }, (_, n) => `trick-${String.fromCharCode(97 + n)}`);
  const row = (name: string, on: boolean): WireTrickInfo => ({ host: "lodge", id: name.toLowerCase(), name, icon: "flask", on, state: on ? "ok" : "off", places: [], provenance: { via: "folder" } });

  it("switch off, no trick on: no line", () => {
    render(<TricksSwitchCard on={false} disabled={false} startAgain={[]} onToggle={() => {}} />);
    expect(document.querySelector(LINE)).toBeNull();
  });

  it("switch off, one trick on: its name, no list words", () => {
    render(<TricksSwitchCard on={false} disabled={false} startAgain={["Tracker"]} onToggle={() => {}} />);
    expect(document.querySelector(LINE)?.textContent).toBe("These start again: Tracker.");
  });

  it("switch off, three tricks on: the three names, joined with commas", () => {
    render(<TricksSwitchCard on={false} disabled={false} startAgain={names(3)} onToggle={() => {}} />);
    expect(document.querySelector(LINE)?.textContent).toBe("These start again: trick-a, trick-b, trick-c.");
  });

  it("exactly five names: all five, no count", () => {
    expect(startAgainLine(names(5))).toBe("These start again: trick-a, trick-b, trick-c, trick-d, trick-e.");
  });

  it("seven tricks on: five names, then 'and 2 more'", () => {
    render(<TricksSwitchCard on={false} disabled={false} startAgain={names(7)} onToggle={() => {}} />);
    expect(document.querySelector(LINE)?.textContent).toBe("These start again: trick-a, trick-b, trick-c, trick-d, trick-e and 2 more.");
  });

  it("six tricks on: 'and 1 more'", () => {
    expect(startAgainLine(names(6))).toBe("These start again: trick-a, trick-b, trick-c, trick-d, trick-e and 1 more.");
  });

  it("switch on: no line, whatever is on", () => {
    render(<TricksSwitchCard on disabled={false} startAgain={names(3)} onToggle={() => {}} />);
    expect(document.querySelector(LINE)).toBeNull();
  });

  it("a Windows bridge: only the Windows line", () => {
    render(<TricksSwitchCard on={false} disabled={false} windows startAgain={names(3)} onToggle={() => {}} />);
    expect(document.querySelector(LINE)).toBeNull();
    expect(document.querySelector('[data-line="windows"]')).not.toBeNull();
  });

  it("the names come from the list's tricks that are on, in order, and from nothing on a member", () => {
    const tricks = [row("Tracker", true), row("Legs", false), row("Gates", true)];
    expect(startAgainNames({ tricks })).toEqual(["Tracker", "Gates"]);
    expect(startAgainNames({ tricks: [row("Legs", false)] })).toEqual([]);
    expect(startAgainNames({ tricks, runsOn: { lead: "lodge" } })).toEqual([]);
  });
});
