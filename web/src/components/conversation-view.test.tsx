import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { vi } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { ConversationThread, ConversationView } from "./conversation-view";
import { Button } from "./ui/button";
import { fixtureTranscript } from "@/test/handlers";

function blocksFromText(text: string) {
  return claudeBuildBlocks(splitLines(parseAnsi(text)));
}

const threadHandlers = {
  blocks: [],
  onPromptAction: vi.fn(),
  onWizardAction: vi.fn(),
  onPreviewAction: vi.fn(),
  onMultiSelectAction: vi.fn(),
  onMenuAction: vi.fn(),
  promptDisabled: false,
};

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
    const { container } = render(
      <ConversationThread entries={fixtureTranscript} state="ok" working={true} agent="claude" {...threadHandlers} />,
    );
    const userBubble = screen.getByText("what changed today?").closest("li")!.firstElementChild!;
    expect(userBubble).toHaveClass("rounded-sm", "bg-primary");
    const working = container.querySelector('[data-slot="conversation-working"]')!;
    expect(working.querySelector('[data-slot="notice"]')).toHaveClass("rounded-sm");
    expect(working.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    expect(working).toHaveTextContent("Working…");
    expect(userBubble.contains(working)).toBe(false);
  });

  it("renders a supported prompt as the thread's last message, without the working bubble", () => {
    const blocks = blocksFromText("Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n");
    const { container } = render(
      <ConversationThread
        entries={fixtureTranscript}
        state="ok"
        working={true}
        agent="claude"
        {...threadHandlers}
        blocks={blocks}
      />,
    );
    const inline = container.querySelector('[data-slot="conversation-inline-prompts"]')!;
    expect(inline.closest('[data-slot="conversation-thread"]')).not.toBeNull();
    // SAFETY: `inline` is the non-null result asserted present one line above; `within` needs the
    // wider HTMLElement type.
    expect(within(inline as HTMLElement).getByRole("button", { name: "Yes" })).toBeInTheDocument();
    // The working bubble and the inline action state are the same screen's two readings; the
    // question wins, so "Working…" never stands next to tappable answers.
    expect(container.querySelector('[data-slot="conversation-working"]')).toBeNull();
  });

  it("renders no inferred controls for a raw-only screen", () => {
    const { container } = render(
      <ConversationThread entries={[]} state="ok" working={false} {...threadHandlers} blocks={[]} />,
    );
    expect(container.querySelector('[data-slot="conversation-inline-prompts"]')).toBeNull();
    expect(container.querySelector('[data-slot="conversation-working"]')).toBeNull();
  });

  // Regression (agentic review #03): rendering TypedBlocks alone dropped the raw rows that carry
  // the question and action details (filename, proposed contents). An approval without visible
  // context invites approving an un-inspected action, so the raw rows must render beside the
  // controls in a conversation-inline-context card.
  it("shows the raw question and action context beside inline permission/edit controls", () => {
    const blocks = blocksFromText(readFileSync(
      join(process.cwd(), "src/fixtures/panes/claude--permission-edit.txt"), "utf8",
    ));
    const { container } = render(
      <ConversationThread
        entries={fixtureTranscript}
        state="ok"
        working={false}
        agent="claude"
        {...threadHandlers}
        blocks={blocks}
      />,
    );
    const inline = container.querySelector('[data-slot="conversation-inline-prompts"]');
    expect(inline).not.toBeNull();
    const context = container.querySelector('[data-slot="conversation-inline-context"]');
    expect(context).not.toBeNull();
    // SAFETY: `context` was asserted non-null directly above.
    expect(within(context as HTMLElement).getByText(/Create file/)).toBeVisible();
    expect(context).toHaveTextContent("1 hello");
    expect(context).toHaveTextContent("Do you want to create hello.txt?");
    // SAFETY: `inline` was asserted non-null directly above.
    expect(within(inline as HTMLElement).getByRole("button", { name: "Yes" })).toBeInTheDocument();
  });

  it("keeps all action context, including rows more than fourteen lines above the answers", () => {
    const text = [
      "Create file important.txt",
      ...Array.from({ length: 30 }, (_, i) => `${i + 1} proposed line ${i + 1}`),
      "Do you want to create important.txt?",
      " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend", "",
    ].join("\n");
    const { container } = render(
      <ConversationThread entries={[]} state="ok" working={false} {...threadHandlers} blocks={blocksFromText(text)} />,
    );
    const context = container.querySelector('[data-slot="conversation-inline-context"]');
    expect(context).toHaveTextContent("Create file important.txt");
    expect(context).toHaveTextContent("1 proposed line 1");
    expect(context).toHaveTextContent("30 proposed line 30");
    expect(screen.getByRole("button", { name: "Yes" })).toBeVisible();
  });

  it.each(["", "Earlier unrelated task output"])("withholds inline approvals when the current raw question is absent: %s", (raw) => {
    const blocks = blocksFromText("Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n");
    expect(blocks.some((block) => block.kind === "prompt-select")).toBe(true);
    const { container } = render(
      <ConversationThread entries={[]} state="ok" working={false} {...threadHandlers} blocks={[{ kind: "raw", lines: splitLines(parseAnsi(raw)) }, ...blocks.filter((block) => block.kind !== "raw")]} />,
    );
    expect(container.querySelector('[data-slot="conversation-inline-prompts"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("shows the raw question beside single-question preview controls", () => {
    const text = readFileSync(
      join(process.cwd(), "src/fixtures/panes/claude--select-preview.txt"),
      "utf8",
    );
    const blocks = blocksFromText(text);
    const { container } = render(
      <ConversationThread
        entries={fixtureTranscript}
        state="ok"
        working={false}
        agent="claude"
        {...threadHandlers}
        blocks={blocks}
      />,
    );
    const inline = container.querySelector('[data-slot="conversation-inline-prompts"]');
    expect(inline).not.toBeNull();
    const context = container.querySelector('[data-slot="conversation-inline-context"]');
    expect(context).not.toBeNull();
    // SAFETY: `context` was asserted non-null directly above; the question row sits in the
    // raw context the typed preview controls replaced.
    expect(within(context as HTMLElement).getByText("Which widget design should we use?", { exact: true })).toBeInTheDocument();
  });
});
