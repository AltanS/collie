import { fireEvent, render } from "@testing-library/react";

import { useScrollMemory } from "./use-scroll-memory";

// The hook needs a real DOM ref (attached to a scrolling element), so — same reasoning as
// use-auto-scroll.test.tsx — we mount a tiny harness and drive it with real DOM events rather than
// renderHook. jsdom's scrollTop is a plain settable/readable number (no layout), so a direct
// assignment plus a dispatched "scroll" event is enough to exercise the listener.
function Harness({ scrollKey }: { scrollKey: string }) {
  const ref = useScrollMemory<HTMLDivElement>(scrollKey);
  return (
    <div ref={ref} data-testid="scroll">
      content
    </div>
  );
}

describe("useScrollMemory", () => {
  it("restores a remembered position for the same key on remount", () => {
    const { getByTestId, unmount } = render(<Harness scrollKey="a" />);
    const el = getByTestId("scroll");
    expect(el.scrollTop).toBe(0);

    el.scrollTop = 120;
    fireEvent.scroll(el);
    unmount();

    const { getByTestId: getByTestId2 } = render(<Harness scrollKey="a" />);
    const el2 = getByTestId2("scroll");
    expect(el2.scrollTop).toBe(120);
  });

  it("starts a different key at 0, independently of another key's remembered position", () => {
    const { getByTestId, unmount } = render(<Harness scrollKey="b" />);
    const el = getByTestId("scroll");
    el.scrollTop = 250;
    fireEvent.scroll(el);
    unmount();

    const { getByTestId: getByTestId2 } = render(<Harness scrollKey="different-key" />);
    const el2 = getByTestId2("scroll");
    expect(el2.scrollTop).toBe(0);
  });

  it("writes the final scroll position on unmount, even with no later scroll event", () => {
    const { getByTestId, unmount } = render(<Harness scrollKey="c" />);
    const el = getByTestId("scroll");
    // No fireEvent.scroll here — only a direct write, then unmount races the next event.
    el.scrollTop = 60;
    unmount();

    const { getByTestId: getByTestId2 } = render(<Harness scrollKey="c" />);
    expect(getByTestId2("scroll").scrollTop).toBe(60);
  });
});
