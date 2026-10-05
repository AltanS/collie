import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { MachinesData } from "@/lib/loaders";
import { FIXTURE_MACHINES_TS, fixtureMachineRows, fixtureMachines, fixtureMachinesSolo, withSpark } from "@/test/machine-fixtures";
import { withHeaderHost } from "@/test/header-host";

import { MachinesRoute } from "./machines";

// The machines list: one card per machine, lead first. It is a report on the poll loop, so the cases
// are about what a card SAYS: the order, the older-machine line, a quiet machine's health and age, and a
// firing alert in words.

function renderMachines(data: MachinesData, entry = "/machines") {
  const router = createMemoryRouter(
    [
      { path: "/machines", loader: () => data, element: withHeaderHost(<MachinesRoute />) },
      { path: "/machines/:id", element: <div data-testid="machine" /> },
      { path: "/settings", element: <div data-testid="settings" /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const crew: MachinesData = { census: withSpark(fixtureMachines), error: false };

/** A card's spark for one metric: the drawing's accessible name starts with the metric. */
function sparkOf(card: HTMLElement, metric: "CPU" | "Memory"): HTMLElement {
  return within(card).getByRole("img", { name: new RegExp(`^${metric}, last 30 minutes`) });
}

/** The card whose name button reads `name`. */
async function cardOf(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: new RegExp(`^${name}$`) });
  const card = button.closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${name}`);
  return card;
}

describe("the machines list", () => {
  it("shows one card per machine, the lead first, in the order the lead answered", async () => {
    renderMachines(crew);
    await screen.findByRole("heading", { name: "Machines" });
    const names = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((text) => ["bluefin", "workshop", "attic", "pantry"].includes(text));
    expect(names).toEqual(["bluefin", "workshop", "attic", "pantry"]);
  });

  it("puts the lead first even when the answer did not", async () => {
    const shuffled = { ts: FIXTURE_MACHINES_TS, machines: [fixtureMachineRows[1]!, fixtureMachineRows[0]!] };
    renderMachines({ census: shuffled, error: false });
    const first = (await screen.findAllByRole("button", { name: /^(bluefin|workshop)$/ }))[0];
    expect(first).toHaveTextContent("bluefin");
  });

  it("gives a reachable machine its CPU and memory now, their half hour, network and load", async () => {
    renderMachines(crew);
    const card = await cardOf("bluefin");
    expect(within(card).getByText("34%")).toBeInTheDocument();
    expect(within(card).getByText("46%")).toBeInTheDocument();
    expect(within(card).getByText("7.4 / 16 GB")).toBeInTheDocument();
    // The spark is one sentence for a screen reader: now, the peak, and the rule's line.
    expect(sparkOf(card, "CPU").getAttribute("aria-label")).toMatch(/^CPU, last 30 minutes: now 34%, peak \d+%\. Alert line at 90%\.$/);
    expect(sparkOf(card, "Memory").getAttribute("aria-label")).toMatch(/^Memory, last 30 minutes: now 46%, peak \d+%\.$/);
    expect(within(card).getByText("1.2 MB/s")).toBeInTheDocument();
    expect(within(card).getByText("340 KB/s")).toBeInTheDocument();
    expect(within(card).getByText("1.42")).toBeInTheDocument();
    expect(within(card).getByText("8 cores")).toBeInTheDocument();
  });

  it("draws a spark from the census's minutes, and the reading now at its right edge", async () => {
    renderMachines(crew);
    const spark = sparkOf(await cardOf("bluefin"), "CPU");
    expect(spark.querySelector('[data-series="line"]')).not.toBeNull();
    expect(spark.querySelector('[data-series="now"]')).not.toBeNull();
    expect(spark.querySelector('[data-series="threshold"]')).not.toBeNull();
    expect(sparkOf(await cardOf("bluefin"), "Memory").querySelector('[data-series="threshold"]')).toBeNull();
  });

  it("says a reachable machine with no sample needs an update, and draws no spark for it", async () => {
    renderMachines(crew);
    const card = await cardOf("pantry");
    expect(within(card).getByText("Update this machine to see its load")).toBeInTheDocument();
    expect(within(card).queryByRole("img")).toBeNull();
  });

  it("shows an unreachable machine's health and the age of its last reading, not its numbers", async () => {
    renderMachines(crew);
    const card = await cardOf("attic");
    expect(within(card).getByText("unreachable")).toBeInTheDocument();
    // Aged against the answer's own clock: 25 minutes before `ts`.
    expect(within(card).getByText(/^Last reading 25m ago$/)).toBeInTheDocument();
    expect(within(card).queryByRole("img")).toBeNull();
    expect(within(card).queryByText("12%")).toBeNull();
  });

  it("shows a reachable machine whose reading stopped as stale: quieted numbers and the age in words", async () => {
    const stuck = { ...fixtureMachineRows[0]!, sampledAt: FIXTURE_MACHINES_TS - 5 * 60_000 };
    renderMachines({ census: withSpark({ ts: FIXTURE_MACHINES_TS, machines: [stuck] }), error: false });
    const card = await cardOf("bluefin");
    expect(within(card).getByText("reachable")).toBeInTheDocument();
    expect(within(card).getByText(/^Last reading 5m ago$/)).toBeInTheDocument();
    expect(within(card).getByText("34%").className).toContain("text-muted-foreground");
    // No dot for "now": the reading is not now.
    expect(sparkOf(card, "CPU").querySelector('[data-series="now"]')).toBeNull();
  });

  it("says a firing metric in words, and tints only that metric", async () => {
    renderMachines(crew);
    const card = await cardOf("workshop");
    expect(within(card).getByText("Alert firing: CPU")).toBeInTheDocument();
    expect(sparkOf(card, "CPU").getAttribute("class")).toContain("text-status-blocked");
    expect(within(card).getByText("96%").className).toContain("text-status-blocked");
    expect(sparkOf(card, "Memory").getAttribute("class")).toContain("text-status-info");
  });

  it("the firing line opens the machine on its Alerts view, and the rest of the card on Status", async () => {
    const user = userEvent.setup();
    const router = renderMachines(crew);
    const card = await cardOf("workshop");
    await user.click(within(card).getByRole("button", { name: /Alert firing: CPU/ }));
    expect(router.state.location.pathname).toBe("/machines/workshop");
    expect(router.state.location.search).toBe("?tab=alerts");
    expect(router.state.location.state).toMatchObject({ from: "/machines" });
  });

  it("gives the fullest disk as one fact, Disk and its percent, with no spark", async () => {
    renderMachines(crew);
    const workshop = await cardOf("workshop");
    const fact = workshop.querySelector('[data-fact="disk"]');
    expect(fact).not.toBeNull();
    // `/srv/backups` at 89 % is fuller than `/` at 41 %.
    expect(fact!.textContent).toBe("Disk89%");
    expect(fact!.className).toContain("whitespace-nowrap");
    expect(within(workshop).getAllByRole("img")).toHaveLength(2);
    expect((await cardOf("bluefin")).querySelector('[data-fact="disk"]')!.textContent).toBe("Disk66%");
  });

  it("tints the disk figure while a disk alert fires, and says it in words", async () => {
    const full = { ...fixtureMachineRows[1]!, alerts: { disk: { above: 0.8, forMin: 30 } }, firing: ["disk" as const] };
    renderMachines({ census: withSpark({ ts: FIXTURE_MACHINES_TS, machines: [full] }), error: false });
    const card = await cardOf("workshop");
    expect(card.querySelector('[data-fact="disk"] dd')!.className).toContain("text-status-blocked");
    expect(within(card).getByText("Alert firing: Disk")).toBeInTheDocument();
  });

  it("says nothing about alerts on a machine where none fires", async () => {
    renderMachines(crew);
    const card = await cardOf("bluefin");
    expect(within(card).queryByText(/Alert firing/)).toBeNull();
    expect(sparkOf(card, "CPU").getAttribute("class")).toContain("text-status-info");
  });

  it("is one card and no role badge on a solo collie", async () => {
    renderMachines({ census: fixtureMachinesSolo, error: false });
    await cardOf("this-machine");
    expect(screen.queryByText("lead")).toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("marks the lead on a crew", async () => {
    renderMachines(crew);
    const card = await cardOf("bluefin");
    expect(within(card).getByText("lead")).toBeInTheDocument();
    expect(within(await cardOf("workshop")).queryByText("lead")).toBeNull();
  });

  it("opens a machine as a push, so back returns here", async () => {
    const user = userEvent.setup();
    const router = renderMachines(crew, "/machines?h=workshop");
    await user.click(await screen.findByRole("button", { name: "workshop" }));
    expect(router.state.location.pathname).toBe("/machines/workshop");
    expect(router.state.location.search).toBe("?h=workshop");
    expect(router.state.location.state).toMatchObject({ from: "/machines?h=workshop" });
  });

  it("goes back up to Settings", async () => {
    const user = userEvent.setup();
    const router = renderMachines(crew);
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings");
  });
});

describe("the machines list without a census", () => {
  it("answers a 404 with one card, not an error", async () => {
    renderMachines({ census: null, error: false });
    expect(await screen.findByText("No machine list here")).toBeInTheDocument();
    expect(screen.queryByText("Could not load machines")).toBeNull();
  });

  it("answers a failed fetch with a different card", async () => {
    renderMachines({ census: null, error: true });
    expect(await screen.findByText("Could not load machines")).toBeInTheDocument();
    expect(screen.queryByText("No machine list here")).toBeNull();
  });
});
