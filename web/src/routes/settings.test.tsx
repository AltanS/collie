import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { type DevicesData } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";

// Settings' HEADER, and only its header.
//
// This route used to hand-roll its own `<header>` beneath a comment claiming "one header treatment
// app-wide". It was not one: the hand-rolled bar carried no <AlphaBar/> and had its own padding
// recipe, so it stood 20px short of every other route's header and silently dropped the "you are on
// a prerelease build" strip on the way in. It fills the one hoisted header shell now, and these cases pin
// that — a false comment in the code is worse than no comment, so the claim is asserted rather than
// written down.

const NO_DEVICES: DevicesData = { enforced: false, current: null, devices: [], error: false };

function renderSettings() {
  const router = createMemoryRouter(
    [
      { path: "/settings", loader: () => NO_DEVICES, element: withHeaderHost(<SettingsRoute />) },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsRoute — the shared header shell", () => {
  it("mounts exactly one header, and it is the shell that carries the prerelease strip", async () => {
    // vitest's define stamps BUILD.version as "0.0.0-test", which IS a prerelease — so the real
    // shell shows the strip here. A hand-rolled header cannot.
    renderSettings();
    expect(await screen.findByText(/TEST/)).toBeInTheDocument();
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("leads with a 44px back button where every other route puts the Collie mark", async () => {
    renderSettings();
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.className).toContain("size-11");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // The mark is NOT here — this route leads with the way out, not with the way home.
    expect(screen.queryByRole("button", { name: /^Collie/ })).toBeNull();
  });
});
