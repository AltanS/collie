import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { tricksStore } from "@/lib/tricks/store";
import type { TricksReply } from "@/lib/tricks/schema";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";
import { SettingsTricksRoute } from "./settings-sections";

// The Tricks row on the Settings index, and the Tricks section behind it (M94 slice 04). The app's one
// store is a module singleton, so the order matters: the row shows with no reply, then the store
// takes a reply and the same render lists it.
//
// 2026-11-18: the switch for tricks as a whole is the Tricks card in Settings, Experiments, so this page
// holds the list only, the index row shows only while the switch is on, and a deep link to this page while
// it is off lands on Settings, Experiments.

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
  it("has the row on the index even while no tricks reply is held, while tricks are on", async () => {
    mount("/settings");
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.getByRole("button", { name: /^Tricks/ })).toBeInTheDocument();
  });

  it("has no card on the page itself while no tricks reply is held", async () => {
    mount("/settings/tricks");
    expect(await screen.findByRole("heading", { name: "Tricks" })).toBeInTheDocument();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
  });

  it("holds no switch for tricks as a whole: the page is the list", async () => {
    mount("/settings/tricks");
    expect(await screen.findByRole("heading", { name: "Tricks" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Tricks" })).toBeNull();
    expect(document.querySelector('[data-slot="tricks-switch"]')).toBeNull();
  });

  it("offers the row once the store holds a reply, and the page lists the tricks", async () => {
    const reply: TricksReply = {
      rev: 3,
      tricks: [{ host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "cli" } }],
      parts: [],
      present: [],
    };
    server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json(reply)));
    await tricksStore.syncTricks(3);
    const router = mount("/settings");
    const row = await screen.findByRole("button", { name: /^Tricks/ });
    expect(row).toHaveTextContent("Add tricks and switch each one on or off");
    row.click();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks"));
  });

  it("lists the tricks on the section page", async () => {
    mount("/settings/tricks");
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(screen.getByText("Added by CLI")).toBeInTheDocument();
  });

  it("starts with the list: no switch card above it", async () => {
    mount("/settings/tricks");
    const list = await screen.findByTestId("tricks-settings");
    expect(screen.queryAllByRole("switch", { name: "Tricks" })).toHaveLength(0);
    expect(document.querySelector('[data-slot="tricks-switch"]')).toBeNull();
    expect(list).toBeInTheDocument();
  });
});

/** Both routes under a root route whose loader answers `data`, as the app mounts them. */
function mountWithRoot(path: string, data: Partial<HomeData>) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          { path: "settings", element: withHeaderHost(<SettingsRoute />) },
          { path: "settings/tricks", element: withHeaderHost(<SettingsTricksRoute />) },
          { path: "settings/experiments", element: <div data-testid="experiments" /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("Settings → Tricks while tricks are switched off", () => {
  it("a deep link lands on Settings, Experiments, with no history entry for the redirect", async () => {
    const router = mountWithRoot("/settings/tricks", { tricksOff: true });
    expect(await screen.findByTestId("experiments")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/experiments");
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    await router.navigate(-1).catch(() => undefined);
    expect(router.state.location.pathname).not.toBe("/settings/tricks");
  });

  it("the index has no Tricks row", async () => {
    mountWithRoot("/settings", { tricksOff: true });
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryByRole("button", { name: /^Tricks/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Experiments/ })).toBeInTheDocument();
  });

  it("the index has the Tricks row, before Experiments, once tricks are on", async () => {
    mountWithRoot("/settings", { tricksOff: false });
    const row = await screen.findByRole("button", { name: /^Tricks/ });
    const all = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(all.findIndex((text) => text.startsWith("Tricks"))).toBe(all.findIndex((text) => text.startsWith("Experiments")) - 1);
    expect(row).toBeInTheDocument();
  });

  it("stays on the page while tricks are on", async () => {
    const router = mountWithRoot("/settings/tricks", { tricksOff: false });
    expect(await screen.findByRole("heading", { name: "Tricks" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/tricks");
  });
});
