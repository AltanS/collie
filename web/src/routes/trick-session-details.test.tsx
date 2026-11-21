import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { syncTricks } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { SettingsTrickRoute } from "./settings-trick";
import { TrickSessionHeaderRow, TrickSessionRoute } from "./trick-session";

// THE TRICK DETAILS BUTTON (2026-11-21): the trailing button of a trick's own page header opens the trick's details
// page one level below, and Back there comes up to the trick's page.

const PANE: AgentView = {
  paneId: "trick:lodge:legs:legs",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:legs",
  agent: "legs",
  status: "idle",
  cwd: "/home/me/.config/collie/tricks/legs",
  focused: false,
  kind: "trick",
  paneLabel: "Browser leg",
  sessionName: "Browser leg",
  view: "lodge/legs/legs",
};

function home(): HomeData {
  return { bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], trickSessions: [PANE], sessions: [], servers: [], ts: 0, scope: {}, viewAll: false, snoozedUntil: null, update: undefined, error: false, authError: false };
}

let rev = 900;
async function serveLegs(): Promise<void> {
  rev += 1;
  const reply = {
    rev,
    tricks: [{ host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["session"], description: "Which release checks are green." }],
    parts: [{ host: "lodge", trick: "legs", part: "legs", rev, asOf: new Date().toISOString(), value: { at: "session", id: "legs", name: "Browser leg", view: [{ kind: "para", text: "23 of 34 green" }] } }],
    present: ["lodge/legs/legs"],
  };
  server.use(
    http.get("/api/tricks", () => HttpResponse.json(reply)),
    http.get("/api/tricks/official", () => HttpResponse.json({ tricks: [] })),
  );
  await syncTricks(rev);
}

describe("the trick details button in a trick page's header", () => {
  it("is one 44 px icon button named Trick details, last in the row, and absent without a handler", () => {
    const { unmount } = render(<TrickSessionHeaderRow pane={PANE} onBack={() => {}} onDetails={() => {}} />);
    const button = screen.getByRole("button", { name: "Trick details" });
    expect(button.className).toContain("size-11");
    expect(button.parentElement?.lastElementChild).toBe(button);
    unmount();
    render(<TrickSessionHeaderRow pane={PANE} onBack={() => {}} />);
    expect(screen.queryByRole("button", { name: "Trick details" })).toBeNull();
  });

  it("opens the trick's details page, and Back there comes up to the trick's page", async () => {
    await serveLegs();
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => home(),
          element: withHeaderHost(<Outlet />),
          children: [
            { index: true, element: <div>dashboard</div> },
            { path: "trick/:paneId", element: <TrickSessionRoute /> },
            { path: "settings/tricks/:key", element: <SettingsTrickRoute /> },
          ],
        },
      ],
      { initialEntries: ["/", "/trick/trick%3Alodge%3Alegs%3Alegs"], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "Trick details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks/lodge%3Alegs"));
    expect(await screen.findByText("Which release checks are green.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/trick/trick%3Alodge%3Alegs%3Alegs"));
    expect(await screen.findByText("23 of 34 green")).toBeInTheDocument();
  });
});
