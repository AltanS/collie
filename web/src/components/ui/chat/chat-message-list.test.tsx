import { render } from "@testing-library/react";

import { ChatMessageList } from "./chat-message-list";

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
    expect(scrollport.lastElementChild?.getAttribute("data-slot")).toBe("clear-bottom");
    expect((scrollport.lastElementChild as HTMLElement).style.height).toBe("72px");
    rerender(
      <ChatMessageList>
        <div>line one</div>
      </ChatMessageList>,
    );
    expect((scrollport.lastElementChild as HTMLElement).style.height).toBe("0px");
  });
});
