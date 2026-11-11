import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { HillCrewStateBar } from "@/components/hill-crew-state";
import { useHillCrewStateControl } from "@/hooks/use-hill-crew-state";
import { readHillCrewStateView, readHillList } from "@/lib/hill/reader";
import { __resetHill, __settleHill, syncHill, useHillCrewState } from "@/lib/hill/store";
import type { HillCrewStateView } from "@/lib/hill/wire";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { server } from "@/test/setup";

// The crew state at the top of the Hill (1.29.0): Here / Quiet / Away with one helper line each, the
// tap that writes `POST /api/hill/state`, and "Tell all sessions now" with its done words.

const AT = 1_762_873_260_000;

function Live() {
  const crew = useHillCrewStateControl();
  if (crew.view === null) return <p>no control</p>;
  return (
    <HillCrewStateBar
      value={crew.value}
      saved={crew.view.state}
      told={crew.view.told}
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

const bar = { told: null, canWrite: true, busy: false, failed: false, telling: false, tellFailed: false, onChange: () => {}, onTell: () => {} };

describe("the crew state control", () => {
  it("offers the three values, each with its one helper line, and no tell under here", () => {
    const { rerender } = render(<HillCrewStateBar {...bar} value="here" saved="here" />);
    expect(screen.getByRole("radiogroup", { name: "Crew state" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Here" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Quiet" })).not.toBeChecked();
    expect(screen.getByText("Agents post as usual.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tell all sessions now" })).toBeNull();
    rerender(<HillCrewStateBar {...bar} value="quiet" saved="quiet" />);
    expect(screen.getByText("No push. Agents post but do not wait.")).toBeInTheDocument();
    rerender(<HillCrewStateBar {...bar} value="away" saved="away" />);
    expect(screen.getByText("No push. Agents hold questions that need an answer now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tell all sessions now" })).toBeEnabled();
  });

  it("reads done with the count once told, and the button takes no second tap", () => {
    const { rerender } = render(<HillCrewStateBar {...bar} value="away" saved="away" told={3} />);
    expect(screen.getByRole("button", { name: "Told 3 sessions" })).toBeDisabled();
    rerender(<HillCrewStateBar {...bar} value="away" saved="away" told={0} />);
    expect(screen.getByRole("button", { name: "No session was waiting" })).toBeDisabled();
  });

  it("on the route: reads the lead's value, writes a tap, and tells once for the change", async () => {
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
    expect(await screen.findByRole("radio", { name: "Here" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Away" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Away" })).toBeChecked());
    expect(posted).toEqual([{ state: "away" }]);
    await userEvent.click(await screen.findByRole("button", { name: "Tell all sessions now" }));
    expect(await screen.findByRole("button", { name: "Told 2 sessions" })).toBeDisabled();
    expect(told).toEqual([{ at: AT }]);
  });

  it("a refused write puts the control back and says so under it", async () => {
    serveState({ state: "quiet", at: AT, by: "terminal", told: null });
    server.use(http.post("/api/hill/state", () => new HttpResponse("no", { status: 403 })));
    renderLive();
    expect(await screen.findByRole("radio", { name: "Quiet" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Away" }));
    expect(await screen.findByText("Could not set the crew state. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Quiet" })).toBeChecked();
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
