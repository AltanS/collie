import { render, screen } from "@testing-library/react";

import type { ChatItem } from "@/lib/chat-items";
import { PinnedMark, StreamBlock } from "./stream-block";

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
});
