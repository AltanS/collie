import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StatusDetailSheet } from "./status-detail-sheet";

// The full text of an error status, in a sheet, for the one header row that has to truncate it.
// See the header comment in status-detail-sheet.tsx for why Copy lives here and why Dismiss and
// Close are two different callbacks.

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
  });
}

describe("StatusDetailSheet", () => {
  const longText = "connection refused: dial tcp 100.64.0.5:22: connect: no route to host";

  it("renders the full text when open", () => {
    render(<StatusDetailSheet open text={longText} onClose={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(longText)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<StatusDetailSheet open={false} text={longText} onClose={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByText(longText)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("writes the text to the clipboard and flips the label to Copied", async () => {
    const user = userEvent.setup();
    stubClipboard(async () => {});
    render(<StatusDetailSheet open text={longText} onClose={vi.fn()} onDismiss={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(longText);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("a clipboard rejection (insecure context) leaves the label at Copy and does not throw", async () => {
    const user = userEvent.setup();
    stubClipboard(async () => {
      throw new Error("clipboard write not allowed");
    });
    render(<StatusDetailSheet open text={longText} onClose={vi.fn()} onDismiss={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("Dismiss calls onDismiss", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<StatusDetailSheet open text={longText} onClose={vi.fn()} onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the Close control calls onClose, not onDismiss", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    render(<StatusDetailSheet open text={longText} onClose={onClose} onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
