import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HillSwitchCard, HillSwitchControl } from "@/components/hill-switch-card";
import { ARM_DWELL_MS } from "@/lib/arm";
import { __resetHill, __settleHill, syncHill, useHillOpen } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus, currentStatus } from "@/lib/status";
import { groupDecision, hillDecision, trickDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// Settings → Experiments → The Hill (bridge/hill/switch.ts): one row, drawn from the snapshot's `hillOff`
// in the root data, a tap that writes `POST /api/hill/switch` and reads the snapshot again, and a
// refusal that puts the switch back and says so.

/** The row under a root route whose loader answers `data`, which a test may change before a revalidation. */
function renderRow(first: Partial<HomeData>) {
  const holder = { data: first };
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => holder.data, element: <HillSwitchControl /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return holder;
}

beforeEach(() => __resetHill());
afterEach(() => clearStatus());

describe("the Hill's row in Settings", () => {
  it("names the switch and says what off does, in one row", () => {
    render(<HillSwitchCard on disabled={false} onToggle={() => {}} />);
    expect(screen.getByText("The Hill")).toBeInTheDocument();
    expect(screen.getByText("Agents and tricks ask you here. Off: they cannot post, and the Hill leaves the bar.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeChecked();
    // Answers to Decisions are typed into sessions: the chip after the label says it costs agent tokens.
    expect(document.querySelector('[data-slot="hill-switch"] [data-slot="token-use"]')?.textContent).toBe("Uses agent tokens");
  });

  it("reads on when the snapshot carries no hillOff", async () => {
    renderRow({});
    expect(await screen.findByRole("switch", { name: "The Hill" })).toBeChecked();
  });

  it("a tap off writes { on: false }, holds the position, and the read snapshot agrees", async () => {
    let posted = "";
    server.use(
      http.post("/api/hill/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: false });
      }),
    );
    const holder = renderRow({});
    const sw = await screen.findByRole("switch", { name: "The Hill" });
    holder.data = { hillOff: true };
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":false}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: "The Hill" })).not.toBeChecked());
  });

  it("starts off with hillOff, and a tap on writes { on: true }", async () => {
    let posted = "";
    server.use(
      http.post("/api/hill/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: true });
      }),
    );
    const holder = renderRow({ hillOff: true });
    const sw = await screen.findByRole("switch", { name: "The Hill" });
    expect(sw).not.toBeChecked();
    holder.data = {};
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":true}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: "The Hill" })).toBeChecked());
  });

  it("a refused write puts the switch back and says so on the status line", async () => {
    server.use(http.post("/api/hill/switch", () => new HttpResponse("the Hill's switch could not be saved on this machine; nothing changed", { status: 503 })));
    renderRow({});
    await userEvent.click(await screen.findByRole("switch", { name: "The Hill" }));
    await waitFor(() => expect(currentStatus()).toMatchObject({ text: "Could not switch the Hill. Try again.", tone: "error" }));
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeChecked();
  });

  it("a device that may only read sees the switch, disabled", async () => {
    renderRow({ device: { enforced: true, device: "tablet", authorized: false } });
    expect(await screen.findByRole("switch", { name: "The Hill" })).toBeDisabled();
  });
});

describe("the armed second tap on the switch", () => {
  const props = { on: true, disabled: false };

  it("with no Decision waiting, one tap switches off at once", () => {
    const onToggle = vi.fn();
    render(<HillSwitchCard {...props} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
  });

  it("with questions waiting, the first tap arms with the count of all of them, the second switches off", () => {
    const onToggle = vi.fn();
    render(<HillSwitchCard {...props} waiting={3} onToggle={onToggle} />);
    const sw = screen.getByRole("switch", { name: "The Hill" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
    expect(sw).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait on the Hill. You cannot answer them while it is off.");
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
    render(<HillSwitchCard {...props} waiting={1} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 question waits on the Hill. You cannot answer it while it is off.");
  });

  it("reserves the note's slot before the tap, so arming moves nothing, and keeps it when the list empties", () => {
    const { rerender } = render(<HillSwitchCard {...props} waiting={3} onToggle={() => {}} />);
    const slot = document.querySelector('[data-slot="armed-slot"]');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('[data-line="armed"]')).toBeNull();
    expect(slot!.querySelector("[aria-hidden]")).toHaveClass("invisible");
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(document.querySelector('[data-slot="armed-slot"]')).toBe(slot);
    rerender(<HillSwitchCard {...props} waiting={0} onToggle={() => {}} />);
    expect(document.querySelector('[data-slot="armed-slot"]')).toBe(slot);
  });

  it("draws no slot when no question waits, and none while the Hill is off", () => {
    const { rerender } = render(<HillSwitchCard {...props} waiting={0} onToggle={() => {}} />);
    expect(document.querySelector('[data-slot="armed-slot"]')).toBeNull();
    rerender(<HillSwitchCard on={false} disabled={false} waiting={3} onToggle={() => {}} />);
    expect(document.querySelector('[data-slot="armed-slot"]')).toBeNull();
  });

  it("the arm lapses by itself, and the next tap arms again instead of switching off", () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      render(<HillSwitchCard {...props} waiting={2} onToggle={onToggle} />);
      const sw = screen.getByRole("switch", { name: "The Hill" });
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
    render(<HillSwitchCard on={false} disabled={false} waiting={3} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("the switch over the list the phone holds", () => {
  it("counts every open Decision, and turning off writes only the switch: nothing is answered, withdrawn or dismissed", async () => {
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
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => ({}),
          element: (
            <>
              <Probe />
              <HillSwitchControl />
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

    const sw = await screen.findByRole("switch", { name: "The Hill" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait on the Hill. You cannot answer them while it is off.");
    expect(requests).toEqual([]);
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    await act(async () => fireEvent.click(sw));
    await waitFor(() => expect(requests).toContain("POST /api/hill/switch"));
    expect(requests.filter((r) => r.startsWith("POST") || r.startsWith("PUT") || r.startsWith("DELETE"))).toEqual(["POST /api/hill/switch"]);
    expect(seen.map((d) => `${d.id}:${d.state}`)).toEqual(before);
    clock.mockRestore();
    server.events.removeAllListeners();
  });
});
