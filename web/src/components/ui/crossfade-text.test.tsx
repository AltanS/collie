import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { CROSSFADE_MS, CROSSFADE_QUIET_MS, CrossfadeText } from "./crossfade-text";

// The name fade (2026-11-19): a text that changes under an unchanged identity fades from the old words
// to the new, and every other change swaps at once. jsdom has no layout and no animation clock, so
// these read the state the primitive heads for: which copies are drawn, which is hidden from a screen
// reader, and when the old one is dropped.

/** jsdom reports `prefers-reduced-motion` as "no preference"; this makes it say the opposite. */
function preferReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const state = (container: HTMLElement) => container.querySelector('[data-slot="crossfade-text"]')!.getAttribute("data-state");
/** Let the text hold still for the quiet time, so the next change may fade. */
const settle = () => act(() => void vi.advanceTimersByTime(CROSSFADE_QUIET_MS));
const outgoing = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="crossfade-out"]');
const incoming = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="crossfade-in"]')!;

describe("CrossfadeText", () => {
  it("draws the first text at once, with no old copy and no animation", () => {
    const { container } = render(<CrossfadeText text="plumbing" identity="p1" />);
    expect(state(container)).toBe("still");
    expect(outgoing(container)).toBeNull();
    expect(incoming(container).textContent).toBe("plumbing");
    expect(incoming(container).className).not.toContain("crossfade-in");
  });

  it("crossfades a new text under the same identity: the old copy out, the new copy in", () => {
    const { container, rerender } = render(<CrossfadeText text="plumbing" identity="p1" />);
    settle();
    rerender(<CrossfadeText text="wiring" identity="p1" />);
    expect(state(container)).toBe("fading");
    expect(outgoing(container)?.textContent).toBe("plumbing");
    expect(outgoing(container)?.className).toContain("crossfade-out");
    expect(incoming(container).textContent).toBe("wiring");
    expect(incoming(container).className).toContain("crossfade-in");
  });

  it("drops the old copy after the fade", () => {
    const { container, rerender } = render(<CrossfadeText text="plumbing" identity="p1" />);
    settle();
    rerender(<CrossfadeText text="wiring" identity="p1" />);
    act(() => void vi.advanceTimersByTime(CROSSFADE_MS - 1));
    expect(outgoing(container)).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(state(container)).toBe("still");
    expect(outgoing(container)).toBeNull();
    expect(incoming(container).textContent).toBe("wiring");
  });

  it("swaps at once when the text changes inside the quiet time, and drops a running fade", () => {
    const { container, rerender } = render(<CrossfadeText text="a" identity="p1" />);
    // Inside the quiet time of the mount: no fade.
    act(() => void vi.advanceTimersByTime(CROSSFADE_QUIET_MS - 1));
    rerender(<CrossfadeText text="b" identity="p1" />);
    expect(state(container)).toBe("still");
    expect(outgoing(container)).toBeNull();
    expect(incoming(container).textContent).toBe("b");
    // The change above restarted the quiet time, so this one is inside it as well.
    act(() => void vi.advanceTimersByTime(CROSSFADE_QUIET_MS - 1));
    rerender(<CrossfadeText text="c" identity="p1" />);
    expect(state(container)).toBe("still");
    expect(incoming(container).textContent).toBe("c");
  });

  it("drops a fade that is running when the next change comes inside the quiet time", () => {
    const { container, rerender } = render(<CrossfadeText text="a" identity="p1" />);
    settle();
    rerender(<CrossfadeText text="b" identity="p1" />);
    expect(state(container)).toBe("fading");
    act(() => void vi.advanceTimersByTime(100));
    rerender(<CrossfadeText text="c" identity="p1" />);
    expect(state(container)).toBe("still");
    expect(outgoing(container)).toBeNull();
    expect(incoming(container).textContent).toBe("c");
  });

  it("fades again once the text has held still for the quiet time", () => {
    const { container, rerender } = render(<CrossfadeText text="a" identity="p1" />);
    rerender(<CrossfadeText text="b" identity="p1" />);
    expect(state(container)).toBe("still");
    settle();
    rerender(<CrossfadeText text="c" identity="p1" />);
    expect(state(container)).toBe("fading");
    expect(outgoing(container)?.textContent).toBe("b");
    expect(incoming(container).textContent).toBe("c");
  });

  it("starts the quiet time again at an identity switch", () => {
    const { container, rerender } = render(<CrossfadeText text="a" identity="p1" />);
    settle();
    rerender(<CrossfadeText text="b" identity="p2" />);
    rerender(<CrossfadeText text="c" identity="p2" />);
    expect(state(container)).toBe("still");
  });

  it("swaps at once when the identity changes: another item took this place", () => {
    const { container, rerender } = render(<CrossfadeText text="plumbing" identity="p1" />);
    rerender(<CrossfadeText text="wiring" identity="p2" />);
    expect(state(container)).toBe("still");
    expect(outgoing(container)).toBeNull();
    expect(incoming(container).textContent).toBe("wiring");
    expect(incoming(container).className).not.toContain("crossfade-in");
  });

  it("swaps at once under prefers-reduced-motion", () => {
    preferReducedMotion(true);
    const { container, rerender } = render(<CrossfadeText text="plumbing" identity="p1" />);
    settle();
    rerender(<CrossfadeText text="wiring" identity="p1" />);
    expect(state(container)).toBe("still");
    expect(outgoing(container)).toBeNull();
    expect(incoming(container).textContent).toBe("wiring");
  });

  it("draws nothing twice for a screen reader: the old copy is aria-hidden and the name is the new text", () => {
    const { container, rerender } = render(
      <button type="button">
        <CrossfadeText text="plumbing" identity="p1" />
      </button>,
    );
    settle();
    rerender(
      <button type="button">
        <CrossfadeText text="wiring" identity="p1" />
      </button>,
    );
    expect(outgoing(container)?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "wiring" })).toBeTruthy();
  });

  it("keeps the caller's truncation working: both copies are inline spans, the old one on one line, out of flow", () => {
    const { container, rerender } = render(
      <p className="truncate" data-testid="host">
        <CrossfadeText text="a long name that gets cut" identity="p1" />
      </p>,
    );
    settle();
    rerender(
      <p className="truncate" data-testid="host">
        <CrossfadeText text="another long name that gets cut" identity="p1" />
      </p>,
    );
    const host = screen.getByTestId("host");
    expect(host.className).toContain("truncate");
    const old = outgoing(container)!;
    expect(old.tagName).toBe("SPAN");
    expect(old.className).toContain("absolute");
    expect(old.className).toContain("whitespace-nowrap");
    expect(incoming(container).tagName).toBe("SPAN");
    // Every element between the host and its words is an inline span, so the host's ellipsis still clips them.
    for (let el: Element | null = incoming(container); el !== null && el !== host; el = el.parentElement) {
      expect(el.tagName).toBe("SPAN");
      expect(el.className).not.toMatch(/\b(inline-block|block|flex|grid)\b/u);
    }
  });
});
