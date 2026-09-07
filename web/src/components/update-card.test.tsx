import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetReloadGuard, isReloadHeld } from "@/lib/reload-guard";
import type {
  PreflightReport,
  UpdateInfo,
  UpdatePackMember,
  UpdateRun,
  UpdateRunState,
} from "@/lib/types";
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

/** What a packaged install's own preflight looks like: short, green, and naming its command. */
const PACKAGED: PreflightReport = {
  schema: 1,
  verdict: "green",
  checks: [
    { id: "doctor", verdict: "green", reason: "doctor reports no issues" },
    {
      id: "package",
      verdict: "green",
      reason: "updates come from your package manager",
      remedy: "sudo pacman -Syu collie-bin",
    },
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

/** One check amber, nothing red — the chronic "doctor" shape on an install missing an
 *  integration. Nothing to act on today, so this stays folded. */
const GREEN_WITH_ONE_AMBER: PreflightReport = {
  schema: 1,
  verdict: "amber",
  checks: [
    { id: "disk", verdict: "green", reason: "4.2 GB free" },
    { id: "bun", verdict: "green", reason: "bun is on PATH" },
    { id: "doctor", verdict: "amber", reason: "1 integration is not linked" },
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

/** The card's own read, answered with `update` plus whatever preflight the case is about — and,
 *  for the pack cases, the census spec 03 puts on the same response. Absent by default, which is
 *  the solo answer and the older-bridge answer both. */
function serveCheck(update: UpdateInfo, preflight: PreflightReport | null, pack?: UpdatePackMember[]) {
  server.use(
    http.get("/api/update/check", () =>
      HttpResponse.json(pack === undefined ? { ...update, preflight } : { ...update, preflight, pack }),
    ),
  );
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

  it("up to date with one amber check renders folded with '1 amber'", async () => {
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    serveCheck(current, GREEN_WITH_ONE_AMBER);
    renderCard(current);
    const toggle = await screen.findByRole("button", { name: /Details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("1 amber")).toBeInTheDocument();
    expect(screen.queryByText("1 integration is not linked")).not.toBeInTheDocument();
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

// ── THE PACK, INSIDE THE CARD (M16/01) ──────────────────────────────────────────────────────────
//
// The line this card used to carry — "Peers are updated from the terminal: collie pack update" —
// is gone, because it is no longer true. The pack is lines in this card now, and the button above
// them covers it.

const PACK: UpdatePackMember[] = [
  { name: "attic", version: "1.3.0", verdict: "red", reasons: ["working tree has tracked changes: bridge/server.ts"], asOf: 1_700_000_000_000 },
  { name: "minibuch", version: "1.3.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
  { name: "shed", version: null, verdict: "unknown", reasons: [], asOf: 1_700_000_000_000 },
];

const LEAD_ROSTER: HomeData["servers"] = [
  { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1 },
  { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1 },
];

describe("peer rows in the card", () => {
  it("grows one line per peer, worst first, with no table beside the card", async () => {
    serveCheck(info(), GREEN, PACK);
    renderCard(info(), LEAD_ROSTER);
    const list = await screen.findByRole("list", { name: "Pack members" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    // Red first, then the unknown, then the green. The row that blocks the confirm sits nearest
    // the button, which is the whole reason the rows live in this card.
    expect(names[0]).toContain("attic");
    expect(names[1]).toContain("shed");
    expect(names[2]).toContain("minibuch");
    expect(names).toHaveLength(3);
  });

  it("peer rows are read-only and carry the reason when red", async () => {
    serveCheck(info(), GREEN, PACK);
    renderCard(info(), LEAD_ROSTER);
    const list = await screen.findByRole("list", { name: "Pack members" });
    // No per-peer update, no per-peer retry — the operator's decision was taken once, above.
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(list).getByText("working tree has tracked changes: bridge/server.ts"),
    ).toBeInTheDocument();
  });

  it("peer row asOf dates every line, so an old green and a fresh green differ", async () => {
    vi.setSystemTime(1_700_000_000_000 + 6 * 60 * 60 * 1000);
    const mixed: UpdatePackMember[] = [
      { name: "minibuch", version: "1.3.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
      { name: "shed", version: "1.3.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 + 6 * 60 * 60 * 1000 - 4000 },
    ];
    serveCheck(info(), GREEN, mixed);
    renderCard(info(), LEAD_ROSTER);
    const list = await screen.findByRole("list", { name: "Pack members" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.find((li) => li.textContent?.includes("minibuch"))?.textContent).toContain("checked 6h");
    expect(rows.find((li) => li.textContent?.includes("shed"))?.textContent).toContain("checked now");
  });

  it("unknown is not green — it says unknown and says why", async () => {
    serveCheck(info(), GREEN, PACK);
    renderCard(info(), LEAD_ROSTER);
    const list = await screen.findByRole("list", { name: "Pack members" });
    const shed = within(list)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("shed"));
    expect(shed?.textContent).toContain("unknown");
    expect(shed?.textContent).toContain("we could not check this machine");
    expect(shed?.textContent).not.toContain("ready");
  });

  it("solo grows no peer rows at all", async () => {
    renderCard(info());
    await screen.findByText(/Running 1\.3\.0/);
    expect(screen.queryByRole("list", { name: "Pack members" })).not.toBeInTheDocument();
  });
});

describe("single action button", () => {
  it("says 'Update pack to X' when this pack has peers", async () => {
    serveCheck(info(), GREEN, PACK);
    renderCard(info(), LEAD_ROSTER);
    expect(await screen.findByRole("button", { name: "Update pack to 1.4.0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update to 1.4.0" })).not.toBeInTheDocument();
  });

  it("says 'Update to X' on a solo install", async () => {
    renderCard(info());
    expect(await screen.findByRole("button", { name: "Update to 1.4.0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update pack/ })).not.toBeInTheDocument();
  });

  it("says 'Retry pack update' once the lead is current and a peer is behind", async () => {
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    const behind: UpdatePackMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
    ];
    serveCheck(current, GREEN, behind);
    renderCard(current, LEAD_ROSTER);
    expect(await screen.findByRole("button", { name: "Retry pack update" })).toBeInTheDocument();
    // And the card does not claim there is nothing to do three inches above that button.
    expect(screen.queryByText("Up to date. Nothing to do.")).not.toBeInTheDocument();
  });
});

/** What `startUpdate` puts on the wire. Named so the assertions below read against a contract
 *  rather than an anonymous bag. */
interface StartBody {
  confirm?: boolean;
  target?: string;
  major?: boolean;
  peersOnly?: boolean;
}

async function readStart(request: Request): Promise<StartBody> {
  // SAFETY: the only writer of this body is `startUpdate` in lib/api.ts, three lines of
  // JSON.stringify over a typed object. Every field above is optional, so a body missing one reads
  // as undefined and the assertion fails loudly rather than the parse throwing.
  return (await request.json()) as StartBody;
}

describe("retry pack update", () => {
  it("starts a new run whose only legs are the peers", async () => {
    const user = userEvent.setup();
    const current = info({ latest: "1.3.0", releaseAvailable: false, newerVersions: [] });
    const behind: UpdatePackMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
    ];
    serveCheck(current, GREEN, behind);
    let sent: StartBody | undefined;
    server.use(
      http.post("/api/update", async ({ request }) => {
        sent = await readStart(request);
        return HttpResponse.json({ ok: true, to: "1.3.0", major: false, run: null });
      }),
    );
    renderCard(current, LEAD_ROSTER);

    await user.click(await screen.findByRole("button", { name: "Retry pack update" }));
    // Its own confirm, in its own words: only the peers run, and each gets one more attempt.
    expect(screen.getByText("Retry the pack update?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, retry" }));

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent).toMatchObject({ confirm: true, peersOnly: true, target: "1.3.0", major: false });
  });

  it("an ordinary pack update is NOT peers-only", async () => {
    const user = userEvent.setup();
    serveCheck(info(), GREEN, PACK);
    let sent: StartBody | undefined;
    server.use(
      http.post("/api/update", async ({ request }) => {
        sent = await readStart(request);
        return HttpResponse.json({ ok: true, to: "1.4.0", major: false, run: null });
      }),
    );
    renderCard(info(), LEAD_ROSTER);

    await user.click(await screen.findByRole("button", { name: "Update pack to 1.4.0" }));
    expect(screen.getByText("Update the pack to 1.4.0?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, update the pack" }));

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent).not.toHaveProperty("peersOnly");
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
    // The hold is set in a passive effect; findByText only proves the commit, so the
    // assertion waits for the effect rather than racing it (this bit CI once).
    await waitFor(() => expect(isReloadHeld()).toBe(true));
    view.unmount();

    renderCard(info({ run: runAt("done") }));
    await screen.findByText("Updated to 1.4.0.");
    await waitFor(() => expect(isReloadHeld()).toBe(false));
  });
});

// ── A packaged install (ADR 0035) ────────────────────────────────────────────
// Its preflight is GREEN — nothing is wrong with it — but it can never take an update from this
// card, because the CLI refuses on a root it cannot write and `POST /api/update` would only relay
// that refusal. An enabled button here is a button that always fails.

describe("UpdateCard — an install a package manager owns", () => {
  it("shows the package command IN PLACE OF the update button, not a greyed-out one", async () => {
    // A disabled control is a thing to try again, and there is nothing here to try. The command is
    // the operator's next move, and it is selectable text so a phone can copy it.
    const update = info({ installKind: "packaged" });
    serveCheck(update, PACKAGED);
    renderCard(update);
    expect(await screen.findByText("sudo pacman -Syu collie-bin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update to 1\.4\.0/i })).not.toBeInTheDocument();
    // The version is still on screen: that a release exists is worth knowing however it is taken.
    expect(screen.getByText(/Newest 1\.4\.0/)).toBeInTheDocument();
  });

  it("takes the command off the snapshot first, and falls back to the preflight remedy", async () => {
    // The snapshot carries the host's own answer since M17/02, so the card no longer has to dig it
    // out of a check's remedy. It wins where both are present.
    const fromSnapshot = info({ installKind: "packaged", packageCommand: "nix profile upgrade collie" });
    serveCheck(fromSnapshot, PACKAGED);
    const { unmount } = renderCard(fromSnapshot);
    expect(await screen.findByText("nix profile upgrade collie")).toBeInTheDocument();
    expect(screen.queryByText("sudo pacman -Syu collie-bin")).not.toBeInTheDocument();
    unmount();

    // And the fallback survives: a bridge older than the field still answers through the remedy.
    const older = info({ installKind: "packaged" });
    serveCheck(older, PACKAGED);
    renderCard(older);
    expect(await screen.findByText("sudo pacman -Syu collie-bin")).toBeInTheDocument();
  });

  it("with no command to name, the sentence stands alone and the button is still gone", async () => {
    // The prefix named no manager this build knows, so the CLI's `package` check carries no remedy.
    const update = info({ installKind: "packaged" });
    serveCheck(update, {
      ...PACKAGED,
      checks: PACKAGED.checks.map((c) =>
        c.id === "package" ? { id: c.id, verdict: c.verdict, reason: c.reason } : c,
      ),
    });
    renderCard(update);
    expect(await screen.findByText(/package manager updates this install/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update to 1\.4\.0/i })).not.toBeInTheDocument();
  });

  it("says who does update it, instead of showing a preflight failure that did not happen", async () => {
    const update = info({ installKind: "packaged" });
    serveCheck(update, GREEN_SIX);
    renderCard(update);
    expect(await screen.findByText(/package manager updates this install/i)).toBeInTheDocument();
  });

  it("offers no major crossing either — that is the same refusal, not a separate path", async () => {
    const update = info({
      installKind: "packaged",
      majorAvailable: "2.0.0",
      majorUrl: "https://github.com/AltanS/collie/releases/tag/v2.0.0",
    });
    serveCheck(update, PACKAGED);
    renderCard(update);
    expect(await screen.findByText("sudo pacman -Syu collie-bin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cross to 2\.0\.0/i })).not.toBeInTheDocument();
  });

  it("a green preflight on any other kind still leaves the action enabled", async () => {
    // The control that keeps the case above from passing for the wrong reason.
    const update = info({ installKind: "detached-checkout" });
    serveCheck(update, GREEN_SIX);
    renderCard(update);
    const button = await screen.findByRole("button", { name: /Update to 1\.4\.0/i });
    await waitFor(() => expect(button).toBeEnabled());
  });

  // ── AND ITS PEERS ARE STILL REACHABLE FROM HERE ────────────────────────────
  //
  // The lead cannot take the release. Levelling the peers to the build it ALREADY runs is a
  // different act and it works — `bridge/update-action.ts` decides the peers-only start above its
  // own packaged refusal for exactly this reason. What used to happen instead: the release
  // short-circuit answered "Update pack to 1.4.0", the card disabled it, and the peers were
  // unreachable from the phone with an explanation that talked only about this machine.

  it("offers the peers-only run to a packaged lead whose peer is a version behind", async () => {
    const user = userEvent.setup();
    const update = info({ installKind: "packaged" });
    const behind: UpdatePackMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
    ];
    serveCheck(update, PACKAGED, behind);
    let sent: StartBody | undefined;
    server.use(
      http.post("/api/update", async ({ request }) => {
        sent = await readStart(request);
        return HttpResponse.json({ ok: true, to: "1.3.0", major: false, run: null });
      }),
    );
    renderCard(update, LEAD_ROSTER);

    const button = await screen.findByRole("button", { name: "Retry pack update" });
    expect(button).toBeEnabled();
    // The disabled release button is gone rather than sitting beside it: one action button, and it
    // is the one whose tap can succeed.
    expect(screen.queryByRole("button", { name: /Update pack to/ })).not.toBeInTheDocument();
    // The card still says why THIS machine is not moving — that is the question a peers-only
    // button raises while "Newest 1.4.0" is on screen above it.
    expect(screen.getByText(/package manager updates this install/i)).toBeInTheDocument();

    await user.click(button);
    // Not "This machine is already current": it is not, and the confirm may not say it is.
    expect(screen.getByText("Retry the pack update?")).toBeInTheDocument();
    expect(screen.queryByText(/already current/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/package manager updates this install/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Yes, retry" }));
    await waitFor(() => expect(sent).toBeDefined());
    // Peers only, to the build this lead runs — never to the release it cannot take.
    expect(sent).toMatchObject({ confirm: true, peersOnly: true, target: "1.3.0", major: false });
  });

  // THE CONTROL. Same packaged lead, same release, and the one difference is that no peer needs
  // levelling — so there is nothing for the release branch to yield to, and the disabled button
  // stays as the card's only way to say a release exists and this machine is not taking it.
  it("names the command and no button at all when no peer needs levelling", async () => {
    const update = info({ installKind: "packaged" });
    const level: UpdatePackMember[] = [
      { name: "minibuch", version: "1.3.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
    ];
    serveCheck(update, PACKAGED, level);
    renderCard(update, LEAD_ROSTER);
    expect(await screen.findByText("sudo pacman -Syu collie-bin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update pack to 1.4.0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry pack update" })).not.toBeInTheDocument();
    expect(screen.getByText(/package manager updates this install/i)).toBeInTheDocument();
  });

  // The second control: an ORDINARY lead in the identical pack shape still leads with its own
  // update. Revert `leadCanTake` and this keeps passing while the two above stop — which is what
  // makes them a statement about the install kind rather than about being behind.
  // An ORDINARY lead can land in `retry-pack` too — already current on releases, itself blocked by
  // a genuinely red check, with a peer behind. The reason line is shown here on purpose: it answers
  // exactly the question a "Retry pack update" button raises while this machine is not moving, and
  // suppressing it (the pre-fix shape) is what let a packaged lead's OWN reason go unsaid. This is
  // the case the review asked to see covered, not a boundary the card is trying to avoid.
  it("an ordinary lead's own red reason shows under retry-pack too, not only a packaged lead's", async () => {
    const update = info({ installKind: "detached-checkout", releaseAvailable: false });
    const behind: UpdatePackMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
    ];
    serveCheck(update, RED, behind);
    renderCard(update, LEAD_ROSTER);
    const button = await screen.findByRole("button", { name: "Retry pack update" });
    // NOT disabled: retry-pack is exempt from `blocked` (a peers-only run works even while this
    // machine's own preflight is red — the two are unrelated moves). The point of this test is the
    // REASON line, which is now shown alongside it rather than swallowed.
    await waitFor(() => expect(button).toBeEnabled());
    const reasonLine = document.querySelector("p.text-status-blocked");
    expect(reasonLine).toHaveTextContent("2 tracked files are modified");
  });

  it("control: an ordinary lead with a peer behind still takes the release itself", async () => {
    const update = info({ installKind: "detached-checkout" });
    const behind: UpdatePackMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
    ];
    serveCheck(update, GREEN_SIX, behind);
    renderCard(update, LEAD_ROSTER);
    const button = await screen.findByRole("button", { name: "Update pack to 1.4.0" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Retry pack update" })).not.toBeInTheDocument();
  });

  // A REAL fault must never hide behind the package-manager sentence. Before this, `packageManaged`
  // was checked first, so a packaged install with an actually broken preflight check (its own
  // service or doctor, both of which the packaged instance-check list still runs) showed only
  // "your package manager updates this install" — true, and useless for finding the real problem.
  it("shows the genuine red reason, not the package-manager sentence, when BOTH are true", async () => {
    const update = info({ installKind: "packaged" });
    serveCheck(update, RED);
    renderCard(update);
    // The red reason appears twice by design — once in the checks list, once as the blocked-reason
    // line — so this waits for it to land at all and then reads the specific line rather than
    // asserting a single match, which the details list already rules out.
    await waitFor(() => expect(screen.getAllByText("2 tracked files are modified").length).toBeGreaterThan(0));
    const reasonLine = document.querySelector("p.text-status-blocked");
    expect(reasonLine).toHaveTextContent("2 tracked files are modified");
    expect(screen.queryByText(/package manager updates this install/i)).not.toBeInTheDocument();
  });
});

// ── THE CARD GOES INERT ON ITS OWN TAP, AND STAYS PUT WHILE IT DOES ─────────────────────────────
//
// Two faults, one shape. `POST /api/update` answers before the updater has written anything, so
// there was a beat with no run record: the button was live and a second tap fitted in it. And the
// whole action row used to unmount the moment a record appeared, so the card collapsed under the
// thumb at the one moment the operator was watching it.
describe("the action row while an update is being asked for and driven", () => {
  it("disables the button between the tap and the first run record", async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(
      http.post("/api/update", () => {
        posts++;
        // `run: null` is the gap itself: accepted, and nothing to show for it yet.
        return HttpResponse.json({ ok: true, to: "1.4.0", major: false, run: null }, { status: 202 });
      }),
    );
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Update to 1.4.0" }));
    await user.click(screen.getByRole("button", { name: "Yes, update" }));
    await waitFor(() => expect(posts).toBe(1));

    const button = await screen.findByRole("button", { name: "Update to 1.4.0" });
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(posts).toBe(1);
  });

  it("says what it is waiting for, and says it louder when the start is slow", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    server.use(
      http.post("/api/update", () =>
        HttpResponse.json({ ok: true, to: "1.4.0", major: false, run: null }, { status: 202 }),
      ),
    );
    renderCard(info());
    await user.click(await screen.findByRole("button", { name: "Update to 1.4.0" }));
    await user.click(screen.getByRole("button", { name: "Yes, update" }));
    const button = await screen.findByRole("button", { name: "Update to 1.4.0" });
    await waitFor(() => expect(button).toBeDisabled());
    // A disabled button must never be a silent one.
    expect(await screen.findByText("Starting…")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(
      await screen.findByText("Still starting. The host has not reported the run yet."),
    ).toBeInTheDocument();
    // The words changed. The BUTTON did not: an in-place checkout writes its record only after it
    // has built, so a wall clock cannot tell a slow build from a dead updater, and unlocking on one
    // would re-open the double tap on exactly the slowest machines.
    expect(button).toBeDisabled();
  });

  it("keeps the button on screen — disabled — for the whole run, instead of unmounting it", async () => {
    renderCard(info({ run: runAt("restarting") }));
    const button = await screen.findByRole("button", { name: "Update to 1.4.0" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Restarting. This is not an outage.")).toBeInTheDocument();
  });

  it("the preflight arrives inside a Collapse, so the button does not teleport when doctor lands", async () => {
    renderCard(info());
    // The list is the card's only async arrival above the action row. Its wrapper is the sanctioned
    // one (DESIGN.md §7, hard rule 1); a bare mount is what moved the row.
    const check = await screen.findByText("4.2 GB free");
    expect(check.closest("[data-slot='collapse']")).not.toBeNull();
  });
});
