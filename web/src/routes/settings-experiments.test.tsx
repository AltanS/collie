import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { withHeaderHost } from "@/test/header-host";
import { coerceDashPrefs } from "@/hooks/use-dash-prefs";
import { SettingsExperimentsRoute } from "./settings-sections";

// The fifth section. Two things are load bearing and both are decisions rather than looks: the
// contract is stated ONCE at the top of the page rather than repeated per card, and the switch on it
// is the opt-in — off by default, so a device that never opens this page draws terminals.

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

/** What this device has stored, read the way the app reads it. */
function stored() {
  const raw = localStorage.getItem("collie:dash-prefs:v1");
  return coerceDashPrefs(raw === null ? undefined : JSON.parse(raw));
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

  it("holds Chat, off, and names what is not finished about it", async () => {
    renderExperiments();
    const toggle = await screen.findByRole("switch", { name: "Chat" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Codex panes do not draw their steps yet/)).toBeInTheDocument();
  });

  it("writes the opt-in for the whole device", async () => {
    const user = userEvent.setup();
    renderExperiments();
    await user.click(await screen.findByRole("switch", { name: "Chat" }));
    expect(stored().chatExperiment).toBe(true);
    // The MODE is not this row's to write: the pane's ⋮ menu is the one place that value is set,
    // and its stored default is what opting in hands you (lib/pane-view.ts).
    expect(stored().paneView).toBe("chat");
  });
});
