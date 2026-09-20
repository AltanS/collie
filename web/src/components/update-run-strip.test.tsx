import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";

import { StripHost } from "@/components/ui/strip-host";
import { updateScreenView, type UpdateScreenInput } from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateRun, UpdateRunState } from "@/lib/types";
import { UpdateRunStrip } from "./update-run-strip";

// THE BADGE, AS A STRIP IN THE BAND (2026-09-20).
//
// It was a `fixed inset-x-0 bottom-0` bar mounted beside the sheet until this change, and on a pane
// screen that is exactly where the composer's input row sits — so the row that says "somebody else
// is updating" covered the box you were typing in, including in the case where the operator had
// just tapped "keep using the app" to get that box back.
//
// The reading is pinned in `lib/update-screen.test.ts` and the sheet in `update-screen.test.tsx`.
// This file is about the strip alone: when it registers a slot, what the line says, and that the
// whole row is one tap that opens the sheet and does nothing else.

const NOW = 1_800_000_000_000;

const run = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: "1.8.2",
  to: "1.9.0",
  startedAt: NOW - 45_000,
  updatedAt: NOW - 4_000,
  pid: 99,
  attempt: 0,
  ...over,
});

const BASE: UpdateScreenInput = {
  run: undefined,
  crew: [],
  leadName: "bluefin",
  stage: "idle",
  progress: null,
  installingSince: null,
  startedHere: false,
  controllerChangedAt: null,
  downloadReleased: false,
  leadReleased: false,
  now: NOW,
};

function mount(over: Partial<UpdateScreenInput>, expandedHere = false) {
  const view = updateScreenView({ ...BASE, ...over });
  const setExpanded: Mock<(open: boolean) => void> = vi.fn();
  const state: UpdateScreenState = {
    view,
    mode: view.mode === "collapsed" && expandedHere ? "expanded" : view.mode,
    blocking: view.mode === "expanded" && !view.dismissible,
    setExpanded,
    releaseDownload: vi.fn(),
    releaseLead: vi.fn(),
  };
  const result = render(
    <StripHost>
      <UpdateRunStrip screen={state} />
    </StripHost>,
  );
  return { ...result, setExpanded };
}

/** The strip's own element, scoped by the house handle — the band carries permanent empty live
 *  regions of its own, so `role="status"` would match those as readily as the notice meant. */
const strip = () => document.querySelector('[data-slot="notice"]');

describe("when the band carries a run at all", () => {
  it("registers a strip for a run this device did not start", () => {
    mount({ startedHere: false, run: run("staging") });
    expect(strip()).not.toBeNull();
  });

  it("registers nothing while the sheet has the screen", () => {
    mount({ startedHere: true, run: run("staging") });
    expect(strip()).toBeNull();
  });

  it("registers nothing once this device has opened the badge by hand", () => {
    mount({ startedHere: false, run: run("staging") }, true);
    expect(strip()).toBeNull();
  });

  it("registers nothing when there is no run to speak of", () => {
    mount({ run: run("idle") });
    expect(strip()).toBeNull();
  });
});

describe("the one line it says", () => {
  it("names whoever is still moving, and that machine's own word", () => {
    // The lead is done and this phone is still fetching the bundle, which is what keeps the sheet
    // alive past the lead's own record — the exact shape of the 1.11.0 run.
    mount({
      startedHere: false,
      run: run("done", { peers: [{ name: "minibuch", state: "updating", version: "1.8.2" }] }),
      stage: "installing",
      installingSince: NOW - 9_000,
    });
    expect(screen.getByText("minibuch: updating")).toBeInTheDocument();
  });

  it("falls back to this device's own download when no machine is moving", () => {
    mount({
      startedHere: false,
      run: run("done"),
      stage: "installing",
      installingSince: NOW - 9_000,
      progress: { done: 12, total: 28, at: NOW - 200 },
    });
    expect(screen.getByText("Downloading the new app")).toBeInTheDocument();
  });
});

describe("the tap", () => {
  it("is the whole row, and it only asks the sheet to open", async () => {
    const user = userEvent.setup();
    const { setExpanded } = mount({ startedHere: false, run: run("staging") });
    const row = screen.getByRole("button");
    // Named from its own text, so a screen reader hears the fact rather than an unnamed control.
    expect(row).toHaveAccessibleName(/bluefin|Update in progress|building/);
    await user.click(row);
    expect(setExpanded).toHaveBeenCalledWith(true);
  });

  it("carries no close, because nothing it describes can be declined", () => {
    mount({ startedHere: false, run: run("staging") });
    expect(screen.queryByRole("button", { name: /dismiss|hide|close/i })).toBeNull();
  });
});
