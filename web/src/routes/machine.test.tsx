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

// One machine's page, in two views. The row comes from the loader (the poll loop's), the history from
// the page's own timed read while Status shows, and the 1 h and 24 h views are one answer sliced
// client-side. Alerts is `?tab=alerts`.

function renderMachine(
  id: string,
  data: MachinesData = { census: fixtureMachines, error: false },
  entry = `/machines/${id}`,
  before: string[] = [],
) {
  const router = createMemoryRouter(
    [
      { path: "/machines/:id", loader: () => data, element: withHeaderHost(<MachineRoute />) },
      { path: "/machines", element: <div data-testid="machines" /> },
      { path: "/", element: <div data-testid="home" /> },
      { path: "/settings/:section", element: <div data-testid="section" /> },
    ],
    { initialEntries: [...before, entry], initialIndex: before.length },
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

  it("draws CPU, memory, disk and network charts from the history", async () => {
    renderMachine("bluefin");
    const imgs = await charts();
    expect(imgs).toHaveLength(4);
    expect(imgs.map((i) => i.getAttribute("data-kind"))).toEqual(["cpu", "mem", "disk", "net"]);
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
    const [cpu, mem, , net] = await charts();
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
    renderMachine("workshop", undefined, "/machines/workshop?tab=alerts");
    expect(await screen.findByText("Firing now")).toBeInTheDocument();
  });

  it("shows one bar per disk with its mount, used and total, and percent", async () => {
    renderMachine("workshop");
    const backups = await screen.findByRole("meter", { name: "Disk /srv/backups" });
    expect(backups).toHaveAttribute("aria-valuenow", "89");
    expect(backups.getAttribute("aria-valuetext")).toMatch(/^89%, 1\.6 \/ 1\.8 TB$/);
    expect(screen.getByRole("meter", { name: "Disk /" })).toHaveAttribute("aria-valuenow", "41");
    expect(screen.getByText("/srv/backups")).toBeInTheDocument();
  });

  it("holds the alert card with the stored rules", async () => {
    renderMachine("workshop", undefined, "/machines/workshop?tab=alerts");
    expect(await screen.findByRole("switch", { name: "CPU alert" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeChecked();
    const memAbove = screen.getByRole("radiogroup", { name: "Memory alert threshold" });
    expect(within(memAbove).getByRole("radio", { checked: true })).toHaveTextContent("95%");
  });

  it("opens Settings, Alerts from the alert card", async () => {
    const user = userEvent.setup();
    const router = renderMachine("bluefin", undefined, "/machines/bluefin?tab=alerts");
    await user.click(await screen.findByRole("button", { name: "Settings, Alerts" }));
    expect(router.state.location.pathname).toBe("/settings/alerts");
  });

  it("goes back up to Machines", async () => {
    const user = userEvent.setup();
    const router = renderMachine("bluefin");
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/machines");
  });

  it("shows an older machine's page without charts it cannot fill, and reads no history for it", async () => {
    renderMachine("pantry");
    expect(await screen.findByText("Update this machine to see its load")).toBeInTheDocument();
    // No range switch and no chart: the lead holds no minute of a machine that never sent a reading.
    expect(screen.queryByRole("radiogroup", { name: "Time range" })).toBeNull();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByText("No readings in this range yet.")).toBeNull();
    expect(historyReads).toBe(0);
  });

  it("shows a reachable machine whose reading stopped with its age marked, its numbers quieted", async () => {
    const stuck = { ...fixtureMachines.machines[0]!, sampledAt: FIXTURE_MACHINES_TS - 5 * 60_000 };
    renderMachine("bluefin", { census: { ts: FIXTURE_MACHINES_TS, machines: [stuck] }, error: false });
    const age = await screen.findByText("Last reading 5m ago");
    expect(age.className).toContain("text-status-working");
  });

  it("hides the alert controls on an older machine and says it needs updating", async () => {
    renderMachine("pantry", undefined, "/machines/pantry?tab=alerts");
    expect(await screen.findByText(/Alerts need this machine to be updated/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: /threshold/ })).toBeNull();
  });

  it("keeps the alert controls on a machine that is only down, which is not an old one", async () => {
    const down = {
      ...fixtureMachines,
      machines: fixtureMachines.machines.map((m) => (m.id === "attic" ? Object.assign({}, m, { sample: undefined }) : m)),
    };
    renderMachine("attic", { census: down, error: false }, "/machines/attic?tab=alerts");
    expect(await screen.findByRole("switch", { name: "CPU alert" })).toBeInTheDocument();
    expect(screen.queryByText(/Alerts need this machine to be updated/)).toBeNull();
  });

  it("says an unreachable machine's health and the age of the last reading", async () => {
    renderMachine("attic");
    expect(await screen.findByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText("Last reading 25m ago")).toBeInTheDocument();
  });
});

describe("the two views", () => {
  it("opens on Status, with no parameter, and the Alerts view holds the rules and no chart", async () => {
    renderMachine("bluefin");
    const status = await screen.findByRole("tab", { name: "Status" });
    expect(status).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("switch")).toBeNull();
    renderMachine("bluefin", undefined, "/machines/bluefin?tab=alerts");
    expect(await screen.findAllByRole("switch", { name: "CPU alert" })).toHaveLength(1);
  });

  it("a switch replaces the entry, so Back leaves the machine and never lands on the other view", async () => {
    const user = userEvent.setup();
    const router = renderMachine("bluefin", undefined, "/machines/bluefin", ["/"]);
    await user.click(await screen.findByRole("tab", { name: "Alerts" }));
    expect(router.state.location.search).toBe("?tab=alerts");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(await screen.findByRole("switch", { name: "CPU alert" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Status" }));
    expect(router.state.location.search).toBe("");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("a switch keeps where the machine was opened from, so the back arrow still steps back", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: "/machines/:id", loader: () => ({ census: fixtureMachines, error: false }), element: withHeaderHost(<MachineRoute />) },
        { path: "/", element: <div data-testid="home" /> },
        { path: "/machines", element: <div data-testid="machines" /> },
      ],
      { initialEntries: ["/", { pathname: "/machines/bluefin", state: { from: "/" } }], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("tab", { name: "Alerts" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("reads history only while Status shows, and coming back asks only for the newer minutes", async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    server.use(
      http.get("/api/machines/:id/history", ({ request }) => {
        historyReads += 1;
        asked.push(new URL(request.url).searchParams.get("since"));
        return HttpResponse.json(fixtureMachineHistory());
      }),
    );
    renderMachine("bluefin", undefined, "/machines/bluefin?tab=alerts");
    await screen.findByRole("switch", { name: "CPU alert" });
    expect(historyReads).toBe(0);
    await user.click(screen.getByRole("tab", { name: "Status" }));
    await charts();
    expect(historyReads).toBe(1);
    await user.click(screen.getByRole("tab", { name: "Alerts" }));
    await user.click(screen.getByRole("tab", { name: "Status" }));
    await waitFor(() => expect(historyReads).toBe(2));
    expect(asked[0]).toBeNull();
    expect(asked[1]).toBe(String(fixtureMachineHistory().points.at(-1)![0]));
  });

  it("marks the Alerts segment while a rule fires, in words for a screen reader", async () => {
    renderMachine("workshop");
    const alerts = await screen.findByRole("tab", { name: "Alerts, alert firing" });
    expect(alerts.querySelector('[data-slot="segmented-mark"]')).not.toBeNull();
    renderMachine("bluefin");
    expect(await screen.findByRole("tab", { name: "Alerts" })).toBeInTheDocument();
  });

  it("the firing line on Status opens the Alerts view", async () => {
    const user = userEvent.setup();
    const router = renderMachine("workshop");
    await user.click(await screen.findByRole("button", { name: /Alert firing: CPU/ }));
    expect(router.state.location.search).toBe("?tab=alerts");
    expect(await screen.findByText("Firing now")).toBeInTheDocument();
  });

  it("an older machine says to update on Status, and keeps the needs-an-update line on Alerts", async () => {
    const user = userEvent.setup();
    renderMachine("pantry");
    expect(await screen.findByText("Update this machine to see its load")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Alerts" }));
    expect(await screen.findByText(/Alerts need this machine to be updated/)).toBeInTheDocument();
    expect(historyReads).toBe(0);
  });

  it("offers a disk rule only for a machine that reports disks", async () => {
    renderMachine("attic", undefined, "/machines/attic?tab=alerts");
    expect(await screen.findByRole("switch", { name: "CPU alert" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Disk alert" })).toBeNull();
    renderMachine("bluefin", undefined, "/machines/bluefin?tab=alerts");
    expect(await screen.findByRole("switch", { name: "Disk alert" })).toBeInTheDocument();
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
    expect(await screen.findAllByText(/Could not load the history/)).toHaveLength(4);
    // The numbers above still show.
    expect(screen.getAllByRole("meter", { name: "CPU" })[0]).toHaveAttribute("aria-valuetext", "34%");
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

  it("reads the whole day once, then only the minutes from its newest point on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const asked: (string | null)[] = [];
    const day = fixtureMachineHistory();
    const newest = day.points.at(-1)![0];
    server.use(
      http.get("/api/machines/:id/history", ({ request }) => {
        historyReads += 1;
        const since = new URL(request.url).searchParams.get("since");
        asked.push(since);
        if (since === null) return HttpResponse.json(day);
        // The newest minute again, now complete, and one new minute after it.
        return HttpResponse.json({
          ts: day.ts + 60_000,
          stepMs: 60_000,
          points: [
            [newest, 0.5, 0.6, 0.4, 1, 1],
            [newest + 60_000, 0.99, 1, 0.4, 1, 1],
          ],
        });
      }),
    );
    renderMachine("bluefin");
    await waitFor(() => expect(historyReads).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_MS + 1_000);
    });
    await waitFor(() => expect(historyReads).toBe(2));
    expect(asked).toEqual([null, String(newest)]);
    // The merged day's CPU now ends on the new minute's 99%.
    await waitFor(() =>
      expect(screen.getAllByRole("img").find((i) => i.getAttribute("data-kind") === "cpu")?.getAttribute("aria-label")).toMatch(/now 99%/),
    );
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
