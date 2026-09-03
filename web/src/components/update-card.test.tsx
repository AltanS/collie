import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReloadGuard, isReloadHeld } from "@/lib/reload-guard";
import type { PreflightReport, UpdateInfo, UpdateRun, UpdateRunState } from "@/lib/types";
import { UpdateCard } from "./update-card";

// The update CARD (M15/05): the settings surface that starts a Collie update from the phone. Driven
// through a memory router (for the root loader's snapshot) plus MSW (for the card's own reads and
// for POST /api/update), which is how every other data-driven component here is tested — no
// `vi.mock` of the API module.

const GREEN: PreflightReport = {
  schema: 1,
  verdict: "green",
  checks: [
    { id: "disk", verdict: "green", reason: "4.2 GB free" },
    { id: "service", verdict: "green", reason: "collie.service is present" },
  ],
};

const RED: PreflightReport = {
  schema: 1,
  verdict: "red",
  checks: [
    { id: "disk", verdict: "green", reason: "4.2 GB free" },
    { id: "tree", verdict: "red", reason: "2 tracked files are modified", remedy: "git stash" },
  ],
};

/** All six checks the settings screenshot showed, all green — the everyday shape of the report. */
const GREEN_SIX: PreflightReport = {
  schema: 1,
  verdict: "green",
  checks: [
    { id: "doctor", verdict: "green", reason: "doctor reports no issues" },
    { id: "disk", verdict: "green", reason: "4.2 GB free" },
    { id: "bun", verdict: "green", reason: "bun is on PATH" },
    { id: "tree", verdict: "green", reason: "the working tree is clean" },
    { id: "upstream", verdict: "green", reason: "upstream is reachable" },
    { id: "service", verdict: "green", reason: "collie.service is present" },
  ],
};

/** Green overall, but one check inside it is red — the case a folded card must still surface. */
const GREEN_WITH_ONE_RED: PreflightReport = {
  schema: 1,
  verdict: "green",
  checks: [
    { id: "disk", verdict: "green", reason: "4.2 GB free" },
    { id: "bun", verdict: "green", reason: "bun is on PATH" },
    { id: "tree", verdict: "red", reason: "2 tracked files are modified", remedy: "git stash" },
  ],
};

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.3.0",
  latest: "1.4.0",
  latestUrl: "https://github.com/AltanS/collie/releases/tag/v1.4.0",
  releaseAvailable: true,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: 1_700_000_000_000,
  newerVersions: ["1.3.1", "1.4.0"],
  ...over,
});

const runAt = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: "1.3.0",
  to: "1.4.0",
  startedAt: 1_000,
  updatedAt: 2_000,
  pid: 4242,
  attempt: 0,
  ...over,
});

