import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { OutageBanner } from "./outage-banner";

// Drive the escalation directly (the 15s wall-clock is covered in use-connection-lost.test.ts) so the
// copy / gating / retry behaviour can be tested without burning 15s of fake time. The stall probe is
// noise here (it'd want a real router loader), so pin it idle. Crucially, the banner passes the
// poll-truth `connecting` to useConnectionLost with NO `online &&` gate — the mock ignores the arg and
// returns the staged value.
const h = vi.hoisted(() => ({ lost: true }));
vi.mock("@/hooks/use-connection-lost", () => ({ useConnectionLost: () => h.lost }));
vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

afterEach(() => {
  setOnline(true);
  h.lost = true;
});

function renderBanner(props: { bridge?: "connected" | "disconnected"; error?: boolean } = {}) {
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
          <OutageBanner bridge={props.bridge ?? "disconnected"} error={props.error ?? false} />
        </>
      ),
    },
  ]);
  const view = render(<RouterProvider router={router} />);
  return { loaderCalls: () => loaderCalls, rerender: () => view.rerender(<RouterProvider router={router} />) };
}

describe("OutageBanner", () => {
  it("renders nothing below the escalation threshold — the header pill is the only signal", async () => {
    h.lost = false;
    renderBanner({ bridge: "connected" });
    await screen.findByTestId("mounted");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows once escalated even while the browser claims to be offline (no online gate)", async () => {
    // The lying-onLine case: onLine stuck false must NOT suppress the banner — `show` is poll-truth.
    setOnline(false);
    server.use(http.get("/api/config", () => HttpResponse.error()));
    renderBanner({ error: true });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("is one crisp, non-wrapping row (role=alert, text-xs, a single truncating copy span)", async () => {
    renderBanner({ bridge: "disconnected" });
    const alert = await screen.findByRole("alert");
    expect(alert.className).toMatch(/text-xs/);
    expect(alert.className).not.toMatch(/flex-wrap/);
    // The copy lives in a lone truncating, flex-1 span so the row can never wrap to a second line.
    expect(alert.querySelector("span.truncate.flex-1")).not.toBeNull();
  });

  it("names Herdr as the outage when the bridge answers the config probe", async () => {
    // Default /api/config handler succeeds → the bridge is up, so the herd link is what's down.
    renderBanner({ bridge: "disconnected" });
    expect(await screen.findByText("Herdr is down on the host")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("says 'Offline' when the probe fails AND the browser reports offline", async () => {
    setOnline(false);
    server.use(http.get("/api/config", () => HttpResponse.error()));
    renderBanner({ error: true });
    expect(await screen.findByText("Offline — can't reach Collie")).toBeInTheDocument();
  });

  it("says 'Can't reach Collie' when the probe fails but the browser still reports online", async () => {
    setOnline(true);
    server.use(http.get("/api/config", () => HttpResponse.error()));
    renderBanner({ error: true });
    expect(await screen.findByText("Can't reach Collie")).toBeInTheDocument();
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
    const { loaderCalls } = renderBanner({ bridge: "disconnected" });
    // First appearance probes once and the loader ran once on mount.
    await waitFor(() => expect(configHits).toBe(1));
    const beforeLoads = loaderCalls();

    await user.click(screen.getByRole("button", { name: /retry/i }));

    // Retry kicks a fresh revalidation (loader re-runs) and a fresh probe.
    await waitFor(() => expect(loaderCalls()).toBeGreaterThan(beforeLoads));
    await waitFor(() => expect(configHits).toBe(2));
  });

  it("dismisses itself on recovery — a healthy poll unmounts it, no reload", async () => {
    const { rerender } = renderBanner({ bridge: "disconnected" });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Recovery: a successful poll flips `connecting` false → `lost` false. The banner unmounts on its
    // own — no reload, no leftover row.
    h.lost = false;
    rerender();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
