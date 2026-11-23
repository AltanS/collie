import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ChatItem } from "@/lib/chat-items";
import { FLASH_MS } from "@/lib/copied-flash";
import { itemCopyText } from "@/lib/message-pins";
import { clearStatus } from "@/lib/status";
import { BlockActionsSheet } from "./block-actions-sheet";
import { BlockTextSheet } from "./block-text-sheet";
import { StreamBlock } from "./stream-block";
import { CopyableBlock } from "./ui/copyable-block";

// Select text opens a sheet with the block's text, the SAME string Copy text writes; Copy all writes it and flashes
// the text area; Copy text flashes the block; a code block's Copy flashes the code block; a failed copy flashes nothing.

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  clearStatus();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

const user: ChatItem = { id: "u1:0", kind: "user", text: "Please fix the retry.\nThen run the tests." };
const reply: ChatItem = { id: "a1:0", kind: "reply", text: "Done.\n\n```ts\nif (last) throw error;\n```\nRethrown on the last attempt." };
const tool: ChatItem = { id: "toolu_1", kind: "tool", status: "done", tool: { kind: "execute", command: "git status", output: "clean" } };

const area = () => screen.getByRole("region", { name: "Text to select" });

describe("BlockTextSheet", () => {
  it("draws nothing without a block", () => {
    const { container } = render(<BlockTextSheet item={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["a user message", user],
    ["a reply with a code block", reply],
    ["a tool block", tool],
  ])("shows, for %s, the very text Copy text writes", (_name, item) => {
    render(<BlockTextSheet item={item} onClose={vi.fn()} />);
    expect(area().textContent).toBe(itemCopyText(item));
  });

  it("is titled by the block's kind, and a tool's output wears the mono face", () => {
    render(<BlockTextSheet item={tool} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Tool: git" })).toBeInTheDocument();
    expect(area().className).toContain("font-mono");
    expect(area().className).toContain("select-text");
    expect(area().className).toContain("whitespace-pre-wrap");
  });

  it("wears the content face for a reply", () => {
    render(<BlockTextSheet item={reply} onClose={vi.fn()} />);
    expect(area().className).toContain("font-content");
    expect(area().className).not.toContain("font-mono");
  });

  it("Copy all writes the whole text, shows the copied state, flashes the text area and stays open", async () => {
    const onClose = vi.fn();
    render(<BlockTextSheet item={reply} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(itemCopyText(reply)));
    await waitFor(() => expect(area()).toHaveAttribute("data-copied"));
    expect(screen.getByRole("button", { name: "Copied to clipboard" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(area()).not.toHaveAttribute("data-copied"), { timeout: FLASH_MS + 800 });
  });

  it("flashes nothing when the browser refuses the copy", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<BlockTextSheet item={reply} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Couldn't copy to clipboard" })).toBeInTheDocument());
    expect(area()).not.toHaveAttribute("data-copied");
  });

  it("closes with its close button", async () => {
    const onClose = vi.fn();
    render(<BlockTextSheet item={reply} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("BlockActionsSheet, Select text", () => {
  it("closes the actions sheet and opens the text sheet with the block's text", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<BlockActionsSheet item={reply} pinned={false} onClose={onClose} onPin={vi.fn()} onUnpin={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Select text" }));
    expect(onClose).toHaveBeenCalledOnce();
    // The parent closes the actions sheet; the text sheet stays.
    rerender(<BlockActionsSheet item={null} pinned={false} onClose={onClose} onPin={vi.fn()} onUnpin={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(area().textContent).toBe(itemCopyText(reply));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a copy flashes what it copied", () => {
  it("Copy text flashes the block that was copied, and no other", async () => {
    function Wired() {
      return (
        <>
          <StreamBlock n={1} item={user} pinned={false} onActions={vi.fn()} className="block">
            <p>first</p>
          </StreamBlock>
          <StreamBlock n={1} item={reply} pinned={false} onActions={vi.fn()} className="block">
            <p>second</p>
          </StreamBlock>
          <BlockActionsSheet item={reply} pinned={false} onClose={vi.fn()} onPin={vi.fn()} onUnpin={vi.fn()} />
        </>
      );
    }
    const { container } = render(<Wired />);
    const [first, second] = container.querySelectorAll<HTMLElement>("[data-block]");
    await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(itemCopyText(reply)));
    await waitFor(() => expect(second).toHaveAttribute("data-copied"));
    expect(first).not.toHaveAttribute("data-copied");
    await waitFor(() => expect(second).not.toHaveAttribute("data-copied"), { timeout: FLASH_MS + 800 });
  });

  it("Copy text flashes nothing when the copy fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { container } = render(
      <>
        <StreamBlock n={1} item={reply} pinned={false} onActions={vi.fn()} className="block">
          <p>second</p>
        </StreamBlock>
        <BlockActionsSheet item={reply} pinned={false} onClose={vi.fn()} onPin={vi.fn()} onUnpin={vi.fn()} />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(container.querySelector("[data-copied]")).toBeNull();
  });

  it("a code block's Copy flashes the block itself, not the button", async () => {
    const { container } = render(
      <CopyableBlock text="if (last) throw error;">
        <pre>code</pre>
      </CopyableBlock>,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(container.firstElementChild).toHaveAttribute("data-copied"));
    expect(within(container).getByRole("button")).not.toHaveAttribute("data-copied");
  });

  it("a code block's Copy flashes nothing when the copy fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { container } = render(
      <CopyableBlock text="x">
        <pre>code</pre>
      </CopyableBlock>,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(within(container).getByRole("button", { name: "Couldn't copy to clipboard" })).toBeInTheDocument());
    expect(container.querySelector("[data-copied]")).toBeNull();
  });
});
