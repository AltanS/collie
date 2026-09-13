import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TourSheet, type TourSheetProps } from "./tour-sheet";
import { en } from "@/lib/i18n/messages/en";
import { t } from "@/lib/i18n";
import type { PushState } from "@/lib/push";

// The controlled screen: one scroll, every sentence on it a prop, no storage, no router and no gate.
// Everything the app's gate decides is passed in here, which is also what lets the states playground
// mount every situation as a plain prop combination.

function push(overrides: Partial<PushState> = {}): PushState {
  return { availability: "ready", subscribed: false, userDisabled: false, ...overrides };
}

/** Push already answered — the quiet default, so a case that is not about push sees neither the
 *  setup row nor the card. */
const pushDone = push({ subscribed: true });

function renderScreen(props: Partial<TourSheetProps> = {}) {
  const onClose = vi.fn();
  const onEnablePush = vi.fn(async () => ({ ok: true }));
  const view = render(
    <TourSheet
      open
      onClose={onClose}
      mux="Herdr"
      host="bluefin"
      panes={4}
      needsYou={1}
      machines={0}
      pushState={pushDone}
      onEnablePush={onEnablePush}
      {...props}
    />,
  );
  return { ...view, onClose, onEnablePush };
}

/** Every control the trap cycles, in DOM order — the same query the component itself runs. */
function focusables(): HTMLElement[] {
  const dialog = screen.getByRole("dialog");
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

/** Tab off the last control lands on the first, Shift+Tab off the first lands on the last. */
function expectTrapped() {
  const items = focusables();
  expect(items.length).toBeGreaterThan(1);
  const first = items[0]!;
  const last = items[items.length - 1]!;

  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);

  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
}

