import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, matchRoutes, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { router as appRouter } from "@/router";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import type { TelemetryView } from "@/lib/types";
import { SettingsInstallCountRoute, SettingsPrivacyRoute } from "./settings-sections";

// Settings → Privacy and data → Telemetry. The page keeps one row with the state, under "What leaves this machine";
// the switch and its explanation are one level down, as Voice's host page is below Voice. The card's own states are
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
      { path: "/settings/privacy", element: withHeaderHost(<SettingsPrivacyRoute />) },
      { path: "/settings/privacy/install-count", element: withHeaderHost(<SettingsInstallCountRoute />) },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("Privacy and data — the telemetry row", () => {
  it("shows one row with the state in short, and not the switch", async () => {
    renderAt("/settings/privacy");
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    await waitFor(() => expect(row.textContent).toContain("On, once a day"));
    expect(row.querySelector("svg[data-icon=\"row-go\"]")).not.toBeNull();
    expect(screen.queryByRole("switch", { name: "Telemetry" })).toBeNull();
    expect(screen.queryByRole("link", { name: "What is sent" })).toBeNull();
  });

  it("says Off when the count is off", async () => {
    renderAt("/settings/privacy", { ...VIEW, on: false, decidedBy: "settings", setting: "off" });
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    await waitFor(() => expect(row.textContent).toContain("Off"));
  });

  it("says Could not be read when the machine does not answer", async () => {
    renderAt("/settings/privacy", "fail");
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    await waitFor(() => expect(row.textContent).toContain("Could not be read"));
  });

  it("stands under What leaves this machine, after the chat copies this phone keeps", async () => {
    renderAt("/settings/privacy");
    const row = await screen.findByRole("button", { name: /Telemetry/ });
    const phone = screen.getByRole("region", { name: "On this phone" });
    const leaves = screen.getByRole("region", { name: "What leaves this machine" });
    expect(leaves.contains(row)).toBe(true);
    expect(phone.compareDocumentPosition(leaves) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the page below as a push", async () => {
    const router = renderAt("/settings/privacy");
    await userEvent.click(await screen.findByRole("button", { name: /Telemetry/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/privacy/install-count"));
    expect(router.state.location.state).toMatchObject({ from: "/settings/privacy" });
  });
});

describe("Settings → Privacy and data → Telemetry", () => {
  it("is registered in the app's router, below Privacy and data", () => {
    const hit = matchRoutes(appRouter.routes, "/settings/privacy/install-count");
    // Under the `settings` layout route (components/settings-shell.tsx), so the pattern is the matched routes' paths joined.
    const pattern = (hit ?? []).map((m) => m.route.path ?? "").filter((part) => part !== "" && part !== "/").join("/");
    expect(pattern).toBe("settings/privacy/install-count");
  });

  it("holds the whole card: the switch, the machine-only line and the link", async () => {
    renderAt("/settings/privacy/install-count");
    expect(await screen.findByRole("heading", { name: "Telemetry" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Telemetry" })).toBeInTheDocument();
    expect(screen.getByText("This switch changes this machine only.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "What is sent" })).toBeInTheDocument();
  });

  it("goes back to Privacy and data", async () => {
    const router = renderAt("/settings/privacy/install-count");
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/privacy"));
  });
});
