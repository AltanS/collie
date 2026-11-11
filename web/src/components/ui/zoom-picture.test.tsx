import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImageSheet } from "./image-sheet";
import { PagerSheet } from "./pager-sheet";
import { ZoomPicture } from "./zoom-picture";

// jsdom lays nothing out, so the box is given a size and a place by hand: 300×200 at the corner.
function sizeBox(box: HTMLElement) {
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 300 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 200 });
  box.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 200 });
}

const box = () => document.querySelector<HTMLElement>("[data-slot='zoom-picture']")!;
const picture = () => box().querySelector("img")!;
const panel = () => document.querySelector<HTMLElement>("div[role='dialog'] > div[tabindex='-1']")!;
const at = (clientX: number, clientY: number, identifier = 0) => ({ clientX, clientY, identifier });

function tapAt(el: HTMLElement, x: number, y: number) {
  fireEvent.touchStart(el, { touches: [at(x, y)] });
  fireEvent.touchEnd(el, { touches: [] });
}

/** Two fingers 100px apart about (150, 100), spread to 200px: 2× about the middle. */
function pinchTo2x(el: HTMLElement) {
  fireEvent.touchStart(el, { touches: [at(100, 100, 0), at(200, 100, 1)] });
  const claimed = !fireEvent.touchMove(el, { touches: [at(50, 100, 0), at(250, 100, 1)], cancelable: true });
  fireEvent.touchEnd(el, { touches: [] });
  return claimed;
}

