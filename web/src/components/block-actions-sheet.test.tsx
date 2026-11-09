import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { endSelectText, selectTextIn, useSelectable } from "@/lib/block-select";
import type { ChatItem } from "@/lib/chat-items";
import { clearStatus, useStatus } from "@/lib/status";
import { BlockActionsSheet } from "./block-actions-sheet";

// The rows a Chat block's sheet offers (M90 spec 02): Pin or Unpin by whether the block is pinned, Copy text, and
// Select text. Each closes the sheet first; Pin and Unpin hand the block to the pane view's hook.

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  clearStatus();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

const reply: ChatItem = { id: "a1:0", kind: "reply", text: "The answer is 42." };
const tool: ChatItem = { id: "toolu_1", kind: "tool", status: "done", tool: { kind: "execute", command: "git status", output: "clean" } };

function Status() {
  const status = useStatus();
  return <p data-testid="status">{status?.text ?? ""}</p>;
}

function sheet(over: Partial<React.ComponentProps<typeof BlockActionsSheet>> = {}) {
  const props = { item: reply, pinned: false, onClose: vi.fn(), onPin: vi.fn(), onUnpin: vi.fn(), ...over };
  render(
    <>
      <BlockActionsSheet {...props} />
      <Status />
    </>,
  );
  return props;
}

describe("BlockActionsSheet, while a pin is on its way", () => {
  it("shows Unpin, dimmed and dead, because there is no pin id to drop yet", async () => {
    const props = sheet({ pinned: true, pinning: true });
    const row = screen.getByRole("button", { name: "Unpin" });
    expect(row).toBeDisabled();
    await userEvent.click(row);
    expect(props.onUnpin).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("takes the tap once the pin has landed", async () => {
    const props = sheet({ pinned: true, pinning: false });
    await userEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(props.onUnpin).toHaveBeenCalledWith(reply);
  });
});

describe("BlockActionsSheet", () => {
  it("draws nothing without a block", () => {
    const { container } = render(<BlockActionsSheet item={null} pinned={false} onClose={vi.fn()} onPin={vi.fn()} onUnpin={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is titled by what the block is, a tool card by its tool", () => {
    sheet();
    expect(screen.getByRole("dialog", { name: "Reply" })).toBeInTheDocument();
  });

  it("titles a tool card by its tool", () => {
    sheet({ item: tool });
    expect(screen.getByRole("dialog", { name: "Tool: git" })).toBeInTheDocument();
  });

  it("offers Pin for a block that is not pinned, closes, and hands the block over", async () => {
    const props = sheet();
    expect(screen.queryByRole("button", { name: "Unpin" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onPin).toHaveBeenCalledWith(reply);
    expect(props.onUnpin).not.toHaveBeenCalled();
  });

  it("offers Unpin for a block that is pinned", async () => {
    const props = sheet({ pinned: true });
    expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onUnpin).toHaveBeenCalledWith(reply);
    expect(props.onPin).not.toHaveBeenCalled();
  });

  it("copies the block's text, closes, and says so", async () => {
    const props = sheet();
    await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("The answer is 42."));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Copied to clipboard"));
  });

  it("copies a tool card as its step line over what it printed", async () => {
    sheet({ item: tool });
    await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("git: git status\nclean"));
  });

  it("says so when the browser refuses the copy", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    sheet();
    await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Couldn't copy to clipboard"));
  });

  it("leaves the Copy row off where nothing can copy", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    sheet();
    expect(screen.queryByRole("button", { name: "Copy text" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
  });
});

function Selectable({ id }: { id: string }) {
  return <p data-testid="selectable">{useSelectable(id) ? "yes" : "no"}</p>;
}

describe("BlockActionsSheet, Select text", () => {
  afterEach(() => endSelectText());

  it("closes the sheet, makes that block selectable and says how in a status line", async () => {
    const props = { item: reply, pinned: false, onClose: vi.fn(), onPin: vi.fn(), onUnpin: vi.fn() };
    render(
      <>
        <BlockActionsSheet {...props} />
        <Status />
        <Selectable id={reply.id} />
      </>,
    );
    expect(screen.getByTestId("selectable")).toHaveTextContent("no");
    await userEvent.setup().click(screen.getByRole("button", { name: "Select text" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selectable")).toHaveTextContent("yes");
    expect(screen.getByTestId("status")).toHaveTextContent("Hold the text to select it. Tap outside the message to end.");
  });

  it("ends a select mode when the sheet opens again", () => {
    selectTextIn(reply.id);
    render(
      <>
        <BlockActionsSheet item={reply} pinned={false} onClose={vi.fn()} onPin={vi.fn()} onUnpin={vi.fn()} />
        <Selectable id={reply.id} />
      </>,
    );
    expect(screen.getByTestId("selectable")).toHaveTextContent("no");
  });
});
