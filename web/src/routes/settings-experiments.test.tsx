import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { withHeaderHost } from "@/test/header-host";
import { SettingsExperimentsRoute } from "./settings-sections";

// The fifth section. Nothing is filed under it since Chat graduated (ADR 0082), so the page is its
// contract and nothing else, and the settings index hides the row (routes/settings.test.tsx). The
// contract is stated ONCE at the top of the page rather than repeated per card.

function renderExperiments() {
  const router = createMemoryRouter(
    [
      { path: "/settings/experiments", element: withHeaderHost(<SettingsExperimentsRoute />) },
      { path: "/settings", element: <div data-testid="settings" /> },
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
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});
