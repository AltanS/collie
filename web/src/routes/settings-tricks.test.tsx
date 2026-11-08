import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { tricksStore } from "@/lib/tricks/store";
import type { TricksReply } from "@/lib/tricks/schema";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";
import { SettingsTricksRoute } from "./settings-sections";

// The Tricks row on the Settings index, and the Tricks section behind it (M94 slice 04). The app's one
// store is a module singleton, so the order matters: the row is checked absent first, then the store
// takes a reply and the same render shows it.

function mount(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: withHeaderHost(<SettingsRoute />) },
      { path: "/settings/tricks", element: withHeaderHost(<SettingsTricksRoute />) },
      { path: "/settings/:section", element: <div data-testid="section" /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("Settings → Tricks", () => {
  it("has no row on the index while no tricks reply is held", async () => {
    mount("/settings");
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryByRole("button", { name: /^Tricks/ })).toBeNull();
  });

  it("has no card on the page itself while no tricks reply is held", async () => {
    mount("/settings/tricks");
    expect(await screen.findByRole("heading", { name: "Tricks" })).toBeInTheDocument();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
  });

  it("offers the row once the store holds a reply, and the page lists the tricks", async () => {
    const reply: TricksReply = {
      rev: 3,
      tricks: [{ host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "cli" } }],
      parts: [],
      present: [],
    };
    server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json(reply)));
    await tricksStore.syncTricks(3);
    const router = mount("/settings");
    const row = await screen.findByRole("button", { name: /^Tricks/ });
    expect(row).toHaveTextContent("Switch tricks on and off");
    row.click();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks"));
  });

  it("lists the tricks on the section page", async () => {
    mount("/settings/tricks");
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(screen.getByText("Added by CLI")).toBeInTheDocument();
  });
});