function homeData(update: UpdateInfo | undefined, servers: HomeData["servers"] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers,
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

function renderCard(update: UpdateInfo | undefined, servers: HomeData["servers"] = []) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(update, servers),
        element: <UpdateCard />,
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

/** The card's own read, answered with `update` plus whatever preflight the case is about. */
function serveCheck(update: UpdateInfo, preflight: PreflightReport | null) {
  server.use(http.get("/api/update/check", () => HttpResponse.json({ ...update, preflight })));
}

beforeEach(() => {
  __resetReloadGuard();
  serveCheck(info(), GREEN);
  server.use(http.post("/api/update/snooze", () => HttpResponse.json(info())));
});

afterEach(() => {
  vi.useRealTimers();
  __resetReloadGuard();
});

describe("update card — what it says before anything happens", () => {
  it("names the version running, the newest version, and what one update folds in", async () => {
    renderCard(info());
    expect(await screen.findByText(/Running 1\.3\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Newest 1\.4\.0/)).toBeInTheDocument();
    expect(await screen.findByText(/folds in 1\.3\.1, 1\.4\.0/)).toBeInTheDocument();
    // And it does NOT borrow the bundle banner's words — two things called "update" in one UI is
    // the confusion this card exists to avoid.
    expect(screen.getByText("Update Collie")).toBeInTheDocument();
    expect(screen.queryByText(/tap to update/i)).not.toBeInTheDocument();
  });

  it("says it is current when there is nothing to take", async () => {
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    serveCheck(current, GREEN);
    renderCard(current);
    expect(await screen.findByText("Up to date. Nothing to do.")).toBeInTheDocument();
    expect(screen.getByText(/Running 1\.3\.0/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update to/ })).not.toBeInTheDocument();
  });

  it("shows each preflight check with its own reason and remedy", async () => {
    serveCheck(info(), RED);
    renderCard(info());
    expect(await screen.findByText("4.2 GB free")).toBeInTheDocument();
    expect(screen.getAllByText("2 tracked files are modified")).not.toHaveLength(0);
    expect(screen.getByText("Fix: git stash")).toBeInTheDocument();
  });

  it("dismisses to the next digest without hiding the version it just named", async () => {
    const user = userEvent.setup();
    let snoozed = false;
    server.use(
      http.post("/api/update/snooze", () => {
        snoozed = true;
        return HttpResponse.json(info());
      }),
    );
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Remind me next digest" }));
    await waitFor(() => expect(snoozed).toBe(true));
    expect(screen.getByText("Dismissed until the next digest.")).toBeInTheDocument();
    expect(screen.getByText(/Running 1\.3\.0/)).toBeInTheDocument();
  });
});

describe("Details fold — noise gone when there is nothing to do, open when something needs a look", () => {
  it("up to date: the done head text shows, and Preflight is collapsed behind a '6 checks' summary", async () => {
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    serveCheck(current, GREEN_SIX);
    renderCard(current);
    expect(await screen.findByText("Up to date. Nothing to do.")).toBeInTheDocument();
    const toggle = await screen.findByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("6 checks")).toBeInTheDocument();
    expect(screen.queryByText("doctor reports no issues")).not.toBeInTheDocument();
  });

  it("an available update renders Details expanded", async () => {
    serveCheck(info(), GREEN_SIX);
    renderCard(info());
    const toggle = await screen.findByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("doctor reports no issues")).toBeInTheDocument();
  });

  it("up to date but one check is red: Details renders expanded with '1 red' in the summary", async () => {
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    serveCheck(current, GREEN_WITH_ONE_RED);
    renderCard(current);
    const toggle = await screen.findByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1 red")).toBeInTheDocument();
    expect(screen.getByText("2 tracked files are modified")).toBeInTheDocument();
  });

  it("tapping Details toggles the fold", async () => {
    const user = userEvent.setup();
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    serveCheck(current, GREEN_SIX);
    renderCard(current);
    const toggle = await screen.findByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("doctor reports no issues")).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("preflight red — the button is disabled with the red's own reason", () => {
  it("disables the action and prints the red check's reason, not a generic line", async () => {
    serveCheck(info(), RED);
    renderCard(info());
    const button = await screen.findByRole("button", { name: "Update to 1.4.0" });
    await waitFor(() => expect(button).toBeDisabled());
    // The reason is on screen twice over — in the check list and under the disabled button — and
    // neither of them is the word "unavailable".
    expect(screen.getAllByText("2 tracked files are modified").length).toBeGreaterThan(0);
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it("a preflight that could not be run disables the action too — 'we could not check' is not 'green'", async () => {
    serveCheck(info(), null);
    renderCard(info());
    const button = await screen.findByRole("button", { name: "Update to 1.4.0" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText("The preflight couldn't be run on this machine.")).toBeInTheDocument();
  });
});

describe("update confirm — one tap plus one confirm, and the confirm says what happens", () => {
  it("names the surviving terminal session and the 30 second phone-view drop", async () => {
    const user = userEvent.setup();
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Update to 1.4.0" }));
    expect(screen.getByText("Update to 1.4.0?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your terminal session stays alive. The phone view drops for up to 30 seconds.",
      ),
    ).toBeInTheDocument();
  });

  it("the tap alone starts nothing; the confirm sends the version the operator read", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/update", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, to: "1.4.0", major: false, run: null }, { status: 202 });
      }),
    );
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Update to 1.4.0" }));
    expect(bodies).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Yes, update" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ confirm: true, target: "1.4.0", major: false });
  });

  it("cancel leaves everything where it was", async () => {
    const user = userEvent.setup();
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Update to 1.4.0" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/stays alive/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update to 1.4.0" })).toBeInTheDocument();
  });

  it("a double tap is reported as the refusal it is, not as a second update", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/update", () =>
        HttpResponse.json(
          {
            error: "an update is already running (staging); nothing was started",
            code: "update.in_progress",
            detail: { state: "staging" },
          },
          { status: 409 },
        ),
      ),
    );
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Update to 1.4.0" }));
    await user.click(screen.getByRole("button", { name: "Yes, update" }));
    expect(
      await screen.findByText("An update is already running (staging). Nothing was started."),
    ).toBeInTheDocument();
  });
});

