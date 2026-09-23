import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetUpdateAsk, type UpdateAsk } from "@/lib/update-ask";
import { clearUpdateStarted, type UpdateClaim } from "@/lib/update-ribbon";
import { updateScreenView, type UpdateScreenInput } from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateCrewMember, UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";
import { UpdateScreen } from "./update-screen";

// Update mode's panel (ADR 0064). The READING is pinned in `lib/update-screen.test.ts`; this file is
// about what reaches the DOM: the dialog, the band, the rows with their fixed boxes, the question a
// member can raise, and the controls each state offers. The component takes its whole state as a
// prop, exactly as `App.tsx` hands it over, so no store is driven here and no timer runs.
//
// jsdom lays nothing out, so the no-shift rule is not measured here: `e2e/update-screen.spec.ts` does
// that in a real browser. What IS pinned here is the mechanism the measurement rests on: every slot
// renders in every state, with the same fixed-height classes, whatever it holds.

const NOW = 1_800_000_000_000;
const FROM = "1.11.1";
const TO = "1.12.0";

const run = (state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: 1,
  state,
  from: FROM,
  to: TO,
  startedAt: NOW - 240_000,
  updatedAt: NOW - 4_000,
  pid: 99,
  attempt: 0,
  runId: "run-1",
  ...over,
});

const leg = (name: string, state: UpdatePeerLeg["state"], over: Partial<UpdatePeerLeg> = {}): UpdatePeerLeg => ({
  name,
  state,
  version: FROM,
  updatedAt: NOW - 3_000,
  ...over,
});

const CREW: UpdateCrewMember[] = [
  { name: "minibuch", version: FROM, verdict: "green", reasons: [], asOf: NOW },
  { name: "cellar", version: FROM, verdict: "green", reasons: [], asOf: NOW },
];

const CLAIM: UpdateClaim = { startedAt: NOW - 250_000, runId: "run-1", target: TO, peersOnly: false, bundleAtStart: "a", skipped: [], lead: "bluefin", members: ["minibuch", "cellar"], lastPhase: null };

const BASE: UpdateScreenInput = {
  run: undefined,
  crew: CREW,
  leadName: "bluefin",
  stage: "idle",
  progress: null,
  installingSince: null,
  startedHere: true,
  controllerChangedAt: null,
  released: false,
  now: NOW,
  claim: CLAIM,
  bundle: { id: "a", version: FROM },
  serverStale: false,
};

const ASK: UpdateAsk = { kind: "crew", version: TO, major: false, peersOnly: false, current: FROM };

afterEach(() => {
  __resetUpdateAsk();
  clearUpdateStarted();
});

function mount(over: Partial<UpdateScreenInput>, opened = false) {
  const input = { ...BASE, ...over };
  const view = updateScreenView(input);
  const spies = {
    setExpanded: vi.fn<(open: boolean) => void>(),
    release: vi.fn<() => void>(),
    skip: vi.fn<(name: string) => void>(),
    keepTrying: vi.fn<(name: string) => void>(),
    back: vi.fn<() => void>(),
    notNow: vi.fn<() => void>(),
    retryMembers: vi.fn<() => void>(),
    tryAgain: vi.fn<() => void>(),
    openUpdates: vi.fn<() => void>(),
  };
  const mode = view.mode === "collapsed" && opened ? "expanded" : view.mode;
  const state: UpdateScreenState = {
    view,
    mode,
    blocking: mode === "expanded",
    ask: input.ask ?? null,
    setExpanded: spies.setExpanded,
    release: spies.release,
    skip: spies.skip,
    keepTrying: spies.keepTrying,
    back: spies.back,
    notNow: spies.notNow,
    retryMembers: spies.retryMembers,
    tryAgain: spies.tryAgain,
  };
  const result = render(<UpdateScreen screen={state} onOpenUpdates={spies.openUpdates} onStarted={() => {}} />);
  return { ...result, spies };
}

/** A slot by its house handle. */
function slot(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (el === null) throw new Error(`no [data-slot="${name}"]`);
  return el;
}

describe("the panel is a named modal dialog", () => {
  it("is named by its heading, and focus moves into the panel", async () => {
    const { container } = mount({ run: run("staging") });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(`Building ${TO} on bluefin`);
    await vi.waitFor(() => expect(slot(container, "update-panel")).toHaveFocus());
  });

  it("renders nothing for the strip or for no update at all", () => {
    expect(mount({ run: run("staging"), startedHere: false, claim: null }).container).toBeEmptyDOMElement();
    expect(mount({ claim: null, startedHere: false }).container).toBeEmptyDOMElement();
  });
});

