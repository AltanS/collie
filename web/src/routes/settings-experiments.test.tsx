import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { withHeaderHost } from "@/test/header-host";
import { SettingsExperimentsRoute } from "./settings-sections";

// The fifth section. Chat left it (ADR 0082); the Hill moved in on 2026-11-13, so the page is its contract and
// the Hill's one switch plus a row for Tricks (2026-11-17, whose switch lives on Settings, Tricks), and the settings index shows the row (routes/settings.test.tsx). The contract is
// stated ONCE at the top of the page rather than repeated per card.

function renderExperiments() {
  const router = createMemoryRouter(
    [
      { path: "/settings/experiments", element: withHeaderHost(<SettingsExperimentsRoute />) },
      { path: "/settings", element: <div data-testid="settings" /> },
      { path: "/settings/tricks", element: <div data-testid="settings-tricks" /> },
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
    expect(screen.getAllByRole("switch")).toEqual([sw]);
    expect(contract.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Agents and tricks ask you here. Off: they cannot post, and the Hill leaves the bar.")).toBeInTheDocument();
  });

  it("holds a Tricks row under the Hill, with no second switch, and it opens Settings, Tricks", async () => {
    const router = renderExperiments();
    const hill = await screen.findByRole("switch", { name: "The Hill" });
    const row = await screen.findByRole("button", { name: /Tricks/ });
    expect(row).toHaveTextContent("Switched on and off at the top of Settings, Tricks.");
    expect(hill.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Tricks" })).toBeNull();
    await userEvent.click(row);
    expect(await screen.findByTestId("settings-tricks")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/tricks");
  });
});
