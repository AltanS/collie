import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";

import { endSelectText, selectTextIn } from "@/lib/block-select";
import type { ChatItem } from "@/lib/chat-items";
import { BLOCK_HOLD_MS, chipShift, PinnedMark, REVEAL_MS, StreamBlock } from "./stream-block";

// The two marks a stream block can wear (M90 spec 02, reworked 2026-11-06): the pin glyph of a pinned block, and the
// `⋯` way in, which shows only after a tap or a hold on the block. Both are absolute and lie over the block, so neither
// moves a box (DESIGN.md §2).

const item: ChatItem = { id: "a:0", kind: "reply", text: "done" };
const other: ChatItem = { id: "b:0", kind: "reply", text: "other" };
const BLOCK = "flex min-w-0 flex-col -m-3 p-3";

function block(over: Partial<React.ComponentProps<typeof StreamBlock>> = {}) {
  return render(
    <StreamBlock n={1} item={item} pinned={false} onActions={undefined} className={BLOCK} {...over}>
      <p>done</p>
      <a href="#x">a link</a>
    </StreamBlock>,
  );
}

const blockEl = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-block]")!;
const more = () => screen.getByRole("button", { name: "Message actions" });

/** A press and a lift with no movement in between, from `from` to `to` (the lift may land elsewhere). */
function tap(target: Element, at = { x: 10, y: 10 }, lift = at, pointerType = "touch") {
  fireEvent.pointerDown(target, { button: 0, clientX: at.x, clientY: at.y, pointerType });
  if (lift !== at) fireEvent.pointerMove(target, { clientX: lift.x, clientY: lift.y, pointerType });
  fireEvent.pointerUp(target, { button: 0, clientX: lift.x, clientY: lift.y, pointerType });
}

let above: (() => void) | null = null;

/** A click listener above the stream, where the reading area's Tap to type listens. */
function listenAbove() {
  const spy = vi.fn();
  document.body.addEventListener("click", spy);
  above = () => document.body.removeEventListener("click", spy);
  return spy;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  above?.();
  above = null;
  vi.useRealTimers();
});

describe("PinnedMark", () => {
  it("is a named image of the pin glyph, out of the way of touches", () => {
    render(<PinnedMark />);
    const mark = screen.getByRole("img", { name: "Pinned" });
    expect(mark.className).toContain("absolute");
    expect(mark.className).toContain("pointer-events-none");
  });
});