describe("major confirm — a crossing is consented to on its own (ADR 0020)", () => {
  const withMajor = info({ majorAvailable: "2.0.0", majorUrl: "https://example.invalid/2.0.0" });

  it("is a separate action with its own words, naming the major", async () => {
    const user = userEvent.setup();
    serveCheck(withMajor, GREEN);
    renderCard(withMajor);
    await user.click(await screen.findByRole("button", { name: "Cross to 2.0.0" }));
    expect(screen.getByText("Cross the major to 2.0.0?")).toBeInTheDocument();
    const body = screen.getByText(/is a new major/);
    expect(body).toHaveTextContent("2.0.0 is a new major");
    expect(body).toHaveTextContent("never folded into a routine update");
    // Not the routine confirm's title — you cannot cross a major by tapping the button you tapped
    // last week.
    expect(screen.queryByText("Update to 2.0.0?")).not.toBeInTheDocument();
  });

  it("sends the major consent explicitly", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    serveCheck(withMajor, GREEN);
    server.use(
      http.post("/api/update", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, to: "2.0.0", major: true, run: null }, { status: 202 });
      }),
    );
    renderCard(withMajor);
    await user.click(await screen.findByRole("button", { name: "Cross to 2.0.0" }));
    await user.click(screen.getByRole("button", { name: "Yes, cross to 2.0.0" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ confirm: true, target: "2.0.0", major: true });
  });
});

