import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CollieHome } from "./collie-home";
import { collieMark, markAccent, markIsLive } from "@/test/collie-mark";

describe("CollieHome", () => {
  it("returns home when tapped", async () => {
    const onHome = vi.fn();
    render(<CollieHome onHome={onHome} trouble={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("keeps ONE mark in every state and blooms it — turning AND in colour — once troubled", () => {
    // The mark is never swapped for a second picture, so nothing can resize or pop as the connection
    // settles. Rest = still, muted chroma; sustained trouble = the orbit turning at full chroma,
    // same element. The colour half matters here specifically: `prefers-reduced-motion` stops the
    // orbit, and colour is what still says "reconnecting" to that reader.
    const { container, rerender } = render(<CollieHome trouble={false} />);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(markIsLive(container)).toBe(false);
    const resting = markAccent(container);
    rerender(<CollieHome trouble />);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(markIsLive(container)).toBe(true);
    expect(markAccent(container)).not.toBe(resting);
  });

  it("drops the bloom and stills the mark, muted, once the outage escalates to lost", () => {
    // Blooming = "still trying"; once the reconnect gives up (lost) the orbit stops turning and the
    // mark is muted. Still the same element — no swap, no frozen sprite frame.
    const { container } = render(<CollieHome trouble lost />);
    expect(markIsLive(container)).toBe(false);
    expect(collieMark(container)?.getAttribute("class")).toMatch(/grayscale/);
    expect(screen.getByRole("button", { name: "Collie home — not connected" })).toBeInTheDocument();
  });

  it("blooms while troubled but NOT yet lost", () => {
    const { container } = render(<CollieHome trouble lost={false} />);
    expect(markIsLive(container)).toBe(true);
    expect(collieMark(container)?.getAttribute("class") ?? "").not.toMatch(/grayscale/);
    expect(screen.getByRole("button", { name: "Collie home — reconnecting" })).toBeInTheDocument();
  });

  it("shows the wordmark only when asked", () => {
    const { rerender } = render(<CollieHome trouble={false} />);
    expect(screen.queryByText("Collie")).toBeNull();
    rerender(<CollieHome trouble={false} wordmark />);
    expect(screen.getByText("Collie")).toBeInTheDocument();
  });
});
