import { render, screen } from "@testing-library/react";

import { ConversationThread, ConversationView } from "./conversation-view";
import { Button } from "./ui/button";
import { fixtureTranscript } from "@/test/handlers";

describe("Conversation native presentation", () => {
  it("uses native buttons with the same tap floor as the composer's controls", () => {
    const { container } = render(<>
      <Button size="icon" className="size-11" aria-label="Reference control" />
      <ConversationView state="ok" dialogPresent={true} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />
    </>);
    const reference = screen.getByRole("button", { name: "Reference control" });
    const refresh = screen.getByRole("button", { name: "Refresh conversation" });
    const tapBox = reference.className.split(" ").find((token) => token.startsWith("size-"))!;
    expect(refresh).toHaveClass(tapBox);
    for (const button of container.querySelectorAll('[data-slot="conversation-view"] button')) {
      expect(button.className).toContain("focus-visible:outline-2");
      expect(button.className).toMatch(/(?:size|min-h)-11/);
    }
  });

  it("puts standing feedback in Notice and Collapse, retaining it through exit", () => {
    const props = { onRefresh: vi.fn(), onOpenTerminal: vi.fn() };
    const { container, rerender } = render(<ConversationView {...props} state="disabled" dialogPresent={true} />);
    const dialog = container.querySelector('[data-slot="conversation-terminal-required"]')!;
    const unavailable = container.querySelector('[data-slot="conversation-state"]')!;
    for (const card of [dialog, unavailable]) {
      expect(card.querySelector('[data-slot="notice"]')).toHaveClass("rounded-sm");
      expect(card.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    }
    rerender(<ConversationView {...props} state="ok" dialogPresent={false} />);
    for (const card of [dialog, unavailable]) {
      expect(card.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "closed");
    }
  });

  it("keeps the message hierarchy with house corners and a separate native working notice", () => {
    const { container } = render(<ConversationThread entries={fixtureTranscript} state="ok" working={true} agent="claude" />);
    const userBubble = screen.getByText("what changed today?").closest("li")!.firstElementChild!;
    expect(userBubble).toHaveClass("rounded-sm", "bg-primary");
    const working = container.querySelector('[data-slot="conversation-working"]')!;
    expect(working.querySelector('[data-slot="notice"]')).toHaveClass("rounded-sm");
    expect(working.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    expect(working).toHaveTextContent("Working…");
    expect(userBubble.contains(working)).toBe(false);
  });
});
