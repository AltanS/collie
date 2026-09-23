import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";

import { StripHost } from "@/components/ui/strip-host";
import { updateScreenView, type UpdateScreenInput } from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateRun, UpdateRunState } from "@/lib/types";
import { UpdateRunStrip } from "./update-run-strip";

// THE STRIP, IN THE BAND (2026-09-20, and update mode, ADR 0064).
//
// It was a `fixed inset-x-0 bottom-0` bar mounted beside the sheet until 2026-09-20, and on a pane
// screen that is exactly where the composer's input row sits. It lives in the band above the header.
// Since update mode it says "Update running, started on another device. <step>." on a device that
// did not start the run, and "Update running. <step>." on the one that took "Use the app anyway".
//
// The reading is pinned in `lib/update-screen.test.ts` and the panel in `update-screen.test.tsx`.
// This file is about the strip alone: when it registers a slot, what the line says, and that "View"
// opens the panel and does nothing else.

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
  released: false,
  now: NOW,
};

function mount(over: Partial<UpdateScreenInput>, expandedHere = false) {
  const view = updateScreenView({ ...BASE, ...over });
  const setExpanded: Mock<(open: boolean) => void> = vi.fn();
  const mode = view.mode === "collapsed" && expandedHere ? "expanded" : view.mode;
  const state: UpdateScreenState = {
    view,
    mode,
    blocking: mode === "expanded",
    ask: null,
    setExpanded,
    release: vi.fn(),
    skip: vi.fn(),
    keepTrying: vi.fn(),
    back: vi.fn(),
    notNow: vi.fn(),
    retryMembers: vi.fn(),
    tryAgain: vi.fn(),
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
  it("on a device that did not start the run: started elsewhere, and the step", () => {
    mount({ startedHere: false, run: run("restarting") });
    expect(strip()).toHaveTextContent("Update running, started on another device. bluefin is restarting.");
  });

  it("keeps saying so while the members are still moving after the lead's own done", () => {
    mount({ startedHere: false, run: run("done", { peers: [{ name: "minibuch", state: "updating", version: "1.8.2", updatedAt: NOW }] }) });
    expect(strip()).toHaveTextContent("Updating the other machines");
  });

  it("on the device that took the way out: no 'another device'", () => {
    mount({ startedHere: true, released: true, run: run("staging") });
    expect(strip()).toHaveTextContent("Update running. Building 1.9.0 on bluefin.");
  });
});

describe("View", () => {
  it("only asks the panel to open", async () => {
    const user = userEvent.setup();
    const { setExpanded } = mount({ startedHere: false, run: run("staging") });
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(setExpanded).toHaveBeenCalledWith(true);
  });

  it("carries no close, because nothing it describes can be declined", () => {
    mount({ startedHere: false, run: run("staging") });
    expect(screen.queryByRole("button", { name: /dismiss|hide|close/i })).toBeNull();
  });
});
