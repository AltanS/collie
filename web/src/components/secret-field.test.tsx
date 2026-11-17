import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretField } from "./secret-field";

// M102 spec 11, the sign-in frame. The text of the frame is its own and is never stored: the frame empties
// after a send that went, and keeps the text after a send that did not, so the code is not lost.

afterEach(() => cleanup());

const field = () => screen.getByRole("textbox", { name: "Sign-in code" });

describe("SecretField", () => {
  it("no tap vanishes: a send the bridge did not take keeps the code in the frame", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve(false));
    render(<SecretField onSend={onSend} onClose={vi.fn()} disabled={false} />);
    await user.type(field(), "123456");
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    expect(onSend).toHaveBeenCalledWith("123456");
    expect(field()).toHaveValue("123456");
    // Send again from the same text.
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("no tap vanishes: a send that went empties the frame", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve(true));
    render(<SecretField onSend={onSend} onClose={vi.fn()} disabled={false} />);
    await user.type(field(), "123456");
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    await waitFor(() => expect(field()).toHaveValue(""));
  });

  it("no tap vanishes: a locked frame says why under the frame, and goes quiet when it is not locked", () => {
    const { rerender } = render(<SecretField onSend={vi.fn()} onClose={vi.fn()} disabled reason="Pane is gone" />);
    expect(screen.getByText("Pane is gone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste" })).toBeDisabled();
    rerender(<SecretField onSend={vi.fn()} onClose={vi.fn()} disabled={false} reason={null} />);
    // It leaves through Collapse, so it is held for the exit with its row closed.
    expect(screen.getByText("Pane is gone").closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "closed");
  });

  it("no tap vanishes: while a send runs, Send shows a busy state", () => {
    render(<SecretField onSend={vi.fn()} onClose={vi.fn()} disabled sending start={{ value: "123456", shown: true }} />);
    expect(screen.getByRole("button", { name: "Send the code" })).toHaveAttribute("aria-busy", "true");
  });
});
