import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { RELEASE_TRAVEL_PX, readsOlder, useReadingReleasesKeyboard } from "./use-reading-releases-keyboard";

function Harness() {
  const [reading, setReading] = useState<HTMLElement | null>(null);
  useReadingReleasesKeyboard(reading);
  return (
    <div>
      <div ref={setReading} data-testid="reading" />
      <textarea data-slot="chat-input" aria-label="reply" />
    </div>
  );
}

/** One finger at (x, y), as a touch event's `touches` list carries it. */
function finger(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] };
}

describe("readsOlder", () => {
  it("counts a drag down of the threshold or more", () => {
    expect(readsOlder({ x: 100, y: 300 }, { x: 102, y: 300 + RELEASE_TRAVEL_PX })).toBe(true);
  });

  it("ignores a few px, a drag up (towards newer text) and a sideways pan", () => {
    expect(readsOlder({ x: 100, y: 300 }, { x: 100, y: 310 })).toBe(false);
    expect(readsOlder({ x: 100, y: 300 }, { x: 100, y: 200 })).toBe(false);
    expect(readsOlder({ x: 100, y: 300 }, { x: 180, y: 340 })).toBe(false);
  });
});

describe("useReadingReleasesKeyboard", () => {
  it("blurs the focused reply field on a finger scroll up in the reading area", () => {
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "reply" });
    field.focus();
    const reading = screen.getByTestId("reading");
    fireEvent.touchStart(reading, finger(200, 300));
    fireEvent.touchMove(reading, finger(200, 312));
    expect(field).toHaveFocus();
    fireEvent.touchMove(reading, finger(201, 330));
    expect(field).not.toHaveFocus();
  });

  it("leaves the field alone on a scroll towards newer text, a short drag, or two fingers", () => {
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "reply" });
    field.focus();
    const reading = screen.getByTestId("reading");
    fireEvent.touchStart(reading, finger(200, 300));
    fireEvent.touchMove(reading, finger(200, 200));
    fireEvent.touchEnd(reading, { touches: [] });
    fireEvent.touchStart(reading, finger(200, 300));
    fireEvent.touchMove(reading, finger(200, 310));
    fireEvent.touchEnd(reading, { touches: [] });
    fireEvent.touchStart(reading, { touches: [{ clientX: 100, clientY: 300 }, { clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(reading, { touches: [{ clientX: 100, clientY: 360 }, { clientX: 200, clientY: 360 }] });
    expect(field).toHaveFocus();
  });

  it("does nothing for a scroll with no finger (a programmatic scroll or the keyboard's resize)", () => {
    render(<Harness />);
    const field = screen.getByRole("textbox", { name: "reply" });
    field.focus();
    fireEvent.scroll(screen.getByTestId("reading"), { target: { scrollTop: 0 } });
    expect(field).toHaveFocus();
  });
});
