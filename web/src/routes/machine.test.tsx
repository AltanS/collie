import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { HISTORY_REFRESH_MS } from "@/hooks/use-machine-history";
import type { MachinesData } from "@/lib/loaders";
import { server } from "@/test/setup";
import { FIXTURE_MACHINES_TS, fixtureMachineHistory, fixtureMachines } from "@/test/machine-fixtures";
import { withHeaderHost } from "@/test/header-host";

import { MachineRoute } from "./machine";

// One machine's page. The row comes from the loader (the poll loop's), the history from the page's own
// timed read, and the 1 h and 24 h views are one answer sliced client-side.

function renderMachine(id: string, data: MachinesData = { census: fixtureMachines, error: false }, entry = `/machines/${id}`) {
  const router = createMemoryRouter(
    [
      { path: "/machines/:id", loader: () => data, element: withHeaderHost(<MachineRoute />) },
      { path: "/machines", element: <div data-testid="machines" /> },
      { path: "/settings/:section", element: <div data-testid="section" /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

let historyReads: number;

beforeEach(() => {
  historyReads = 0;
  server.use(
    http.get("/api/machines/:id/history", () => {
      historyReads += 1;
      return HttpResponse.json(fixtureMachineHistory());
    }),
  );
});

const charts = () => screen.findAllByRole("img");

describe("the machine page", () => {
  it("shows the numbers large, the machine's name as the title, and the age of the reading", async () => {
    renderMachine("bluefin");
    expect(await screen.findByRole("heading", { name: "bluefin", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("meter", { name: "CPU" })[0]).toHaveAttribute("aria-valuetext", "34%");
    expect(screen.getByText("Last reading just now")).toBeInTheDocument();
  });

  it("draws CPU, memory and network charts from the history", async () => {
    renderMachine("bluefin");
    const imgs = await charts();
    expect(imgs).toHaveLength(3);
    expect(imgs.map((i) => i.getAttribute("data-kind"))).toEqual(["cpu", "mem", "net"]);
    for (const img of imgs) expect(img.getAttribute("aria-label")).toContain("last hour");
  });

  it("switches between the last hour and the last 24 hours without asking again", async () => {
    const user = userEvent.setup();
    renderMachine("bluefin");
    await charts();
    expect(historyReads).toBe(1);

    await user.click(screen.getByRole("radio", { name: "24 h" }));
    for (const img of await charts()) {
      expect(img.getAttribute("data-range")).toBe("day");
      expect(img.getAttribute("aria-label")).toContain("last 24 hours");
    }
    await user.click(screen.getByRole("radio", { name: "1 h" }));
    for (const img of await charts()) expect(img.getAttribute("data-range")).toBe("hour");
    // One answer, sliced twice: the switch is not a request.
    expect(historyReads).toBe(1);
  });

  it("starts on the last hour", async () => {
    renderMachine("bluefin");
    await charts();
    expect(screen.getByRole("radio", { name: "1 h" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "24 h" })).toHaveAttribute("aria-checked", "false");
  });

  it("draws the alert threshold on the chart from the stored rule", async () => {
    renderMachine("workshop");
    const [cpu, mem, net] = await charts();
    expect(cpu!.querySelector('line[data-series="threshold"]')).not.toBeNull();
    expect(mem!.querySelector('line[data-series="threshold"]')).not.toBeNull();
    expect(net!.querySelector('line[data-series="threshold"]')).toBeNull();
  });

  it("draws no threshold on a metric that has no rule", async () => {
    renderMachine("bluefin");
    const [cpu, mem] = await charts();
    expect(cpu!.querySelector('line[data-series="threshold"]')).not.toBeNull();
    // bluefin has a CPU rule and no memory rule.
    expect(mem!.querySelector('line[data-series="threshold"]')).toBeNull();
  });

  it("says in words that an alert is firing, on the numbers and on the switch", async () => {
    renderMachine("workshop");
    expect(await screen.findByText("Alert firing: CPU")).toBeInTheDocument();
    expect(screen.getByText("Firing now")).toBeInTheDocument();
  });

  it("holds the alert card with the stored rules", async () => {
    renderMachine("workshop");
    expect(await screen.findByRole("switch", { name: "CPU alert" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeChecked();
    const memAbove = screen.getByRole("radiogroup", { name: "Memory alert threshold" });
    expect(within(memAbove).getByRole("radio", { checked: true })).toHaveTextContent("95%");
  });

  it("opens Settings, Alerts from the alert card", async () => {
    const user = userEvent.setup();
    const router = renderMachine("bluefin");
    await user.click(await screen.findByRole("button", { name: "Settings, Alerts" }));
    expect(router.state.location.pathname).toBe("/settings/alerts");
  });

  it("goes back up to Machines", async () => {
    const user = userEvent.setup();
    const router = renderMachine("bluefin");
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/machines");
  });

  it("shows an older machine's page without charts it cannot fill", async () => {
    server.use(
      http.get("/api/machines/:id/history", () =>
        HttpResponse.json({ ts: FIXTURE_MACHINES_TS, stepMs: 60_000, points: [] }),
      ),
    );
    renderMachine("pantry");
    expect(await screen.findByText("Update this machine to see its load")).toBeInTheDocument();
    expect(await screen.findAllByText("No readings in this range yet.")).toHaveLength(3);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("says an unreachable machine's health and the age of the last reading", async () => {
    renderMachine("attic");
    expect(await screen.findByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText("Last reading 25m ago")).toBeInTheDocument();
  });
});

describe("the machine page without its data", () => {
  it("says no such machine for an id the census does not know, and asks for no history", async () => {
    renderMachine("nowhere");
    expect(await screen.findByText("No such machine")).toBeInTheDocument();
    expect(historyReads).toBe(0);
  });

  it("answers a 404 census with the unavailable card", async () => {
    renderMachine("bluefin", { census: null, error: false });
    expect(await screen.findByText("No machine list here")).toBeInTheDocument();
    expect(historyReads).toBe(0);
  });

  it("answers a failed census with the error card", async () => {
    renderMachine("bluefin", { census: null, error: true });
    expect(await screen.findByText("Could not load machines")).toBeInTheDocument();
  });

  it("says the history could not load, in each chart's own place", async () => {
    server.use(http.get("/api/machines/:id/history", () => HttpResponse.json({ error: "x" }, { status: 500 })));
    renderMachine("bluefin");
    expect(await screen.findAllByText(/Could not load the history/)).toHaveLength(3);
    // The numbers above and the alert card below still work.
    expect(screen.getByRole("switch", { name: "CPU alert" })).toBeInTheDocument();
  });
});

describe("the history read", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads again once a minute while the page is visible, and never on a poll tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderMachine("bluefin");
    await waitFor(() => expect(historyReads).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_MS - 1_000);
    });
    expect(historyReads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(historyReads).toBe(2));
  });

  it("does not re-read on a loader revalidation, which is what every poll tick is", async () => {
    const router = renderMachine("bluefin");
    await charts();
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        await router.revalidate();
      });
    }
    expect(historyReads).toBe(1);
  });

  it("skips the minute's read while the page is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderMachine("bluefin");
    await waitFor(() => expect(historyReads).toBe(1));
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_MS + 1_000);
    });
    expect(historyReads).toBe(1);
    spy.mockRestore();
  });
});