describe("TourSheet — the claim", () => {
  it("renders nothing while closed", () => {
    renderScreen({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a modal dialog named by the claim, and prints it as the heading too", () => {
    renderScreen();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(en["tour.title"]);
    expect(screen.getByRole("heading", { name: en["tour.title"] })).toBeInTheDocument();
  });

  it("names this install's multiplexer and machine", () => {
    renderScreen({ mux: "tmux", host: "minibuch" });
    expect(
      screen.getByText(t("tour.lead", { mux: "tmux", host: "minibuch" })),
    ).toBeInTheDocument();
  });

  // A solo snapshot carries no `servers` at all, so there is no machine LABEL to print — and the URL
  // host is not one (on a served install it is a long DNS name nobody calls the machine).
  it("drops the machine clause when the snapshot names no machine", () => {
    renderScreen({ host: undefined });
    expect(screen.getByText(t("tour.leadNoHost", { mux: "Herdr" }))).toBeInTheDocument();
  });

  // "under unknown" is a worse sentence than no name at all — the rule lib/mux-capability.ts states
  // for every read of the multiplexer's name.
  it("drops the multiplexer clause too while no bridge has answered", () => {
    renderScreen({ mux: "", host: undefined });
    expect(screen.getByText(en["tour.leadNoMux"])).toBeInTheDocument();
  });
});

describe("TourSheet — your setup", () => {
  it("counts the panes and the ones blocked on you", () => {
    renderScreen({ panes: 4, needsYou: 1 });
    expect(screen.getByText("4 panes, 1 needs you")).toBeInTheDocument();
  });

  it("says so plainly when nothing is running", () => {
    renderScreen({ panes: 0, needsYou: 0 });
    expect(screen.getByText(en["tour.setup.noPanes"])).toBeInTheDocument();
  });

  it("leaves the blocked half off when nothing is blocked", () => {
    renderScreen({ panes: 4, needsYou: 0 });
    expect(screen.getByText("4 panes")).toBeInTheDocument();
  });

  it("hides the crew row on a solo install", () => {
    renderScreen({ machines: 0 });
    // Anchored, because one of the six capability lines also ends in "in your crew".
    expect(screen.queryByText(/^\d+ machines? in your crew$/)).not.toBeInTheDocument();
  });

  it("counts the machines on a crew", () => {
    renderScreen({ machines: 3 });
    expect(screen.getByText("3 machines in your crew")).toBeInTheDocument();
  });

  it("says this device may type", () => {
    renderScreen();
    expect(screen.getByText(en["tour.setup.canType"])).toBeInTheDocument();
  });

  it("says so instead when it may not", () => {
    renderScreen({ readOnly: true });
    expect(screen.getByText(en["tour.setup.readOnly"])).toBeInTheDocument();
  });

  it("mentions notifications where they could be on and are not", () => {
    renderScreen({ pushState: push() });
    expect(screen.getByText(en["tour.setup.pushOff"])).toBeInTheDocument();
  });

  it("says nothing about them on a device that cannot run them", () => {
    renderScreen({ pushState: push({ availability: "server-off" }) });
    expect(screen.queryByText(en["tour.setup.pushOff"])).not.toBeInTheDocument();
  });
});

describe("TourSheet — do this next", () => {
  it("is absent entirely on an install with nothing to fix", () => {
    renderScreen();
    expect(screen.queryByText(en["tour.doNext"])).not.toBeInTheDocument();
  });

  it("leads with pairing on a device that cannot type", () => {
    renderScreen({ readOnly: true, panes: 0, pushState: push() });
    expect(screen.getByText(en["tour.pair.title"])).toBeInTheDocument();
  });

  it("offers a space when nothing is running", () => {
    renderScreen({ panes: 0, needsYou: 0 });
    expect(screen.getByText(en["tour.space.title"])).toBeInTheDocument();
  });

  // Two is the cap, and it is first-match order: pair, space, push, install.
  it("shows at most two cards, and drops the third offer rather than stacking it", () => {
    renderScreen({ readOnly: true, panes: 0, pushState: push(), installOffer: true });
    expect(screen.getByText(en["tour.pair.title"])).toBeInTheDocument();
    expect(screen.getByText(en["tour.space.title"])).toBeInTheDocument();
    expect(screen.queryByText(en["tour.pushCard.title"])).not.toBeInTheDocument();
    expect(screen.queryByText(en["tour.install.title"])).not.toBeInTheDocument();
  });

  it("reports which card was tapped instead of navigating itself", () => {
    const { onClose } = renderScreen({ readOnly: true, panes: 0 });
    fireEvent.click(screen.getByRole("button", { name: en["tour.pair.button"] }));
    expect(onClose).toHaveBeenCalledWith("pair");
    fireEvent.click(screen.getByRole("button", { name: en["tour.space.button"] }));
    expect(onClose).toHaveBeenCalledWith("space");
  });

  it("offers the home screen when the browser is holding an install offer", () => {
    renderScreen({ installOffer: true });
    expect(screen.getByRole("button", { name: en["tour.install.button"] })).toBeInTheDocument();
  });
});

describe("TourSheet — what you can do here", () => {
  it("prints all six lines", () => {
    renderScreen();
    for (const key of [
      "tour.can.mirror",
      "tour.can.answer",
      "tour.can.type",
      "tour.can.harness",
      "tour.can.session",
      "tour.can.crew",
    ] as const) {
      expect(screen.getByText(en[key])).toBeInTheDocument();
    }
  });
});

describe("TourSheet — the way out", () => {
  it("offers the blocked pane when something is blocked", () => {
    const { onClose } = renderScreen({ needsYou: 1 });
    fireEvent.click(screen.getByRole("button", { name: en["tour.done.pane"] }));
    expect(onClose).toHaveBeenCalledWith("pane");
  });

  it("offers the dashboard when nothing is", () => {
    const { onClose } = renderScreen({ needsYou: 0 });
    fireEvent.click(screen.getByRole("button", { name: en["tour.done.dashboard"] }));
    expect(onClose).toHaveBeenCalledWith("dashboard");
  });

  it("closes with 'skip' on Skip", () => {
    const { onClose } = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: en["tour.skip"] }));
    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("closes with 'skip' on Escape", () => {
    const { onClose } = renderScreen();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("skip");
  });
});

describe("TourSheet — the notifications card", () => {
  // Every "decided or impossible" outcome takes the card off the screen entirely rather than
  // printing an explanation on it, which is what a derived to-do list means.
  it("shows no card while the first push read is still in flight", () => {
    renderScreen({ pushState: null });
    expect(screen.queryByText(en["tour.pushCard.title"])).not.toBeInTheDocument();
  });

  it("shows no card at all when push cannot run here", () => {
    renderScreen({ pushState: push({ availability: "server-off" }) });
    expect(screen.queryByText(en["tour.pushCard.title"])).not.toBeInTheDocument();
  });

  it("shows no card when this device is already subscribed", () => {
    renderScreen({ pushState: push({ subscribed: true }) });
    expect(screen.queryByText(en["tour.pushCard.title"])).not.toBeInTheDocument();
  });

  it("shows no card when the operator turned notifications off", () => {
    renderScreen({ pushState: push({ userDisabled: true }) });
    expect(screen.queryByText(en["tour.pushCard.title"])).not.toBeInTheDocument();
  });

  it("offers the live button, and becomes a confirmation line once it succeeds", async () => {
    const { onEnablePush } = renderScreen({ pushState: push() });
    const button = screen.getByRole("button", { name: en["tour.push.enable"] });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(en["tour.push.enabled"])).toBeInTheDocument());
    expect(onEnablePush).toHaveBeenCalledTimes(1);
  });
});

// The router behind this sheet is still fully focusable, so this is the first modal in this app that
// must TRAP. Asserted on the plain screen and on one with both a disabled and an enabled card button,
// because a disabled control changes which element the cycle has to land on.
describe("TourSheet — the focus trap", () => {
  it("cycles on a screen with nothing to do next", () => {
    renderScreen();
    expectTrapped();
  });

  it("cycles with the notifications card's own button in the run", () => {
    renderScreen({ pushState: push(), panes: 4, needsYou: 0 });
    expect(focusables()).toContain(screen.getByRole("button", { name: en["tour.push.enable"] }));
    expectTrapped();
  });

  it("cycles with two live cards on screen", () => {
    renderScreen({ readOnly: true, panes: 0 });
    expectTrapped();
  });
});
