import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { HoldToApprove } from "@/components/hold-to-approve";
import { APPROVE_HOLD_MS, ARM_DWELL_MS, HOLD_BACK_MS } from "@/lib/arm";
import { aHoldIsActive } from "@/lib/hold-flag";

// THE YES TO A TRICK'S CODE IS A HOLD OF 1.5 SECONDS (ADR 0156). The control every trick card uses: the hold
// approves once with the finger still down, every way a hold can end early approves nothing, and a key keeps
// the belt Stop's two presses. A scroll, a layout shift and the window's focus do not end a hold (fix/hold-works):
// in a live chat they come from the page, not the person.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const button = () => screen.getByRole("button", { name: /hold to switch on|keep holding|press again to confirm/i });

function draw(over: { enabled?: boolean; resetKey?: string } = {}) {
  const onApprove = vi.fn();
  const view = render(<HoldToApprove label="Hold to switch on" enabled={over.enabled ?? true} resetKey={over.resetKey ?? "a"} onApprove={onApprove} data-slot="yes" />);
  const redraw = (next: { enabled?: boolean; resetKey?: string }) =>
    view.rerender(<HoldToApprove label="Hold to switch on" enabled={next.enabled ?? true} resetKey={next.resetKey ?? "a"} onApprove={onApprove} data-slot="yes" />);
  return { onApprove, redraw, view };
}

