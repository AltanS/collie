import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { MachinesData } from "@/lib/loaders";
import { FIXTURE_MACHINES_TS, fixtureMachineRows, fixtureMachines, fixtureMachinesSolo } from "@/test/machine-fixtures";
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

const crew: MachinesData = { census: fixtureMachines, error: false };

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

  it("gives a reachable machine its CPU and memory bars, network and load", async () => {
    renderMachines(crew);
    const card = await cardOf("bluefin");
    const cpu = within(card).getByRole("meter", { name: "CPU" });
    expect(cpu).toHaveAttribute("aria-valuetext", "34%");
    expect(cpu).toHaveAttribute("aria-valuenow", "34");
    expect(within(card).getByRole("meter", { name: "Memory" })).toHaveAttribute("aria-valuetext", "7.4 / 16 GB");
    expect(within(card).getByText("1.2 MB/s")).toBeInTheDocument();
    expect(within(card).getByText("340 KB/s")).toBeInTheDocument();
    expect(within(card).getByText("1.42")).toBeInTheDocument();
    expect(within(card).getByText("8 cores")).toBeInTheDocument();
  });

  it("says a reachable machine with no sample needs an update, and draws no bar for it", async () => {
    renderMachines(crew);
    const card = await cardOf("pantry");
    expect(within(card).getByText("Update this machine to see its load")).toBeInTheDocument();
    expect(within(card).queryByRole("meter")).toBeNull();
  });

  it("shows an unreachable machine's health and the age of its last reading, not its numbers", async () => {
    renderMachines(crew);
    const card = await cardOf("attic");
    expect(within(card).getByText("unreachable")).toBeInTheDocument();
    // Aged against the answer's own clock: 25 minutes before `ts`.
    expect(within(card).getByText(/^Last reading 25m ago$/)).toBeInTheDocument();
    expect(within(card).queryByRole("meter")).toBeNull();
    expect(within(card).queryByText("12%")).toBeNull();
  });

  it("says a firing metric in words, and tints only that bar", async () => {
    renderMachines(crew);
    const card = await cardOf("workshop");
    expect(within(card).getByText("Alert firing: CPU")).toBeInTheDocument();
    const tint = (meter: HTMLElement) => meter.firstElementChild?.className ?? "";
    expect(tint(within(card).getByRole("meter", { name: "CPU" }))).toContain("bg-status-blocked");
    expect(tint(within(card).getByRole("meter", { name: "Memory" }))).toContain("bg-status-info");
  });

  it("says nothing about alerts on a machine where none fires", async () => {
    renderMachines(crew);
    const card = await cardOf("bluefin");
    expect(within(card).queryByText(/Alert firing/)).toBeNull();
    expect(within(card).getByRole("meter", { name: "CPU" }).firstElementChild?.className).toContain("bg-status-info");
  });

  it("is one card and no role badge on a solo collie", async () => {
    renderMachines({ census: fixtureMachinesSolo, error: false });
    await cardOf("this-machine");
    expect(screen.queryByText("lead")).toBeNull();
    expect(screen.getAllByRole("meter")).toHaveLength(2);
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
