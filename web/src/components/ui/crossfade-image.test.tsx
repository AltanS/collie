import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { CrossfadeImage } from "./crossfade-image";
import { CROSSFADE_MS, CROSSFADE_QUIET_MS } from "./crossfade-text";

// The picture fade (issue 811, ADR 0160): `CrossfadeText`'s rules for a fixed box that shows a picture or
// a fallback. jsdom has no animation clock, so these read the layers the primitive draws.

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

const A = "data:image/png;base64,AAAA";
const B = "data:image/png;base64,BBBB";
const fallback = <span>logo</span>;
const box = (c: HTMLElement) => c.querySelector('[data-slot="crossfade-image"]')!;
const out = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="crossfade-out"]');
const into = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="crossfade-in"]')!;
const settle = () => act(() => void vi.advanceTimersByTime(CROSSFADE_QUIET_MS));

describe("CrossfadeImage", () => {
  it("draws the fallback with no picture, and the picture once there is one, at once on the first draw", () => {
    const { container } = render(<CrossfadeImage src={null} identity="p1" fallback={fallback} className="size-4" />);
    expect(box(container).getAttribute("data-picture")).toBe("off");
    expect(into(container).textContent).toBe("logo");
    const second = render(<CrossfadeImage src={A} identity="p2" fallback={fallback} className="size-4" />);
    expect(box(second.container).getAttribute("data-state")).toBe("still");
    expect(into(second.container).querySelector("img")?.getAttribute("src")).toBe(A);
    // Decorative: the caller names the box.
    expect(into(second.container).querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("fades from the logo to a picture under one identity, then drops the old layer", () => {
    const { container, rerender } = render(<CrossfadeImage src={null} identity="p1" fallback={fallback} />);
    settle();
    rerender(<CrossfadeImage src={A} identity="p1" fallback={fallback} />);
    expect(box(container).getAttribute("data-state")).toBe("fading");
    expect(out(container)?.textContent).toBe("logo");
    expect(out(container)?.getAttribute("aria-hidden")).toBe("true");
    expect(into(container).className).toContain("crossfade-in");
    act(() => void vi.advanceTimersByTime(CROSSFADE_MS));
    expect(out(container)).toBeNull();
    expect(box(container).getAttribute("data-state")).toBe("still");
  });

  it("fades between two pictures", () => {
    const { container, rerender } = render(<CrossfadeImage src={A} identity="p1" fallback={fallback} />);
    settle();
    rerender(<CrossfadeImage src={B} identity="p1" fallback={fallback} />);
    expect(out(container)?.querySelector("img")?.getAttribute("src")).toBe(A);
    expect(into(container).querySelector("img")?.getAttribute("src")).toBe(B);
  });

  it("swaps at once for a new identity: another pane in this place", () => {
    const { container, rerender } = render(<CrossfadeImage src={A} identity="p1" fallback={fallback} />);
    settle();
    rerender(<CrossfadeImage src={B} identity="p2" fallback={fallback} />);
    expect(out(container)).toBeNull();
    expect(box(container).getAttribute("data-state")).toBe("still");
  });

  it("swaps at once when the picture changed again inside the quiet time", () => {
    const { container, rerender } = render(<CrossfadeImage src={A} identity="p1" fallback={fallback} />);
    rerender(<CrossfadeImage src={B} identity="p1" fallback={fallback} />);
    expect(out(container)).toBeNull();
  });

  it("swaps at once under reduced motion", () => {
    preferReducedMotion(true);
    const { container, rerender } = render(<CrossfadeImage src={A} identity="p1" fallback={fallback} />);
    settle();
    rerender(<CrossfadeImage src={B} identity="p1" fallback={fallback} />);
    expect(out(container)).toBeNull();
    expect(into(container).className).not.toContain("crossfade-in");
  });
});
