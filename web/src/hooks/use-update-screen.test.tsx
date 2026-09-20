import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UpdateScreen } from "@/components/update-screen";
import { UpdateRunStrip } from "@/components/update-run-strip";
import { StripHost } from "@/components/ui/strip-host";
import { clearStatus, useStatus } from "@/lib/status";
import {
  __resetUpdateRunStore,
  noteCrewRunBegun,
  noteSnapshotCrew,
  noteSnapshotRun,
} from "@/lib/update-run-store";
import { clearUpdateStarted, noteUpdateStarted } from "@/lib/update-ribbon";
import type { UpdateCheckResponse, UpdateInfo, UpdatePeerLeg, UpdateRun } from "@/lib/types";
import { server } from "@/test/setup";
import { useUpdateScreen } from "./use-update-screen";

// A RUN THAT MOVES ONLY THE MEMBERS TAKES THE SCREEN ON THE PHONE THAT STARTED IT (M32).
//
// The reducer's table is in `lib/update-screen.test.ts`. This file proves the one thing the table
// cannot: that the hook, fed by the real store, makes the app behind the sheet INERT on the device
// that tapped "Retry crew update", hands it back when the run is over, and never takes it at all on
// a device that only heard about the run. The harness is `App.tsx`'s own wiring, cut down to the two
// siblings that matter: the wrapper whose `inert` is `screen.blocking`, and the sheet beside it.

function Harness() {
  const updateScreen = useUpdateScreen();
  const status = useStatus();
  return (
    <>
      <div style={{ display: "contents" }} inert={updateScreen.blocking}>
        {/* The band is inside the router in the real app, so it is inside the wrapper here too —
            which is also what proves the strip goes inert with everything else while a run this
            device started is blocking. */}
        <StripHost>
          <UpdateRunStrip screen={updateScreen} />
          <button type="button">The app behind</button>
        </StripHost>
      </div>
      <UpdateScreen screen={updateScreen} onOpenUpdates={() => {}} />
      <p>{status?.text ?? ""}</p>
    </>
  );
}

const status = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.9.1",
  latest: "1.9.1",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now(),
  ...over,
});

const MOVING: UpdatePeerLeg[] = [{ name: "minibuch", state: "updating", version: "1.9.0", updatedAt: Date.now() }];
const FAILED: UpdatePeerLeg[] = [
  { name: "minibuch", state: "rolled-back", version: "1.9.0", reason: "health gate timed out", updatedAt: Date.now() },
];
const DONE: UpdatePeerLeg[] = [{ name: "minibuch", state: "done", version: "1.9.1", updatedAt: Date.now() }];

/** Is the app behind the sheet inert? Asked of the DOM, as the e2e case asks it. */
function appIsInert(container: HTMLElement): boolean {
  return container.querySelector("[inert]") !== null;
}

beforeEach(() => {
  __resetUpdateRunStore();
  clearUpdateStarted();
  clearStatus();
  // The store's first read. The census says minibuch is a release behind, which is why the retry ran.
  server.use(
    http.get("/api/update/check", () =>
      HttpResponse.json({
        ...status(),
        preflight: { schema: 1, verdict: "green", checks: [] },
        crew: [{ name: "minibuch", version: "1.9.0", verdict: "green", reasons: [], asOf: Date.now() }],
      } satisfies UpdateCheckResponse),
    ),
  );
});

afterEach(() => {
  __resetUpdateRunStore();
  clearUpdateStarted();
  clearStatus();
});

describe("a crew-only run, on the device that tapped it", () => {
  it("takes the screen in the same tap, blocks the app, and hands it back with the failure", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    expect(appIsInert(container)).toBe(false);

    // What the card does on the 202 of a peers-only start.
    act(() => {
      noteUpdateStarted(Date.now(), null);
      noteCrewRunBegun("1.9.1");
    });
    const sheet = screen.getByRole("dialog", { name: "Update in progress" });
    expect(appIsInert(container)).toBe(true);
    // The lead is honest about itself: already on the version, not part of this run.
    expect(within(sheet).getByText("already up to date")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Close" })).toBeNull();

    // The first sweep folds the run: the member is moving, and the app stays blocked.
    act(() => noteSnapshotCrew(status({ peers: MOVING, peersTo: "1.9.1" })));
    expect(within(screen.getByRole("dialog")).getByText("minibuch")).toBeInTheDocument();
    expect(appIsInert(container)).toBe(true);

    // It ends badly. The failed sheet stays, in the band's own words, and the app is usable again.
    act(() => noteSnapshotCrew(status({ peers: FAILED, settledAt: Date.now(), peersTo: "1.9.1" })));
    const failed = screen.getByRole("dialog");
    expect(within(failed).getByText("Could not update minibuch: health gate timed out.")).toBeInTheDocument();
    expect(appIsInert(container)).toBe(false);

    // And the close closes it. A dismissible sheet whose ✕ did nothing was a full-screen trap.
    await user.click(within(failed).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appIsInert(container)).toBe(false);
  });

  it("ends a good run with a toast that names the members, and lets the app go", () => {
    const { container } = render(<Harness />);
    act(() => {
      noteUpdateStarted(Date.now(), null);
      noteCrewRunBegun("1.9.1");
    });
    act(() => noteSnapshotCrew(status({ peers: MOVING, peersTo: "1.9.1" })));
    expect(appIsInert(container)).toBe(true);

    act(() => noteSnapshotCrew(status({ peers: DONE, settledAt: Date.now(), peersTo: "1.9.1" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appIsInert(container)).toBe(false);
    expect(screen.getByText("Members updated to 1.9.1")).toBeInTheDocument();
  });
});

describe("a crew-only run, on every other device", () => {
  it("shows the badge and never blocks the app", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    // No confirm was tapped here: the run arrives on the poll.
    act(() => noteSnapshotCrew(status({ peers: MOVING, peersTo: "1.9.1" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appIsInert(container)).toBe(false);

    // The badge opens a sheet that closes again, and blocks nothing either way.
    await user.click(screen.getByRole("button", { name: /minibuch/ }));
    const sheet = screen.getByRole("dialog");
    expect(appIsInert(container)).toBe(false);
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // And the end is not announced to a device that did not start the run.
    act(() => noteSnapshotCrew(status({ peers: DONE, settledAt: Date.now(), peersTo: "1.9.1" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Members updated to 1.9.1")).toBeNull();
  });
});

describe("a failed sheet's close", () => {
  it("closes the sheet a failed FULL run leaves on every device, and only that failure", async () => {
    // The reading has always called a failed run's sheet dismissible, but its ✕ only folded a badge,
    // and a failed sheet is never a badge: the full-screen sheet stayed where it was.
    const user = userEvent.setup();
    const failed = (startedAt: number): UpdateRun => ({
      schema: 1,
      state: "rolled-back",
      from: "1.9.0",
      to: "1.9.1",
      startedAt,
      updatedAt: startedAt + 60_000,
      pid: 1,
      attempt: 0,
      reason: "health gate timed out",
    });
    render(<Harness />);
    act(() => noteSnapshotRun(failed(Date.now() - 120_000)));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // A later failure is a different one, and it is shown again.
    act(() => noteSnapshotRun(failed(Date.now())));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
