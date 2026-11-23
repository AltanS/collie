import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HillRow, HillRowControl, type HillRowProps } from "@/components/hill-row";
import { ARM_DWELL_MS } from "@/lib/arm";
import { __resetHill, __settleHill, syncHill, useHillOpen } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { clearStatus, currentStatus } from "@/lib/status";
import { groupDecision, hillDecision, trickDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";
import { tapAtFirstPaint } from "@/test/tap-at-first-paint";

// Settings → Tricks → The Hill (bridge/hill/switch.ts): the first row of the trick list, drawn from the snapshot's `hillOff`
// in the root data, a tap that writes `POST /api/hill/switch` and reads the snapshot again, and a
// refusal that puts the switch back and says so. The row's words, its labels and its link are tested here too; the details
// page's head holds the same switch (hill-page.test.tsx).

/** The row over props, in a router: its name is a link. */
function Row(props: Omit<HillRowProps, "to" | "waiting"> & { waiting?: number }) {
  return (
    <MemoryRouter>
      <HillRow waiting={0} to="/settings/tricks/hill" {...props} />
    </MemoryRouter>
  );
}

/** The row under a root route whose loader answers `data`, which a test may change before a revalidation. */
function renderRow(first: Partial<HomeData>) {
  const holder = { data: first };
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => holder.data, element: <HillRowControl /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return holder;
}

/** The note while it shows: its layer is the visible one (the unarmed ghost is aria-hidden). */
const shown = (root: ParentNode = document) => root.querySelector('[data-line="armed"]:not([aria-hidden])');

beforeEach(() => __resetHill());
afterEach(() => clearStatus());

describe("the Hill's row in Settings, Tricks", () => {
  it("is one row: the mountain, the name, the labels, one line of what it is, and the switch", () => {
    render(<Row on disabled={false} onToggle={() => {}} />);
    const row = document.querySelector('[data-hill-row]')!;
    expect(row.querySelector('[data-slot="row-name"]')).toHaveTextContent("Asks");
    expect(row.querySelector('[data-line="description"]')).toHaveTextContent("Agents and tricks ask you a question here. You answer with one tap.");
    // Built in is a neutral label: no Official accent, no mark that claims safety.
    const built = row.querySelector('[data-slot="trick-origin"]')!;
    expect(built).toHaveTextContent("Built in");
    expect(built.getAttribute("data-origin")).toBe("builtin");
    expect(built.className).not.toContain("control-on");
    expect(built.querySelector("svg")).toBeNull();
    expect(row.querySelector('[data-slot="experimental-badge"]')).not.toBeNull();
    // Answers to asks are typed into sessions: the chip after the label says it costs agent tokens.
    expect(row.querySelector('[data-slot="token-use"]')?.textContent).toBe("Uses agent tokens");
    expect(screen.getByRole("switch", { name: "Asks" })).toBeChecked();
    // The old card's long words are gone from the row: the page holds them.
    expect(screen.queryByText(/Off: they cannot post/)).toBeNull();
    expect(screen.queryByText(/An experiment: it may change/)).toBeNull();
  });

  it("opens the details page from the name's link, and the switch is no part of that link", () => {
    render(<Row on disabled={false} onToggle={() => {}} />);
    const link = screen.getByRole("link", { name: "About Asks" });
    expect(link.getAttribute("href")).toBe("/settings/tricks/hill");
    expect(link.contains(screen.getByRole("switch", { name: "Asks" }))).toBe(false);
    expect(document.querySelector('[data-hill-row]')!.getAttribute("data-setting")).toBe("tricks.hill");
  });

  it.each([
    [0, null],
    [1, "1 ask waits on you"],
    [3, "3 asks wait on you"],
  ])("with %i asks waiting the slot line is %s", (waiting, line) => {
    render(<Row on disabled={false} waiting={waiting} onToggle={() => {}} />);
    const slot = document.querySelector('[data-hill-row] [data-line="slot"]');
    expect(slot?.textContent ?? null).toBe(line);
    // No places line: the Hill draws nowhere but its own page.
    expect(document.querySelector('[data-hill-row] [data-line="places"]')).toBeNull();
  });

  it("reads on when the snapshot carries no hillOff", async () => {
    renderRow({});
    expect(await screen.findByRole("switch", { name: "Asks" })).toBeChecked();
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
    const sw = await screen.findByRole("switch", { name: "Asks" });
    holder.data = { hillOff: true };
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":false}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Asks" })).not.toBeChecked());
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
    const sw = await screen.findByRole("switch", { name: "Asks" });
    expect(sw).not.toBeChecked();
    holder.data = {};
    await userEvent.click(sw);
    await waitFor(() => expect(posted).toBe('{"on":true}'));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Asks" })).toBeChecked());
  });

  it("a refused write puts the switch back and says so on the status line", async () => {
    server.use(http.post("/api/hill/switch", () => new HttpResponse("the Hill's switch could not be saved on this machine; nothing changed", { status: 503 })));
    renderRow({});
    await userEvent.click(await screen.findByRole("switch", { name: "Asks" }));
    await waitFor(() => expect(currentStatus()).toMatchObject({ text: "Could not switch Asks. Try again.", tone: "error" }));
    expect(screen.getByRole("switch", { name: "Asks" })).toBeChecked();
  });

  it("a device that may only read sees the switch, disabled", async () => {
    renderRow({ device: { enforced: true, device: "tablet", authorized: false } });
    expect(await screen.findByRole("switch", { name: "Asks" })).toBeDisabled();
  });
});