describe("the band: the step, the clock and the progress bar", () => {
  it("says the step out of seven, with the clock from this device's own tap", () => {
    const { container } = mount({ run: run("restarting") });
    const band = slot(container, "update-band");
    expect(band).toHaveTextContent("Update mode · step 3 of 7");
    expect(band).toHaveTextContent("4:10");
    expect(within(band).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  });

  it("is not drawn on Ready to start", () => {
    const { container } = mount({ ask: ASK, claim: null, startedHere: false });
    expect(container.querySelector('[data-slot="update-band"]')).toBeNull();
  });
});

describe("every slot is there in every state, at its fixed height", () => {
  const states: [string, Partial<UpdateScreenInput>][] = [
    ["ready", { ask: ASK, claim: null, startedHere: false }],
    ["check", { run: run("preflight") }],
    ["members, one unreachable", { run: run("done", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting", { updatedAt: NOW - 90_000 })] }) }],
    ["phone downloading", { run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "done", { version: TO })], settledAt: NOW }), stage: "installing", installingSince: NOW - 1_000, progress: { done: 5, total: 20, at: NOW } }],
    ["done", { run: run("done", { settledAt: NOW }), bundle: { id: "b", version: TO } }],
    ["stuck", { run: run("stuck", { recovery: "collie update --rollback" }) }],
  ];
  for (const [label, over] of states) {
    it(label, () => {
      const { container } = mount(over);
      expect(slot(container, "update-heading")).toHaveClass("h-7", "truncate");
      expect(slot(container, "update-subtitle")).toHaveClass("h-10");
      expect(slot(container, "update-subtitle").firstElementChild).toHaveClass("line-clamp-2");
      const rows = container.querySelectorAll('[data-slot="update-row"]');
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toHaveClass("h-13");
      expect(slot(container, "update-rows")).toHaveStyle({ height: "208px" });
      expect(slot(container, "update-note")).toHaveClass("h-[84px]");
      expect(slot(container, "update-footer")).toHaveClass("h-24");
    });
  }
});

describe("the rows", () => {
  it("names each machine, its words and its versions, and puts the phone last", () => {
    mount({ run: run("staging", { peers: [leg("minibuch", "waiting"), leg("cellar", "waiting")] }) });
    const items = within(screen.getByRole("list", { name: "Machines" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `bluefin · building ${TO}${FROM} → ${TO}`,
      `minibuch · waits for bluefin${FROM} → ${TO}`,
      `cellar · waits for bluefin${FROM} → ${TO}`,
      `This phone · waits its turn${FROM} → ${TO}`,
    ]);
  });

  it("animates only the active row", () => {
    const { container } = mount({ run: run("done", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting")] }) });
    expect(container.querySelectorAll(".motion-safe\\:animate-spin")).toHaveLength(1);
  });

  it("draws this phone's download as a bar in the row's reserved slot", () => {
    mount({
      run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "done", { version: TO })], settledAt: NOW }),
      stage: "installing",
      installingSince: NOW - 1_000,
      progress: { done: 5, total: 20, at: NOW },
    });
    const bar = screen.getByRole("progressbar", { name: "Files downloaded" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });
});

describe("the controls each state offers", () => {
  it("Ready to start: Start update and Not now", async () => {
    const { spies } = mount({ ask: ASK, claim: null, startedHere: false });
    expect(screen.getByRole("button", { name: "Start update" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(spies.notNow).toHaveBeenCalledOnce();
  });

  it("in flight on the device that started it: the lock line, and no way out until a stall", () => {
    mount({ run: run("staging") });
    expect(screen.getByText(/The app is locked until this finishes/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a stall offers Use the app anyway", async () => {
    const { spies } = mount({ run: run("staging", { updatedAt: NOW - 200_000 }) });
    await userEvent.click(screen.getByRole("button", { name: "Use the app anyway" }));
    expect(spies.release).toHaveBeenCalledOnce();
  });

  it("a member that needs you: Skip it, or keep trying", async () => {
    const { spies } = mount({ run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { updatedAt: NOW - 90_000 })] }) });
    await userEvent.click(screen.getByRole("button", { name: "Skip cellar" }));
    expect(spies.skip).toHaveBeenCalledWith("cellar");
    await userEvent.click(screen.getByRole("button", { name: "Keep trying" }));
    expect(spies.keepTrying).toHaveBeenCalledWith("cellar");
  });

  it("a read-only panel on another device offers Back to the app instead of the lock", async () => {
    const { spies } = mount({ run: run("restarting"), claim: null, startedHere: false }, true);
    expect(screen.queryByText(/The app is locked/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to the app" }));
    expect(spies.back).toHaveBeenCalledOnce();
  });

  it("Done: Back to the app, and Try <name> again for a member left behind", async () => {
    const { spies } = mount({
      run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "rolled-back", { reason: "gate" })], settledAt: NOW }),
      bundle: { id: "b", version: TO },
    });
    await userEvent.click(screen.getByRole("button", { name: "Try cellar again" }));
    expect(spies.retryMembers).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Back to the app" }));
    expect(spies.back).toHaveBeenCalledOnce();
  });

  it("Rolled back: Back, Try again and Show log", async () => {
    const { spies } = mount({ run: run("rolled-back", { reason: "gate" }) });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(spies.tryAgain).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Show log" }));
    expect(spies.openUpdates).toHaveBeenCalledOnce();
  });

  it("Stuck: the command to run by hand, with Copy", () => {
    mount({ run: run("stuck", { recovery: "collie update --rollback" }) });
    expect(screen.getByText("collie update --rollback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("every button is at least 44px tall (size lg is h-11)", () => {
    mount({ run: run("rolled-back", { reason: "gate" }) });
    for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("h-11");
  });
});