describe("StreamBlock at rest", () => {
  it("is the plain block when it is not pinned and has no way in: no mark, no button, no extra class", () => {
    const { container } = block();
    const el = blockEl(container);
    expect(el.className).toBe(BLOCK);
    expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(el).toHaveAttribute("data-n", "1");
  });

  it("wears the mark when pinned, with its own anchor class and no other change to the block", () => {
    const { container } = block({ pinned: true });
    expect(blockEl(container).className).toBe(`${BLOCK} relative`);
    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
  });

  it("holds the ⋯ in the DOM for Tab, but clear and deaf to the pointer, and wraps nothing round the text", () => {
    const { container } = block({ onActions: vi.fn() });
    const el = blockEl(container);
    expect(el).not.toHaveAttribute("data-revealed");
    expect(more().className).toContain("opacity-0");
    expect(more().className).toContain("pointer-events-none");
    // Shown on a keyboard focus and on a mouse's hover of the block, opacity only.
    expect(more().className).toContain("focus-visible:opacity-100");
    expect(more().className).toContain("group-hover/block:opacity-100");
    expect(el.className).toContain("group/block");
    // index.css turns selection and the callout off for `data-pinnable` under `pointer: coarse` only; no class does it,
    // so a mouse and a desk keep selection.
    expect(el).toHaveAttribute("data-pinnable");
    expect(el).not.toHaveAttribute("data-selectable");
    expect(el.className).not.toContain("select-none");
    // No spacer and no wrapper: the block's first child is the content itself.
    expect(container.querySelector("[data-slot='block-more-spacer']")).toBeNull();
    expect(el.firstElementChild!.textContent).toBe("done");
  });

  it("draws the ⋯ as a 20px chip with a hairline on the chrome ground, inside the padding, with a 44px reach", () => {
    block({ onActions: vi.fn() });
    const chip = more();
    for (const cls of ["absolute", "size-5", "top-3", "right-0.5", "rounded-sm", "border", "border-border", "bg-chrome", "before:-inset-3", "focus-visible:outline-offset-0"]) {
      expect(chip.className).toContain(cls);
    }
    expect(chip.className).not.toMatch(/(^|\s)right-0(\s|$)/);
    expect(chip).toHaveAttribute("type", "button");
  });

  it("draws no ⋯ for a folded run, which has no item", () => {
    block({ item: null, onActions: vi.fn() });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("StreamBlock reveal", () => {
  it("shows the ⋯ on a tap on the block's text, and the tap opens nothing", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    tap(screen.getByText("done"));
    expect(blockEl(container)).toHaveAttribute("data-revealed");
    expect(more().className).toContain("opacity-100");
    expect(more().className).toContain("pointer-events-auto");
    expect(more().className).not.toContain("opacity-0");
    expect(onActions).not.toHaveBeenCalled();
  });

  it("opens the sheet from the shown ⋯, and the ⋯ goes", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    tap(screen.getByText("done"));
    fireEvent.click(more());
    expect(onActions).toHaveBeenCalledExactlyOnceWith(item);
    expect(blockEl(container)).not.toHaveAttribute("data-revealed");
  });

  it("shows nothing on a tap on a link, a button or a picture inside the block", () => {
    const { container } = render(
      <StreamBlock n={1} item={item} pinned={false} onActions={vi.fn()} className={BLOCK}>
        <a href="#x">a link</a>
        <button type="button">copy</button>
        <img alt="shot" src="data:," />
      </StreamBlock>,
    );
    for (const target of [screen.getByText("a link"), screen.getByRole("button", { name: "copy" }), screen.getByRole("img", { name: "shot" })]) {
      tap(target);
      expect(blockEl(container)).not.toHaveAttribute("data-revealed");
    }
  });

  it("shows nothing when the press moved more than 8px: that is a scroll", () => {
    const { container } = block({ onActions: vi.fn() });
    tap(screen.getByText("done"), { x: 10, y: 10 }, { x: 10, y: 19 });
    expect(blockEl(container)).not.toHaveAttribute("data-revealed");
    tap(screen.getByText("done"), { x: 10, y: 10 }, { x: 10, y: 18 });
    expect(blockEl(container)).toHaveAttribute("data-revealed");
  });

  it("shows nothing while text of the block is selected", () => {
    const { container } = block({ onActions: vi.fn() });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("done"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    tap(screen.getByText("done"));
    window.getSelection()?.removeAllRanges();
    expect(blockEl(container)).not.toHaveAttribute("data-revealed");
  });

  it("opens the sheet on a touch hold after 650ms, silently until it fires, with no contextmenu", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    const el = blockEl(container);
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS - 50));
    expect(el).not.toHaveAttribute("data-holding");
    expect(el.getAttribute("style")).toBeNull();
    expect(onActions).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));
    expect(onActions).toHaveBeenCalledExactlyOnceWith(item);
    fireEvent.pointerUp(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    // The hold is not also a tap: no chip after it, and its click is the hold's.
    expect(el).not.toHaveAttribute("data-revealed");
    expect(onActions).toHaveBeenCalledOnce();
    expect(el).not.toHaveAttribute("data-holding");
  });

  it("shows one block's ⋯ at a time", () => {
    const { container } = render(
      <>
        <StreamBlock n={1} item={item} pinned={false} onActions={vi.fn()} className={BLOCK}>
          <p>done</p>
        </StreamBlock>
        <StreamBlock n={1} item={other} pinned={false} onActions={vi.fn()} className={BLOCK}>
          <p>other</p>
        </StreamBlock>
      </>,
    );
    const [a, b] = container.querySelectorAll<HTMLElement>("[data-block]");
    tap(screen.getByText("done"));
    expect(a).toHaveAttribute("data-revealed");
    tap(screen.getByText("other"));
    expect(b).toHaveAttribute("data-revealed");
    expect(a).not.toHaveAttribute("data-revealed");
  });

  it("hides on a press elsewhere", () => {
    const { container } = block({ onActions: vi.fn() });
    tap(screen.getByText("done"));
    fireEvent.pointerDown(document.body);
    expect(blockEl(container)).not.toHaveAttribute("data-revealed");
  });

  it("stays shown through a scroll, of what holds the block or inside it: the stream follows new output on its own", () => {
    const { container } = render(
      <div className="scroller">
        <StreamBlock n={1} item={item} pinned={false} onActions={vi.fn()} className={BLOCK}>
          <p>done</p>
          <pre>wide table</pre>
        </StreamBlock>
      </div>,
    );
    const el = blockEl(container);
    tap(screen.getByText("done"));
    fireEvent.scroll(screen.getByText("wide table"));
    expect(el).toHaveAttribute("data-revealed");
    fireEvent.scroll(container.querySelector(".scroller")!);
    fireEvent.scroll(document);
    expect(el).toHaveAttribute("data-revealed");
  });

  it("hides after its wait without a press, and a press on the block starts the wait again", () => {
    const { container } = block({ onActions: vi.fn() });
    const el = blockEl(container);
    tap(screen.getByText("done"));
    act(() => vi.advanceTimersByTime(REVEAL_MS - 100));
    fireEvent.pointerDown(screen.getByText("done"), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(screen.getByText("done"), { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(REVEAL_MS - 100));
    expect(el).toHaveAttribute("data-revealed");
    act(() => vi.advanceTimersByTime(200));
    expect(el).not.toHaveAttribute("data-revealed");
  });

  it("opens the sheet at once on a mouse's right click, and takes the native menu away", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    const el = blockEl(container);
    fireEvent.pointerDown(el, { button: 2, clientX: 10, clientY: 10, pointerType: "mouse" });
    const menu = createEvent.contextMenu(el);
    fireEvent(el, menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onActions).toHaveBeenCalledOnce();
    expect(el).not.toHaveAttribute("data-revealed");
  });

  it("swallows the one click the hold's lift sends wherever it lands, and the next press clears that", () => {
    const elsewhere = listenAbove();
    const { container } = block({ onActions: vi.fn() });
    const el = blockEl(container);
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS));
    fireEvent.pointerUp(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    // The lift's click lands on what opened under the finger, outside the block.
    fireEvent.click(document.body);
    expect(elsewhere).not.toHaveBeenCalled();
    // A browser that sent no click: the next press clears the guard, and its click goes through.
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS));
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
    fireEvent.click(document.body);
    expect(elsewhere).toHaveBeenCalledOnce();
  });

  it("opens the sheet on the contextmenu that ends a touch hold (Android), the fallback, and only once", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    const el = blockEl(container);
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    const menu = createEvent.contextMenu(el);
    fireEvent(el, menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onActions).toHaveBeenCalledOnce();
    // The timer that was still running is the same gesture: it opens nothing more.
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS));
    expect(onActions).toHaveBeenCalledOnce();
  });

  it("keeps the click of a tap that reveals from the reading area under the block: no Tap to type", () => {
    const readingArea = listenAbove();
    render(
      <StreamBlock n={1} item={item} pinned={false} onActions={vi.fn()} className={BLOCK}>
        <p>done</p>
        <a href="#x">a link</a>
      </StreamBlock>,
    );
    tap(screen.getByText("done"));
    fireEvent.click(screen.getByText("done"));
    expect(readingArea).not.toHaveBeenCalled();
    // A tap the block does not take keeps its click: the link's, and the next press starts clean.
    tap(screen.getByText("a link"));
    fireEvent.click(screen.getByText("a link"));
    expect(readingArea).toHaveBeenCalledOnce();
    tap(screen.getByText("done"), { x: 10, y: 10 }, { x: 10, y: 40 });
    fireEvent.click(screen.getByText("done"));
    expect(readingArea).toHaveBeenCalledTimes(2);
  });

  it("passes the click of a block that cannot reveal to the reading area", () => {
    const readingArea = listenAbove();
    render(
      <StreamBlock n={1} item={item} pinned={false} onActions={undefined} className={BLOCK}>
        <p>done</p>
      </StreamBlock>,
    );
    tap(screen.getByText("done"));
    fireEvent.click(screen.getByText("done"));
    expect(readingArea).toHaveBeenCalledOnce();
  });

  it("opens the sheet on a touch hold over text it selected, takes the native menu away and collapses the selection", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    const el = blockEl(container);
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    // Android's selection starts first: its pointer cancel ends the hold, then `contextmenu` arrives.
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("done"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.pointerCancel(el, { pointerType: "touch" });
    const menu = createEvent.contextMenu(el);
    fireEvent(el, menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
    expect(onActions).toHaveBeenCalledOnce();
  });

  it("leaves a mouse's right click over selected text to the browser's menu", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    const el = blockEl(container);
    fireEvent.pointerDown(el, { button: 2, clientX: 10, clientY: 10, pointerType: "mouse" });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("done"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const menu = createEvent.contextMenu(el);
    fireEvent(el, menu);
    const selected = window.getSelection()?.isCollapsed === false;
    window.getSelection()?.removeAllRanges();
    expect(menu.defaultPrevented).toBe(false);
    expect(selected).toBe(true);
    expect(onActions).not.toHaveBeenCalled();
    expect(el).not.toHaveAttribute("data-revealed");
  });

  it("leaves a block with no way in alone: a tap shows nothing and a right click keeps the native menu", () => {
    const { container } = block({ pinned: true });
    const el = blockEl(container);
    tap(screen.getByText("done"));
    expect(el).not.toHaveAttribute("data-revealed");
    const menu = createEvent.contextMenu(el);
    fireEvent(el, menu);
    expect(menu.defaultPrevented).toBe(false);
    expect(within(el).queryByRole("button")).toBeNull();
  });
});

