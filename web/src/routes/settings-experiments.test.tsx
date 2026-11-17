import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsExperimentsRoute } from "./settings-sections";

// The fifth section. Chat left it (ADR 0082); the Hill moved in on 2026-11-13, so the page is its contract and
// the Hill's one switch plus the one switch for Tricks as a whole (2026-11-18: it moved here from Settings, Tricks, whose index row now shows only while it is on), and the settings index shows the row (routes/settings.test.tsx). The contract is
// stated ONCE at the top of the page rather than repeated per card.

function renderExperiments(data: Partial<HomeData> = {}) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          { path: "settings/experiments", element: withHeaderHost(<SettingsExperimentsRoute />) },
          { path: "settings", element: <div data-testid="settings" /> },
        ],
      },
    ],
    { initialEntries: ["/settings/experiments"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsExperimentsRoute", () => {
  it("states the section's contract once, above the cards", async () => {
    renderExperiments();
    expect(
      await screen.findByText(
        "Anything here may change, lose settings, or be withdrawn in a patch release.",
      ),
    ).toBeInTheDocument();
  });

  it("holds no Chat switch any more: Chat is the default view", async () => {
    renderExperiments();
    await screen.findByText(/Anything here may change/);
    expect(screen.queryByRole("switch", { name: "Chat" })).toBeNull();
  });

  it("holds the Hill's one switch, after the contract, off until the bridge says on", async () => {
    renderExperiments();
    const contract = await screen.findByText(/Anything here may change/);
    const sw = await screen.findByRole("switch", { name: "The Hill" });
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(contract.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Agents and tricks ask you here. Off: they cannot post, and the Hill leaves the bar.")).toBeInTheDocument();
  });

  it("holds the Tricks card under the Hill's, with its switch and its own words, and no row that opens a page", async () => {
    renderExperiments({ tricksOff: true });
    const hill = await screen.findByRole("switch", { name: "The Hill" });
    const tricks = await screen.findByRole("switch", { name: "Tricks" });
    expect(tricks).not.toBeChecked();
    expect(hill.compareDocumentPosition(tricks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-slot="tricks-switch"]')).not.toBeNull();
    expect(screen.getByText("Tricks are small programs that add buttons, lines and pages to Collie. A trick's program runs as you on this machine.")).toBeInTheDocument();
    expect(screen.getByText("Tricks are an experiment: they may change, lose settings, or be withdrawn in a patch release.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tricks/ })).toBeNull();
    expect(document.querySelector('[data-slot="tricks-experiment-row"]')).toBeNull();
  });

  it("the Tricks card writes the switch through POST /api/tricks/switch", async () => {
    let posted = "";
    server.use(
      http.post("/api/tricks/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: true });
      }),
    );
    renderExperiments({ tricksOff: true });
    await userEvent.click(await screen.findByRole("switch", { name: "Tricks" }));
    await waitFor(() => expect(posted).toBe('{"on":true}'));
  });
});
