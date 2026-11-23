import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { HillCrewStateMenu } from "@/components/hill-crew-state";
import { useHillCrewStateControl } from "@/hooks/use-hill-crew-state";
import { readHillCrewStateView, readHillList } from "@/lib/hill/reader";
import { __resetHill, __settleHill, syncHill, useHillCrewState } from "@/lib/hill/store";
import type { HillCrewStateView } from "@/lib/hill/wire";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { server } from "@/test/setup";

// The Mode control of the Asks page (1.29.0's crew state, Asks build 6): a bell in the header, Here / Quiet / Away as
// the rows of its menu with one help line each, the tap that writes `POST /api/hill/state`, and "Tell all sessions now"
// with its done words, all inside the menu.

const AT = 1_762_873_260_000;

function Live() {
  const crew = useHillCrewStateControl();
  if (crew.view === null) return <p>no control</p>;
  return (
    <HillCrewStateMenu
      value={crew.value}
      saved={crew.view.state}
      told={crew.view.told}
      setBy={crew.view.by === null || crew.view.at === null ? null : { by: crew.view.by, at: crew.view.at }}
      canWrite={crew.canWrite}
      busy={crew.busy}
      failed={crew.failed}
      telling={crew.telling}
      tellFailed={crew.tellFailed}
      onChange={(next) => void crew.set(next)}
      onTell={() => void crew.tell()}
    />
  );
}

function renderLive() {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => ({}), element: <Live /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
}

function serveState(first: HillCrewStateView | Response) {
  server.use(http.get("/api/hill/state", () => (first instanceof Response ? first : HttpResponse.json(first))));
}

beforeEach(() => __resetHill());

const bar = { told: null, setBy: null, canWrite: true, busy: false, failed: false, telling: false, tellFailed: false, onChange: () => {}, onTell: () => {} };

const bell = () => screen.getByRole("button", { name: /^Mode: / });
const menu = () => screen.getByRole("menu", { name: "How agents ask you" });

async function openMenu() {
  await userEvent.click(bell());
  return menu();
}

