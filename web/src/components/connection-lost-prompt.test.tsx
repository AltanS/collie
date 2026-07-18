import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { ConnectionLostPrompt } from "./connection-lost-prompt";

// Drive the escalation timer directly so the copy / gating / retry behaviour can be tested without
// waiting out 15s of fake time (the threshold itself is covered in use-connection-lost.test.ts).
const h = vi.hoisted(() => ({ lost: true }));
vi.mock("@/hooks/use-connection-lost", () => ({ useConnectionLost: () => h.lost }));
// The stall probe is noise here (and would want a real router loader); pin it idle.
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

afterEach(() => {
  setOnline(true);
  h.lost = true;
});

function renderPrompt(props: { bridge?: "connected" | "disconnected"; error?: boolean } = {}) {
  let loaderCalls = 0;
  const router = createMemoryRouter([
    {
      id: "root",
      path: "/",
      loader: () => {
        loaderCalls += 1;
        return null;
      },
      element: (
        <>
          <div data-testid="mounted" />
          <ConnectionLostPrompt bridge={props.bridge ?? "disconnected"} error={props.error ?? false} />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return { loaderCalls: () => loaderCalls };
}

describe("ConnectionLostPrompt", () => {
  it("renders nothing while the connection is healthy", async () => {
    h.lost = false;
    renderPrompt({ bridge: "connected" });
    await screen.findByTestId("mounted");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays hidden when offline (that's OfflineBanner's job — the two never show together)", async () => {
    setOnline(false);
    h.lost = true; // even a sustained outage
    renderPrompt();
    await screen.findByTestId("mounted");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the Herdr-down copy when the bridge itself answers the config probe", async () => {
    // Default /api/config handler succeeds → the bridge is up, so the herd link is what's down.
    renderPrompt({ bridge: "disconnected" });
    expect(await screen.findByText("Herdr appears to be down on the host.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("shows the bridge-unreachable copy when the config probe fails", async () => {
    server.use(http.get("/api/config", () => HttpResponse.error()));
    renderPrompt({ error: true });
    expect(await screen.findByText("Can't reach the Collie bridge.")).toBeInTheDocument();
  });

  it("Retry revalidates the snapshot and re-probes the bridge", async () => {
    const user = userEvent.setup();
    let configHits = 0;
    server.use(
      http.get("/api/config", () => {
        configHits += 1;
        return HttpResponse.json({ push: false, vapidPublicKey: "" });
      }),
    );
    const { loaderCalls } = renderPrompt({ bridge: "disconnected" });
    // First appearance probes once and the loader ran once on mount.
    await waitFor(() => expect(configHits).toBe(1));
    const beforeLoads = loaderCalls();

    await user.click(screen.getByRole("button", { name: /retry/i }));

    // Retry kicks a fresh revalidation (loader re-runs) and a fresh probe.
    await waitFor(() => expect(loaderCalls()).toBeGreaterThan(beforeLoads));
    await waitFor(() => expect(configHits).toBe(2));
  });
});
