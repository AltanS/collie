import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetHill } from "@/lib/hill/store";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { searchSettings, settingById, settingPath } from "@/lib/settings";
import type { TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import { tricksStore } from "@/lib/tricks/store";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsTricksRoute } from "./settings-sections";

// THE HILL IS THE FIRST ROW OF THE TRICK LIST (2026-11-22), and it does not depend on the Tricks switch: with tricks off, on a
// crew member whose tricks run on the lead, and on a Windows bridge it is drawn and its switch works. The page's other
// states are in settings-tricks.test.tsx. The app's tricks store is a module singleton, so each reply here is newer than the last.

function mount(data: Partial<HomeData> = {}) {
  const router = createMemoryRouter(
    [{ id: ROOT_ROUTE_ID, path: "/", loader: () => data, children: [{ path: "settings/tricks", element: withHeaderHost(<SettingsTricksRoute />) }] }],
    { initialEntries: ["/settings/tricks"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const LEGS: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "cli" } };

async function hold(reply: TricksReply): Promise<void> {
  server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json(reply)));
  await tricksStore.syncTricks(reply.rev);
}

/** The switch of the Hill's row is flipped and writes `POST /api/hill/switch`. */
async function flipsTheHill(): Promise<void> {
  let posted = "";
  server.use(
    http.post("/api/hill/switch", async ({ request }) => {
      posted = await request.text();
      return HttpResponse.json({ on: false });
    }),
  );
  await userEvent.click(await screen.findByRole("switch", { name: "Asks" }));
  await waitFor(() => expect(posted).toBe('{"on":false}'));
}

beforeEach(() => __resetHill());
afterEach(() => cleanup());

describe("the Hill's row without the Tricks switch", () => {
  it("is drawn and works with tricks off as a whole", async () => {
    mount({ tricksOff: true });
    expect(await screen.findByRole("switch", { name: "Tricks" })).not.toBeChecked();
    expect(screen.getByRole("link", { name: "About Asks" }).getAttribute("href")).toBe("/settings/tricks/hill");
    await flipsTheHill();
  });

  it("is drawn and works on a crew member whose tricks run on the lead", async () => {
    await hold({ rev: 11, tricks: [LEGS], parts: [], present: [], runsOn: { lead: "lodge" } });
    mount({ tricksOff: false });
    const list = await screen.findByTestId("tricks-settings");
    expect(list.querySelector('[data-line="runs-on"]')).not.toBeNull();
    expect(list.querySelector("[data-hill-row]")).not.toBeNull();
    await flipsTheHill();
  });

  it("is drawn alone, in a card of the list's look, on a Windows bridge", async () => {
    await hold({ rev: 12, tricks: [], parts: [], present: [], gate: "windows" });
    mount({ tricksOff: false });
    const card = await screen.findByTestId("hill-row-card");
    expect(card.querySelector("[data-hill-row]")).not.toBeNull();
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    await flipsTheHill();
  });
});

describe("the Settings search finds the Hill's row", () => {
  it.each(["asks", "decisions"])("for %s, on the Tricks page, with the row's own id", (query) => {
    const hit = searchSettings(query).find((each) => each.setting.id === "tricks.hill");
    expect(hit, query).toBeDefined();
    expect(settingPath(hit!.setting)).toBe("/settings/tricks#tricks.hill");
    expect(hit!.page).toBe("Tricks");
  });

  it("no longer finds the Tricks switch or the list for asks: the page's name does not say it", () => {
    const ids = searchSettings("asks").map((hit) => hit.setting.id);
    expect(ids).not.toContain("tricks.enabled");
    expect(ids).not.toContain("tricks.addRepo");
    expect(ids).toContain("tricks.hill");
  });

  it.each(["test Decision", "send a test"])("for %s, the Hill's page holds the button, found by its own id", (query) => {
    const hit = searchSettings(query).find((each) => each.setting.id === "tricks.hill.test");
    expect(hit, query).toBeDefined();
    expect(settingPath(hit!.setting)).toBe("/settings/tricks/hill#tricks.hill.test");
  });

  it("keeps the row's id, its label and its hint, and marks it an experiment", () => {
    const row = settingById("tricks.hill");
    expect(row).toMatchObject({ label: "settings.hill.label", hint: "settings.hill.hint", experiment: true, page: "tricks" });
  });
});