const down = (id = 1, x = 10, y = 10) => fireEvent.pointerDown(button(), { button: 0, pointerId: id, clientX: x, clientY: y, pointerType: "touch" });
const up = (id = 1) => {
  fireEvent.pointerUp(button(), { button: 0, pointerId: id, clientX: 10, clientY: 10, pointerType: "touch" });
  fireEvent.click(button(), { detail: 1 });
};
const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("hold to approve", () => {
  it("just short of the hold, a lift approves nothing, and the fill runs back", async () => {
    const { onApprove } = draw();
    down();
    await wait(APPROVE_HOLD_MS - 100);
    expect(document.querySelector("[data-slot='hold-fill']:not([data-back])")).not.toBeNull();
    expect(button().textContent).toContain("Keep holding…");
    up();
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.querySelector("[data-slot='hold-fill'][data-back]")).not.toBeNull();
    await wait(HOLD_BACK_MS);
    expect(document.querySelector("[data-slot='hold-fill']")).toBeNull();
    await wait(5000);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("3.0 seconds approves exactly once, with the finger still down; the lift and its click add nothing", async () => {
    const { onApprove } = draw();
    down();
    await wait(APPROVE_HOLD_MS - 1);
    expect(onApprove).not.toHaveBeenCalled();
    await wait(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
    await wait(5000);
    up();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("after a cancel the next hold starts from zero", async () => {
    const { onApprove } = draw();
    down();
    await wait(APPROVE_HOLD_MS - 500);
    up();
    down();
    await wait(APPROVE_HOLD_MS - 500);
    expect(onApprove).not.toHaveBeenCalled();
    await wait(500);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  const cancels: [string, () => void][] = [
    ["the pointer leaves the button", () => fireEvent.pointerLeave(button(), { pointerId: 1, pointerType: "touch" })],
    ["pointercancel", () => fireEvent.pointerCancel(button(), { pointerId: 1, pointerType: "touch" })],
    ["a move past a thumb's jitter", () => fireEvent.pointerMove(button(), { pointerId: 1, clientX: 10, clientY: 40, pointerType: "touch" })],
    [
      "the page is hidden",
      () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        fireEvent(document, new Event("visibilitychange"));
      },
    ],
  ];
  for (const [what, act_] of cancels) {
    it(`${what} cancels the hold, and a finger kept down approves nothing`, async () => {
      const { onApprove } = draw();
      down();
      await wait(APPROVE_HOLD_MS / 2);
      act_();
      await wait(5000);
      expect(onApprove).not.toHaveBeenCalled();
      // The finger still lifts later: nothing.
      up();
      expect(onApprove).not.toHaveBeenCalled();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    });
  }

  it("a scroll, the window losing focus and the button moving under the finger do not end a hold", async () => {
    const { onApprove } = draw();
    const el = button();
    let top = 100;
    el.getBoundingClientRect = () => ({ top, left: 0, right: 200, bottom: top + 44, width: 200, height: 44, x: 0, y: top, toJSON: () => ({}) });
    down();
    await wait(300);
    fireEvent.scroll(document.body);
    fireEvent.scroll(window);
    await wait(300);
    fireEvent.blur(window);
    top = 160;
    await wait(300);
    expect(button().getAttribute("data-phase")).toBe("filling");
    await wait(APPROVE_HOLD_MS - 900);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("a swipe that starts on the button still pans the chat: touch-action pan-y, never none", () => {
    draw();
    expect(button().className).toContain("touch-pan-y");
    expect(button().className).not.toContain("touch-none");
  });

  it("a hold ended by the page hiding, whose lift never arrives, leaves the button ready for the next press", async () => {
    const { onApprove } = draw();
    down(1);
    await wait(APPROVE_HOLD_MS / 2);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    // No pointerup for finger 1 ever comes. A new press, with another pointer id, holds and approves.
    down(7);
    await wait(APPROVE_HOLD_MS);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("a finished hold whose lift is lost leaves the button ready too", async () => {
    const { onApprove } = draw();
    down(1);
    await wait(APPROVE_HOLD_MS);
    expect(onApprove).toHaveBeenCalledTimes(1);
    down(2);
    await wait(APPROVE_HOLD_MS);
    expect(onApprove).toHaveBeenCalledTimes(2);
  });

  it("the page-wide hold flag is up while a finger holds and down after every end", async () => {
    const { view } = draw();
    expect(aHoldIsActive()).toBe(false);
    down();
    expect(aHoldIsActive()).toBe(true);
    up();
    expect(aHoldIsActive()).toBe(false);
    down();
    await wait(APPROVE_HOLD_MS);
    expect(aHoldIsActive()).toBe(false);
    fireEvent.pointerUp(button(), { button: 0, pointerId: 1, pointerType: "touch" });
    down(3);
    fireEvent.pointerMove(button(), { pointerId: 3, clientX: 10, clientY: 60, pointerType: "touch" });
    expect(aHoldIsActive()).toBe(false);
    down(4);
    view.unmount();
    expect(aHoldIsActive()).toBe(false);
  });

  it("a changed digest cancels the hold", async () => {
    const { onApprove, redraw } = draw();
    down();
    await wait(APPROVE_HOLD_MS / 2);
    redraw({ resetKey: "b" });
    await wait(5000);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("the card leaving cancels the hold", async () => {
    const { onApprove, view } = draw();
    down();
    await wait(APPROVE_HOLD_MS / 2);
    view.unmount();
    await wait(5000);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("a second finger does nothing: it neither restarts nor ends the first finger's hold", async () => {
    const { onApprove } = draw();
    down(1);
    await wait(APPROVE_HOLD_MS / 2);
    down(2);
    fireEvent.pointerUp(button(), { button: 0, pointerId: 2, pointerType: "touch" });
    await wait(APPROVE_HOLD_MS / 2);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("no second answer while one is in flight: the button takes no hold", async () => {
    function Flight() {
      const [sending, setSending] = useState(false);
      return <HoldToApprove label="Hold to switch on" enabled={!sending} busy={sending} resetKey="a" onApprove={() => setSending(true)} data-slot="yes" />;
    }
    render(<Flight />);
    const yes = () => document.querySelector<HTMLButtonElement>("[data-slot='yes']")!;
    fireEvent.pointerDown(yes(), { button: 0, pointerId: 1, pointerType: "touch" });
    await wait(APPROVE_HOLD_MS);
    expect(yes().disabled).toBe(true);
    expect(yes().getAttribute("aria-busy")).toBe("true");
    fireEvent.pointerDown(yes(), { button: 0, pointerId: 3, pointerType: "touch" });
    await wait(APPROVE_HOLD_MS);
    fireEvent.click(yes(), { detail: 0 });
    fireEvent.click(yes(), { detail: 0 });
    expect(yes().disabled).toBe(true);
  });

  it("a disabled button takes no hold, and a press begun before it was enabled is no hold", async () => {
    const { onApprove, redraw } = draw({ enabled: false });
    down();
    redraw({ enabled: true });
    await wait(5000);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("a key arms on the first press and approves on a second one inside the window, past the dwell", async () => {
    const { onApprove } = draw();
    fireEvent.click(button(), { detail: 0 });
    expect(onApprove).not.toHaveBeenCalled();
    expect(button().textContent).toContain("Press again to confirm");
    expect(button().getAttribute("data-phase")).toBe("armed");
    // Inside the dwell: the same press landing twice.
    fireEvent.click(button(), { detail: 0 });
    expect(onApprove).not.toHaveBeenCalled();
    await wait(ARM_DWELL_MS);
    fireEvent.click(button(), { detail: 0 });
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("a key's arm lapses, and a changed digest drops it", async () => {
    const { onApprove, redraw } = draw();
    fireEvent.click(button(), { detail: 0 });
    await wait(10_000);
    fireEvent.click(button(), { detail: 0 });
    expect(onApprove).not.toHaveBeenCalled();
    redraw({ resetKey: "b" });
    await wait(ARM_DWELL_MS);
    fireEvent.click(button(), { detail: 0 });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("a click made by a pointer never arms or approves: the hold judged that press", async () => {
    const { onApprove } = draw();
    down();
    up();
    await wait(ARM_DWELL_MS);
    down();
    up();
    expect(onApprove).not.toHaveBeenCalled();
    expect(button().getAttribute("data-phase")).toBe("rest");
  });

  it("a long-press menu is kept away and is no shortcut to the yes", async () => {
    const { onApprove } = draw();
    down();
    await wait(500);
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(button(), menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("the hold is 1.5 seconds, and the fill shows from the first moment of the press", async () => {
    expect(APPROVE_HOLD_MS).toBe(1500);
    const { onApprove } = draw();
    down();
    // No feedback delay: the fill is there at the press, and runs over the whole hold.
    const fill = document.querySelector<HTMLElement>("[data-slot='hold-fill']:not([data-back])");
    expect(fill).not.toBeNull();
    expect(fill?.style.animationDuration).toBe("1500ms");
    expect(button().textContent).toContain("Keep holding…");
    await wait(1499);
    expect(onApprove).not.toHaveBeenCalled();
    await wait(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("a chosen option keeps its look with a check mark and takes no press", async () => {
    const onApprove = vi.fn();
    render(<HoldToApprove label="Hold to switch on" enabled={false} chosen resetKey="a" onApprove={onApprove} data-slot="yes" />);
    const yes = document.querySelector<HTMLButtonElement>("[data-slot='yes']")!;
    expect(yes.querySelector("[data-slot='option-chosen-mark']")).not.toBeNull();
    expect(yes).toBeDisabled();
    expect(yes.className).toContain("border-primary");
    fireEvent.pointerDown(yes, { button: 0, pointerId: 1, pointerType: "touch" });
    await wait(APPROVE_HOLD_MS);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("names what a hold does: the words at rest, and a description of the hold", () => {
    draw();
    const yes = screen.getByRole("button", { name: "Hold to switch on" });
    expect(yes).toHaveAccessibleDescription("Hold to confirm. With a keyboard, press it twice.");
  });
});