describe("the first tap on the switch right after the card appears", () => {
  it("still arms it: the mount effect must not drop the arm a tap in the first paint set", async () => {
    const onToggle = vi.fn();
    await tapAtFirstPaint(<Row on disabled={false} waiting={3} onToggle={onToggle} />, '[role="switch"]', (host) => {
      expect(onToggle).not.toHaveBeenCalled();
      expect(shown(host)).not.toBeNull();
    });
  });
});

describe("the armed second tap on the switch", () => {
  const props = { on: true, disabled: false };

  it("with no Decision waiting, one tap switches off at once", () => {
    const onToggle = vi.fn();
    render(<Row {...props} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: "Asks" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
  });

  it("with questions waiting, the first tap arms with the count of all of them, the second switches off", () => {
    const onToggle = vi.fn();
    render(<Row {...props} waiting={3} onToggle={onToggle} />);
    const sw = screen.getByRole("switch", { name: "Asks" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
    expect(sw).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait in Asks. You cannot answer them while it is off.");
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
    render(<Row {...props} waiting={1} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Asks" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 question waits in Asks. You cannot answer it while it is off.");
  });

  it("lays the note over the text in one grid cell: arming swaps the layers and the row keeps its height", () => {
    render(<Row {...props} waiting={3} onToggle={() => {}} />);
    const cell = document.querySelector('[data-slot="hill-text"]')!;
    const text = cell.querySelector('[data-layer="text"]')!;
    const note = cell.querySelector('[data-line="armed"]')!;
    // Both layers share the cell's one grid area, so the cell is as tall as the taller one.
    expect(cell).toHaveClass("grid");
    expect(text).toHaveClass("col-start-1", "row-start-1");
    expect(note).toHaveClass("col-start-1", "row-start-1");
    // Unarmed: the note is a ghost, the text shows.
    expect(note).toHaveClass("invisible");
    expect(note.getAttribute("aria-hidden")).toBe("true");
    expect(text).not.toHaveClass("invisible");
    expect(text.getAttribute("aria-hidden")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Asks" }));
    // Armed: the note shows, the text is the ghost. Same two elements, none added or removed.
    expect(cell.querySelector('[data-line="armed"]')).toBe(note);
    expect(note).not.toHaveClass("invisible");
    expect(note.getAttribute("aria-hidden")).toBeNull();
    expect(text).toHaveClass("invisible");
    expect(text.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("status")).toBe(note);
  });

  it("holds the note's layer once a question waited, until the row unmounts, so the row does not shrink after the second tap", () => {
    const { rerender } = render(<Row {...props} waiting={3} onToggle={() => {}} />);
    const note = document.querySelector('[data-line="armed"]');
    expect(note).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Asks" }));
    rerender(<Row {...props} waiting={0} onToggle={() => {}} />);
    expect(document.querySelector('[data-line="armed"]')).toBe(note);
  });

  it("draws only the text when no question waits, and no note layer while the Hill is off", () => {
    const { rerender } = render(<Row {...props} waiting={0} onToggle={() => {}} />);
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
    expect(document.querySelector('[data-layer="text"]')).not.toBeNull();
    rerender(<Row on={false} disabled={false} waiting={3} onToggle={() => {}} />);
    expect(document.querySelector('[data-line="armed"]')).toBeNull();
  });

  it("the stretched link still opens the page from the text area while unarmed: the text layer is no control and sits under the link's layer", () => {
    render(<Row {...props} waiting={3} onToggle={() => {}} />);
    const link = screen.getByRole("link", { name: "About Asks" });
    expect(link.className).toContain("after:absolute");
    expect(document.querySelector('[data-layer="text"]')!.closest("a")).toBeNull();
    expect(document.querySelector('[data-hill-row]')!.querySelector('[data-layer="text"] button, [data-layer="text"] a')).toBeNull();
  });

  it("the arm lapses by itself, and the next tap arms again instead of switching off", () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      render(<Row {...props} waiting={2} onToggle={onToggle} />);
      const sw = screen.getByRole("switch", { name: "Asks" });
      fireEvent.click(sw);
      expect(shown()).not.toBeNull();
      act(() => vi.advanceTimersByTime(5000));
      expect(shown()).toBeNull();
      fireEvent.click(sw);
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turning on never asks", () => {
    const onToggle = vi.fn();
    render(<Row on={false} disabled={false} waiting={3} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: "Asks" }));
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
              <HillRowControl />
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

    const sw = await screen.findByRole("switch", { name: "Asks" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(sw);
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait in Asks. You cannot answer them while it is off.");
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
