import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";

import { updateScreenView, type UpdateScreenInput } from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateRun, UpdateRunState } from "@/lib/types";
import { UpdateScreen } from "./update-screen";

// The sheet a running update takes the screen with. The READING is pinned in
// `lib/update-screen.test.ts`; this file is about what reaches the DOM — the dialog, the rows, the
// device's own row, and the controls each way out offers.
//
// The component takes its whole state as a prop, exactly as `App.tsx` hands it over, so no store is
// driven here and no timer runs. What is asserted is that the component reads `view.dismissible` and
// never re-derives it: a ✕ that appeared on its own judgement would be the second opinion the reducer
// exists to remove.

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

interface Spies {
  setExpanded: Mock<(open: boolean) => void>;
  releaseDownload: Mock<() => void>;
  releaseLead: Mock<() => void>;
  openUpdates: Mock<() => void>;
}

function mount(over: Partial<UpdateScreenInput>, expandedHere = false) {
  const view = updateScreenView({ ...BASE, ...over });
  const spies: Spies = {
    setExpanded: vi.fn<(open: boolean) => void>(),
    releaseDownload: vi.fn<() => void>(),
    releaseLead: vi.fn<() => void>(),
    openUpdates: vi.fn<() => void>(),
  };
  const state: UpdateScreenState = {
    view,
    // The one thing the hook adds on top of the reading: this document's own expand of a badge.
    mode: view.mode === "collapsed" && expandedHere ? "expanded" : view.mode,
    blocking: view.mode === "expanded" && !view.dismissible,
    setExpanded: spies.setExpanded,
    releaseDownload: spies.releaseDownload,
    releaseLead: spies.releaseLead,
  };
  const result = render(<UpdateScreen screen={state} onOpenUpdates={spies.openUpdates} />);
  return { ...result, spies, state };
}

describe("accessible in every mode it renders at all", () => {
  it("is a named modal dialog, with focus moved into the panel", async () => {
    mount({ startedHere: true, run: run("staging") });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Update in progress");
    // `inert` on the app behind takes it out of the focus order; it does NOT move focus in. So the
    // panel is a focus target and `useDialogFocus` puts focus there, exactly as `BottomSheet` does.
    const panel = dialog.firstElementChild;
    expect(panel).toHaveAttribute("tabindex", "-1");
    await vi.waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it("the badge is a real button, and tapping it asks to expand", async () => {
    const user = userEvent.setup();
    const { spies } = mount({ startedHere: false, run: run("staging") });
    // No dialog on a device that did not ask for this: a takeover nobody asked for reads as hijacked.
    expect(screen.queryByRole("dialog")).toBeNull();
    const badge = screen.getByRole("button");
    await user.click(badge);
    expect(spies.setExpanded).toHaveBeenCalledWith(true);
  });

  it("the machine list is a named list, and the progress bar reports its own numbers", () => {
    mount({
      startedHere: true,
      run: run("done", { peers: [{ name: "minibuch", state: "done", version: "1.9.0" }] }),
      stage: "installing",
      installingSince: NOW - 9_000,
      progress: { done: 12, total: 28, at: NOW - 200 },
    });
    expect(screen.getByRole("list", { name: "Machines" })).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Files downloaded" });
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemax", "28");
  });

  it("renders nothing at all when the reading says hidden", () => {
    const { container } = mount({ run: run("idle") });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the close exists exactly where the reading allows it", () => {
  it("is absent while a run this device started is in flight", () => {
    mount({ startedHere: true, run: run("restarting") });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("is there on a run that ended badly, which is expanded everywhere and still closable", async () => {
    const user = userEvent.setup();
    const { spies } = mount({ startedHere: false, run: run("stuck", { reason: "the gate never answered" }) });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(spies.setExpanded).toHaveBeenCalledWith(false);
  });

  it("is there on an expanded badge, on a device that did not start the run", () => {
    mount({ startedHere: false, run: run("staging") }, true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("the rows on screen", () => {
  it("names the lead first, then every peer, with its version and its word", () => {
    mount({
      startedHere: true,
      run: run("staging", {
        peers: [
          { name: "minibuch", state: "updating", version: "1.8.2" },
          { name: "cellar", state: "package-managed", version: "1.8.2" },
        ],
      }),
    });
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("bluefin");
    expect(items[0]).toHaveTextContent("building");
    expect(items[1]).toHaveTextContent("minibuch");
    expect(items[2]).toHaveTextContent("package-managed");
    expect(items[2]).toHaveTextContent(/package manager/);
  });

  it("a quiet peer dates itself and offers the page, never a cancel", async () => {
    const user = userEvent.setup();
    const { spies } = mount({
      startedHere: true,
      run: run("verifying", {
        peers: [{ name: "minibuch", state: "unreachable", reason: "missed 3 sweeps", updatedAt: NOW - 4 * 60_000 }],
      }),
    });
    expect(screen.getByText(/last seen/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "See Updates" })[0]!);
    expect(spies.openUpdates).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("says once, small, that the run is on the machines and this screen only shows it", () => {
    mount({ startedHere: true, run: run("staging") });
    expect(screen.getByText(/closing the app does not stop it/)).toBeInTheDocument();
  });
});

describe("the two ways out", () => {
  it("a hung download offers 'keep using the app', and that is all it does", async () => {
    const user = userEvent.setup();
    const { spies } = mount({
      startedHere: true,
      run: run("staging"),
      stage: "installing",
      installingSince: NOW - 10 * 60_000,
      progress: { done: 12, total: 28, at: NOW - 10 * 60_000 },
    });
    expect(screen.getByText(/Still downloading/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep using the app" }));
    expect(spies.releaseDownload).toHaveBeenCalledTimes(1);
  });

  it("a stalled lead offers 'keep waiting' beside the page, and never a reload", async () => {
    const user = userEvent.setup();
    const { spies } = mount({
      startedHere: true,
      run: run("staging", { updatedAt: NOW - 10 * 60_000 }),
    });
    expect(screen.getByText(/waiting is the whole job/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep waiting" }));
    expect(spies.releaseLead).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
  });
});
