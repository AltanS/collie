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

// Settings → Tricks (ADR 0170): both experiments on one page, always on the index. The switch for tricks
// as a whole stands first and the list of your tricks under it while that switch is on; the Hill is the first row of that
// list (and stands alone under the switch while tricks are off). Each experiment wears the Experimental badge; there is no notice for the page.
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

describe("Settings → Tricks", () => {
  it("has its row on the index with tricks off and on, with its line", async () => {
    mount("/settings", { tricksOff: true });
    const row = await screen.findByRole("button", { name: /^Tricks/ });
    expect(row).toHaveTextContent("The Tricks switch and your tricks");
  });

  it("stays on the page while tricks are off, with the Tricks switch, the Hill's row and no list", async () => {
    const router = mount("/settings/tricks", { tricksOff: true });
    expect(await screen.findByRole("heading", { name: "Tricks" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/tricks");
    expect(await screen.findByRole("switch", { name: "Tricks" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Asks" })).toBeInTheDocument();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    // The Hill's own card at the foot of the page is gone: the row stands in a list card of its own.
    expect(screen.getByTestId("hill-row-card").querySelector("[data-hill-row]")).not.toBeNull();
    expect(document.querySelector('[data-slot="hill-switch"] > [data-slot="card"]')).toBeNull();
  });

  it("puts the Tricks switch first and the Hill's row under it, each with the Experimental badge", async () => {
    mount("/settings/tricks", { tricksOff: true });
    const tricks = await screen.findByRole("switch", { name: "Tricks" });
    const hill = await screen.findByRole("switch", { name: "Asks" });
    expect(precedes(tricks, hill)).toBe(true);
    expect(document.querySelectorAll('[data-slot="experimental-badge"]')).toHaveLength(2);
    expect(screen.queryByText(/Anything here may change/)).toBeNull();
  });

  it("says what the Hill is in one line on its row, and leaves the long words to its page", async () => {
    mount("/settings/tricks", { tricksOff: true });
    expect(await screen.findByText("Agents and tricks ask you a question here. You answer with one tap.")).toBeInTheDocument();
    expect(screen.queryByText(/Off: they cannot post/)).toBeNull();
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

  it("draws no list while tricks are on and no tricks reply is held, and the Hill's row stands alone", async () => {
    mount("/settings/tricks", { tricksOff: false });
    expect(await screen.findByRole("switch", { name: "Tricks" })).toBeInTheDocument();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    expect(screen.getByTestId("hill-row-card").querySelector("[data-hill-row]")).not.toBeNull();
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
    // The Hill is the first row of the list: above the trick, inside the same card, and there is no card of its own below.
    const hill = screen.getByRole("switch", { name: "Asks" });
    expect(list.contains(hill)).toBe(true);
    expect(precedes(hill, screen.getByRole("switch", { name: "Browser leg" }))).toBe(true);
    expect(screen.queryByTestId("hill-row-card")).toBeNull();
  });
});
