import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, type InitialEntry } from "react-router";
import { vi } from "vitest";

import { ARM_DWELL_MS } from "@/lib/arm";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { clearStatus, currentStatus } from "@/lib/status";
import { asJsonString, parseJsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { partKey, type TricksReply, type WireTrickPart } from "@/lib/tricks/schema";
import { tricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { hillDecision, hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { HillRoute } from "./hill";

// The route `/hill` (M96): the header with the count, the cards from the store, Back up to the
// Dashboard, and an answer that reaches the bridge and comes back as the card's receipt. Under it the
// Dashboard's bottom bar, with the Hill item as the current one (amended 2026-11-10).

// The on-screen keyboard, as the bar reads it: up only where a test raises it.
const keyboard = vi.hoisted(() => ({ open: false }));
vi.mock("@/hooks/use-keyboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-keyboard")>()),
  useKeyboardOpen: () => keyboard.open,
}));

const LEGS_SESSION: AgentView = {
  paneId: "trick:lodge:legs:legs",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:legs",
  agent: "legs",
  status: "idle",
  cwd: "",
  focused: false,
  kind: "trick",
};

function home(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    trickSessions: [LEGS_SESSION],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    hill: true,
    ...over,
  };
}

/**
 * The Hill under the root route, as the app mounts it. By default the history is the one the bar's own
 * Hill item leaves: the Dashboard, then the Hill pushed down from it with `from` naming the Dashboard.
 */
function renderHill(entries: InitialEntry[] = ["/", { pathname: "/hill", state: { from: "/" } }], data: HomeData = home()) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "hill", element: <HillRoute /> },
          { path: "trick/:paneId", element: <div data-testid="trick" /> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

let tricksRev = 500;
async function seedTabbar(tricks: string[]) {
  tricksRev += 1;
  const parts: WireTrickPart[] = tricks.map((trick) => ({ host: "lodge", trick, part: "tabbar", rev: 1, asOf: new Date().toISOString(), value: { at: "tabbar", id: "tabbar", item: { label: trick } } }));
  const reply: TricksReply = {
    rev: tricksRev,
    tricks: tricks.map((id) => ({ host: "lodge", id, name: id, icon: "flask", on: true, state: "ok", places: ["tabbar"] })),
    parts,
    present: parts.map(partKey),
  };
  server.use(http.get(/\/api\/tricks/, () => HttpResponse.json(reply)));
  await act(() => tricksStore.syncTricks(tricksRev));
}

async function hillHolds(open: ReturnType<typeof hillDecision>[]) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed: [] })));
  await act(async () => {
    syncHill(1);
    await __settleHill();
  });
}

beforeEach(() => __resetHill());
afterEach(async () => {
  __resetHill();
  keyboard.open = false;
  localStorage.clear();
  await seedTabbar([]);
});

