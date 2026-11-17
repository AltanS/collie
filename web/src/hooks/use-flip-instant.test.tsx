import { render } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";

import { useFlip } from "./use-flip";

// M104: a box that let go of a sent text takes its closed shape in the frame of the tap. `instant` plays nothing for
// the next change of key, and the hook sets it back, so every other open and close still plays.

function Box({ boxState, instant }: { boxState: string; instant: MutableRefObject<boolean> }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, boxState, { enabled: true, grows: true, instant });
  return (
    <div ref={ref}>
      <button type="button">a</button>
      {boxState === "open" && <button type="button">b</button>}
    </div>
  );
}

describe("useFlip — instant (M104)", () => {
  const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  beforeEach(() => {
    animate.mockClear();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    // SAFETY: the property was defined above for these cases only; jsdom has none of its own.
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("plays the entrance of a new button on an ordinary change of the box", () => {
    const instant = { current: false };
    const { rerender } = render(<Box boxState="rest" instant={instant} />);
    rerender(<Box boxState="open" instant={instant} />);
    expect(animate).toHaveBeenCalled();
  });

  it("plays nothing for the change it was asked to land at once, and is set back after it", () => {
    const instant = { current: false };
    const { rerender } = render(<Box boxState="rest" instant={instant} />);
    instant.current = true;
    rerender(<Box boxState="open" instant={instant} />);
    expect(animate).not.toHaveBeenCalled();
    expect(instant.current).toBe(false);
    rerender(<Box boxState="rest" instant={instant} />);
    rerender(<Box boxState="open" instant={instant} />);
    expect(animate).toHaveBeenCalled();
  });
});
