import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Settings → Tricks and the Hill (ADR 0170): both experiments on one page, always on the index. The switch for tricks
// as a whole stands first and the list of your tricks under it while that switch is on; the Hill's switch ends the
// page. Each experiment wears the Experimental badge on its own card; there is no notice for the page.
//
// The app's one tricks store is a module singleton, so the order matters: the page draws no list with no reply,
// then the store takes a reply and the same page lists it.

function mount(path: string, data: Partial<HomeData> = {}) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          { path: "settings", element: withHeaderHost(<SettingsRoute />) },
          { path: "settings/tricks", element: withHeaderHost(<SettingsTricksRoute />) },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const precedes = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("Settings → Tricks and the Hill", () => {
  it("has its row on the index with tricks off and on, with its line", async () => {
    mount("/settings", { tricksOff: true });
    const row = await screen.findByRole("button", { name: /^Tricks and the Hill/ });
    expect(row).toHaveTextContent("The Tricks switch, your tricks, the Hill");
  });

  it("stays on the page while tricks are off, with both switches and no list", async () => {
    const router = mount("/settings/tricks", { tricksOff: true });
    expect(await screen.findByRole("heading", { name: "Tricks and the Hill" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/tricks");
    expect(await screen.findByRole("switch", { name: "Tricks" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeInTheDocument();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
  });

  it("puts the Tricks switch first and the Hill's last, each with the Experimental badge", async () => {
    mount("/settings/tricks", { tricksOff: true });
    const tricks = await screen.findByRole("switch", { name: "Tricks" });
    const hill = await screen.findByRole("switch", { name: "The Hill" });
    expect(precedes(tricks, hill)).toBe(true);
    expect(document.querySelectorAll('[data-slot="experimental-badge"]')).toHaveLength(2);
    expect(screen.queryByText(/Anything here may change/)).toBeNull();
  });

  it("says what the Hill is, then its switch's words, then the experiment line", async () => {
    mount("/settings/tricks", { tricksOff: true });
    expect(
      await screen.findByText(
        "The page where agents and tricks ask you to decide. Agents and tricks ask you here. Off: they cannot post, and the Hill leaves the bar.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("An experiment: it may change, lose settings, or be withdrawn in a patch release.")).toBeInTheDocument();
    expect(screen.getByText("Tricks are an experiment: they may change, lose settings, or be withdrawn in a patch release.")).toBeInTheDocument();
  });

  it("writes the Tricks switch through POST /api/tricks/switch", async () => {
    let posted = "";
    server.use(
      http.post("/api/tricks/switch", async ({ request }) => {
        posted = await request.text();
        return HttpResponse.json({ on: true });
      }),
    );
    mount("/settings/tricks", { tricksOff: true });
    await userEvent.click(await screen.findByRole("switch", { name: "Tricks" }));
    await waitFor(() => expect(posted).toBe('{"on":true}'));
  });

  it("draws no list while tricks are on and no tricks reply is held", async () => {
    mount("/settings/tricks", { tricksOff: false });
    expect(await screen.findByRole("switch", { name: "Tricks" })).toBeInTheDocument();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
  });

  it("lists the tricks under the Tricks switch once the store holds a reply", async () => {
    const reply: TricksReply = {
      rev: 3,
      tricks: [{ host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "cli" } }],
      parts: [],
      present: [],
    };
    server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json(reply)));
    await tricksStore.syncTricks(3);
    mount("/settings/tricks", { tricksOff: false });
    const list = await screen.findByTestId("tricks-settings");
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(screen.getByText("Added by CLI")).toBeInTheDocument();
    expect(precedes(screen.getByRole("switch", { name: "Tricks" }), list)).toBe(true);
    expect(precedes(list, screen.getByRole("switch", { name: "The Hill" }))).toBe(true);
  });
});
