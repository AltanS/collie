import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, matchRoutes, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { router as appRouter } from "@/router";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import type { TelemetryView } from "@/lib/types";
import { SettingsInstallCountRoute, SettingsSystemRoute } from "./settings-sections";

// Settings → System → Telemetry. System keeps one row with the state; the switch and
// its explanation are one level down, as Voice's host page is below Voice. The card's own states are
// pinned in components/telemetry-settings-card.test.tsx.

const VIEW: TelemetryView = {
  on: true,
  decidedBy: "default",
  setting: null,
  next: null,
};

function renderAt(initial: string, view: TelemetryView | "fail" = VIEW) {
  server.use(
    http.get("/api/telemetry", () =>
      view === "fail" ? HttpResponse.json({ error: "x" }, { status: 500 }) : HttpResponse.json(view),
    ),
  );
  const router = createMemoryRouter(
    [
      { path: "/settings/system", element: withHeaderHost(<SettingsSystemRoute />) },
      { path: "/settings/system/install-count", element: withHeaderHost(<SettingsInstallCountRoute />) },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("System — the telemetry row", () => {
  it("shows one row with the state in short, and not the switch", async () => {
    renderAt("/settings/system");
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    await waitFor(() => expect(row.textContent).toContain("On, once a day"));
    expect(row.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    expect(screen.queryByRole("switch", { name: "Telemetry" })).toBeNull();
    expect(screen.queryByRole("link", { name: "What is sent" })).toBeNull();
  });

  it("says Off when the count is off", async () => {
    renderAt("/settings/system", { ...VIEW, on: false, decidedBy: "settings", setting: "off" });
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    await waitFor(() => expect(row.textContent).toContain("Off"));
  });

  it("says Could not be read when the machine does not answer", async () => {
    renderAt("/settings/system", "fail");
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    await waitFor(() => expect(row.textContent).toContain("Could not be read"));
  });

  it("sits at the bottom, between Connection and the report card", async () => {
    renderAt("/settings/system");
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    const connection = screen.getByText("Connection");
    const report = screen.getByText("Offer a report when sending fails");
    const before = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(connection.compareDocumentPosition(row) & before).toBeTruthy();
    expect(row.compareDocumentPosition(report) & before).toBeTruthy();
  });

  it("opens the page below as a push", async () => {
    const router = renderAt("/settings/system");
    await userEvent.click(await screen.findByRole("button", { name: /Telemetry/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/system/install-count"));
    expect(router.state.location.state).toMatchObject({ from: "/settings/system" });
  });
});

describe("Settings → System → Telemetry", () => {
  it("is registered in the app's router, beside System", () => {
    const hit = matchRoutes(appRouter.routes, "/settings/system/install-count");
    expect(hit?.at(-1)?.route.path).toBe("settings/system/install-count");
  });

  it("holds the whole card: the switch, the machine-only line and the link", async () => {
    renderAt("/settings/system/install-count");
    expect(await screen.findByRole("heading", { name: "Telemetry" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Telemetry" })).toBeInTheDocument();
    expect(screen.getByText("This switch changes this machine only.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "What is sent" })).toBeInTheDocument();
  });

  it("goes back to System", async () => {
    const router = renderAt("/settings/system/install-count");
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/system"));
  });
});
