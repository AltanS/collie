import { act, fireEvent, render, screen } from "@testing-library/react";

import type { ChatItem } from "@/lib/chat-items";
import { BLOCK_HOLD_MS, MORE_SPACER, PinnedMark, StreamBlock } from "./stream-block";

// The two marks a stream block can wear (M90 spec 02): the pin glyph of a pinned block, and the `⋯` way in.
// Both are absolute and sit in the padding the block already owns, so neither moves a box (DESIGN.md §2).

const item: ChatItem = { id: "a:0", kind: "reply", text: "done" };
const BLOCK = "flex min-w-0 flex-col -m-3 p-3";

function block(over: Partial<React.ComponentProps<typeof StreamBlock>> = {}) {
  return render(
    <StreamBlock n={1} item={item} pinned={false} onActions={undefined} className={BLOCK} {...over}>
      <p>done</p>
    </StreamBlock>,
  );
}

describe("PinnedMark", () => {
  it("is a named image of the pin glyph, out of the way of touches", () => {
    render(<PinnedMark />);
    const mark = screen.getByRole("img", { name: "Pinned" });
    expect(mark.className).toContain("absolute");
    expect(mark.className).toContain("pointer-events-none");
  });
});

describe("StreamBlock", () => {
  it("is the plain block when it is not pinned and has no way in: no mark, no button, no extra class", () => {
    const { container } = block();
    const el = container.querySelector("[data-block]")!;
    expect(el.className).toBe(BLOCK);
    expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(el).toHaveAttribute("data-n", "1");
  });

  it("wears the mark when pinned, with its own anchor class and no other change to the block", () => {
    const { container } = block({ pinned: true });
    const el = container.querySelector("[data-block]")!;
    expect(el.className).toBe(`${BLOCK} relative`);
    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
  });

  it("draws the ⋯ as a button of 44px reach inside the block's padding, only with a way in and an item", () => {
    block({ onActions: vi.fn() });
    const more = screen.getByRole("button", { name: "Message actions" });
    expect(more.className).toContain("absolute");
    expect(more.className).toContain("before:-inset-3");
    expect(more).toHaveAttribute("type", "button");
  });

  it("draws no ⋯ for a folded run, which has no item", () => {
    block({ item: null, onActions: vi.fn() });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no hold look while a finger rests on it: no data-holding and no inline style, before the sheet opens", () => {
    vi.useFakeTimers();
    try {
      const onActions = vi.fn();
      const { container } = block({ onActions });
      const el = container.querySelector<HTMLElement>("[data-block]")!;
      fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS - 50));
      expect(el).not.toHaveAttribute("data-holding");
      expect(el.getAttribute("style")).toBeNull();
      act(() => vi.advanceTimersByTime(100));
      expect(onActions).toHaveBeenCalledOnce();
      expect(el).not.toHaveAttribute("data-holding");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the ⋯ off the block's edge and reserves its corner on the first lines, so no text sits under it", () => {
    const { container } = block({ onActions: vi.fn() });
    const more = screen.getByRole("button", { name: "Message actions" });
    // At `right-0.5` (2px) and 20px wide, it covers the block's right 22px, 10px of them over the content box, which
    // starts 12px in. Flush at `right-0` its ring and reach were clipped by `content-visibility`.
    expect(more.className).toContain("right-0.5");
    expect(more.className).not.toMatch(/(^|\s)right-0(\s|$)/);
    expect(more.className).toContain("size-5");
    // The spacer is the first thing in the content, floated right: 16px wide and 20px tall, which holds the content
    // clear of the button's 10px and the first 32px of the block's height (12px padding + 20px).
    const body = container.querySelector("[data-slot='block-body']")!;
    const spacer = body.firstElementChild!;
    expect(spacer).toHaveAttribute("data-slot", "block-more-spacer");
    expect(spacer.className).toBe(MORE_SPACER);
    expect(MORE_SPACER).toContain("float-right");
    expect(MORE_SPACER).toContain("w-4");
    expect(MORE_SPACER).toContain("h-5");
    expect(body.lastElementChild!.textContent).toBe("done");
    // The ring fits inside the 2px it has, so the clip does not cut it.
    expect(more.className).toContain("focus-visible:outline-offset-0");
  });

  it("holds no spacer when there is no way in", () => {
    const { container } = block({ pinned: true });
    expect(container.querySelector("[data-slot='block-more-spacer']")).toBeNull();
  });
});