describe("ZoomPicture", () => {
  it("opens fitted, and leaves one-finger scrolls to the browser but never its zoom", () => {
    render(<ZoomPicture src="/a.png" alt="A shot" />);
    expect(screen.getByRole("img", { name: "A shot" })).toBe(picture());
    expect(picture().style.transform).toBe("");
    expect(box().className).toContain("[touch-action:pan-x_pan-y]");
    expect(box()).not.toHaveAttribute("data-zoomed");
  });

  it("pinches bigger about the fingers' midpoint and claims the move from the page", () => {
    render(<ZoomPicture src="/a.png" alt="A shot" />);
    sizeBox(box());
    expect(pinchTo2x(box())).toBe(true);
    // The middle of the picture stays under the fingers: offset = 150 × 2 − 150, 100 × 2 − 100.
    expect(picture().style.transform).toBe("translate(-150px, -100px) scale(2)");
    expect(box()).toHaveAttribute("data-zoomed", "true");
    expect(box().className).toContain("[touch-action:none]");
  });

  it("pans with one finger while zoomed, no further than the picture's edges", () => {
    render(<ZoomPicture src="/a.png" alt="A shot" />);
    sizeBox(box());
    pinchTo2x(box());
    fireEvent.touchStart(box(), { touches: [at(150, 100)] });
    expect(fireEvent.touchMove(box(), { touches: [at(190, 70)], cancelable: true })).toBe(false);
    expect(picture().style.transform).toBe("translate(-110px, -130px) scale(2)");
    // Far past the corner: held at the picture's edge, 300 × 2 − 300 and 200 × 2 − 200.
    fireEvent.touchMove(box(), { touches: [at(-900, -900)], cancelable: true });
    expect(picture().style.transform).toBe("translate(-300px, -200px) scale(2)");
    fireEvent.touchEnd(box(), { touches: [] });
  });

  it("does not claim a one-finger move at 1×, so the sheet scrolls and drags as before", () => {
    render(<ZoomPicture src="/a.png" alt="A shot" />);
    sizeBox(box());
    fireEvent.touchStart(box(), { touches: [at(150, 100)] });
    expect(fireEvent.touchMove(box(), { touches: [at(150, 180)], cancelable: true })).toBe(true);
    fireEvent.touchEnd(box(), { touches: [] });
    expect(picture().style.transform).toBe("");
  });

  it("toggles with a double tap: 2.5× about the tapped point, then back to fit, easing each way", () => {
    render(<ZoomPicture src="/a.png" alt="A shot" />);
    sizeBox(box());
    tapAt(box(), 100, 80);
    tapAt(box(), 100, 80);
    expect(picture().style.transform).toBe("translate(-150px, -120px) scale(2.5)");
    expect(picture().className).toContain("motion-reduce:transition-none");
    tapAt(box(), 100, 80);
    tapAt(box(), 100, 80);
    expect(picture().style.transform).toBe("");
    expect(box()).not.toHaveAttribute("data-zoomed");
  });

  it("zooms on a trackpad pinch and pans on the wheel only while zoomed", () => {
    render(<ZoomPicture src="/a.png" alt="A shot" />);
    sizeBox(box());
    // At 1× a plain wheel is the sheet's scroll.
    expect(fireEvent.wheel(box(), { deltaY: 40, cancelable: true })).toBe(true);
    expect(fireEvent.wheel(box(), { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0, cancelable: true })).toBe(false);
    expect(box()).toHaveAttribute("data-zoomed", "true");
    expect(fireEvent.wheel(box(), { deltaX: 10, deltaY: 20, cancelable: true })).toBe(false);
    expect(picture().style.transform).toMatch(/^translate\(-10px, -20px\) scale\(/);
  });
});

describe("ZoomPicture in a sheet", () => {
  function openImageSheet(onError?: () => void) {
    render(<ImageSheet src="/a.png" alt="A shot" title="Shot" onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "A shot" }));
    sizeBox(box());
  }

  it("takes no page zoom anywhere on the panel", () => {
    openImageSheet();
    expect(panel().className).toContain("[touch-action:pan-x_pan-y]");
  });

  it("at 1×, a pull down on the picture still closes the sheet", () => {
    openImageSheet();
    fireEvent.touchStart(box(), { touches: [at(150, 50)] });
    fireEvent.touchMove(box(), { touches: [at(150, 100)], cancelable: true });
    expect(panel().style.transform).toBe("translateY(50px)");
    fireEvent.touchMove(box(), { touches: [at(150, 200)], cancelable: true });
    fireEvent.touchEnd(box(), { touches: [] });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("zoomed, a pull down pans the picture and never drags or closes the sheet", () => {
    openImageSheet();
    pinchTo2x(box());
    fireEvent.touchStart(box(), { touches: [at(150, 20)] });
    fireEvent.touchMove(box(), { touches: [at(150, 120)], cancelable: true });
    fireEvent.touchMove(box(), { touches: [at(150, 220)], cancelable: true });
    expect(panel().style.transform).toBe("");
    fireEvent.touchEnd(box(), { touches: [] });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(picture().style.transform).toBe("translate(-150px, 0px) scale(2)");
  });

  it("a second finger lets go of a pull that had begun, and the sheet stays open", () => {
    openImageSheet();
    fireEvent.touchStart(box(), { touches: [at(150, 20, 0)] });
    fireEvent.touchMove(box(), { touches: [at(150, 60, 0)], cancelable: true });
    expect(panel().style.transform).toBe("translateY(40px)");
    fireEvent.touchStart(box(), { touches: [at(150, 60, 0), at(250, 60, 1)] });
    fireEvent.touchMove(box(), { touches: [at(150, 200, 0), at(290, 200, 1)], cancelable: true });
    expect(panel().style.transform).toBe("");
    fireEvent.touchEnd(box(), { touches: [] });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("ZoomPicture in the pager", () => {
  function Pager({ index, onIndex }: { index: number; onIndex: (i: number) => void }) {
    return (
      <PagerSheet
        open
        onClose={() => {}}
        title={`Shot ${index + 1}`}
        index={index}
        count={2}
        onIndex={onIndex}
        prevLabel="Previous"
        nextLabel="Next"
        position={`${index + 1} of 2`}
      >
        <ZoomPicture src={`/${index}.png`} alt={`Shot ${index + 1}`} />
      </PagerSheet>
    );
  }

  it("a sideways pan of a zoomed picture never pages, and the next page opens fitted", () => {
    const onIndex = vi.fn();
    const { rerender } = render(<Pager index={0} onIndex={onIndex} />);
    sizeBox(box());
    pinchTo2x(box());
    fireEvent.touchStart(box(), { touches: [at(250, 100)] });
    fireEvent.touchMove(box(), { touches: [at(20, 100)], cancelable: true });
    fireEvent.touchEnd(box(), { touches: [] });
    expect(onIndex).not.toHaveBeenCalled();
    expect(box()).toHaveAttribute("data-zoomed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onIndex).toHaveBeenCalledWith(1);
    rerender(<Pager index={1} onIndex={onIndex} />);
    expect(screen.getByRole("img", { name: "Shot 2" })).toBe(picture());
    expect(picture().style.transform).toBe("");
    expect(box()).not.toHaveAttribute("data-zoomed");
  });
});
