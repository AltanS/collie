import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TourSheet } from "./tour-sheet";
import { en } from "@/lib/i18n/messages/en";
import type { PushState } from "@/lib/push";

// The controlled sheet: three slides, one at a time, no storage and no gate. Everything the app's
// gate decides is a prop here, which is also what lets the states playground mount every slide.

function push(overrides: Partial<PushState> = {}): PushState {
  return { availability: "ready", subscribed: false, userDisabled: false, ...overrides };
}

function renderSheet(props: Partial<Parameters<typeof TourSheet>[0]> = {}) {
  const onIndex = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <TourSheet open index={0} onIndex={onIndex} onClose={onClose} pushState={push()} {...props} />,
  );
  return { ...view, onIndex, onClose };
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

describe("TourSheet — the three slides", () => {
  it("renders nothing while closed", () => {
    renderSheet({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a modal dialog named by the slide on screen", () => {
    renderSheet();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(en["tour.slide1.title"]);
  });

  it("shows the slides in order, one at a time", () => {
    const { rerender, onIndex, onClose } = renderSheet();
    expect(screen.getByText(en["tour.slide1.body"])).toBeInTheDocument();
    expect(screen.queryByText(en["tour.slide2.body"])).not.toBeInTheDocument();

    for (const [index, body] of [
      [1, en["tour.slide2.body"]],
      [2, en["tour.slide3.body"]],
    ] as const) {
      rerender(
        <TourSheet
          open
          index={index}
          onIndex={onIndex}
          onClose={onClose}
          pushState={push({ subscribed: true })}
        />,
      );
      expect(screen.getByText(body)).toBeInTheDocument();
    }
  });

  it("keeps Skip on every slide and swaps Next for Start on the last", () => {
    const { rerender, onIndex, onClose } = renderSheet();
    for (const index of [0, 1, 2]) {
      rerender(
        <TourSheet
          open
          index={index}
          onIndex={onIndex}
          onClose={onClose}
          pushState={push({ subscribed: true })}
        />,
      );
      expect(screen.getByRole("button", { name: en["tour.skip"] })).toBeInTheDocument();
      const primary = index === 2 ? en["tour.start"] : en["tour.next"];
      const absent = index === 2 ? en["tour.next"] : en["tour.start"];
      expect(screen.getByRole("button", { name: primary })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: absent })).not.toBeInTheDocument();
    }
  });

  it("closes with 'skip' on Skip and with 'start' on the last slide's Start", () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: en["tour.skip"] }));
    expect(onClose).toHaveBeenCalledWith("skip");

    const last = renderSheet({ index: 2, pushState: push({ subscribed: true }) });
    fireEvent.click(last.getAllByRole("button", { name: en["tour.start"] })[0]!);
    expect(last.onClose).toHaveBeenCalledWith("start");
  });

  it("closes with 'skip' on Escape", () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("skip");
  });

  it("moves on a dot tap, and marks the current dot as the step you are on", () => {
    const { onIndex } = renderSheet();
    const dots = screen.getAllByRole("button", { name: /^Slide \d$/ });
    const current = dots.find((d) => d.getAttribute("aria-current") === "step");
    expect(current).toHaveAttribute("aria-label", "Slide 1");
    fireEvent.click(screen.getByRole("button", { name: "Slide 3" }));
    expect(onIndex).toHaveBeenCalledWith(2);
  });

  it("moves on a horizontal swipe and ignores a mostly-vertical one", () => {
    const { onIndex } = renderSheet({ index: 1, pushState: push() });
    const body = screen.getByText(en["tour.slide2.body"]).parentElement!;

    fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 400 }] });
    fireEvent.touchEnd(body, { changedTouches: [{ clientX: 60, clientY: 410 }] });
    expect(onIndex).toHaveBeenCalledWith(2);

    onIndex.mockClear();
    // Down the screen: the primitive's own drag-to-dismiss owns this gesture, not the tour.
    fireEvent.touchStart(body, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchEnd(body, { changedTouches: [{ clientX: 190, clientY: 400 }] });
    expect(onIndex).not.toHaveBeenCalled();
  });
});

// A read-only device SEES the tour — that is the decision. Slide 2 keeps its first two sentences and
// swaps only the instruction it cannot honour.
describe("TourSheet — slide 2 on a device that cannot type", () => {
  it("tells a paired device to tap Type", () => {
    renderSheet({ index: 1 });
    expect(screen.getByText(en["tour.slide2.body"])).toBeInTheDocument();
  });

  it("tells an unpaired device who to ask instead", () => {
    renderSheet({ index: 1, readOnly: true });
    expect(screen.getByText(en["tour.slide2.bodyReadOnly"])).toBeInTheDocument();
    expect(screen.queryByText(en["tour.slide2.body"])).not.toBeInTheDocument();
  });
});

describe("TourSheet — slide 3's four push outcomes", () => {
  it("renders the button disabled and says nothing while the first read is in flight", () => {
    renderSheet({ index: 2, pushState: null });
    expect(screen.getByRole("button", { name: en["tour.push.enable"] })).toBeDisabled();
  });

  it("prints the availability sentence and offers no button when push cannot run here", () => {
    renderSheet({ index: 2, pushState: push({ availability: "server-off" }) });
    expect(screen.getByText(en["settings.push.availability.serverOff"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en["tour.push.enable"] })).not.toBeInTheDocument();
  });

  it("says the answer is already in when this device is subscribed", () => {
    renderSheet({ index: 2, pushState: push({ subscribed: true }) });
    expect(screen.getByText(en["tour.push.subscribed"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en["tour.push.enable"] })).not.toBeInTheDocument();
  });

  it("says so, and points at Settings, when the operator turned notifications off", () => {
    renderSheet({ index: 2, pushState: push({ userDisabled: true }) });
    expect(screen.getByText(en["tour.push.userDisabled"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en["tour.push.enable"] })).not.toBeInTheDocument();
  });

  it("offers the live button, and becomes a confirmation line once it succeeds", async () => {
    renderSheet({ index: 2, pushState: push() });
    const button = screen.getByRole("button", { name: en["tour.push.enable"] });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(en["tour.push.enabled"])).toBeInTheDocument());
  });
});

// The router behind this sheet is still fully focusable, so the tour is the first modal in this app
// that must TRAP. Asserted on every slide, and twice on slide 3, because the push button's disabled
// state changes which element the cycle has to land on.
describe("TourSheet — the focus trap", () => {
  it("cycles on slide 1", () => {
    renderSheet();
    expectTrapped();
  });

  it("cycles on slide 2", () => {
    renderSheet({ index: 1 });
    expectTrapped();
  });

  it("cycles on slide 3 with the push button disabled", () => {
    renderSheet({ index: 2, pushState: null });
    // The disabled button is excluded from the cycle, which is exactly why this case exists.
    expect(focusables()).not.toContain(
      screen.getByRole("button", { name: en["tour.push.enable"] }),
    );
    expectTrapped();
  });

  it("cycles on slide 3 with the push button enabled", () => {
    renderSheet({ index: 2, pushState: push() });
    expect(focusables()).toContain(screen.getByRole("button", { name: en["tour.push.enable"] }));
    expectTrapped();
  });
});
