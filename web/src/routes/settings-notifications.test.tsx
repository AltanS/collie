import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsNotificationsRoute } from "./settings-sections";

// Settings → Notifications → Clear notifications, on the real route. This page mounts no floating status,
// so the acknowledgement a person sees is the card's own line: these cases read what is on the page,
// not the status store. The card's logic is pinned in components/clear-notifications-control.test.tsx.

function renderAlerts() {
  const router = createMemoryRouter([{ path: "/settings/notifications", element: withHeaderHost(<SettingsNotificationsRoute />) }], {
    initialEntries: ["/settings/notifications"],
  });
  const { container } = render(<RouterProvider router={router} />);
  return within(container);
}

describe("Settings → Notifications — Clear all", () => {
  it("sits beside the snooze and says on the page that the notifications were cleared", async () => {
    server.use(http.post("/api/notifications/clear", () => HttpResponse.json({ clearedSlots: [] })));
    const page = renderAlerts();
    const button = await page.findByRole("button", { name: "Clear all" });
    expect(page.getByText("Do not disturb")).toBeInTheDocument();

    await userEvent.click(button);

    await waitFor(() => expect(page.getAllByText("Notifications cleared.").length).toBeGreaterThan(0));
  });

  it("says on the page why a refused clear did nothing", async () => {
    server.use(http.post("/api/notifications/clear", () => new HttpResponse("device not paired", { status: 403 })));
    const page = renderAlerts();
    const button = await page.findByRole("button", { name: "Clear all" });

    await userEvent.click(button);

    const cardElement = button.closest("[data-slot=card]");
    if (!(cardElement instanceof HTMLElement)) throw new Error("the Clear all button sits in no card");
    const card = within(cardElement);
    await waitFor(() => expect(card.getByRole("status").textContent).not.toBe(""));
    expect(card.queryByText("Notifications cleared.")).toBeNull();
  });
});

describe("Settings → Notifications — the groups", () => {
  it("stands the switches under their headings: This device, Notify me when, Cache, Machine load, Quiet", async () => {
    const page = renderAlerts();
    for (const name of ["This device", "Notify me when", "Cache", "Machine load", "Quiet"]) {
      expect(await page.findByRole("region", { name })).toBeInTheDocument();
    }
    const when = page.getByRole("region", { name: "Notify me when" });
    expect(within(when).getByText("For every device")).toBeInTheDocument();
    expect(within(when).getByRole("switch", { name: "A new Collie version" })).toBeInTheDocument();
    expect(within(when).getByRole("switch", { name: "A Decision marked Now on the Hill" })).toBeInTheDocument();
    expect(within(when).queryByRole("switch", { name: "Cache about to go cold" })).toBeNull();
    const cache = page.getByRole("region", { name: "Cache" });
    expect(within(cache).getByText("Watched panes")).toBeInTheDocument();
    const load = page.getByRole("region", { name: "Machine load" });
    expect(within(load).getByRole("switch", { name: "Machine load stays high" })).toBeInTheDocument();
  });
});
