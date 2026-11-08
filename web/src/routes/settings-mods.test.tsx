import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { modsStore } from "@/lib/mods/store";
import type { ModsReply } from "@/lib/mods/schema";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";
import { SettingsModsRoute } from "./settings-sections";

// The Mods row on the Settings index, and the Mods section behind it (M94 slice 04). The app's one
// store is a module singleton, so the order matters: the row is checked absent first, then the store
// takes a reply and the same render shows it.

function mount(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: withHeaderHost(<SettingsRoute />) },
      { path: "/settings/mods", element: withHeaderHost(<SettingsModsRoute />) },
      { path: "/settings/:section", element: <div data-testid="section" /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("Settings → Mods", () => {
  it("has no row on the index while no mods reply is held", async () => {
    mount("/settings");
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryByRole("button", { name: /^Mods/ })).toBeNull();
  });

  it("has no card on the page itself while no mods reply is held", async () => {
    mount("/settings/mods");
    expect(await screen.findByRole("heading", { name: "Mods" })).toBeInTheDocument();
    expect(screen.queryByTestId("mods-settings")).toBeNull();
  });

  it("offers the row once the store holds a reply, and the page lists the mods", async () => {
    const reply: ModsReply = {
      rev: 3,
      mods: [{ host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "cli" } }],
      parts: [],
      present: [],
    };
    server.use(http.get(/\/api\/mods$/, () => HttpResponse.json(reply)));
    await modsStore.syncMods(3);
    const router = mount("/settings");
    const row = await screen.findByRole("button", { name: /^Mods/ });
    expect(row).toHaveTextContent("Switch mods on and off");
    row.click();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/mods"));
  });

  it("lists the mods on the section page", async () => {
    mount("/settings/mods");
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(screen.getByText("Added by CLI")).toBeInTheDocument();
  });
});
