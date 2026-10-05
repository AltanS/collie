import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CREW_TAB_POLL_MS, resetMachineCensus } from "@/hooks/use-machine-census";
import { FIXTURE_MACHINES_TS, fixtureMachineRows, fixtureMachines, withSpark } from "@/test/machine-fixtures";
import { keepCensusIdentity } from "@/lib/loaders";
import { server } from "@/test/setup";

import { CrewTab } from "./crew-tab";

// The dashboard's Crew tab body (ADR 0085): one card per machine with two sparks, read on mount and
// every 15 s while it is on screen, one round at a time, nothing while the page is hidden.

let reads: URL[];
let answer: () => Response;

beforeEach(() => {
  resetMachineCensus();
  reads = [];
  answer = () => HttpResponse.json(withSpark(fixtureMachines));
  server.use(
    http.get("/api/machines", ({ request }) => {
      reads.push(new URL(request.url));
      return answer();
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function renderTab() {
  const router = createMemoryRouter(
    [
      { path: "/", element: <CrewTab /> },
      { path: "/machines/:id", element: <div data-testid="machine" /> },
    ],
    { initialEntries: ["/?h=bluefin"] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

const cardOf = async (name: string) => {
  const button = await screen.findByRole("button", {
    name: new RegExp(`^${name}$`),
  });
  const card = button.closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${name}`);
  return card;
};

describe("the Crew tab", () => {
  it("shows a skeleton until the first answer, announced as loading", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("/api/machines", async () => {
        await gate;
        return HttpResponse.json(withSpark(fixtureMachines));
      }),
    );
    renderTab();
    expect(screen.getByRole("status")).toHaveTextContent("Loading machines");
    release();
    await cardOf("bluefin");
    expect(screen.queryByText("Loading machines")).toBeNull();
  });

  it("asks for the last half hour, and draws one card per machine, the lead first", async () => {
    renderTab();
    await cardOf("bluefin");
    expect(reads[0]?.searchParams.get("spark")).toBe("30");
    const names = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((text) => ["bluefin", "workshop", "attic", "pantry"].includes(text));
    expect(names).toEqual(["bluefin", "workshop", "attic", "pantry"]);
  });

  it("gives a card its numbers, two sparks, the firing metric in words, and the lead mark", async () => {
    renderTab();
    const lead = await cardOf("bluefin");
    expect(within(lead).getByText("lead")).toBeInTheDocument();
    expect(within(lead).getByText("34%")).toBeInTheDocument();
    expect(within(lead).getByText("7.4 / 16 GB")).toBeInTheDocument();
    expect(within(lead).getByText("1.42")).toBeInTheDocument();
    expect(within(lead).getAllByRole("img")).toHaveLength(2);
    const hot = await cardOf("workshop");
    expect(within(hot).getByText("Alert firing: CPU")).toBeInTheDocument();
  });

  it("says an older machine needs an update, and an unreachable one the age of its reading", async () => {
    renderTab();
    expect(within(await cardOf("pantry")).getByText("Update this machine to see its load")).toBeInTheDocument();
    const quiet = await cardOf("attic");
    expect(within(quiet).getByText("unreachable")).toBeInTheDocument();
    expect(within(quiet).getByText("Last reading 25m ago")).toBeInTheDocument();
    expect(within(quiet).queryByRole("img")).toBeNull();
  });

  it("answers a 404 with the one card that says there is no list here", async () => {
    answer = () => HttpResponse.json({ error: "not lead", code: "crew.not_lead" }, { status: 404 });
    renderTab();
    expect(await screen.findByText("No machine list here")).toBeInTheDocument();
  });

  it("answers a first failure with the error card, and a later one by keeping the cards", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer = () => HttpResponse.json({ error: "x" }, { status: 500 });
    renderTab();
    expect(await screen.findByText("Could not load machines")).toBeInTheDocument();
    answer = () => HttpResponse.json(withSpark(fixtureMachines));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS + 100);
    });
    await cardOf("bluefin");
    answer = () => HttpResponse.json({ error: "x" }, { status: 500 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS + 100);
    });
    await screen.findByText("Could not refresh. These are the last numbers Collie read.");
    expect(await cardOf("bluefin")).toBeInTheDocument();
  });

  it("opens a machine as a step down, carrying the dashboard as where it came from", async () => {
    const user = userEvent.setup();
    const { router } = renderTab();
    await user.click(await screen.findByRole("button", { name: "workshop" }));
    expect(router.state.location.pathname).toBe("/machines/workshop");
    expect(router.state.location.search).toBe("?h=bluefin");
    expect(router.state.location.state).toMatchObject({ from: "/?h=bluefin" });
  });
});

describe("the Crew tab's pacing", () => {
  it("reads on mount, then every 15 s while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTab();
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS - 1_000);
    });
    expect(reads).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(reads).toHaveLength(2));
  });

  it("reads nothing while the page is hidden, and at once when it comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTab();
    await waitFor(() => expect(reads).toHaveLength(1));
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS * 4);
    });
    expect(reads).toHaveLength(1);
    spy.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2));
    spy.mockRestore();
  });

  it("starts a round only after the last one ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release = () => {};
    let held = 0;
    server.use(
      http.get("/api/machines", async ({ request }) => {
        reads.push(new URL(request.url));
        held += 1;
        if (held === 2) await new Promise<void>((r) => (release = r));
        return HttpResponse.json(withSpark(fixtureMachines));
      }),
    );
    renderTab();
    await cardOf("bluefin");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS + 100);
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    // Two more beats while the second round is still out: neither starts a third.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS * 2);
    });
    expect(reads).toHaveLength(2);
    release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS + 100);
    });
    await waitFor(() => expect(reads).toHaveLength(3));
  });

  it("stops reading once it unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = renderTab();
    await waitFor(() => expect(reads).toHaveLength(1));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_TAB_POLL_MS * 4);
    });
    expect(reads).toHaveLength(1);
  });

  it("shows the cards it last had at once on a return to the tab", async () => {
    const first = renderTab();
    await cardOf("bluefin");
    first.unmount();
    let release = () => {};
    server.use(
      http.get("/api/machines", async () => {
        await new Promise<void>((r) => (release = r));
        return HttpResponse.json(withSpark(fixtureMachines));
      }),
    );
    renderTab();
    // No skeleton: the kept census draws on the first frame.
    expect(screen.queryByText("Loading machines")).toBeNull();
    expect(screen.getByRole("button", { name: "bluefin" })).toBeInTheDocument();
    release();
  });
});

describe("keepCensusIdentity", () => {
  it("keeps an unchanged row's object across reads, so its memoised card does not draw again", () => {
    const a = withSpark({
      ts: FIXTURE_MACHINES_TS,
      machines: fixtureMachineRows.slice(0, 2),
    });
    const b = structuredClone(a);
    b.ts += 4_000;
    b.machines[1]!.sample!.cpu = 0.5;
    const first = keepCensusIdentity(a);
    const second = keepCensusIdentity(b);
    expect(second.ts).toBe(FIXTURE_MACHINES_TS + 4_000);
    expect(second.machines[0]).toBe(first.machines[0]);
    expect(second.machines[1]).not.toBe(first.machines[1]);
    expect(second.machines[1]!.spark).toBe(first.machines[1]!.spark);
  });
});
