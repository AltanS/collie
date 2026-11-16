import { fireEvent, render } from "@testing-library/react";

import { ChatMessageList, TailRoomContext } from "./chat-message-list";

// The mirror's own scroll region: `h-full` inside the flex-col pane, so once its content overruns
// that height and the user drags past ITS bound, `overscroll-contain` is what stops the gesture from
// chaining into the document instead of the composer (root.tsx has no scroll of its own to give up
// safely — see agent-chat.tsx's statusline strip, which had the same gap for the same reason).
describe("ChatMessageList — scroll containment", () => {
  beforeAll(() => {
    // jsdom doesn't implement scrollTo; the auto-follow effect calls it on mount.
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  });

  it("renders its scrollport with overscroll-contain so an over-drag can't chain into the page", () => {
    const { container } = render(
      <ChatMessageList>
        <div>line one</div>
      </ChatMessageList>,
    );
    const scrollport = container.querySelector('[class*="overflow-y-auto"]');
    expect(scrollport).not.toBeNull();
    expect(scrollport!.className).toMatch(/(?:^|\s)overscroll-contain(?=\s|$)/);
  });
});

// THE ROOM A FLOATING TAG TAKES FROM THE TAIL (#759). Layout is measured in the browser
// (e2e/model-tag-room.spec.ts); here: the list publishes the number for its caller's padding to read,
// publishes nothing without a tag, and re-pins a list that follows the tail when the number changes.
describe("ChatMessageList: the tail room", () => {
  const scrollTo = vi.fn();
  beforeAll(() => {
    Element.prototype.scrollTo = scrollTo;
  });
  beforeEach(() => scrollTo.mockClear());

  const scrollport = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('[class*="overflow-y-auto"]')!;

  it("publishes --tail-room on its scrollport while a tag floats over it, and nothing without one", () => {
    const withTag = render(
      <TailRoomContext.Provider value={18}>
        <ChatMessageList className="pb-[max(0.75rem,var(--tail-room,0px))]">
          <div>line</div>
        </ChatMessageList>
      </TailRoomContext.Provider>,
    );
    expect(scrollport(withTag.container).style.getPropertyValue("--tail-room")).toBe("18px");
    const without = render(
      <ChatMessageList>
        <div>line</div>
      </ChatMessageList>,
    );
    expect(scrollport(without.container).style.getPropertyValue("--tail-room")).toBe("");
  });

  it("re-pins to the tail when the tag arrives, since padding is no size change the observers see", () => {
    const list = (room: number) => (
      <TailRoomContext.Provider value={room}>
        <ChatMessageList>
          <div>line</div>
        </ChatMessageList>
      </TailRoomContext.Provider>
    );
    const { rerender } = render(list(0));
    scrollTo.mockClear();
    rerender(list(18));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    rerender(list(18));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

// THE ONE ROOM BELOW THE LAST LINE: the model tag's room and the floating cards' height (`clearBottom`) are
// one value, published as `--tail-room`, and the caller's bottom padding reads it. The tag's room is
// the larger of the two with the cards' own air (never the sum): both float over the same strip.
describe("ChatMessageList: the cards and the tag share one room", () => {
  const scrollTo = vi.fn();
  beforeAll(() => {
    Element.prototype.scrollTo = scrollTo;
  });
  beforeEach(() => scrollTo.mockClear());

  const scrollport = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('[class*="overflow-y-auto"]')!;
  const room = (container: HTMLElement): string => scrollport(container).style.getPropertyValue("--tail-room");
  const list = ({ tag = 0, cards, onAtBottomChange }: { tag?: number; cards?: number; onAtBottomChange?: (atBottom: boolean) => void }) => (
    <TailRoomContext.Provider value={tag}>
      <ChatMessageList clearBottom={cards} onAtBottomChange={onAtBottomChange}>
        <div>line one</div>
      </ChatMessageList>
    </TailRoomContext.Provider>
  );

  it("ends exactly as before with no card and no tag: no room, no extra element, the button stays put", () => {
    const { container } = render(list({}));
    expect(room(container)).toBe("");
    expect(scrollport(container).children).toHaveLength(1);
    expect(container.querySelector('[data-slot="clear-bottom"]')).toBeNull();
  });

  it("takes the cards' height and 12px of air as the room when a card floats and no tag shows", () => {
    const { container } = render(list({ cards: 72 }));
    expect(room(container)).toBe("84px");
  });

  it("takes the tag's room alone as it is, with no card", () => {
    const { container } = render(list({ tag: 18 }));
    expect(room(container)).toBe("18px");
  });

  it("takes the larger of the two, never the sum: a card covers the tag's corner", () => {
    const tall = render(list({ tag: 18, cards: 72 }));
    expect(room(tall.container)).toBe("84px");
    const small = render(list({ tag: 18, cards: 2 }));
    expect(room(small.container)).toBe("18px");
  });

  it("adds no second spacer: the list holds its children and nothing after them", () => {
    const { container } = render(list({ tag: 18, cards: 72 }));
    expect(scrollport(container).children).toHaveLength(1);
    expect(scrollport(container).lastElementChild?.textContent).toBe("line one");
  });

  // A browser, as far as the scroll rule can tell: the scroll height is the content (1000px) plus the
  // room the list publishes, `scrollTo` clamps and fires the scroll event, and a layout change that
  // clamps `scrollTop` fires one too. Only a real browser shows where the pixels land (e2e).
  const CONTENT = 1000;
  const VIEW = 400;
  function browser(el: HTMLElement) {
    const roomPx = () => Number.parseFloat(el.style.getPropertyValue("--tail-room")) || 0;
    const max = () => CONTENT + roomPx() - VIEW;
    let top = 0;
    Object.defineProperty(el, "clientHeight", { value: VIEW, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => CONTENT + roomPx(), configurable: true });
    Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
    scrollTo.mockImplementation((opts?: { top?: number }) => {
      if (opts?.top === undefined) return;
      top = Math.min(opts.top, max());
      fireEvent.scroll(el);
    });
    return {
      /** The browser clamping an overlong `scrollTop` after the room shrank. */
      settle: () => {
        if (top <= max()) return;
        top = max();
        fireEvent.scroll(el);
      },
      scrollTo: (to: number) => {
        top = to;
        fireEvent.scroll(el);
      },
      top: () => top,
      max,
    };
  }

  it("follows the tail when a card comes, grows and goes, so the last line stays above the cards", () => {
    const seen: boolean[] = [];
    const { container, rerender } = render(list({ onAtBottomChange: (b) => seen.push(b) }));
    const view = browser(scrollport(container));
    view.scrollTo(view.max());
    for (const cards of [72, 110, 0]) {
      rerender(list({ cards, onAtBottomChange: (b) => seen.push(b) }));
      view.settle();
      expect(view.top()).toBe(view.max());
    }
    expect(seen).not.toContain(false);
  });

  it("follows when the model tag comes while a card is already there, to the larger room only", () => {
    const { container, rerender } = render(list({ cards: 72 }));
    const view = browser(scrollport(container));
    view.scrollTo(view.max());
    rerender(list({ cards: 72, tag: 18 }));
    expect(view.top()).toBe(view.max());
    expect(room(container)).toBe("84px");
  });

  it("does not move a reader scrolled away from the tail when a card comes, grows or goes", () => {
    const seen: boolean[] = [];
    const { container, rerender } = render(list({ onAtBottomChange: (b) => seen.push(b) }));
    const view = browser(scrollport(container));
    view.scrollTo(100);
    expect(seen).toEqual([false]);
    scrollTo.mockClear();
    for (const cards of [72, 110, 0]) {
      rerender(list({ cards, onAtBottomChange: (b) => seen.push(b) }));
      view.settle();
      expect(view.top()).toBe(100);
    }
    expect(scrollTo).not.toHaveBeenCalled();
    expect(seen).toEqual([false]);
  });

  it("lifts the jump-to-latest button over the cards and leaves it where it was without one", () => {
    const away = (cards: number | undefined) => {
      const { container, getByRole, unmount } = render(list({ tag: 18, cards }));
      browser(scrollport(container)).scrollTo(100);
      const button = getByRole("button");
      const bottom = button.style.bottom;
      unmount();
      return bottom;
    };
    expect(away(72)).toBe("84px");
    expect(away(undefined)).toBe("");
  });
});
