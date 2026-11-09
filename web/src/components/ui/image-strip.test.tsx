import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IMAGE_STRIP_HEIGHT, ImageStrip, ImageStripItem, stripItemWidth } from "./image-strip";

// The sideways row of pictures (M96): one height, each item as wide as its picture's shape, the box
// reserved while a picture loads or after it failed, the house fade, and a tap that opens the sheet.

const SRC = "data:image/png;base64,AAAA";

describe("an item's width", () => {
  it("follows the picture's shape at the strip's height", () => {
    expect(stripItemWidth(600, 360)).toBe(Math.round((IMAGE_STRIP_HEIGHT * 600) / 360));
  });

  it("is square when the shape is unknown", () => {
    expect(stripItemWidth(null, 360)).toBe(IMAGE_STRIP_HEIGHT);
    expect(stripItemWidth(600, null)).toBe(IMAGE_STRIP_HEIGHT);
    expect(stripItemWidth(0, 0)).toBe(IMAGE_STRIP_HEIGHT);
  });

  it("keeps a sliver and a panorama to a picture's width", () => {
    expect(stripItemWidth(10, 1000)).toBe(64);
    expect(stripItemWidth(4000, 100)).toBe(280);
  });
});

describe("the image strip", () => {
  it("names the row and scrolls it inside the house fade, with no chevron", () => {
    const { container } = render(
      <ImageStrip label="Images">
        <ImageStripItem width={600} height={360} src={SRC} alt="Before" />
      </ImageStrip>,
    );
    const strip = container.querySelector('[data-slot="image-strip"]')!;
    expect(strip).toHaveAttribute("role", "group");
    expect(strip).toHaveAttribute("aria-label", "Images");
    expect(strip.querySelector("[data-overflow]")).not.toBeNull();
    expect(strip.querySelector("[data-icon^='scroll-hint']")).toBeNull();
    expect(strip.querySelector(".overflow-x-auto")).not.toBeNull();
  });

  it("reserves an item's box before its picture arrives, and keeps it for the fallback", () => {
    const loading = render(<ImageStripItem width={600} height={360} src={null} alt="Before" />);
    const box = loading.container.querySelector<HTMLElement>('[data-slot="image-strip-item"]')!;
    expect(box.style.width).toBe(`${stripItemWidth(600, 360)}px`);
    expect(box.querySelector("img")).toBeNull();
    loading.unmount();
    const failed = render(<ImageStripItem width={600} height={360} src={null} alt="Before" fallback={<span>gone</span>} />);
    const failedBox = failed.container.querySelector<HTMLElement>('[data-slot="image-strip-item"]')!;
    expect(failedBox.style.width).toBe(`${stripItemWidth(600, 360)}px`);
    expect(failedBox).toHaveTextContent("gone");
  });

  it("draws the caption under the picture, and none without one", () => {
    const withCaption = render(<ImageStripItem width={1} height={1} src={SRC} alt="a" caption="After" />);
    expect(withCaption.container.querySelector("figcaption")).toHaveTextContent("After");
    withCaption.unmount();
    expect(render(<ImageStripItem width={1} height={1} src={SRC} alt="a" />).container.querySelector("figcaption")).toBeNull();
  });

  it("opens a picture at full size in the picture sheet on a tap", () => {
    const { container } = render(<ImageStripItem width={600} height={360} src={SRC} alt="The card after" />);
    fireEvent.click(container.querySelector("button")!);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("The card after");
    expect(dialog.querySelector("img")).toHaveAttribute("src", SRC);
  });
});
