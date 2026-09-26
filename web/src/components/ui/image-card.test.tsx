import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImageCard } from "./image-card";

const SRC = "/api/blobs/" + "3f".repeat(32);

describe("ImageCard — one journal picture, framed", () => {
  it("is an anchor to the bytes, with the picture and its caption", () => {
    const { container } = render(<ImageCard src={SRC} alt="Terminal graphics" caption="from the log" />);
    const card = container.querySelector("[data-slot='image-card']");
    const link = card?.querySelector("a");
    // An anchor, so the picture is keyboard reachable, long-pressable and opens at full size.
    expect(link).toHaveAttribute("href", SRC);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // The caption doubles as the tooltip: hovering the picture asks about the picture.
    expect(link).toHaveAttribute("title", "from the log");
    expect(card?.querySelector("img")).toHaveAttribute("alt", "Terminal graphics");
    expect(card).toHaveTextContent("from the log");
  });

  it("is spans all the way down, so it may sit inside the mirror's <pre>", () => {
    const { container } = render(<ImageCard src={SRC} alt="a" caption="c" />);
    expect(container.querySelector("div")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("SPAN");
  });

  it("reports a failed load to the caller, who decides what stands in", () => {
    const onError = vi.fn();
    const { container } = render(<ImageCard src={SRC} alt="a" caption="c" onError={onError} />);
    fireEvent.error(container.querySelector("img")!);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