describe("state rendering — progress is not failure", () => {
  it("restarting and verifying read as progress, and say so in as many words", async () => {
    renderCard(info({ run: runAt("restarting") }));
    const line = await screen.findByText("Restarting. This is not an outage.");
    expect(line).toBeInTheDocument();
    expect(screen.getByText(/Your terminal session is untouched/)).toBeInTheDocument();
    // Progress is drawn in the working tone, never the blocked one a failure carries.
    expect(line.closest("div")).toHaveClass("text-status-working");
    expect(line.closest("div")).not.toHaveClass("text-status-blocked");
  });

  it("every state has a line — a state with nothing to say reads as a hang", async () => {
    const lines: [UpdateRunState, RegExp][] = [
      ["preflight", /Checking this machine/],
      ["staging", /Staging 1\.4\.0/],
      ["restarting", /not an outage/],
      ["verifying", /Verifying the new build/],
      ["done", /Updated to 1\.4\.0/],
      ["rolled-back", /still on 1\.3\.0/],
      ["stuck", /stuck/],
      ["interrupted", /stopped before it finished/],
    ];
    for (const [state, pattern] of lines) {
      const view = renderCard(info({ run: runAt(state) }));
      expect(await screen.findByText(pattern)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("rolled-back is drawn apart from the progress states it must never be mistaken for", async () => {
    renderCard(info({ run: runAt("rolled-back") }));
    const line = await screen.findByText(/still on 1\.3\.0/);
    expect(line.closest("div")).toHaveClass("text-status-blocked");
    expect(line.closest("div")).not.toHaveClass("text-status-working");
  });
});

describe("rolled back card — the machine is named, the log is there, and there is a way on", () => {
  it("names the version still installed, shows the log tail and offers a Retry", async () => {
    const user = userEvent.setup();
    renderCard(
      info({
        run: runAt("rolled-back", {
          logTail: "collie.service: Main process exited, code=exited, status=1/FAILURE",
          reason: "the new build failed its health check",
        }),
      }),
    );
    expect(await screen.findByText("Rolled back. This machine is still on 1.3.0.")).toBeInTheDocument();
    expect(screen.getByText(/Main process exited/)).toBeInTheDocument();
    // Retry is not a dead end: it re-opens the same confirm the first attempt went through.
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Update to 1.4.0?")).toBeInTheDocument();
  });

  it("stuck prints the recovery command, and interrupted offers a Retry", async () => {
    const view = renderCard(info({ run: runAt("stuck", { recovery: "collie update --rollback" }) }));
    expect(await screen.findByText("collie update --rollback")).toBeInTheDocument();
    view.unmount();

    renderCard(info({ run: runAt("interrupted") }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("pack lead card — peers are levelled from the terminal this milestone", () => {
  it("points a lead at `collie pack update` instead of a button that does not exist", async () => {
    renderCard(info(), [
      { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1 },
      { id: "laptop", name: "laptop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1 },
    ]);
    expect(
      await screen.findByText("Peers are updated from the terminal: collie pack update"),
    ).toBeInTheDocument();
  });

  it("a solo install grows no such line", async () => {
    renderCard(info());
    await screen.findByText(/Running 1\.3\.0/);
    expect(screen.queryByText(/collie pack update/)).not.toBeInTheDocument();
  });

  it("is hidden when up to date, even with pack members", async () => {
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    serveCheck(current, GREEN);
    renderCard(current, [
      { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1 },
      { id: "laptop", name: "laptop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1 },
    ]);
    await screen.findByText("Up to date. Nothing to do.");
    expect(screen.queryByText(/collie pack update/)).not.toBeInTheDocument();
  });
});

describe("restarting gap is not an outage", () => {
  it("keeps the progress state, reads the standby door, and renders no error when the bridge is gone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let standbyReads = 0;
    server.use(
      // The front door is down — this is the update doing exactly what was asked of it.
      http.get("/api/update/check", () => HttpResponse.error()),
      http.get("/standby/update", () => {
        standbyReads += 1;
        return HttpResponse.json(runAt("verifying", { updatedAt: 9_000 }));
      }),
    );
    renderCard(info({ run: runAt("restarting") }));
    expect(await screen.findByText("Restarting. This is not an outage.")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(standbyReads).toBeGreaterThan(0));
    // The standby door's fresher record moves the card on, and at no point is a failure drawn.
    expect(await screen.findByText("Verifying the new build…")).toBeInTheDocument();
    expect(screen.queryByText(/Rolled back/)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't/i)).not.toBeInTheDocument();
  });

  it("a standby door that is unreachable too changes nothing on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.use(
      http.get("/api/update/check", () => HttpResponse.error()),
      http.get("/standby/update", () => HttpResponse.error()),
    );
    renderCard(info({ run: runAt("restarting") }));
    expect(await screen.findByText("Restarting. This is not an outage.")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByText("Restarting. This is not an outage.")).toBeInTheDocument();
  });

  it("self-update hold: the bundle reload is held for the length of the run", async () => {
    const view = renderCard(info({ run: runAt("restarting") }));
    await screen.findByText("Restarting. This is not an outage.");
    expect(isReloadHeld()).toBe(true);
    view.unmount();

    renderCard(info({ run: runAt("done") }));
    await screen.findByText("Updated to 1.4.0.");
    expect(isReloadHeld()).toBe(false);
  });
});
