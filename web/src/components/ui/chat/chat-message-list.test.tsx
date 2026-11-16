import { render } from "@testing-library/react";

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

describe("ChatMessageList clearBottom", () => {
  beforeAll(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  });

  it("ends the list below what floats over its bottom edge, and only then", () => {
    const { container, rerender } = render(
      <ChatMessageList clearBottom={72}>
        <div>line one</div>
      </ChatMessageList>,
    );
    const scrollport = container.querySelector('[class*="overflow-y-auto"]')!;
    const spacer = scrollport.querySelector<HTMLElement>(':scope > [data-slot="clear-bottom"]');
    expect(scrollport.lastElementChild).toBe(spacer);
    expect(spacer?.style.height).toBe("72px");
    rerender(
      <ChatMessageList>
        <div>line one</div>
      </ChatMessageList>,
    );
    expect(spacer?.style.height).toBe("0px");
  });
});
