import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReloadGuard } from "@/lib/reload-guard";
import { __resetUpdateRunStore } from "@/lib/update-run-store";
import { __resetUpdateAsk } from "@/lib/update-ask";
import { clearUpdateStarted } from "@/lib/update-ribbon";
import { useUpdateScreen } from "@/hooks/use-update-screen";
import { asJsonString, parseJsonObject } from "@/lib/json";
import type { JsonObject } from "@/lib/json";
import type { UpdateInfo } from "@/lib/types";
import { ReleaseLineCard } from "./release-line-card";
import { UpdateScreen } from "./update-screen";

// The Release line card (M60 spec 01, ADR 0110): Stable | Edge with a receipt, and the three cases
// of a machine on Stable that runs an Edge build. Driven through a memory router (the root loader's
// snapshot) and MSW, like the update card's own tests.

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.22.6",
  latest: "1.22.6",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: 1_700_000_000_000,
  ...over,
});

function homeData(update: UpdateInfo): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

function ModeHost() {
  const mode = useUpdateScreen();
  return <UpdateScreen screen={mode} onOpenUpdates={() => {}} onStarted={() => {}} />;
}

function renderCard(update: UpdateInfo) {
  server.use(http.get("/api/update/check", () => HttpResponse.json({ ...update, preflight: null })));
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => homeData(update), element: <ReleaseLineCard /> }], {
    initialEntries: ["/"],
  });
  return render(
    <>
      <RouterProvider router={router} />
      <ModeHost />
    </>,
  );
}

beforeEach(() => {
  __resetReloadGuard();
  __resetUpdateAsk();
  clearUpdateStarted();
  __resetUpdateRunStore();
});

describe("Release line: Stable | Edge (M60 spec 01)", () => {
  it("shows the line the bridge reports, Stable when an older bridge sends none", async () => {
    renderCard(info());
    const group = await screen.findByRole("radiogroup", { name: "Release line" });
    expect(within(group).getByRole("radio", { name: "Stable" })).toBeChecked();
    expect(screen.getByText("This machine is on Stable.")).toBeInTheDocument();
  });

  it("a tap saves the line with a request id, installs nothing, and shows the receipt", async () => {
    const user = userEvent.setup();
    const bodies: JsonObject[] = [];
    server.use(
      http.post("/api/update/line", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        bodies.push(body);
        return HttpResponse.json({ ok: true, line: "edge", rejected: [], changedAt: 1, requestId: asJsonString(body.requestId) ?? "" });
      }),
      http.post("/api/update", () => HttpResponse.json({ error: "must not be called" }, { status: 500 })),
    );
    renderCard(info());
    await user.click(await screen.findByRole("radio", { name: "Edge" }));
    expect(await screen.findByText("Saved. This machine is on Edge. New Edge builds show up above as updates.")).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.line).toBe("edge");
    expect(asJsonString(bodies[0]?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole("radio", { name: "Edge" })).toBeChecked();
  });

  it("on Edge, a Stable tap is a person-started switch back: it saves stable and shows its receipt", async () => {
    // Case 15 of the crew leg: the card must open on the line the bridge reports. A card that drew
    // Stable here (a status with no line) made the Stable tap a no-op, and the record stayed edge.
    const user = userEvent.setup();
    const bodies: JsonObject[] = [];
    server.use(
      http.post("/api/update/line", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        bodies.push(body);
        return HttpResponse.json({ ok: true, line: "stable", rejected: [], changedAt: 2, requestId: asJsonString(body.requestId) ?? "" });
      }),
    );
    renderCard(info({ line: "edge" }));
    const group = await screen.findByRole("radiogroup", { name: "Release line" });
    expect(within(group).getByRole("radio", { name: "Edge" })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "Stable" }));
    expect(await screen.findByText("Saved. This machine is on Stable and takes final releases only.")).toBeInTheDocument();
    expect(bodies.map((b) => b.line)).toEqual(["stable"]);
    expect(screen.getByRole("radio", { name: "Stable" })).toBeChecked();
  });

  it("a refusal keeps the old line and says why, beside the control", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/update/line", () =>
        HttpResponse.json({ error: "the release line must be stable or edge; nothing was changed", code: "update.line_invalid" }, { status: 400 }),
      ),
    );
    renderCard(info());
    await user.click(await screen.findByRole("radio", { name: "Edge" }));
    expect(await screen.findByText(/The release line was not changed\./)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Stable" })).toBeChecked();
  });

  it("case 2: an Edge build ahead of Stable offers Go back now and Wait for Stable", async () => {
    const user = userEvent.setup();
    renderCard(info({ current: "1.23.0-edge.2", line: "stable", back: { to: "1.22.6", exceptions: [] } }));
    expect(await screen.findByText("This machine runs Edge build 1.23.0-edge.2. The newest Stable release, 1.22.6, is older.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go back now" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Wait for Stable" }));
    expect(
      screen.getByText("Waiting for Stable. No more Edge builds are offered, and the next Stable release is offered the day it is out."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go back now" })).toBeNull();
  });

  it("Go back now opens Ready to start; its start posts /api/update/back with a request id", async () => {
    const user = userEvent.setup();
    const bodies: JsonObject[] = [];
    server.use(
      http.post("/api/update/back", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        bodies.push(body);
        return HttpResponse.json(
          { ok: true, from: "1.23.0-edge.2", to: "1.22.6", run: null, runId: asJsonString(body.requestId) ?? "" },
          { status: 202 },
        );
      }),
    );
    renderCard(info({ current: "1.23.0-edge.2", line: "stable", back: { to: "1.22.6", exceptions: [] } }));
    await user.click(await screen.findByRole("button", { name: "Go back now" }));
    const panel = screen.getByRole("dialog", { name: "Go back to Stable 1.22.6" });
    expect(bodies).toHaveLength(0);
    await user.click(within(panel).getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ confirm: true, target: "1.22.6" });
    expect(asJsonString(bodies[0]?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("names every state file the Stable release cannot read, before the button", async () => {
    renderCard(info({ current: "1.23.0-edge.2", line: "stable", back: { to: "1.22.6", exceptions: ["update-run.json"] } }));
    expect(await screen.findByText("1.22.6 cannot read these files from this build: update-run.json.")).toBeInTheDocument();
  });

  it("case 1: a Stable release at or above the build is the normal offer, one sentence here", async () => {
    renderCard(info({ current: "1.23.0-edge.2", latest: "1.23.0", releaseAvailable: true, line: "stable" }));
    expect(await screen.findByText("Stable 1.23.0 is out. Update to it with the button above.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go back now" })).toBeNull();
  });

  it("case 3 and Edge: a Stable build, or a machine on Edge, gets no way-back text", async () => {
    const view = renderCard(info({ line: "stable" }));
    await screen.findByText("This machine is on Stable.");
    expect(screen.queryByRole("button", { name: "Go back now" })).toBeNull();
    view.unmount();
    renderCard(info({ current: "1.23.0-edge.2", line: "edge" }));
    expect(await screen.findByText("This machine is on Edge.")).toBeInTheDocument();
    expect(screen.queryByText(/Edge build 1\.23\.0-edge\.2/)).toBeNull();
  });

  it("a packaged machine is told the facts but offered no Go back now", async () => {
    renderCard(info({ current: "1.23.0-edge.2", line: "stable", installKind: "packaged", back: { to: "1.22.6", exceptions: [] } }));
    expect(await screen.findByText(/The newest Stable release, 1\.22\.6, is older\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go back now" })).toBeNull();
  });
});