describe("the mode control", () => {
  it("is the bell alone under here, and a crossed bell with the word under quiet or away", () => {
    const { rerender } = render(<HillCrewStateMenu {...bar} value="here" saved="here" />);
    expect(bell()).toHaveAccessibleName("Mode: Here");
    expect(bell()).toHaveTextContent("");
    expect(document.querySelector('[data-slot="hill-crew-state-word"]')).toBeNull();
    const here = bell().querySelector("svg")!.outerHTML;
    rerender(<HillCrewStateMenu {...bar} value="quiet" saved="quiet" />);
    expect(bell()).toHaveAccessibleName("Mode: Quiet");
    expect(bell()).toHaveTextContent("Quiet");
    const quiet = bell().querySelector("svg")!.outerHTML;
    expect(quiet).not.toBe(here);
    rerender(<HillCrewStateMenu {...bar} value="away" saved="away" />);
    expect(bell()).toHaveAccessibleName("Mode: Away");
    expect(bell()).toHaveTextContent("Away");
  });

  it("opens a menu of three radio rows with their help lines, the bell showing it is open", async () => {
    render(<HillCrewStateMenu {...bar} value="here" saved="here" />);
    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    await openMenu();
    expect(bell()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Here/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Quiet/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /^Away/ })).toHaveAttribute("aria-checked", "false");
    expect(within(menu()).getByText("Agents ask as usual.")).toBeInTheDocument();
    expect(within(menu()).getByText("Agents ask, but do not wait for your answer.")).toBeInTheDocument();
    expect(within(menu()).getByText("Agents keep back questions that need an answer now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tell all sessions now" })).toBeNull();
  });

  it("sets a value from a row, and offers the tell only under quiet or away", async () => {
    const changed: string[] = [];
    const { rerender } = render(<HillCrewStateMenu {...bar} value="here" saved="here" onChange={(next) => changed.push(next)} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Away/ }));
    expect(changed).toEqual(["away"]);
    rerender(<HillCrewStateMenu {...bar} value="away" saved="away" />);
    expect(screen.getByRole("button", { name: "Tell all sessions now" })).toBeEnabled();
  });

  it("closes on the row already chosen and sets nothing", async () => {
    const changed: string[] = [];
    render(<HillCrewStateMenu {...bar} value="here" saved="here" onChange={(next) => changed.push(next)} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Here/ }));
    expect(changed).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("shows the rows disabled where this device may not write", async () => {
    render(<HillCrewStateMenu {...bar} canWrite={false} value="away" saved="away" />);
    await openMenu();
    for (const row of screen.getAllByRole("menuitemradio")) expect(row).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tell all sessions now" })).toBeDisabled();
  });

  it("says who set quiet or away and when, without a push: a phone by its name, the CLI as a terminal (review 8)", async () => {
    const { rerender } = render(<HillCrewStateMenu {...bar} value="away" saved="away" setBy={{ by: "Pixel 9", at: Date.now() }} />);
    await openMenu();
    expect(screen.getByText(/^Set by Pixel 9 at /)).toBeInTheDocument();
    rerender(<HillCrewStateMenu {...bar} value="quiet" saved="quiet" setBy={{ by: "terminal", at: Date.now() }} />);
    expect(screen.getByText(/^Set from a terminal at /)).toBeInTheDocument();
    rerender(<HillCrewStateMenu {...bar} value="here" saved="here" setBy={{ by: "Pixel 9", at: Date.now() }} />);
    // Under here the line leaves with the tell row: the closed Collapse holds it out of reach.
    expect(screen.getByText(/^Set (by|from) /).closest("[inert]")).not.toBeNull();
  });

  it("reads done with the count once told, and the button takes no second tap", async () => {
    const { rerender } = render(<HillCrewStateMenu {...bar} value="away" saved="away" told={3} />);
    await openMenu();
    expect(screen.getByRole("button", { name: "Told 3 sessions" })).toBeDisabled();
    rerender(<HillCrewStateMenu {...bar} value="away" saved="away" told={0} />);
    expect(screen.getByRole("button", { name: "No session was waiting" })).toBeDisabled();
  });

  it("keeps the menu up with its line when a write fails, and the tell's failure line too", async () => {
    const { rerender } = render(<HillCrewStateMenu {...bar} value="here" saved="here" />);
    await openMenu();
    rerender(<HillCrewStateMenu {...bar} value="here" saved="here" failed />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not set the crew state. Try again.");
    rerender(<HillCrewStateMenu {...bar} value="away" saved="away" tellFailed />);
    expect(screen.getByText("Could not tell the sessions. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("on the route: reads the lead's value, writes a tap, closes after it, and tells once for the change", async () => {
    serveState({ state: "here", at: null, by: null, told: null });
    const posted: unknown[] = [];
    const told: unknown[] = [];
    server.use(
      http.post("/api/hill/state", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ state: "away", at: AT, by: "Pixel 9", told: null });
      }),
      http.post("/api/hill/state/tell", async ({ request }) => {
        told.push(await request.json());
        return HttpResponse.json({ told: 2 });
      }),
    );
    renderLive();
    expect(await screen.findByRole("button", { name: "Mode: Here" })).toBeInTheDocument();
    await openMenu();
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Away/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mode: Away" })).toHaveTextContent("Away"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(posted).toEqual([{ state: "away" }]);
    await openMenu();
    await userEvent.click(await screen.findByRole("button", { name: "Tell all sessions now" }));
    expect(await screen.findByRole("button", { name: "Told 2 sessions" })).toBeDisabled();
    expect(told).toEqual([{ at: AT }]);
  });

  it("a refused write puts the control back and says so in the open menu", async () => {
    serveState({ state: "quiet", at: AT, by: "terminal", told: null });
    server.use(http.post("/api/hill/state", () => new HttpResponse("no", { status: 403 })));
    renderLive();
    expect(await screen.findByRole("button", { name: "Mode: Quiet" })).toBeInTheDocument();
    await openMenu();
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Away/ }));
    expect(await screen.findByText("Could not set the crew state. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^Quiet/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a member, whose bridge answers no crew state, draws no control", async () => {
    let asked = 0;
    server.use(
      http.get("/api/hill/state", () => {
        asked += 1;
        return new HttpResponse("the crew state lives on the crew's lead", { status: 400 });
      }),
    );
    renderLive();
    await waitFor(() => expect(asked).toBe(1));
    expect(screen.getByText("no control")).toBeInTheDocument();
  });
});

describe("the crew state on the wire", () => {
  it("a list carries it, and a value this build does not know is left out", () => {
    expect(readHillList({ rev: 2, open: [], closed: [], crewState: { state: "away", at: AT, by: "Pixel 9", told: 4 } })?.crewState).toEqual({ state: "away", at: AT, by: "Pixel 9", told: 4 });
    expect(readHillList({ rev: 2, open: [], closed: [], crewState: { state: "asleep", at: AT, by: "x" } })?.crewState).toBeUndefined();
    expect(readHillCrewStateView({ state: "quiet", at: null, by: null })).toEqual({ state: "quiet", at: null, by: null, told: null });
  });

  it("the store takes it from a list, and keeps it when a snapshot names no number", async () => {
    server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 3, open: [], closed: [], crewState: { state: "quiet", at: AT, by: "terminal" } })));
    const seen: (string | null)[] = [];
    function Probe() {
      seen.push(useHillCrewState()?.state ?? null);
      return null;
    }
    render(<Probe />);
    await act(async () => {
      syncHill(3);
      await __settleHill();
    });
    expect(seen.at(-1)).toBe("quiet");
    await act(async () => {
      syncHill(undefined);
      await __settleHill();
    });
    expect(seen.at(-1)).toBe("quiet");
  });
});