describe("StreamBlock select mode (the sheet's Select text)", () => {
  it("marks the block selectable, and its own hold, tap and contextmenu stand down", () => {
    const onActions = vi.fn();
    const { container } = block({ onActions });
    const el = blockEl(container);
    act(() => selectTextIn(item.id));
    expect(el).toHaveAttribute("data-selectable");
    tap(screen.getByText("done"));
    expect(el).not.toHaveAttribute("data-revealed");
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS * 2));
    const menu = createEvent.contextMenu(el);
    fireEvent(el, menu);
    expect(menu.defaultPrevented).toBe(false);
    expect(onActions).not.toHaveBeenCalled();
  });

  it("keeps a tap in the selectable block from Tap to type, and lets a link's click through", () => {
    const readingArea = listenAbove();
    block({ onActions: vi.fn() });
    act(() => selectTextIn(item.id));
    fireEvent.click(screen.getByText("done"));
    expect(readingArea).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("a link"));
    expect(readingArea).toHaveBeenCalledOnce();
  });

  it("ends on a press outside the block, and not on a press inside it", () => {
    const { container } = block({ onActions: vi.fn() });
    const el = blockEl(container);
    act(() => selectTextIn(item.id));
    fireEvent.pointerDown(screen.getByText("done"), { button: 0, pointerType: "touch" });
    expect(el).toHaveAttribute("data-selectable");
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "touch" });
    expect(el).not.toHaveAttribute("data-selectable");
  });

  it("ends when the block opens its sheet again, and holds one block at a time", () => {
    const onActions = vi.fn();
    const { container } = render(
      <>
        <StreamBlock n={1} item={item} pinned={false} onActions={onActions} className={BLOCK}>
          <p>done</p>
        </StreamBlock>
        <StreamBlock n={1} item={other} pinned={false} onActions={onActions} className={BLOCK}>
          <p>other</p>
        </StreamBlock>
      </>,
    );
    const [a, b] = container.querySelectorAll<HTMLElement>("[data-block]");
    act(() => selectTextIn(item.id));
    act(() => selectTextIn(other.id));
    expect(a).not.toHaveAttribute("data-selectable");
    expect(b).toHaveAttribute("data-selectable");
    act(() => endSelectText());
    tap(screen.getByText("other"));
    act(() => selectTextIn(other.id));
    fireEvent.click(within(b!).getByRole("button", { name: "Message actions" }));
    expect(onActions).toHaveBeenCalledOnce();
    expect(b).not.toHaveAttribute("data-selectable");
  });

  it("ends when the block leaves the stream", () => {
    const view = block({ onActions: vi.fn() });
    act(() => selectTextIn(item.id));
    view.unmount();
    const again = block({ onActions: vi.fn() });
    expect(blockEl(again.container)).not.toHaveAttribute("data-selectable");
  });
});

describe("chipShift", () => {
  const chip = { left: 280, right: 300, top: 12, bottom: 32 };

  it("stays where it is when no control is under it", () => {
    expect(chipShift(chip, [{ left: 200, right: 240, top: 12, bottom: 40 }], 280)).toBe(0);
    // Touching is not covering.
    expect(chipShift(chip, [{ left: 300, right: 320, top: 12, bottom: 32 }], 280)).toBe(0);
  });

  it("steps left of a control it would cover, with 4px of air", () => {
    // A code block's copy button at the top right of a reply.
    const copy = { left: 274, right: 298, top: 14, bottom: 38 };
    const shift = chipShift(chip, [copy], 280);
    expect(shift).toBe(300 - 274 + 4);
    expect(chip.right - shift).toBe(copy.left - 4);
  });

  it("steps again past a second control the first step lands on", () => {
    const copy = { left: 274, right: 298, top: 14, bottom: 38 };
    const next = { left: 240, right: 264, top: 14, bottom: 38 };
    expect(chipShift(chip, [copy, next], 280)).toBe(300 - 240 + 4);
  });

  it("never leaves the block", () => {
    expect(chipShift(chip, [{ left: 0, right: 299, top: 12, bottom: 32 }], 40)).toBe(40);
  });
});
