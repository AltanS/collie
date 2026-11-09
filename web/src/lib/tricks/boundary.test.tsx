import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrickBoundary } from "./boundary";

// THE BOUNDARY AROUND ONE PART (M94 review): a part that throws draws the placeholder for a view and
// nothing for a mark or a status item, and the parts beside it stay drawn.

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("this part is broken");
  return <span data-testid="part">drawn</span>;
}

beforeEach(() => {
  // React logs a caught render error, and the boundary warns once: both are expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("TrickBoundary", () => {
  it("draws the placeholder for a view that throws, and the sibling stays drawn", () => {
    const { container } = render(
      <div>
        <TrickBoundary fallback="placeholder" resetKey="b/a/one@1">
          <Bomb explode />
        </TrickBoundary>
        <TrickBoundary fallback="placeholder" resetKey="b/a/two@1">
          <Bomb explode={false} />
        </TrickBoundary>
      </div>,
    );
    expect(container.querySelector('[data-trick-node="placeholder"]')?.textContent).toBe("This Collie cannot draw this part");
    expect(container.querySelectorAll('[data-testid="part"]')).toHaveLength(1);
  });

  it("draws nothing for a mark or a status item that throws", () => {
    const { container } = render(
      <div>
        <TrickBoundary fallback="none" resetKey="b/a/one@1">
          <Bomb explode />
        </TrickBoundary>
        <TrickBoundary fallback="none" resetKey="b/a/two@1">
          <Bomb explode={false} />
        </TrickBoundary>
      </div>,
    );
    expect(container.querySelector('[data-trick-node="placeholder"]')).toBeNull();
    expect(container.textContent).toBe("drawn");
  });

  it("tries the part again when its rev changes, and keeps the failure while it does not", () => {
    const view = (key: string, explode: boolean) => (
      <TrickBoundary fallback="placeholder" resetKey={key}>
        <Bomb explode={explode} />
      </TrickBoundary>
    );
    const { container, rerender } = render(view("b/a/one@1", true));
    expect(container.querySelector('[data-trick-node="placeholder"]')).not.toBeNull();
    // The same rev with healthy children is still the failure: the part did not change.
    rerender(view("b/a/one@1", false));
    expect(container.querySelector('[data-trick-node="placeholder"]')).not.toBeNull();
    rerender(view("b/a/one@2", false));
    expect(container.querySelector('[data-trick-node="placeholder"]')).toBeNull();
    expect(container.textContent).toBe("drawn");
  });
});
