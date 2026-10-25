import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImageCard } from "./image-card";

const SRC = "/api/blobs/" + "3f".repeat(32);

describe("ImageCard — one journal picture, framed", () => {
  it("opens the picture at full size in a sheet, never a link to the bytes", () => {
    const { container } = render(<ImageCard src={SRC} alt="Terminal graphics" caption="from the log" />);
    const card = container.querySelector("[data-slot='image-card']");
    // A data: URL cannot be opened as a page and an object URL cannot leave an installed iOS app.
    expect(card?.querySelector("a")).toBeNull();
    const button = card?.querySelector("button");
    // The caption doubles as the tooltip: hovering the picture asks about the picture.
    expect(button).toHaveAttribute("title", "from the log");
    expect(card?.querySelector("img")).toHaveAttribute("alt", "Terminal graphics");
    expect(card).toHaveTextContent("from the log");
    fireEvent.click(button!);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("from the log");
    expect(dialog.querySelector("img")).toHaveAttribute("src", SRC);
    // Portalled to <body>, so the card around the picture is still only spans.
    expect(container.querySelector("div")).toBeNull();
  });

  it("is spans all the way down, so it may sit inside the mirror's <pre>", () => {
    const { container } = render(<ImageCard src={SRC} alt="a" caption="c" />);
    expect(container.querySelector("div")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("SPAN");
  });

  it("takes the dark-space frame inside the mirror, and the app's tokens on the page", () => {
    const inMirror = render(<ImageCard src={SRC} alt="a" caption="c" />).container.firstElementChild;
    expect(inMirror).toHaveClass("bg-black/20");
    const onPage = render(<ImageCard src={SRC} alt="a" caption="c" surface="page" />).container.firstElementChild;
    expect(onPage).toHaveClass("bg-muted/30");
    expect(onPage).not.toHaveClass("bg-black/20");
  });

  it("reports a failed load to the caller, who decides what stands in", () => {
    const onError = vi.fn();
    const { container } = render(<ImageCard src={SRC} alt="a" caption="c" onError={onError} />);
    fireEvent.error(container.querySelector("img")!);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