describe("the hill route", () => {
  it("shows the title and how many are open, and how many of them are Now", async () => {
    await hillHolds([hillDecision({ priority: "now" }), hillDecision(), hillDecision()]);
    renderHill();
    expect(await screen.findByRole("heading", { name: "Hill" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="hill-count"]')).toHaveTextContent("3 open · 1 now");
    expect(document.querySelectorAll('[data-slot="decision-card"]')).toHaveLength(3);
  });

  it("shows the clear hill, and All clear in the count line, when nothing is open", async () => {
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    expect(document.querySelector('[data-slot="hill-count"]')).toHaveTextContent("All clear");
    expect(document.querySelector('[data-slot="hill-empty"]')).toHaveTextContent("The hill is clear.");
  });

  it("goes back up to the Dashboard", async () => {
    const router = renderHill();
    await userEvent.click(await screen.findByRole("button", { name: "Back to the Dashboard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("sends an answer and shows its receipt on the card", async () => {
    const decision = hillDecision();
    await hillHolds([decision]);
    let node = "";
    server.use(
      http.post("/api/hill/answer", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        node = asJsonString(body.node) ?? "";
        return HttpResponse.json({ ...hillReceipt(), rid: asJsonString(body.rid) ?? "" });
      }),
    );
    renderHill();
    const option = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('[data-slot="decision-option"][data-intent="no"]');
      if (el === null) throw new Error("no option yet");
      return el;
    });
    await userEvent.click(option);
    await waitFor(() => expect(document.querySelector('[data-slot="decision-receipt"]')).toHaveTextContent("Sent to collie lead"));
    expect(node).toBe(`hill/${decision.id}`);
  });

  // Where a `now` Decision's notification lands (lib/push-decision.ts `notificationPath`).
  it("scrolls the card the hash names into view, once, and nothing for an id the list does not hold", async () => {
    const target = hillDecision();
    await hillHolds([hillDecision(), hillDecision(), target]);
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    scrolled.mockClear();
    renderHill(["/", { pathname: "/hill", hash: `#${target.id}`, state: { from: "/" } }]);
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    const card = scrolled.mock.contexts[0];
    if (!(card instanceof HTMLElement)) throw new Error("scrollIntoView ran on no element");
    expect(card.dataset.slot).toBe("decision-card");
    expect(card.dataset.id).toBe(target.id);
    scrolled.mockClear();
    renderHill(["/", { pathname: "/hill", hash: "#dc_zzzzzzzzzzzz", state: { from: "/" } }]);
    await screen.findAllByRole("heading", { name: "Hill" });
    expect(scrolled).not.toHaveBeenCalled();
    scrolled.mockRestore();
  });
});

describe("the Dashboard's bar on the hill route (amended 2026-11-10)", () => {
  const bar = () => screen.getByRole("navigation", { name: "Dashboard views" });
  const hillItem = () => bar().querySelector<HTMLElement>('[data-slot="tab-link"][data-link="hill"]')!;
  const storedView = () => asJsonString(parseJsonObject(localStorage.getItem("collie:dash-prefs:v1") ?? "{}")?.dashView);

  it("draws the bar under the list: the Dashboard's tabs, none selected, and the Hill item current with its count", async () => {
    await hillHolds([hillDecision({ priority: "now" }), hillDecision()]);
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    const tabs = [...bar().querySelectorAll<HTMLElement>('[data-slot="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Dashboard", "Files"]);
    for (const tab of tabs) expect(tab).not.toHaveAttribute("aria-current");
    expect(hillItem()).toHaveAttribute("aria-current", "page");
    expect(hillItem().className).toMatch(/\bborder-foreground\b/u);
    expect(hillItem().querySelector('[data-slot="tab-badge"]')).toHaveTextContent("2");
    expect(hillItem().querySelector('[data-icon="hill-now"]')).not.toBeNull();
  });

  it("draws the bar on the clear hill too, with the Hill item current and no count", async () => {
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    expect(hillItem()).toHaveAttribute("aria-current", "page");
    expect(hillItem().querySelector('[data-slot="tab-badge"]')).toBeNull();
  });

  it("ends the list above the bar: the bar is outside the scroller, which keeps its own air and leaves the safe area to the bar", async () => {
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    const scroll = document.querySelector<HTMLElement>('[data-slot="hill-scroll"]')!;
    expect(scroll.className).toMatch(/\boverflow-y-auto\b/u);
    expect(scroll.className).toMatch(/\bflex-1\b/u);
    expect(scroll.className).toMatch(/\bpb-4\b/u);
    expect(scroll.className).not.toContain("safe-area-inset-bottom");
    expect(scroll.contains(bar())).toBe(false);
    expect(scroll.compareDocumentPosition(bar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The bar owns the safe area under its row, as on the Dashboard.
    expect(bar().className).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  it("hides the bar while the on-screen keyboard is up, and the list keeps its padding", async () => {
    keyboard.open = true;
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    expect(screen.queryByRole("navigation", { name: "Dashboard views" })).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-slot="hill-scroll"]')!.className).toMatch(/\bpb-4\b/u);
  });

  it("does nothing on a tap on the Hill item: the Hill is where you are", async () => {
    const router = renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    await userEvent.click(hillItem());
    expect(router.state.location.pathname).toBe("/hill");
    expect(router.state.historyAction).toBe("POP");
  });

  it("a tab stores its view and steps back up to the Dashboard, so Back from there never lands on the Hill", async () => {
    const router = renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    await userEvent.click(within(bar()).getByRole("button", { name: "Files" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(storedView()).toBe("changes");
    // A step back, not a push: the Dashboard is the first entry again and the Hill is forward of it.
    expect(router.state.historyAction).toBe("POP");
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/");
    await act(() => router.navigate(1));
    expect(router.state.location.pathname).toBe("/hill");
  });

  it("a tab on a Hill opened cold replaces it with the Dashboard: nothing is stacked behind", async () => {
    const router = renderHill(["/hill"]);
    await screen.findByRole("heading", { name: "Hill" });
    await userEvent.click(within(bar()).getByRole("button", { name: "Dashboard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(storedView()).toBe("dashboard");
  });

  it("puts the tricks' items after the Hill, and an item opens its trick's Session sideways, in the Hill's place", async () => {
    await seedTabbar(["legs", "tracker", "triage", "spend", "deploy", "notes"]);
    const router = renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    expect(bar().dataset.mode).toBe("scroll");
    const items = [...bar().querySelectorAll<HTMLElement>('[data-slot="tab-extra"]')];
    expect(items.map((el) => el.dataset.trick)).toEqual(["legs", "tracker", "triage", "spend", "deploy", "notes"]);
    for (const el of items) expect(el).not.toHaveAttribute("aria-current");
    await userEvent.click(items[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/trick/trick%3Alodge%3Alegs%3Alegs"));
    expect(router.state.historyAction).toBe("REPLACE");
    // The Session took the Hill's entry and its `from`: the entry behind is the Dashboard.
    expect(router.state.location.state).toEqual({ from: "/" });
  });

  it("draws no Hill item and the bar without it where the snapshot carries no hill", async () => {
    renderHill(undefined, home({ hill: false }));
    await screen.findByRole("heading", { name: "Hill" });
    expect(bar().querySelector('[data-slot="tab-link"]')).toBeNull();
  });
});

// The Hill switched off (bridge/hill/switch.ts): the snapshot carries `hillOff` and no `hillRev`, so the
// root data says `hillOff: true, hill: false`. The route stays and says so, with the way back on.
describe("the hill route with the Hill switched off", () => {
  const offBar = () => document.querySelector<HTMLElement>('[data-slot="tab-bar"]');

  it("shows the off state, Off in the count line, and no Hill item in the bar", async () => {
    renderHill(undefined, home({ hill: false, hillOff: true }));
    await screen.findByRole("heading", { name: "Hill" });
    expect(document.querySelector('[data-slot="hill-count"]')).toHaveTextContent("Off");
    expect(document.querySelector('[data-slot="hill-off"]')).toHaveTextContent("The Hill is off.");
    expect(document.querySelector('[data-slot="hill-off"]')).toHaveTextContent("Agents and tricks cannot ask you here. Open Decisions come back when you switch it on.");
    expect(document.querySelector('[data-slot="hill-empty"]')).toBeNull();
    expect(offBar()?.querySelector('[data-slot="tab-link"]')).toBeNull();
  });

  it("switches the Hill on from the off state: one POST { on: true }, then the snapshot is read again", async () => {
    let posted = "";
    server.use(
      http.post("/api/hill/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: true });
      }),
    );
    let data = home({ hill: false, hillOff: true });
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => data,
          element: withHeaderHost(<Outlet />),
          children: [{ path: "hill", element: <HillRoute /> }],
        },
      ],
      { initialEntries: ["/hill"] },
    );
    render(<RouterProvider router={router} />);
    const button = await screen.findByRole("button", { name: "Switch the Hill on" });
    data = home({ hill: true });
    await userEvent.click(button);
    await waitFor(() => expect(document.querySelector('[data-slot="hill-empty"]')).toHaveTextContent("The hill is clear."));
    expect(posted).toBe('{"on":true}');
    expect(document.querySelector('[data-slot="hill-off"]')).toBeNull();
  });

  it("a refused switch keeps the off state and says so on the status line", async () => {
    server.use(http.post("/api/hill/switch", () => new HttpResponse("nope", { status: 503 })));
    renderHill(undefined, home({ hill: false, hillOff: true }));
    await userEvent.click(await screen.findByRole("button", { name: "Switch the Hill on" }));
    await waitFor(() => expect(currentStatus()).toMatchObject({ text: "Could not switch the Hill. Try again.", tone: "error" }));
    expect(document.querySelector('[data-slot="hill-off"]')).not.toBeNull();
    clearStatus();
  });

  it("a device that may only read sees the button, disabled", async () => {
    renderHill(undefined, home({ hill: false, hillOff: true, device: { enforced: true, device: "tablet", authorized: false } }));
    expect(await screen.findByRole("button", { name: "Switch the Hill on" })).toBeDisabled();
  });
});

// CLEAR on the Answered group: the quiet button at the right end of its header, one tap to arm and a
// second to clear every closed entry, the rows leaving at once and coming back if the bridge refuses.
describe("clearing the closed entries", () => {
  const closedRow = (state: "answered" | "dismissed" | "expired", at: number) => hillDecision({ state, closedAt: at, closedReason: state === "expired" ? "expired" : null });

  async function hillHoldsClosed(open: ReturnType<typeof hillDecision>[], closed: ReturnType<typeof hillDecision>[], closedTotal?: number) {
    server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open, closed, closedTotal: closedTotal ?? null })));
    await act(async () => {
      syncHill(1);
      await __settleHill();
    });
  }

  const clearButton = () => document.querySelector<HTMLButtonElement>('[data-slot="hill-clear"]');
  /** The word the button shows now: its slot holds both, and only the active layer is on top. */
  const shown = () => clearButton()?.querySelector("[data-active]")?.textContent;
  const rows = () => document.querySelectorAll('[data-slot="hill-closed-row"]').length;
  const dwell = () => new Promise((resolve) => setTimeout(resolve, ARM_DWELL_MS + 60));

  it("puts a Clear button at the right end of the Answered header, 44px tall, and none when nothing is closed", async () => {
    await hillHoldsClosed([], [closedRow("answered", 3), closedRow("dismissed", 2), closedRow("expired", 1)]);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    const header = document.querySelector('[data-slot="hill-answered"] h2')?.parentElement;
    expect(header?.lastElementChild).toContainElement(clearButton());
    expect(shown()).toBe("Clear");
    expect(clearButton()).toHaveAccessibleName("Clear");
    expect(clearButton()?.className).toContain("h-11");
    expect(rows()).toBe(3);
  });

  it("draws no button when there are no closed entries", async () => {
    await hillHolds([hillDecision()]);
    renderHill();
    await screen.findByRole("heading", { name: "Hill" });
    expect(clearButton()).toBeNull();
    expect(document.querySelector('[data-slot="hill-answered"]')).toBeNull();
  });

  it("the first tap only arms it, in place: Clear 3 entries?, and nothing is sent", async () => {
    let posted = 0;
    server.use(
      http.post("/api/hill/clear", () => {
        posted += 1;
        return HttpResponse.json({ cleared: 3, skipped: [] });
      }),
    );
    await hillHoldsClosed([], [closedRow("answered", 3), closedRow("dismissed", 2), closedRow("expired", 1)]);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    await userEvent.click(clearButton()!);
    expect(shown()).toBe("Clear 3 entries?");
    expect(clearButton()).toHaveAccessibleName("Clear 3 entries?: tap again to confirm");
    expect(clearButton()?.className).toContain("text-destructive");
    expect(posted).toBe(0);
    expect(rows()).toBe(3);
    // A tap inside the dwell is the same touch landing twice.
    await userEvent.click(clearButton()!);
    expect(posted).toBe(0);
  });

  it("the second tap posts {} once, the rows and their group leave at once, and the empty Hill shows", async () => {
    let body = "";
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post("/api/hill/clear", async ({ request }) => {
        body = await request.text();
        await held;
        return HttpResponse.json({ cleared: 2, skipped: [] });
      }),
    );
    await hillHoldsClosed([], [closedRow("answered", 3), closedRow("dismissed", 2)]);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    await userEvent.click(clearButton()!);
    await dwell();
    await userEvent.click(clearButton()!);
    // The request is still in flight: the rows are already gone.
    await waitFor(() => expect(document.querySelector('[data-slot="hill-answered"]')).toBeNull());
    expect(document.querySelector('[data-slot="hill-empty"]')).toHaveTextContent("Nothing waits on you.");
    await waitFor(() => expect(body).toBe("{}"));
    release();
    await waitFor(() => expect(currentStatus()).toBeNull());
    expect(document.querySelector('[data-slot="hill-answered"]')).toBeNull();
  });

  it("with open Decisions, the open cards stay and only the Answered group goes", async () => {
    server.use(http.post("/api/hill/clear", () => HttpResponse.json({ cleared: 1, skipped: [] })));
    await hillHoldsClosed([hillDecision(), hillDecision()], [closedRow("answered", 3)]);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    await userEvent.click(clearButton()!);
    await dwell();
    await userEvent.click(clearButton()!);
    await waitFor(() => expect(document.querySelector('[data-slot="hill-answered"]')).toBeNull());
    expect(document.querySelectorAll('[data-slot="decision-card"]')).toHaveLength(2);
    expect(document.querySelector('[data-slot="hill-empty"]')).toBeNull();
  });

  it("a refusal puts the rows back and says Could not clear. Try again. on the status line", async () => {
    server.use(http.post("/api/hill/clear", () => new HttpResponse("nope", { status: 503 })));
    await hillHoldsClosed([], [closedRow("answered", 3), closedRow("dismissed", 2)]);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    await userEvent.click(clearButton()!);
    await dwell();
    await userEvent.click(clearButton()!);
    await waitFor(() => expect(currentStatus()).toMatchObject({ text: "Could not clear. Try again.", tone: "error" }));
    await waitFor(() => expect(rows()).toBe(2));
    // Back to idle: the button says Clear and takes a new first tap.
    expect(shown()).toBe("Clear");
    expect(clearButton()).toBeEnabled();
    clearStatus();
  });

  it("asks about every closed entry the bridge holds, not only the rows it serves", async () => {
    const served = Array.from({ length: 3 }, (_, i) => closedRow("answered", 10 - i));
    await hillHoldsClosed([], served, 45);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    await userEvent.click(clearButton()!);
    expect(shown()).toBe("Clear 45 entries?");
  });

  it("says entry, not entries, for one", async () => {
    await hillHoldsClosed([], [closedRow("answered", 3)]);
    renderHill();
    await waitFor(() => expect(clearButton()).not.toBeNull());
    await userEvent.click(clearButton()!);
    expect(shown()).toBe("Clear 1 entry?");
  });

  it("a device that may only read sees the button, disabled", async () => {
    await hillHoldsClosed([], [closedRow("answered", 3)]);
    renderHill(undefined, home({ device: { enforced: true, device: "tablet", authorized: false } }));
    await waitFor(() => expect(clearButton()).not.toBeNull());
    expect(clearButton()).toBeDisabled();
  });
});
