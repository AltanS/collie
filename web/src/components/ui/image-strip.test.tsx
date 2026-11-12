import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CAPTION_MIN_WIDTH,
  IMAGE_STRIP_HEIGHT,
  IMAGE_STRIP_TALL,
  IMAGE_STRIP_TALL_VH,
  ImageStrip,
  ImageStripItem,
  isPortrait,
  stripHeightCss,
  stripItemCss,
  stripItemWidth,
  stripSize,
} from "./image-strip";

// The sideways row of pictures (M96): one height, each item as wide as its picture's shape, the box
// reserved while a picture loads or after it failed, the house fade, and a tap that opens the sheet.

const SRC = "data:image/png;base64,AAAA";

describe("an item's width", () => {
  it("follows the picture's picture at the strip's height", () => {
    expect(stripItemWidth(600, 360)).toBe(Math.round((IMAGE_STRIP_HEIGHT * 600) / 360));
  });

  it("is square when the picture is unknown", () => {
    expect(stripItemWidth(null, 360)).toBe(IMAGE_STRIP_HEIGHT);
    expect(stripItemWidth(600, null)).toBe(IMAGE_STRIP_HEIGHT);
    expect(stripItemWidth(0, 0)).toBe(IMAGE_STRIP_HEIGHT);
  });

  it("keeps a sliver and a panorama to a picture's width", () => {
    expect(stripItemWidth(10, 1000)).toBe(64);
    expect(stripItemWidth(4000, 100)).toBe(280);
  });
});

describe("the strip's one height, chosen from the pictures (2026-11-10)", () => {
  const phone = { width: 390, height: 844 };
  const wide = { width: 600, height: 360 };
  const square = { width: 500, height: 500 };
  const unknown = { width: null, height: null };

  it("calls a picture portrait only when it is taller than wide and its picture is known", () => {
    expect(isPortrait(phone)).toBe(true);
    expect(isPortrait(square)).toBe(false);
    expect(isPortrait(wide)).toBe(false);
    expect(isPortrait(unknown)).toBe(false);
  });

  it("keeps the short height when any picture is landscape, square or unknown", () => {
    expect(stripSize([wide, wide])).toBe("short");
    expect(stripSize([phone, wide])).toBe("short");
    expect(stripSize([phone, square])).toBe("short");
    expect(stripSize([phone, unknown])).toBe("short");
  });

  it("is tall when every picture is portrait, and for a single picture of any picture", () => {
    expect(stripSize([phone, phone])).toBe("tall");
    expect(stripSize([phone])).toBe("tall");
    expect(stripSize([wide])).toBe("tall");
    expect(stripSize([unknown])).toBe("tall");
  });

  it("holds the tall height under its share of the screen", () => {
    expect(stripHeightCss("short")).toBe(`${IMAGE_STRIP_HEIGHT}px`);
    expect(stripHeightCss("tall")).toBe(`min(${IMAGE_STRIP_TALL}px, ${IMAGE_STRIP_TALL_VH}dvh)`);
  });

  it("sizes an item of a tall row from its picture at the tall height, clamped, and reserves the box height", () => {
    const css = stripItemCss({ picture: phone, size: "tall", single: false, caption: false });
    expect(css.boxHeight).toBe(stripHeightCss("tall"));
    expect(css.itemWidth).toBe(`clamp(64px, calc(${stripHeightCss("tall")} * 390 / 844), 280px)`);
  });

  it("lets a single picture use the row's width up to the tall height, its height from its ratio", () => {
    const css = stripItemCss({ picture: wide, size: "tall", single: true, caption: false });
    expect(css.itemWidth).toBe(`min(calc(${stripHeightCss("tall")} * 600 / 360), 100%)`);
    expect(css.boxHeight).toBeNull();
    expect(css.ratio).toBe("600 / 360");
  });

  it("keeps an item with a caption at least the caption's width", () => {
    const css = stripItemCss({ picture: phone, size: "short", single: false, caption: true });
    expect(css.itemWidth).toBe(`max(${stripItemWidth(390, 844)}px, ${CAPTION_MIN_WIDTH}px)`);
    expect(stripItemCss({ picture: phone, size: "short", single: false, caption: false }).itemWidth).toBe(`${stripItemWidth(390, 844)}px`);
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
    expect(box.style.getPropertyValue("--strip-item-w")).toBe(`${stripItemWidth(600, 360)}px`);
    expect(box.style.getPropertyValue("--strip-box-h")).toBe(`${IMAGE_STRIP_HEIGHT}px`);
    expect(box.querySelector("img")).toBeNull();
    loading.unmount();
    const failed = render(<ImageStripItem width={600} height={360} src={null} alt="Before" fallback={<span>gone</span>} />);
    const failedBox = failed.container.querySelector<HTMLElement>('[data-slot="image-strip-item"]')!;
    expect(failedBox.style.getPropertyValue("--strip-item-w")).toBe(`${stripItemWidth(600, 360)}px`);
    expect(failedBox).toHaveTextContent("gone");
  });

  it("wraps a caption onto two lines under its own picture, never cut on its first line", () => {
    const { container } = render(<ImageStripItem width={390} height={844} size="tall" src={SRC} alt="a" caption="The option you chose" />);
    const caption = container.querySelector("figcaption")!;
    expect(caption.className).toMatch(/\bline-clamp-2\b/u);
    expect(caption.className).toMatch(/\bbreak-words\b/u);
    expect(caption.className).not.toMatch(/\btruncate\b/u);
    // What a third line would cut is still there to read.
    expect(caption).toHaveAttribute("title", "The option you chose");
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
